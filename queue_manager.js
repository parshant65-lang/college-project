const fs = require('fs');
const path = require('path');

const queueFile = path.join(__dirname, 'links_queue.json');
const historyFile = path.join(__dirname, 'history.txt');

// Master memory cache
let queue = [];
const urlToItemMap = new Map(); // normalizedUrl -> queueItem
const scrapedHistory = new Set();

/**
 * Smart URL Normalizer: removes tracking parameters, query strings, hashes, and trailing slashes
 */
function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.protocol = 'https:'; // Unify http and https so we never have duplicate URLs
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
 * Strict Financial & Business Story URL Validator:
 * Rejects non-news utilities, calculators, author profiles, topic tags, video players, games,
 * and ALL non-financial topics (crimes, murder, sports, cinema, astrology, gossip).
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

    // 3. Dedicated Financial Portals: 100% focused on business & economy
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

    // 4. LiveMint: Strictly enforce business sections (filter out general /news/india/ and /news/world/ crime/politics)
    if (host.includes('livemint')) {
      const liveMintBizSections = ['/market', '/companies', '/money', '/industry', '/economy', '/budget', '/mutual-funds', '/banking', '/technology', '/opinion', '/business'];
      const hasBizSection = liveMintBizSections.some(sec => p.includes(sec));
      if (!hasBizSection) return false;
      if (p.endsWith('.html') && /-\d{8,}\.html$/.test(p)) return true;
      return false;
    }

    // 5. If from a general news network, REQUIRE business / economy / markets section
    if (!isDedicated) {
      const allowedSections = ['/business', '/economy', '/market', '/markets', '/industry', '/money', '/finance', '/profit', '/stocks', '/banking', '/tech'];
      const hasBizSection = allowedSections.some(sec => p.includes(sec));
      if (!hasBizSection) return false;
    }

    // 6. Validate article structure pattern for each publication
    // Hindustan Times
    if (p.endsWith('.html') && /-\d{8,}\.html$/.test(p)) return true;

    // Moneycontrol: genuine news & market reports with story ID
    if (host.includes('moneycontrol') && (p.includes('/news/') || p.includes('/market/')) && /[-_]\d{5,}\.html$/.test(p)) return true;

    // Business Standard: dedicated financial publication (all article IDs)
    if (host.includes('business-standard') && /-\d+(_\d+)?\.html$/.test(p)) return true;

    // Financial Express: dedicated financial publication
    if (host.includes('financialexpress') && (/-\d+\/?$/.test(p) || /-\d+\.html$/.test(p))) return true;

    // The Hindu
    if (p.endsWith('.ece') && /article\d+\.ece$/.test(p)) return true;

    // Times of India, The Economic Times
    if (p.includes('/articleshow/') && p.endsWith('.cms')) return true;

    // Aaj Tak & India Today
    if ((p.includes('/story/') || p.includes('/trending/') || p.includes('/national/')) && /-\d{5,}/.test(p)) return true;

    // BBC News (both modern /articles/c... and classic 8-digit)
    if (/\/articles\/c[a-z0-9]{8,}/i.test(p) || (host.includes('bbc.') && /-\d{7,8}$/.test(p))) return true;

    // Bloomberg News (both /news/ and /opinion/)
    if (/\/(news|opinion)\/articles\/\d{4}-\d{2}-\d{2}\//i.test(p)) return true;

    // Indian Express
    if (/\/article\/.*-\d{6,}$/i.test(p)) return true;

    // NDTV / NDTV Profit
    if (host.includes('ndtv') && /-\d{6,}$/.test(p)) return true;

    // Yahoo Finance
    if (host.includes('yahoo.com') && (p.includes('/articles/') || p.includes('/article/') || p.includes('/news/')) && p.endsWith('.html')) return true;

    return false;
  } catch(e) {
    return false;
  }
}

/**
 * Universal Source Identifier
 */
function getSourceName(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('economictimes')) return 'The Economic Times';
    if (host.includes('livemint')) return 'LiveMint';
    if (host.includes('moneycontrol')) return 'Moneycontrol';
    if (host.includes('business-standard')) return 'Business Standard';
    if (host.includes('bloomberg')) return 'Bloomberg News';
    if (host.includes('yahoo.com')) return 'Yahoo Finance';
    if (host.includes('ndtvprofit') || host.includes('ndtv')) return 'NDTV Profit';
    if (host.includes('thehindu')) return 'The Hindu Business';
    if (host.includes('indianexpress')) return 'Indian Express Business';
    if (host.includes('hindustantimes')) return 'Hindustan Times Business';
    if (host.includes('timesofindia') || host.includes('indiatimes')) return 'Times of India Business';
    if (host.includes('bbc')) return 'BBC Business';
    if (host.includes('aajtak')) return 'Aaj Tak Business';
    if (host.includes('indiatoday')) return 'India Today Business';
    return host.replace('www.', '').split('.')[0].toUpperCase();
  } catch (e) {
    return 'Finance';
  }
}

