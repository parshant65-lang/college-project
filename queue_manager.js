const fs = require('fs');
const path = require('path');

const queuesDir = path.join(__dirname, 'queues');
const historyDir = path.join(__dirname, 'history');
const historyFile = path.join(historyDir, 'history.txt');
const statsFile = path.join(__dirname, 'stats.json');

// Ensure required directories exist
if (!fs.existsSync(queuesDir)) fs.mkdirSync(queuesDir, { recursive: true });
if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });

// Master memory cache
const sourceQueues = new Map();   // sourceSlug -> array of URLs
const sourcePointers = new Map(); // sourceSlug -> pointer index
const enqueuedUrls = new Set();   // O(1) global membership check
const scrapedHistory = new Set(); // O(1) history check
let sourceNames = [];
let currentSourceIndex = 0;
let totalPendingCount = 0;
const MAX_QUEUE_PER_SOURCE = 300; // Cap to keep each queue file lightweight (< 40 KB)

/**
 * Smart URL Normalizer: removes tracking parameters, query strings, hashes, and trailing slashes
 */
function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.protocol = 'https:';
    u.hash = '';
    u.search = '';
    let clean = u.href;
    if (clean.endsWith('/')) clean = clean.slice(0, -1);
    return clean;
  } catch (e) {
    let s = (rawUrl || '').trim();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  }
}

/**
 * Strict Financial & Business Story URL Validator
 */
function isRealStory(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    let p = u.pathname.toLowerCase();
    if (p.endsWith('/')) p = p.slice(0, -1);

    // 1. General utility, tools, calculators, and non-article page blacklist
    const utilityBlacklist = [
      '/author/', '/authors/', '/profile/', '/topic/', '/topics/', '/tag/', '/tags/',
      '/photos/', '/photo-gallery/', '/photogallery/', '/picture-gallery/',
      '/videos/', '/video/', '/web-stories/', '/webstories/', '/visual-stories/',
      '/live-blog/', '/liveblog/', '/games/', '/crossword/', '/sudoku/',
      '/horoscope/', '/astrology/', '/podcasts/', '/podcast/',
      'newsletter', '/epaper/', '/brand-stories/', '/native/',
      '/players/', '/teams/', '/scores/', '/series/', '/stats/',
      '/calculator', '/calculators/', '/tools/', '/performance-tracker',
      '/fixed-income/calculator', '/logout', '/login', '/about', '/contact', '/terms', '/privacy', '/ht-img/'
    ];
    if (utilityBlacklist.some(b => p.includes(b))) return false;

    // 2. Topic Blacklist: Strictly reject crime, murder, sports, cinema, and lifestyle
    const nonFinancialBlacklist = [
      '/sports/', '/sport/', '/cricket/', '/football/', '/tennis/', '/hockey/', '/badminton/',
      '/olympics/', '/entertainment/', '/bollywood/', '/hollywood/', '/cinema/', '/movie',
      '/lifestyle/', '/fashion/', '/relationships/', '/horoscope/', '/astrology/', '/zodiac/',
      '/religion/', '/dharm/', '/crime/', '/murder/', '/rape/', '/accident/', '/suicide/',
      '/police/', '/city/', '/cities/', '/viral/', '/offbeat/', '/delhi-news/', '/mumbai-news/',
      '/noida-news/', '/bengaluru-news/', '/kolkata-news/', '/chennai-news/', '/hyderabad-news/',
      '/elections/', '/politics/'
    ];
    if (nonFinancialBlacklist.some(b => p.includes(b))) return false;

    // 3. Dedicated Financial Portals
    const dedicatedFinancialDomains = [
      'economictimes.indiatimes.com',
      'livemint.com',
      'bloomberg.com',
      'yahoo.com',
      'moneycontrol.com',
      'business-standard.com',
      'ndtvprofit.com',
      'financialexpress.com'
    ];

    const isDedicated = dedicatedFinancialDomains.some(d => host.endsWith(d));

    // 4. LiveMint: Strictly enforce business sections
    if (host.includes('livemint')) {
      const liveMintBizSections = ['/market', '/companies', '/money', '/industry', '/economy', '/budget', '/mutual-funds', '/banking', '/technology', '/opinion', '/business'];
      const hasBizSection = liveMintBizSections.some(sec => p.includes(sec));
      if (!hasBizSection) return false;
      if (p.endsWith('.html') && /-\d{8,}\.html$/.test(p)) return true;
      return false;
    }

    // 5. General news network: REQUIRE business / economy / markets section
    if (!isDedicated) {
      const allowedSections = ['/business', '/economy', '/market', '/markets', '/industry', '/money', '/finance', '/profit', '/stocks', '/banking', '/tech'];
      const hasBizSection = allowedSections.some(sec => p.includes(sec));
      if (!hasBizSection) return false;
    }

    // 6. Article structure patterns
    if (p.endsWith('.html') && /-\d{8,}\.html$/.test(p)) return true;
    if (host.includes('moneycontrol') && (p.includes('/news/') || p.includes('/market/')) && /[-_]\d{5,}\.html$/.test(p)) return true;
    if (host.includes('business-standard') && /-\d+(_\d+)?\.html$/.test(p)) return true;
    if (host.includes('financialexpress') && (/-\d+\/?$/.test(p) || /-\d+\.html$/.test(p))) return true;
    if (p.endsWith('.ece') && /article\d+\.ece$/.test(p)) return true;
    if (p.includes('/articleshow/') && p.endsWith('.cms')) return true;
    if ((p.includes('/story/') || p.includes('/trending/') || p.includes('/national/')) && /-\d{5,}/.test(p)) return true;
    if (/\/articles\/c[a-z0-9]{8,}/i.test(p) || (host.includes('bbc.') && /-\d{7,8}$/.test(p))) return true;
    if (/\/(news|opinion)\/articles\/\d{4}-\d{2}-\d{2}\//i.test(p)) return true;
    if (/\/article\/.*-\d{6,}$/i.test(p)) return true;
    if (host.includes('ndtv') && /-\d{6,}$/.test(p)) return true;
    if (host.includes('yahoo.com') && (p.includes('/articles/') || p.includes('/article/') || p.includes('/news/')) && p.endsWith('.html')) return true;

    return false;
  } catch(e) {
    return false;
  }
}

