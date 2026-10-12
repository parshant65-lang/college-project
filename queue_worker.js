/**
 * Ultra-Fast Queue Worker:
 * High-performance continuous pipeline with partitioned multi-file queues.
 * Concurrency: 24 parallel streams across 13 major news networks.
 *
 * Repositories:
 *   - Engine       : parshant65-lang/college-project (Public, 100% Free Actions)
 *   - Article Vault: parshant65-lang/college-data-vault (Private, Data/<Website>/<YYYY>/<MM>/<DD>.json)
 *   - Queue Vault  : parshant65-lang/college-queue-vault (Private, queues/*.json, history/)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const queueManager = require('./queue_manager');
const { scrapeSingleArticle, discoverAllNewsSources, dataDir } = require('./ref');

// Cloud Vault Configuration
const VAULT_PAT = process.env.VAULT_PAT;
const DATA_VAULT_URL = VAULT_PAT ? `https://x-access-token:${VAULT_PAT}@github.com/parshant65-lang/college-data-vault.git` : null;
const QUEUE_VAULT_URL = VAULT_PAT ? `https://x-access-token:${VAULT_PAT}@github.com/parshant65-lang/college-queue-vault.git` : null;
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

let isRunning = true;
let activeWorkers = 0;
let savedCount = 0;
let skippedCount = 0;
let errorCount = 0;
let totalProcessed = 0;
const startTime = Date.now();

function pullInitialStateFromVault() {
  if (!QUEUE_VAULT_URL) return;
  const qvDir = path.join(__dirname, 'qv_init_tmp');
  try {
    console.log('[QUEUE VAULT INIT] Pulling partitioned queues and history from college-queue-vault...');
    if (fs.existsSync(qvDir)) fs.rmSync(qvDir, { recursive: true, force: true });
    execSync(`git clone --depth 1 ${QUEUE_VAULT_URL} "${qvDir}"`, { stdio: 'pipe' });

    const vQueues = path.join(qvDir, 'queues');
    const lQueues = path.join(__dirname, 'queues');
    if (fs.existsSync(vQueues)) {
      if (!fs.existsSync(lQueues)) fs.mkdirSync(lQueues, { recursive: true });
      for (const f of fs.readdirSync(vQueues)) {
        fs.copyFileSync(path.join(vQueues, f), path.join(lQueues, f));
      }
      console.log('[QUEUE VAULT INIT] Loaded partitioned queues from vault.');
    }

    const vHist = path.join(qvDir, 'history', 'history.txt');
    const lHistDir = path.join(__dirname, 'history');
    if (fs.existsSync(vHist)) {
      if (!fs.existsSync(lHistDir)) fs.mkdirSync(lHistDir, { recursive: true });
      fs.copyFileSync(vHist, path.join(lHistDir, 'history.txt'));
      console.log('[QUEUE VAULT INIT] Loaded history.txt from vault.');
    }
    queueManager.reloadQueue();
  } catch (e) {
    console.log(`[QUEUE VAULT INIT NOTE] Initial vault pull: ${e.message}`);
  } finally {
    if (fs.existsSync(qvDir)) {
      try { fs.rmSync(qvDir, { recursive: true, force: true }); } catch (e) {}
    }
  }
}

function syncToVault() {
  // A. Sync Scraped Articles to Data Vault
  if (DATA_VAULT_URL) {
    const dataVaultDir = path.join(__dirname, 'data_vault_sync_tmp');
    try {
      console.log('\n[DATA VAULT SYNC] Synchronizing articles to college-data-vault...');
      if (fs.existsSync(dataVaultDir)) fs.rmSync(dataVaultDir, { recursive: true, force: true });

      execSync(`git clone --depth 1 ${DATA_VAULT_URL} "${dataVaultDir}"`, { stdio: 'pipe' });
      const vaultDataDir = path.join(dataVaultDir, 'Data');
      if (!fs.existsSync(vaultDataDir)) fs.mkdirSync(vaultDataDir, { recursive: true });

      // Scan all local daily JSON files in Data/
      const localDailyFiles = [];
      function scanDailyFiles(dir, relPath = '') {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          const rel = relPath ? path.join(relPath, ent.name) : ent.name;
          if (ent.isDirectory()) {
            scanDailyFiles(full, rel);
          } else if (ent.isFile() && ent.name.endsWith('.json') && ent.name !== 'latest.json') {
            localDailyFiles.push({ fullPath: full, relPath: rel });
          }
        }
      }
      scanDailyFiles(dataDir);

      let newlySyncedCount = 0;
      for (const item of localDailyFiles) {
        try {
          const localList = JSON.parse(fs.readFileSync(item.fullPath, 'utf8'));
          if (!Array.isArray(localList) || localList.length === 0) continue;

          const targetVaultFile = path.join(vaultDataDir, item.relPath);
          const targetDir = path.dirname(targetVaultFile);
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

          let vaultList = [];
          const knownUrls = new Set();
          if (fs.existsSync(targetVaultFile)) {
            try {
              vaultList = JSON.parse(fs.readFileSync(targetVaultFile, 'utf8'));
              for (const a of vaultList) if (a && a.url) knownUrls.add(a.url);
            } catch(e) {
              vaultList = [];
            }
          }

          for (const a of localList) {
            if (a && a.url && !knownUrls.has(a.url)) {
              vaultList.push(a);
              knownUrls.add(a.url);
              newlySyncedCount++;
            }
          }

          fs.writeFileSync(targetVaultFile, JSON.stringify(vaultList, null, 2), 'utf8');
        } catch(e) {}
      }

      execSync('git config user.name "github-actions[bot]"', { cwd: dataVaultDir, stdio: 'pipe' });
      execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { cwd: dataVaultDir, stdio: 'pipe' });
      execSync('git add .', { cwd: dataVaultDir, stdio: 'pipe' });

      try {
        execSync(`git commit -m "Autonomous Dataset Sync: +${newlySyncedCount} articles [skip ci]"`, { cwd: dataVaultDir, stdio: 'pipe' });
        execSync('git pull --rebase origin main', { cwd: dataVaultDir, stdio: 'pipe' });
        execSync('git push origin main', { cwd: dataVaultDir, stdio: 'pipe' });
        console.log(`[DATA VAULT SYNC] ✅ Successfully pushed +${newlySyncedCount} articles to college-data-vault!`);

        // Clean local runner files so storage footprint stays 0 MB
        for (const item of localDailyFiles) {
          try { fs.unlinkSync(item.fullPath); } catch (e) {}
        }
      } catch (commitErr) {
        console.log(`[DATA VAULT SYNC] No new git commit created: ${commitErr.message}`);
      }
    } catch (err) {
      console.error(`[DATA VAULT SYNC ERROR] ${err.message}`);
    } finally {
      if (fs.existsSync(dataVaultDir)) {
        try { fs.rmSync(dataVaultDir, { recursive: true, force: true }); } catch (e) {}
      }
    }
  }

  // B. Sync Queues & History to Queue Vault
  if (QUEUE_VAULT_URL) {
    const queueVaultDir = path.join(__dirname, 'queue_vault_sync_tmp');
    try {
      console.log('\n[QUEUE VAULT SYNC] Synchronizing partitioned queues to college-queue-vault...');
      if (fs.existsSync(queueVaultDir)) fs.rmSync(queueVaultDir, { recursive: true, force: true });

      execSync(`git clone --depth 1 ${QUEUE_VAULT_URL} "${queueVaultDir}"`, { stdio: 'pipe' });
      queueManager.saveQueueSync();

      const lQueues = path.join(__dirname, 'queues');
      const vQueues = path.join(queueVaultDir, 'queues');
      if (fs.existsSync(lQueues)) {
        if (!fs.existsSync(vQueues)) fs.mkdirSync(vQueues, { recursive: true });
        for (const f of fs.readdirSync(lQueues)) {
          fs.copyFileSync(path.join(lQueues, f), path.join(vQueues, f));
        }
      }

      const lHist = path.join(__dirname, 'history', 'history.txt');
      const vHistDir = path.join(queueVaultDir, 'history');
      if (fs.existsSync(lHist)) {
        if (!fs.existsSync(vHistDir)) fs.mkdirSync(vHistDir, { recursive: true });
        fs.copyFileSync(lHist, path.join(vHistDir, 'history.txt'));
      }

      // Update stats.json
      const stats = queueManager.getQueueStats();
      stats.lastSync = new Date().toISOString();
      fs.writeFileSync(path.join(queueVaultDir, 'stats.json'), JSON.stringify(stats, null, 2), 'utf8');

      execSync('git config user.name "github-actions[bot]"', { cwd: queueVaultDir, stdio: 'pipe' });
      execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { cwd: queueVaultDir, stdio: 'pipe' });
      execSync('git add .', { cwd: queueVaultDir, stdio: 'pipe' });

      try {
        execSync(`git commit -m "Sync partitioned queues (Pending: ${stats.totalPending}) [skip ci]"`, { cwd: queueVaultDir, stdio: 'pipe' });
        execSync('git pull --rebase origin main', { cwd: queueVaultDir, stdio: 'pipe' });
        execSync('git push origin main', { cwd: queueVaultDir, stdio: 'pipe' });
        console.log(`[QUEUE VAULT SYNC] ✅ Successfully pushed partitioned queues to college-queue-vault!`);
      } catch(commitErr) {
        console.log(`[QUEUE VAULT SYNC] Queues up-to-date: ${commitErr.message}`);
      }
    } catch(err) {
      console.error(`[QUEUE VAULT SYNC ERROR] ${err.message}`);
    } finally {
      if (fs.existsSync(queueVaultDir)) {
        try { fs.rmSync(queueVaultDir, { recursive: true, force: true }); } catch (e) {}
      }
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
  console.log(`🚀 ULTRA-FAST MULTI-VAULT QUEUE WORKER`);
  console.log(`   ⚡ Concurrency     : ${CONCURRENCY} parallel streaming workers`);
  console.log(`   🌐 Queue Partitions: 13 news networks (Round-Robin)`);
  console.log(`   ⏳ Total Pending   : ${initialStats.totalPending.toLocaleString()} URLs`);
  console.log(`   📜 History URLs    : ${initialStats.totalHistory.toLocaleString()} URLs`);
  console.log(`   📁 Article Vault   : ${DATA_VAULT_URL ? 'parshant65-lang/college-data-vault' : 'Local Data/'}`);
  console.log(`   🗃️ Queue Vault     : ${QUEUE_VAULT_URL ? 'parshant65-lang/college-queue-vault' : 'Local queues/'}`);
  console.log(`==========================================================\n`);

  // Periodic vault sync every 15 minutes in cloud
  if (DATA_VAULT_URL || QUEUE_VAULT_URL) {
    setInterval(() => {
      syncToVault();
    }, VAULT_SYNC_INTERVAL_MS);
  }

  let isReplenishing = false;

  // Auto-replenish if queue is initial low
  if (initialStats.totalPending < 50) {
    console.log('[AUTO-DISCOVERY] Initial queue low (< 50). Scanning news networks for fresh seeds...');
    try {
      const discovered = await discoverAllNewsSources();
      queueManager.enqueueLinks(discovered);
    } catch(e) {}
  }

  // Continuous streaming worker
  async function worker(workerId) {
    activeWorkers++;
    while (isRunning) {
      if ((DATA_VAULT_URL || QUEUE_VAULT_URL) && (Date.now() - startTime) >= (SESSION_MAX_SECONDS * 1000)) {
        console.log('\n[SESSION MAX REACHED] 5.5 Hours complete. Handing over to next relay...');
        isRunning = false;
        break;
      }

      const item = queueManager.getNextUnopened();
      if (!item) {
        if (workerId === 1 && !isReplenishing) {
          isReplenishing = true;
          console.log('[AUTO-DISCOVERY] Unopened queues low. Scanning news networks for fresh seeds...');
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
        const result = await scrapeSingleArticle(item.url);
        totalProcessed++;

        const elapsedSec = Math.max(1, (Date.now() - startTime) / 1000);
        const speed = (totalProcessed / elapsedSec).toFixed(1);
        const stats = queueManager.getQueueStats();

        if (result && result.status === 'saved') {
          savedCount++;
          const spiderBadge = result.queuedNewCount > 0 ? ` 🕸️ (+${result.queuedNewCount})` : '';
          console.log(`[⚡ ${speed}/s] ✅ [SAVED] [${result.source}] "${result.heading.slice(0, 36)}..." (${result.paragraphsCount}p)${spiderBadge} [Q: ${stats.totalPending} left]`);
        } else if (result && result.status === 'skipped') {
          skippedCount++;
          console.log(`[⚡ ${speed}/s] ⏩ [SKIPPED] ${item.url.slice(0, 52)} [Q: ${stats.totalPending} left]`);
        } else {
          queueManager.markLinkOpened(item.url, { error: 'Parse failed' });
          errorCount++;
          console.log(`[⚡ ${speed}/s] ⚠️ [PARSE FAIL] ${item.url.slice(0, 52)} [Q: ${stats.totalPending} left]`);
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
  console.log(`   ⏱️  Total Duration     : ${Math.round(elapsedSec)}s`);
  console.log(`   ⚡ Average Speed      : ${speed} articles/second`);
  console.log(`   ✅ Newly Saved        : ${savedCount}`);
  console.log(`   ⏩ Already Downloaded  : ${skippedCount}`);
  console.log(`   ⚠️ Failed / Skipped   : ${errorCount}`);
  console.log(`   📊 Queue Remaining    : ${stats.totalPending} pending`);
  console.log(`   📁 Partitioned Queues : Successfully synced`);
  console.log(`==========================================================\n`);

  if (DATA_VAULT_URL || QUEUE_VAULT_URL) {
    syncToVault();
    triggerNextRelay();
  }

  process.exit(0);
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

// Start
startQueueWorker();