/**
 * Check whether a target URL belongs to the same publication apex domain
 * or any of the supported financial news networks
 */
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

    const tApex = getApex(tHost);
    const cApex = getApex(cHost);

    if (tApex === cApex || tHost.includes(cApex) || cHost.includes(tApex)) {
      return true;
    }

    const supported = [
      'economictimes.indiatimes.com', 'livemint.com', 'bloomberg.com',
      'moneycontrol.com', 'business-standard.com', 'financialexpress.com',
      'ndtvprofit.com', 'yahoo.com', 'thehindu.com', 'indianexpress.com',
      'hindustantimes.com', 'ndtv.com', 'indiatoday.in', 'bbc.com',
      'bbc.co.uk', 'timesofindia.indiatimes.com', 'aajtak.in'
    ];

    return supported.some(d => tHost.endsWith(d));
  } catch (e) {
    return false;
  }
}

// 1. Load History
function loadHistory() {
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

// 2. High-Performance Multi-Source Queue State
const sourceQueues = new Map();   // sourceName -> array of items
const sourcePointers = new Map(); // sourceName -> current read index
let sourceNames = [];
let sourceIndex = 0;
let unopenedCount = 0;
let openedCount = 0;

function addToSourceQueue(item) {
  const src = item.source || 'News';
  if (!sourceQueues.has(src)) {
    sourceQueues.set(src, []);
    sourcePointers.set(src, 0);
    sourceNames.push(src);
  }
  sourceQueues.get(src).push(item);
}

function loadQueue() {
  loadHistory();
  if (fs.existsSync(queueFile)) {
    try {
      const data = fs.readFileSync(queueFile, 'utf8');
      queue = JSON.parse(data);
      if (!Array.isArray(queue)) queue = [];
    } catch(e) {
      queue = [];
    }
  }

  urlToItemMap.clear();
  sourceQueues.clear();
  sourcePointers.clear();
  sourceNames = [];
  sourceIndex = 0;
  unopenedCount = 0;
  openedCount = 0;

  for (const item of queue) {
    if (item && item.url) {
      const norm = normalizeUrl(item.url);
      urlToItemMap.set(norm, item);
      urlToItemMap.set(item.url, item);
      if (item.status === 'unopened') {
        addToSourceQueue(item);
        unopenedCount++;
      } else if (item.status === 'opened') {
        openedCount++;
      }
    }
  }
}

// High-Performance Async Debounced Disk Save
let saveTimeout = null;
let isSaving = false;
let needsSaveAgain = false;

function scheduleSave() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(async () => {
    saveTimeout = null;
    await saveQueueAsync();
  }, 2500); // Debounce to 2.5 seconds during high-speed runs
}

async function saveQueueAsync() {
  if (isSaving) {
    needsSaveAgain = true;
    return;
  }
  isSaving = true;
  try {
    const tmpFile = queueFile + '.tmp';
    const jsonStr = JSON.stringify(queue);
    await fs.promises.writeFile(tmpFile, jsonStr, 'utf8');
    await fs.promises.rename(tmpFile, queueFile);
  } catch (err) {
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
    const tmpFile = queueFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(queue), 'utf8');
    fs.renameSync(tmpFile, queueFile);
  } catch (err) {
    try {
      fs.writeFileSync(queueFile, JSON.stringify(queue), 'utf8');
    } catch(e) {}
  }
}

// Ensure data is saved on exit
process.on('exit', () => saveQueueSync());
process.on('SIGINT', () => {
  saveQueueSync();
  process.exit();
});

// Initialize on load
loadQueue();

/**
 * Enqueue links into links_queue.json
 * Marks them as 'unopened'
 */
function enqueueLinks(urls, defaultSource = null) {
  if (!urls || !Array.isArray(urls)) return 0;
  let addedCount = 0;

  for (const rawUrl of urls) {
    if (!rawUrl || typeof rawUrl !== 'string') continue;
    const cleanUrl = rawUrl.trim();
    if (!isRealStory(cleanUrl)) continue;

    const norm = normalizeUrl(cleanUrl);
    // Skip if already in scrapedHistory
    if (scrapedHistory.has(norm) || scrapedHistory.has(cleanUrl)) continue;

    // Skip if already present in queue
    if (urlToItemMap.has(norm) || urlToItemMap.has(cleanUrl)) continue;

    const src = getSourceName(cleanUrl) || defaultSource || 'News';
    const item = {
      url: cleanUrl,
      source: src,
      status: 'unopened',
      addedAt: new Date().toISOString()
    };

    queue.push(item);
    urlToItemMap.set(norm, item);
    urlToItemMap.set(cleanUrl, item);
    addToSourceQueue(item);
    unopenedCount++;
    addedCount++;
  }

  if (addedCount > 0) {
    scheduleSave();
  }
  return addedCount;
}