/**
 * Canonical Source Slug Identifier (Unifies all publication names)
 */
function getCanonicalSource(sourceName, url) {
  let s = (sourceName || '').trim().replace(/\s+Business$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const low = s.toLowerCase();
  if (low.includes('economic')) return 'The_Economic_Times';
  if (low.includes('livemint')) return 'LiveMint';
  if (low.includes('moneycontrol')) return 'Moneycontrol';
  if (low.includes('business_standard') || low.includes('business-standard')) return 'Business_Standard';
  if (low.includes('bloomberg')) return 'Bloomberg_News';
  if (low.includes('yahoo')) return 'Yahoo_Finance';
  if (low.includes('ndtv')) return 'NDTV_Profit';
  if (low.includes('hindu')) return 'The_Hindu';
  if (low.includes('indian_express')) return 'Indian_Express';
  if (low.includes('hindustan_times')) return 'Hindustan_Times';
  if (low.includes('times_of_india') || low.includes('indiatimes')) return 'Times_of_India';
  if (low.includes('bbc')) return 'BBC_Business';
  if (low.includes('aaj_tak') || low.includes('aajtak')) return 'Aaj_Tak';
  if (low.includes('india_today')) return 'India_Today';

  // Fallback to URL inspection
  if (url) {
    try {
      const h = new URL(url).hostname.toLowerCase();
      if (h.includes('economictimes')) return 'The_Economic_Times';
      if (h.includes('livemint')) return 'LiveMint';
      if (h.includes('moneycontrol')) return 'Moneycontrol';
      if (h.includes('business-standard')) return 'Business_Standard';
      if (h.includes('bloomberg')) return 'Bloomberg_News';
      if (h.includes('yahoo')) return 'Yahoo_Finance';
      if (h.includes('ndtv')) return 'NDTV_Profit';
      if (h.includes('thehindu')) return 'The_Hindu';
      if (h.includes('indianexpress')) return 'Indian_Express';
      if (h.includes('hindustantimes')) return 'Hindustan_Times';
      if (h.includes('timesofindia') || h.includes('indiatimes')) return 'Times_of_India';
      if (h.includes('bbc')) return 'BBC_Business';
      if (h.includes('aajtak')) return 'Aaj_Tak';
      if (h.includes('indiatoday')) return 'India_Today';
    } catch(e) {}
  }

  return s || 'General_News';
}

function getSourceName(url) {
  const canon = getCanonicalSource('', url);
  return canon.replace(/_/g, ' ');
}

function isSameOrSupportedNetwork(targetUrl, currentUrl) {
  try {
    const tHost = new URL(targetUrl).hostname.toLowerCase();
    const cHost = new URL(currentUrl).hostname.toLowerCase();
    const getApex = (h) => {
      const parts = h.split('.');
      if (parts.length >= 2) {
        if (parts.length >= 3 && (parts[parts.length - 2] === 'co' || parts[parts.length - 2] === 'com' || parts[parts.length - 2] === 'org')) {
          return parts.slice(-3).join('.');
        }
        return parts.slice(-2).join('.');
      }
      return h;
    };
    if (getApex(tHost) === getApex(cHost)) return true;
    const supported = [
      'economictimes.indiatimes.com', 'livemint.com', 'bloomberg.com',
      'moneycontrol.com', 'business-standard.com', 'financialexpress.com',
      'ndtvprofit.com', 'yahoo.com', 'thehindu.com', 'indianexpress.com',
      'hindustantimes.com', 'ndtv.com', 'indiatoday.in', 'bbc.com',
      'bbc.co.uk', 'timesofindia.indiatimes.com', 'aajtak.in'
    ];
    return supported.some(d => tHost.endsWith(d));
  } catch(e) {
    return false;
  }
}

// 1. Load History
function loadHistory() {
  scrapedHistory.clear();
  if (fs.existsSync(historyFile)) {
    try {
      const lines = fs.readFileSync(historyFile, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          scrapedHistory.add(normalizeUrl(trimmed));
          scrapedHistory.add(trimmed);
        }
      }
    } catch(e) {}
  }
}

