/**
 * Ultra-Fast Queue Worker:
 * High-performance continuous pipeline with O(1) multi-source round-robin dispatch.
 * Concurrency: 24 parallel streams across all 12 major news networks.
 *
 * Usage:
 *   node queue_worker.js
 *   node queue_worker.js --concurrency 32
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const queueManager = require('./queue_manager');
const { scrapeSingleArticle, discoverAllNewsSources, dataDir } = require('./ref');

// Cloud Vault Configuration
const VAULT_PAT = process.env.VAULT_PAT;
const VAULT_REPO_URL = VAULT_PAT ? `https://x-access-token:${VAULT_PAT}@github.com/parshant65-lang/college-data-vault.git` : null;
const SESSION_MAX_SECONDS = 5 * 3600 + 30 * 60; // 5.5 Hours continuous cloud session
const VAULT_SYNC_INTERVAL_MS = 15 * 60 * 1000;  // 15 Minutes sync cadence

// Parse CLI concurrency (default 24 parallel streaming workers)
const args = process.argv.slice(2);
let CONCURRENCY = 24;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--concurrency' || args[i] === '-c') {
    CONCURRENCY = parseInt(args[i + 1], 10) || CONCURRENCY;
  } else if (!isNaN(parseInt(args[i], 10))) {
    CONCURRENCY = parseInt(args[i], 10);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function getSessionFolder() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const hours = now.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = String(hours % 12 || 12).padStart(2, '0');
  const timeStr = `Run_${displayHours}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}${ampm}`;
  const sessionDir = path.join(dataDir, dateStr, timeStr);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

let isRunning = true;
let activeWorkers = 0;
let savedCount = 0;
let skippedCount = 0;
let errorCount = 0;
let totalProcessed = 0;
const startTime = Date.now();

function pullInitialStateFromVault() {
  if (!VAULT_REPO_URL) return;
  const vaultDir = path.join(__dirname, 'vault_init_tmp');
  try {
    console.log('[VAULT INIT] Pulling latest queue and history from college-data-vault...');
    if (fs.existsSync(vaultDir)) fs.rmSync(vaultDir, { recursive: true, force: true });
    execSync(`git clone --depth 1 ${VAULT_REPO_URL} "${vaultDir}"`, { stdio: 'pipe' });

    const vaultQ = path.join(vaultDir, 'links_queue.json');
    if (fs.existsSync(vaultQ)) {
      fs.copyFileSync(vaultQ, path.join(__dirname, 'links_queue.json'));
      console.log('[VAULT INIT] Loaded latest links_queue.json from vault.');
    }
    const vaultH = path.join(vaultDir, 'history.txt');
    if (fs.existsSync(vaultH)) {
      fs.copyFileSync(vaultH, path.join(__dirname, 'history.txt'));
      console.log('[VAULT INIT] Loaded latest history.txt from vault.');
    }
    queueManager.reloadQueue();
  } catch (e) {
    console.log(`[VAULT INIT NOTE] Initial vault pull: ${e.message}`);
  } finally {
    if (fs.existsSync(vaultDir)) {
      try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (e) {}
    }
  }
}

function syncToVault() {
  if (!VAULT_REPO_URL) return;

  const vaultDir = path.join(__dirname, 'vault_sync_tmp');
  try {
    console.log('\n[VAULT SYNC] Synchronizing scraped data to private college-data-vault...');
    if (fs.existsSync(vaultDir)) {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }

    execSync(`git clone --depth 1 ${VAULT_REPO_URL} "${vaultDir}"`, { stdio: 'pipe' });

    const vaultDataDir = path.join(vaultDir, 'Data');
    if (!fs.existsSync(vaultDataDir)) {
      fs.mkdirSync(vaultDataDir, { recursive: true });
    }

    // Read and consolidate all JSON files from local Data/
    const allFiles = [];
    function scanFiles(dir) {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const fullPath = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          scanFiles(fullPath);
        } else if (ent.isFile() && ent.name.endsWith('.json') && ent.name !== 'latest.json') {
          allFiles.push(fullPath);
        }
      }
    }
    scanFiles(dataDir);

    console.log(`[VAULT SYNC] Consolidating ${allFiles.length} local article JSONs...`);
    let syncedArticlesCount = 0;
    const dateMap = new Map();

    for (const f of allFiles) {
      try {
        const content = JSON.parse(fs.readFileSync(f, 'utf8'));
        const dateKey = (content.date && /^\d{4}-\d{2}-\d{2}/.test(content.date))
          ? content.date.slice(0, 10)
          : new Date().toISOString().slice(0, 10);
        if (!dateMap.has(dateKey)) dateMap.set(dateKey, []);
        dateMap.get(dateKey).push(content);
      } catch (e) {}
    }

    for (const [dateKey, newArticles] of dateMap.entries()) {
      const targetFile = path.join(vaultDataDir, `${dateKey}.json`);
      let existingArticles = [];
      const knownUrls = new Set();
      if (fs.existsSync(targetFile)) {
        try {
          existingArticles = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
          for (const a of existingArticles) {
            if (a.url) knownUrls.add(a.url);
          }
        } catch (e) {
          existingArticles = [];
        }
      }

      for (const a of newArticles) {
        if (!knownUrls.has(a.url)) {
          existingArticles.push(a);
          knownUrls.add(a.url);
          syncedArticlesCount++;
        }
      }

      fs.writeFileSync(targetFile, JSON.stringify(existingArticles, null, 2), 'utf8');
    }

    // Save and sync queue & history
    queueManager.saveQueueSync();
    const qFile = path.join(__dirname, 'links_queue.json');
    if (fs.existsSync(qFile)) {
      fs.copyFileSync(qFile, path.join(vaultDir, 'links_queue.json'));
    }
    const hFile = path.join(__dirname, 'history.txt');
    if (fs.existsSync(hFile)) {
      fs.copyFileSync(hFile, path.join(vaultDir, 'history.txt'));
    }

    execSync('git config user.name "github-actions[bot]"', { cwd: vaultDir, stdio: 'pipe' });
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { cwd: vaultDir, stdio: 'pipe' });
    execSync('git add .', { cwd: vaultDir, stdio: 'pipe' });

    try {
      execSync(`git commit -m "Autonomous Node.js Sync: +${syncedArticlesCount} articles [skip ci]"`, { cwd: vaultDir, stdio: 'pipe' });
      execSync('git pull --rebase origin main', { cwd: vaultDir, stdio: 'pipe' });
      execSync('git push origin main', { cwd: vaultDir, stdio: 'pipe' });
      console.log(`[VAULT SYNC] ✅ Successfully pushed +${syncedArticlesCount} articles to college-data-vault!`);

      // Clean local session JSON files so runner storage remains 0 MB
      for (const f of allFiles) {
        try { fs.unlinkSync(f); } catch (e) {}
      }
    } catch (commitErr) {
      console.log(`[VAULT SYNC] No new git commit created: ${commitErr.message}`);
    }
  } catch (err) {
    console.error(`[VAULT SYNC ERROR] ${err.message}`);
  } finally {
    if (fs.existsSync(vaultDir)) {
      try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (e) {}
    }
  }
}

function triggerNextRelay() {
  if (!VAULT_PAT) return;
  const payload = JSON.stringify({ ref: 'main' });
  const req = https.request({
    hostname: 'api.github.com',
    path: '/repos/parshant65-lang/college-project/actions/workflows/continuous_scraper.yml/dispatches',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VAULT_PAT}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Continuous-College-Scraper',
      'Content-Type': 'application/json',
      'Content-Length': payload.length
    }
  }, (res) => {
    console.log(`[SEAMLESS RELAY] Next continuous session triggered successfully (HTTP ${res.statusCode}).`);
  });
  req.on('error', (err) => console.error(`[RELAY DISPATCH ERROR] ${err.message}`));
  req.write(payload);
  req.end();
}

async function startQueueWorker() {
  pullInitialStateFromVault();
  const initialStats = queueManager.getQueueStats();
  console.log(`\n==========================================================`);
  console.log(`🚀 ULTRA-FAST CONTINUOUS QUEUE WORKER`);
  console.log(`   ⚡ Concurrency    : ${CONCURRENCY} parallel streaming workers`);
  console.log(`   🌐 Dispatch Mode   : Round-Robin across 12 News Networks`);
  console.log(`   📊 Queue Status    : ${initialStats.unopened} unopened | ${initialStats.opened} opened`);
  console.log(`   📂 Data Output     : ${VAULT_REPO_URL ? 'Private college-data-vault' : 'Data/ directory'}`);
  console.log(`==========================================================\n`);

  const sessionFolder = getSessionFolder();

  // Periodic vault sync every 15 minutes in cloud
  if (VAULT_REPO_URL) {
    setInterval(() => {
      syncToVault();
    }, VAULT_SYNC_INTERVAL_MS);
  }

  let isReplenishing = false;

  // Auto-replenish if queue is initial low
  if (initialStats.unopened < 20) {
    console.log('[AUTO-DISCOVERY] Initial queue low (< 20). Scanning news networks for fresh seeds...');
    try {
      const discovered = await discoverAllNewsSources();
      queueManager.enqueueLinks(discovered);
    } catch(e) {}
  }

  // Continuous streaming worker
  async function worker(workerId) {
    activeWorkers++;
    while (isRunning) {
      if (VAULT_REPO_URL && (Date.now() - startTime) >= (SESSION_MAX_SECONDS * 1000)) {
        console.log('\n[SESSION MAX REACHED] 5.5 Hours complete. Handing over to next relay...');
        isRunning = false;
        break;
      }

      const item = queueManager.getNextUnopened();
      if (!item) {
        if (workerId === 1 && !isReplenishing) {
          isReplenishing = true;
          console.log('[AUTO-DISCOVERY] Unopened queue empty. Scanning news networks for fresh seeds...');
          try {
            const discovered = await discoverAllNewsSources();
            queueManager.enqueueLinks(discovered);
          } catch(e) {}
          isReplenishing = false;
        }
        await sleep(1000);
        continue;
      }

      try {
        const result = await scrapeSingleArticle(item.url, sessionFolder);
        totalProcessed++;

        const elapsedSec = Math.max(1, (Date.now() - startTime) / 1000);
        const speed = (totalProcessed / elapsedSec).toFixed(1);
        const stats = queueManager.getQueueStats();

        if (result && result.status === 'saved') {
          savedCount++;
          const spiderBadge = result.queuedNewCount > 0 ? ` 🕸️ (+${result.queuedNewCount})` : '';
          console.log(`[⚡ ${speed}/s] ✅ [SAVED] [${result.source}] "${result.heading.slice(0, 36)}..." (${result.paragraphsCount}p)${spiderBadge} [Q: ${stats.unopened} left]`);
        } else if (result && result.status === 'skipped') {
          skippedCount++;
          console.log(`[⚡ ${speed}/s] ⏩ [SKIPPED] ${item.url.slice(0, 52)} [Q: ${stats.unopened} left]`);
        } else {
          queueManager.markLinkOpened(item.url, { error: 'Parse failed' });
          errorCount++;
          console.log(`[⚡ ${speed}/s] ⚠️ [PARSE FAIL] ${item.url.slice(0, 52)} [Q: ${stats.unopened} left]`);
        }
      } catch (err) {
        queueManager.markLinkOpened(item.url, { error: err.message });
        errorCount++;
        totalProcessed++;
        console.log(`[❌ ERROR] ${item.url.slice(0, 52)}: ${err.message}`);
      }
    }
    activeWorkers--;
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);
}

// Graceful Shutdown
let isShuttingDown = false;
async function handleShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  isRunning = false;

  console.log(`\n🛑 Stopping Queue Worker gracefully... Waiting for active downloads to finish...`);
  while (activeWorkers > 0) {
    await sleep(200);
  }

  queueManager.saveQueueSync();
  const elapsedSec = Math.max(1, (Date.now() - startTime) / 1000);
  const speed = (totalProcessed / elapsedSec).toFixed(1);
  const stats = queueManager.getQueueStats();

  console.log(`\n==========================================================`);
  console.log(`🏁 QUEUE WORKER RUN SUMMARY:`);
  console.log(`   ⏱️  Total Duration   : ${Math.round(elapsedSec)}s`);
  console.log(`   ⚡ Average Speed    : ${speed} articles/second`);
  console.log(`   ✅ Newly Saved      : ${savedCount}`);
  console.log(`   ⏩ Already Downloaded: ${skippedCount}`);
  console.log(`   ⚠️ Failed / Skipped : ${errorCount}`);
  console.log(`   📊 Queue Remaining  : ${stats.unopened} unopened | ${stats.opened} opened`);
  console.log(`   💾 links_queue.json : Successfully updated`);
  console.log(`==========================================================\n`);

  if (VAULT_REPO_URL) {
    syncToVault();
    triggerNextRelay();
  }

  process.exit(0);
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

// Start
startQueueWorker();