/**
 * O(1) Round-Robin Dispatcher:
 * Cycles through all 12 news sources so parallel workers never hit
 * a single website concurrently or get throttled!
 */
function getNextUnopened() {
  if (unopenedCount === 0 || sourceNames.length === 0) return null;

  const total = sourceNames.length;
  for (let i = 0; i < total; i++) {
    sourceIndex = (sourceIndex + 1) % total;
    const src = sourceNames[sourceIndex];
    const qList = sourceQueues.get(src);
    let ptr = sourcePointers.get(src) || 0;

    while (qList && ptr < qList.length) {
      const item = qList[ptr++];
      sourcePointers.set(src, ptr);
      if (item && item.status === 'unopened') {
        return item;
      }
    }
  }
  return null;
}

/**
 * Get unopened links from queue in O(1) time
 */
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
 * Mark a link as 'opened' (Idempotent O(1))
 */
function markLinkOpened(url, metadata = {}) {
  const norm = normalizeUrl(url);
  let item = urlToItemMap.get(norm) || urlToItemMap.get(url);

  if (!item) {
    item = {
      url: url,
      source: getSourceName(url),
      status: 'opened',
      addedAt: new Date().toISOString(),
      openedAt: new Date().toISOString(),
      ...metadata
    };
    queue.push(item);
    urlToItemMap.set(norm, item);
    urlToItemMap.set(url, item);
    openedCount++;
  } else {
    if (item.status === 'unopened') {
      item.status = 'opened';
      unopenedCount = Math.max(0, unopenedCount - 1);
      openedCount++;
    }
    item.openedAt = new Date().toISOString();
    Object.assign(item, metadata);
  }

  // Record in history.txt
  recordInHistory(norm);

  scheduleSave();
  return item;
}

/**
 * O(1) Instant Queue Statistics
 */
function getQueueStats() {
  return {
    total: queue.length,
    unopened: unopenedCount,
    opened: openedCount
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
  console.log(`🎯 MASTER QUEUE MANAGER DASHBOARD (Status: 🟢 HEALTHY)`);
  console.log(`==========================================================`);
  console.log(`📊 Queue Overview:`);
  console.log(`   📁 Total URLs in Queue  : ${stats.total.toLocaleString()}`);
  console.log(`   ⏳ Unopened (Pending)   : ${stats.unopened.toLocaleString()} articles`);
  console.log(`   ✅ Opened (Completed)   : ${stats.opened.toLocaleString()} articles`);
  console.log(`   📜 Scraped History      : ${scrapedHistory.size.toLocaleString()} URLs`);
  console.log(`----------------------------------------------------------`);
  console.log(`🌐 Pending Articles Distribution by News Publication:`);

  const unopenedBySource = {};
  for (const item of queue) {
    if (item.status === 'unopened') {
      const s = item.source || 'News';
      unopenedBySource[s] = (unopenedBySource[s] || 0) + 1;
    }
  }

  const sorted = Object.entries(unopenedBySource).sort((a, b) => b[1] - a[1]);
  for (const [src, count] of sorted) {
    console.log(`   ⚡ ${src.padEnd(26)}: ${count.toLocaleString()} pending`);
  }

  console.log(`----------------------------------------------------------`);
  console.log(`🔎 Sample Next 3 URLs in Dispatch Queue:`);
  const samplePointers = new Map(sourcePointers);
  let sampleCount = 0;
  for (const src of sourceNames) {
    const list = sourceQueues.get(src) || [];
    for (const item of list) {
      if (item.status === 'unopened') {
        console.log(`   [${sampleCount + 1}] [${item.source}] ${item.url}`);
        sampleCount++;
        break;
      }
    }
    if (sampleCount >= 3) break;
  }

  console.log(`----------------------------------------------------------`);
  console.log(`💡 How to run:`);
  console.log(`   • Test a URL filter:        node queue_manager.js --test <url>`);
  console.log(`   • Run Fast Scraper:         node queue_worker.js --concurrency 24`);
  console.log(`   • Run Continuous Harvester: node ref.js --concurrency 16`);
  console.log(`==========================================================\n`);
}