// 2. Load Partitioned Queues
function loadQueue() {
  loadHistory();
  sourceQueues.clear();
  sourcePointers.clear();
  enqueuedUrls.clear();
  sourceNames = [];
  totalPendingCount = 0;

  if (fs.existsSync(queuesDir)) {
    const files = fs.readdirSync(queuesDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const slug = f.replace(/\.json$/, '');
      try {
        const content = JSON.parse(fs.readFileSync(path.join(queuesDir, f), 'utf8'));
        if (Array.isArray(content)) {
          const active = [];
          for (const rawUrl of content) {
            const url = typeof rawUrl === 'string' ? rawUrl : (rawUrl.url || '');
            if (!url) continue;
            const norm = normalizeUrl(url);
            if (!scrapedHistory.has(norm) && !scrapedHistory.has(url)) {
              active.push(url);
              enqueuedUrls.add(norm);
              enqueuedUrls.add(url);
            }
          }
          sourceQueues.set(slug, active);
          sourcePointers.set(slug, 0);
          sourceNames.push(slug);
          totalPendingCount += active.length;
        }
      } catch(e) {}
    }
  }

  // Ensure default sources are registered
  const defaultSources = [
    'The_Economic_Times', 'LiveMint', 'Moneycontrol', 'Business_Standard',
    'Yahoo_Finance', 'NDTV_Profit', 'The_Hindu', 'Times_of_India',
    'Bloomberg_News', 'Indian_Express', 'Hindustan_Times', 'BBC_Business', 'Aaj_Tak'
  ];
  for (const ds of defaultSources) {
    if (!sourceQueues.has(ds)) {
      sourceQueues.set(ds, []);
      sourcePointers.set(ds, 0);
      sourceNames.push(ds);
    }
  }
}

// Initialize on require
loadQueue();

// Async Debounced Disk Save
let saveTimeout = null;
let isSaving = false;
let needsSaveAgain = false;

function scheduleSave() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(async () => {
    saveTimeout = null;
    await saveQueueAsync();
  }, 2000);
}

async function saveQueueAsync() {
  if (isSaving) {
    needsSaveAgain = true;
    return;
  }
  isSaving = true;
  try {
    for (const [slug, list] of sourceQueues.entries()) {
      const qPath = path.join(queuesDir, `${slug}.json`);
      const tmpPath = qPath + '.tmp';
      await fs.promises.writeFile(tmpPath, JSON.stringify(list, null, 2), 'utf8');
      await fs.promises.rename(tmpPath, qPath);
    }
  } catch(e) {
  } finally {
    isSaving = false;
    if (needsSaveAgain) {
      needsSaveAgain = false;
      scheduleSave();
    }
  }
}

function saveQueueSync() {
  try {
    for (const [slug, list] of sourceQueues.entries()) {
      const qPath = path.join(queuesDir, `${slug}.json`);
      const tmpPath = qPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(list, null, 2), 'utf8');
      fs.renameSync(tmpPath, qPath);
    }
  } catch(e) {}
}

/**
 * Enqueue Links across Partitioned Sources
 */
function enqueueLinks(urls, defaultSource = null) {
  if (!urls || !Array.isArray(urls)) return 0;
  let addedCount = 0;

  for (const rawUrl of urls) {
    if (!rawUrl || typeof rawUrl !== 'string') continue;
    const cleanUrl = rawUrl.trim();
    if (!isRealStory(cleanUrl)) continue;

    const norm = normalizeUrl(cleanUrl);
    if (scrapedHistory.has(norm) || scrapedHistory.has(cleanUrl)) continue;
    if (enqueuedUrls.has(norm) || enqueuedUrls.has(cleanUrl)) continue;

    const slug = getCanonicalSource(defaultSource, cleanUrl);
    if (!sourceQueues.has(slug)) {
      sourceQueues.set(slug, []);
      sourcePointers.set(slug, 0);
      sourceNames.push(slug);
    }

    const qList = sourceQueues.get(slug);
    qList.push(cleanUrl);
    enqueuedUrls.add(norm);
    enqueuedUrls.add(cleanUrl);
    totalPendingCount++;
    addedCount++;

    // Cap at MAX_QUEUE_PER_SOURCE to prevent bloated files
    if (qList.length > MAX_QUEUE_PER_SOURCE) {
      const droppedUrl = qList.shift();
      enqueuedUrls.delete(normalizeUrl(droppedUrl));
      enqueuedUrls.delete(droppedUrl);
      totalPendingCount--;
    }
  }

  if (addedCount > 0) {
    scheduleSave();
  }
  return addedCount;
}

/**
 * O(1) Round-Robin Dispatcher across 13 news networks
 */
function getNextUnopened() {
  if (totalPendingCount === 0 || sourceNames.length === 0) return null;

  const total = sourceNames.length;
  for (let i = 0; i < total; i++) {
    currentSourceIndex = (currentSourceIndex + 1) % total;
    const slug = sourceNames[currentSourceIndex];
    const qList = sourceQueues.get(slug);
    let ptr = sourcePointers.get(slug) || 0;

    while (qList && ptr < qList.length) {
      const url = qList[ptr++];
      sourcePointers.set(slug, ptr);
      const norm = normalizeUrl(url);
      if (!scrapedHistory.has(norm) && !scrapedHistory.has(url)) {
        return {
          url,
          source: slug.replace(/_/g, ' '),
          sourceSlug: slug,
          status: 'unopened'
        };
      }
    }
  }
  return null;
}

function getUnopenedLinks(limit = 100) {
  const result = [];
  for (let i = 0; i < limit; i++) {
    const item = getNextUnopened();
    if (!item) break;
    result.push(item);
  }
  return result;
}

function isScraped(url) {
  const norm = normalizeUrl(url);
  return scrapedHistory.has(norm) || scrapedHistory.has(url);
}

function recordInHistory(url) {
  const norm = normalizeUrl(url);
  if (!scrapedHistory.has(norm)) {
    scrapedHistory.add(norm);
    scrapedHistory.add(url);
    try {
      fs.appendFileSync(historyFile, norm + '\n');
    } catch(e) {}
  }
}

/**
 * Mark a link as 'opened': Records in history and evicts from partitioned queue
 */
function markLinkOpened(url, metadata = {}) {
  const norm = normalizeUrl(url);
  recordInHistory(url);
  recordInHistory(norm);
  enqueuedUrls.delete(norm);
  enqueuedUrls.delete(url);

  // Evict from corresponding source queue if present
  const slug = getCanonicalSource(metadata.source, url);
  if (sourceQueues.has(slug)) {
    const qList = sourceQueues.get(slug);
    const idx = qList.findIndex(u => normalizeUrl(u) === norm || u === url);
    if (idx !== -1) {
      qList.splice(idx, 1);
      totalPendingCount = Math.max(0, totalPendingCount - 1);
      scheduleSave();
    }
  }

  return { url, status: 'opened', ...metadata };
}

/**
 * Instant Queue Statistics
 */
function getQueueStats() {
  const perSource = {};
  for (const [slug, list] of sourceQueues.entries()) {
    perSource[slug] = list.length;
  }
  return {
    totalPending: totalPendingCount,
    totalHistory: scrapedHistory.size,
    sources: perSource
  };
}

module.exports = {
  enqueueLinks,
  getUnopenedLinks,
  getNextUnopened,
  markLinkOpened,
  getQueueStats,
  saveQueueSync,
  saveQueueAsync,
  normalizeUrl,
  isRealStory,
  getSourceName,
  getCanonicalSource,
  isSameOrSupportedNetwork,
  isScraped,
  recordInHistory,
  reloadQueue: loadQueue
};

// Interactive CLI Dashboard when executed directly via 'node queue_manager.js'
if (require.main === module) {
  const args = process.argv.slice(2);

  // URL test mode: node queue_manager.js --test <url>
  if (args[0] === '--test' && args[1]) {
    const testUrl = args[1];
    const norm = normalizeUrl(testUrl);
    const valid = isRealStory(testUrl);
    const src = getSourceName(testUrl);
    const inHistory = isScraped(testUrl);

    console.log(`\n==========================================================`);
    console.log(`🔍 URL VALIDATION & FILTER TEST`);
    console.log(`==========================================================`);
    console.log(`   🔗 Input URL       : ${testUrl}`);
    console.log(`   ✨ Normalized URL  : ${norm}`);
    console.log(`   📰 Detected Source : ${src}`);
    console.log(`   🛡️ Real Story Check: ${valid ? '✅ PASSED (Genuine Financial News)' : '❌ REJECTED (Filtered by Blacklist/Utility)'}`);
    console.log(`   📜 In History      : ${inHistory ? '⚠️ Yes (Already scraped)' : '✅ No (Fresh link)'}`);
    console.log(`==========================================================\n`);
    process.exit(0);
  }

  const stats = getQueueStats();
  console.log(`\n==========================================================`);
  console.log(`🎯 MASTER MULTI-FILE QUEUE REGISTRY (Status: 🟢 HEALTHY)`);
  console.log(`==========================================================`);
  console.log(`📊 Global Summary:`);
  console.log(`   ⏳ Total Active Pending : ${stats.totalPending.toLocaleString()} URLs`);
  console.log(`   📜 Scraped History URLs  : ${stats.totalHistory.toLocaleString()} URLs`);
  console.log(`   📁 Partitioned Files     : ${Object.keys(stats.sources).length} news network files`);
  console.log(`----------------------------------------------------------`);
  console.log(`🌐 Partitioned Queue Files (queues/*.json):`);

  const sorted = Object.entries(stats.sources).sort((a, b) => b[1] - a[1]);
  for (const [slug, count] of sorted) {
    const qFile = path.join(queuesDir, `${slug}.json`);
    let fSize = '0 KB';
    if (fs.existsSync(qFile)) {
      fSize = `${(fs.statSync(qFile).size / 1024).toFixed(1)} KB`;
    }
    console.log(`   ⚡ ${slug.padEnd(24)}: ${String(count).padStart(4)} pending  (${fSize})`);
  }

  console.log(`----------------------------------------------------------`);
  console.log(`💡 Usage:`);
  console.log(`   • Test a link:    node queue_manager.js --test <url>`);
  console.log(`   • Run Scraper:    node queue_worker.js --concurrency 24`);
  console.log(`==========================================================\n`);
}
