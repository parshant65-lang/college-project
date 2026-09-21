const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// Ensure 'Data' directory exists
const dataDir = path.join(__dirname, 'Data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Master History Registry: remembers all scraped URLs forever
// Even if local articles are deleted to save disk space!
const historyFile = path.join(__dirname, 'history.txt');
const scrapedHistory = new Set();

/**
 * Smart URL Normalizer: removes tracking parameters, query strings, hashes, and trailing slashes
 */
function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    u.search = '';
    let clean = u.href;
    if (clean.endsWith('/')) clean = clean.slice(0, -1);
    return clean;
  } catch (e) {
    return (rawUrl || '').trim();
  }
}

if (fs.existsSync(historyFile)) {
  const lines = fs.readFileSync(historyFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      scrapedHistory.add(normalizeUrl(trimmed));
      scrapedHistory.add(trimmed);
    }
  }
}

function recordInHistory(url) {
  const clean = normalizeUrl(url);
  if (!scrapedHistory.has(clean)) {
    scrapedHistory.add(clean);
    scrapedHistory.add(url);
    fs.appendFileSync(historyFile, clean + '\n');
  }
}

// In-memory RSS metadata cache (stores titles/descriptions for paywalled sites like Bloomberg)
const rssMetadataCache = new Map();

// Polite delay
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Filter out noise / non-news text
const ignorePhrases = [
  'subscribed with another email',
  'account subscription benefits',
  'terms & conditions',
  'comments have to be in english',
  'we have migrated to a new commenting platform',
  'advertisement',
  'subscribe now',
  'all rights reserved',
  'published -',
  'updated -',
  'also read',
  'click here to join',
  'sign in to continue',
  'download the app',
  'follow us on',
  'to continue, please click the box below'
];

/**
 * Exact story URL validator across all 10 major networks
 * Rejects non-news utilities, players, login pages, and ads
 */
function isRealStory(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    if (p.includes('/players/') || p.includes('/teams/') || p.includes('/scores/') || p.includes('/series/') || p.includes('/stats/')) return false;
    if (p.includes('/logout') || p.includes('/login') || p.includes('/about') || p.includes('/contact') || p.includes('/terms') || p.includes('/privacy') || p.includes('/ht-img/')) return false;

    if (p.endsWith('.html') && /-\d{8,}\.html$/.test(p)) return true; // Hindustan Times, LiveMint
    if (p.endsWith('.ece') && /article\d+\.ece$/.test(p)) return true; // The Hindu
    if (p.includes('/articleshow/') && p.endsWith('.cms')) return true; // Times of India
    if (p.includes('/story/') && /-\d{5,}/.test(p)) return true; // Aaj Tak & India Today
    if (/\/articles\/c[a-z0-9]+/i.test(p)) return true; // BBC News
    if (/\/news\/articles\/\d{4}-/i.test(p)) return true; // Bloomberg
    if (/\/article\/.*-\d{6,}\/?$/i.test(p)) return true; // Indian Express
    if (/-\d{7,}\/?$/i.test(p)) return true; // NDTV
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
    if (host.includes('bloomberg')) return 'Bloomberg News';
    if (host.includes('thehindu')) return 'The Hindu';
    if (host.includes('indianexpress')) return 'Indian Express';
    if (host.includes('hindustantimes')) return 'Hindustan Times';
    if (host.includes('ndtv')) return 'NDTV';
    if (host.includes('indiatoday')) return 'India Today';
    if (host.includes('bbc')) return 'BBC News';
    if (host.includes('livemint')) return 'LiveMint';
    if (host.includes('timesofindia') || host.includes('indiatimes')) return 'Times of India';
    if (host.includes('aajtak')) return 'Aaj Tak';
    return host.replace('www.', '').split('.')[0].toUpperCase();
  } catch (e) {
    return 'News';
  }
}

/**
 * 1. Universal Article Scraper
 * Extracts clean, ad-free article from ANY news website (including Bloomberg)!
 */
async function scrapeSingleArticle(articleUrl, targetFolder = null) {
  try {
    // 0. Instant History Check: Skip immediately if already in master history registry
    if (scrapedHistory.has(articleUrl)) {
      return { status: 'skipped', heading: 'Already in history registry', filename: '' };
    }

    const source = getSourceName(articleUrl);
    let heading = '';
    let category = '';
    let photo = '';
    let author = '';
    let date = '';
    let paragraphs = [];

    // Attempt web fetch with full browser emulation headers
    let html = '';
    try {
      const res = await fetch(articleUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
        }
      });
      if (res.ok) {
        html = await res.text();
      }
    } catch (e) {}

    // Check if we hit a genuine bot-block or empty HTML (e.g. Bloomberg 403 / captcha)
    const isBlocked = !html || html.length < 500 || html.includes('please click the box below') || html.includes('captcha-delivery');

    let $ = null;
    if (!isBlocked) {
      // Normal HTML extraction
      $ = cheerio.load(html);

      heading = $('meta[property="og:title"]').attr('content') || 
                $('h1').first().text().trim() || 
                $('title').text().trim();

      category = $('meta[property="article:section"]').attr('content') || 
                 $('meta[name="section"]').attr('content') || 
                 $('meta[property="og:section"]').attr('content') || 
                 $('.breadcrumb a, .breadcrumb-item').eq(1).text().trim() || '';

      photo = $('meta[property="og:image"]').attr('content') || 
              $('meta[name="twitter:image"]').attr('content') || 
              $('article img, figure img').first().attr('src') || '';

      author = $('meta[name="author"]').attr('content') || 
               $('.author-name, .byline, [rel="author"], .story-byline').first().text().trim() || '';

      date = $('meta[property="article:published_time"]').attr('content') || 
             $('time').first().text().trim() || '';

      // 1. Primary: Extract all genuine story <p> tags across the page
      $('p').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        const lower = text.toLowerCase();
        const shouldIgnore = ignorePhrases.some(phrase => lower.includes(phrase));

        if (text.length > 45 && !shouldIgnore) {
          paragraphs.push(text);
        }
      });

      // 2. Secondary: If <p> tags gave very few paras (common on Times of India / custom CMS), check JSON-LD
      if (paragraphs.length < 2) {
        $('script[type="application/ld+json"]').each((_, el) => {
          if (paragraphs.length >= 2) return;
          try {
            const data = JSON.parse($(el).text());
            const items = Array.isArray(data) ? data : [data];
            for (const it of items) {
              if (it.articleBody && typeof it.articleBody === 'string') {
                const split = it.articleBody.split(/\n+|\.\s+(?=[A-Z])/).map(s => s.trim()).filter(s => s.length > 45);
                if (split.length > paragraphs.length) paragraphs = split;
              }
            }
          } catch(e) {}
        });

        // 3. Check custom story containers (like TOI div._s30J, div.ihgno)
        if (paragraphs.length < 2) {
          const customDiv = $('div._s30J, div.ihgno, div.article_content, div.story-text');
          if (customDiv.length > 0) {
            const text = customDiv.text().replace(/\s+/g, ' ').trim();
            const split = text.split(/\.\s+(?=[A-Z])/).map(s => s.trim() + '.').filter(s => s.length > 45 && !s.toLowerCase().includes('download the'));
            if (split.length > paragraphs.length) paragraphs = split;
          }
        }
      }
    }

    // Fallback: If blocked (e.g. Bloomberg 403 paywall) or no paras found, recover from RSS metadata cache!
    if (paragraphs.length === 0 && rssMetadataCache.has(articleUrl)) {
      const cached = rssMetadataCache.get(articleUrl);
      heading = cached.title || heading;
      category = cached.category || category;
      date = cached.date || date;
      author = `${source} Editorial`;
      if (cached.description) {
        paragraphs = [cached.description];
      }
      if (source === 'Bloomberg News') {
        photo = 'https://assets.bwbx.io/s3/javelin/public/hub/images/og-image-bloomberg.png';
      }
    }

    // In-page Related News & Suggestion Link Discovery (Web Spidering)
    const discoveredLinks = [];
    if (!isBlocked && $) {
      $('a[href]').each((_, el) => {
        try {
          const rawHref = $(el).attr('href');
          if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) return;

          const absUrl = new URL(rawHref, articleUrl).href.split('?')[0].split('#')[0];
          const host = new URL(absUrl).hostname.toLowerCase();
          const baseHost = new URL(articleUrl).hostname.toLowerCase();

          // Keep within the same news organization domain
          if (host.includes(baseHost.replace('www.', '')) || baseHost.includes(host.replace('www.', ''))) {
            const clean = normalizeUrl(absUrl);
            if (isRealStory(absUrl) && !scrapedHistory.has(clean) && !scrapedHistory.has(absUrl)) {
              discoveredLinks.push(absUrl);
            }
          }
        } catch (e) {}
      });
    }

    // Clean up heading
    heading = heading.replace(/\s+/g, ' ')
      .replace(/\|\s*(Bloomberg|The Hindu|Indian Express|Hindustan Times|NDTV|India Today|BBC|Aaj Tak|LiveMint|Times of India).*$/i, '')
      .replace(/-\s*(Bloomberg|The Hindu|Indian Express|Hindustan Times|NDTV|India Today|BBC|Aaj Tak|LiveMint|Times of India).*$/i, '')
      .trim();

    if (!heading || heading.length < 5 || paragraphs.length === 0) return null;

    // Fallback category from URL pathname
    if (!category) {
      try {
        const parts = new URL(articleUrl).pathname.split('/').filter(Boolean);
        if (parts.length > 0) {
          let seg = parts[0];
          if ((seg === 'news' || seg === 'article' || seg === 'section') && parts[1]) seg = parts[1];
          category = seg.charAt(0).toUpperCase() + seg.slice(1).replace(/[-_]/g, ' ');
        }
      } catch (e) {}
    }
    if (!category || category.length > 30) category = 'General';

    if (photo && photo.startsWith('//')) photo = 'https:' + photo;

    // Generate filename with source prefix
    const sourceSlug = source.toLowerCase().replace(/[^a-z0-9]+/g, '');
    let safeHeading = heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 50);

    const safeFilename = `${sourceSlug}_${safeHeading}`;

    // Target save directory with Date & Time (e.g. Data/2026-09-22/Run_12-00AM/)
    let saveDir = targetFolder;
    if (!saveDir) {
      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const hours = now.getHours();
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const displayHours = String(hours % 12 || 12).padStart(2, '0');
      const timeStr = `Run_${displayHours}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}${ampm}`;
      saveDir = path.join(dataDir, dateStr, timeStr);
    }

    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }

    const jsonFilePath = path.join(saveDir, `${safeFilename}.json`);

    // If already downloaded previously, skip quickly!
    if (fs.existsSync(jsonFilePath)) {
      recordInHistory(articleUrl);
      return { status: 'skipped', heading, filename: safeFilename, discoveredLinks };
    }

    // Clean JSON Object
    const articleData = {
      source,
      url: articleUrl,
      heading,
      category,
      photo,
      author,
      date,
      totalParagraphs: paragraphs.length,
      paragraphs
    };

    fs.writeFileSync(jsonFilePath, JSON.stringify(articleData, null, 2));

    // Update latest.json for quick preview
    fs.writeFileSync(path.join(dataDir, 'latest.json'), JSON.stringify(articleData, null, 2));

    // Record URL in master history registry
    recordInHistory(articleUrl);

    return { status: 'saved', source, heading, category, photo, paragraphsCount: paragraphs.length, filename: safeFilename, discoveredLinks };
  } catch (err) {
    return null;
  }
}

/**
 * 2. MASTER MULTI-SOURCE REGISTRY
 * All Major Global & Indian News Networks
 */
const NEWS_SOURCES = [
  {
    name: 'Bloomberg News',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://feeds.bloomberg.com/markets/news.rss', category: 'Markets' },
      { url: 'https://feeds.bloomberg.com/technology/news.rss', category: 'Technology' },
      { url: 'https://feeds.bloomberg.com/politics/news.rss', category: 'Politics' },
      { url: 'https://feeds.bloomberg.com/wealth/news.rss', category: 'Wealth' },
      { url: 'https://feeds.bloomberg.com/economics/news.rss', category: 'Economics' },
      { url: 'https://feeds.bloomberg.com/industries/news.rss', category: 'Industries' },
      { url: 'https://feeds.bloomberg.com/crypto/news.rss', category: 'Crypto' },
      { url: 'https://feeds.bloomberg.com/businessweek/news.rss', category: 'Businessweek' }
    ]
  },
  {
    name: 'The Hindu',
    sitemaps: [
      'https://www.thehindu.com/sitemap/googlenews/all/all.xml',
      'https://www.thehindu.com/sitemap/update/all.xml'
    ],
    rssFeeds: [
      { url: 'https://www.thehindu.com/feeder/default.rss', category: 'Top News' },
      { url: 'https://www.thehindu.com/news/national/feeder/default.rss', category: 'National' },
      { url: 'https://www.thehindu.com/business/feeder/default.rss', category: 'Business' },
      { url: 'https://www.thehindu.com/sport/feeder/default.rss', category: 'Sport' }
    ]
  },
  {
    name: 'The Indian Express',
    sitemaps: [
      'https://indianexpress.com/news-sitemap.xml'
    ],
    rssFeeds: [
      { url: 'https://indianexpress.com/feed/', category: 'National' }
    ]
  },
  {
    name: 'Hindustan Times',
    sitemaps: [
      'https://www.hindustantimes.com/sitemap/news.xml'
    ],
    rssFeeds: [
      { url: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml', category: 'National' },
      { url: 'https://www.hindustantimes.com/feeds/rss/business/rssfeed.xml', category: 'Business' },
      { url: 'https://www.hindustantimes.com/feeds/rss/sports/rssfeed.xml', category: 'Sports' }
    ]
  },
  {
    name: 'NDTV News',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://feeds.feedburner.com/ndtvnews-top-stories', category: 'Top Stories' },
      { url: 'https://feeds.feedburner.com/ndtvnews-latest', category: 'Latest' },
      { url: 'https://feeds.feedburner.com/ndtvnews-india-news', category: 'National' },
      { url: 'https://feeds.feedburner.com/ndtvnews-world-news', category: 'World' },
      { url: 'https://feeds.feedburner.com/ndtvprofit-latest', category: 'Business' },
      { url: 'https://feeds.feedburner.com/ndtvsports-cricket', category: 'Sports' }
    ]
  },
  {
    name: 'India Today',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://www.indiatoday.in/rss/home', category: 'Top News' },
      { url: 'https://www.indiatoday.in/rss/1206584', category: 'National' },
      { url: 'https://www.indiatoday.in/rss/1206577', category: 'World' },
      { url: 'https://www.indiatoday.in/rss/1206550', category: 'Business' }
    ]
  },
  {
    name: 'BBC News',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://feeds.bbci.co.uk/news/rss.xml', category: 'World' },
      { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'World' },
      { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'Business' }
    ]
  },
  {
    name: 'LiveMint',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://www.livemint.com/rss/news', category: 'Latest' },
      { url: 'https://www.livemint.com/rss/markets', category: 'Markets' },
      { url: 'https://www.livemint.com/rss/companies', category: 'Companies' }
    ]
  },
  {
    name: 'Times of India',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', category: 'Top Stories' },
      { url: 'https://timesofindia.indiatimes.com/rssfeeds/1898055.cms', category: 'Business' }
    ]
  },
  {
    name: 'Aaj Tak',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://www.aajtak.in/rssfeeds/?id=home', category: 'Top News' },
      { url: 'https://www.aajtak.in/rssfeeds/?id=national', category: 'National' },
      { url: 'https://www.aajtak.in/rssfeeds/?id=business', category: 'Business' }
    ]
  }
];

/**
 * 3. Master Multi-Source Parallel Discovery
 * Scans ALL configured news websites simultaneously in parallel!
 */
async function discoverAllNewsSources() {
  console.log(`\n==========================================================`);
  console.log(`🌐  UNIVERSAL AUTOMATED MULTI-SOURCE ENGINE`);
  console.log(`📡  Scanning ${NEWS_SOURCES.length} major news networks simultaneously in parallel...`);
  console.log(`==========================================================`);

  const allArticles = new Set();
  const sourceStats = {};

  // Scan all sources in parallel!
  await Promise.all(NEWS_SOURCES.map(async (src) => {
    let srcCount = 0;

    // A. Sitemaps in parallel
    const smPromises = (src.sitemaps || []).map(async (smUrl) => {
      try {
        const res = await fetch(smUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' }
        });
        if (!res.ok) return;

        const xml = await res.text();
        const locMatches = xml.match(/<loc>(.*?)<\/loc>/gi) || [];

        for (const locTag of locMatches) {
          const cleanUrl = locTag.replace(/<\/?loc>/gi, '').trim().split('?')[0].split('#')[0];
          if (cleanUrl.startsWith('http') && (cleanUrl.includes('/article') || cleanUrl.includes('.ece') || cleanUrl.includes('.html') || cleanUrl.match(/\/\d{5,}/))) {
            allArticles.add(cleanUrl);
            srcCount++;
          }
        }
      } catch (e) {}
    });

    // B. RSS Feeds in parallel
    const rssPromises = (src.rssFeeds || []).map(async (feed) => {
      try {
        const res = await fetch(feed.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (!res.ok) return;

        const xml = await res.text();
        const $ = cheerio.load(xml, { xmlMode: true });

        $('item').each((_, el) => {
          let link = $(el).find('link').text().trim().split('?')[0].split('#')[0];
          const title = $(el).find('title').text().trim();
          const description = $(el).find('description').text().replace(/<[^>]+>/g, '').trim();
          const pubDate = $(el).find('pubDate').text().trim();

          if (link.startsWith('http')) {
            rssMetadataCache.set(link, {
              title,
              description,
              date: pubDate,
              category: feed.category || '',
              source: src.name
            });

            allArticles.add(link);
            srcCount++;
          }
        });
      } catch (e) {}
    });

    await Promise.all([...smPromises, ...rssPromises]);
    sourceStats[src.name] = srcCount;
    console.log(`   ⚡ [CONNECTED] ${src.name.padEnd(20)}: ${srcCount} articles found`);
  }));

  const articlesArray = Array.from(allArticles);

  // Round-robin interleave across sources so workers scrape all websites simultaneously!
  const sourceQueues = {};
  for (const url of articlesArray) {
    const sName = getSourceName(url);
    if (!sourceQueues[sName]) sourceQueues[sName] = [];
    sourceQueues[sName].push(url);
  }

  const interleavedArticles = [];
  let hasMore = true;
  let round = 0;
  while (hasMore) {
    hasMore = false;
    for (const sName of Object.keys(sourceQueues)) {
      if (round < sourceQueues[sName].length) {
        interleavedArticles.push(sourceQueues[sName][round]);
        hasMore = true;
      }
    }
    round++;
  }

  return interleavedArticles;
}

/**
 * 4. Master Parallel Crawler Engine
 */
async function crawlAllArticles(concurrency = 8) {
  const articleLinks = await discoverAllNewsSources();
  const total = articleLinks.length;

  // Session run folder with Date and Time: e.g. Data/2026-09-22/Run_12-05-59AM/
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateFolder = `${year}-${month}-${day}`;

  const hours = now.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = String(hours % 12 || 12).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const timeFolder = `Run_${displayHours}-${minutes}-${seconds}${ampm}`;

  const sessionDir = path.join(dataDir, dateFolder, timeFolder);

  // 1. Separate discovered seeds into unvisited vs already cached
  let unvisitedArticles = [];
  const visitedArticles = [];

  for (const url of articleLinks) {
    const norm = normalizeUrl(url);
    if (scrapedHistory.has(norm) || scrapedHistory.has(url)) {
      visitedArticles.push(url);
    } else {
      unvisitedArticles.push(url);
    }
  }

  console.log(`\n==========================================================`);
  console.log(`🎯 TOTAL SEEDS SCANNED   : ${total}`);
  console.log(`⏩ ALREADY IN HISTORY   : ${visitedArticles.length} (Skipping redundant downloads)`);
  console.log(`✨ NEW UN-SCRAPED SEEDS : ${unvisitedArticles.length}`);
  console.log(`⏰ Run Session Folder   : Data/${dateFolder}/${timeFolder}/`);
  console.log(`⚡ Concurrency          : ${concurrency} parallel multi-source workers`);

  // 2. SMART SPIDER AUTO-ACTIVATION:
  // If new seeds are few (< 40), the spider automatically dives into existing articles to find un-downloaded stories!
  if (unvisitedArticles.length < 40 && visitedArticles.length > 0) {
    console.log(`\n🕸️  SMART DEEP SPIDER ACTIVATED!`);
    console.log(`   (Seeds already exist in history; deep-scanning existing articles for related stories...)`);

    // Pick 80 diverse articles from history
    const shuffledVisited = [...visitedArticles].sort(() => 0.5 - Math.random()).slice(0, 80);
    const newDiscoveredSet = new Set();

    await Promise.all(shuffledVisited.map(async (vUrl) => {
      try {
        const res = await fetch(vUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) return;
        const html = await res.text();
        const $ = cheerio.load(html);
        const host = new URL(vUrl).hostname.toLowerCase();

        $('a[href]').each((_, el) => {
          try {
            const raw = $(el).attr('href');
            if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return;
            const abs = new URL(raw, vUrl).href.split('?')[0].split('#')[0];
            const absHost = new URL(abs).hostname.toLowerCase();
            if (absHost.includes(host.replace('www.', '')) || host.includes(absHost.replace('www.', ''))) {
              const normAbs = normalizeUrl(abs);
              if (isRealStory(abs) && !scrapedHistory.has(normAbs) && !scrapedHistory.has(abs)) {
                newDiscoveredSet.add(abs);
              }
            }
          } catch(e) {}
        });
      } catch(e) {}
    }));

    console.log(`   ✨ Deep Spider Discovered: +${newDiscoveredSet.size} BRAND NEW un-downloaded articles!`);
    for (const dUrl of newDiscoveredSet) {
      unvisitedArticles.push(dUrl);
    }
  }

  console.log(`🚀 Starting download of ${unvisitedArticles.length} NEW articles...`);
  console.log(`==========================================================\n`);

  let savedCount = 0;
  let skippedCount = visitedArticles.length;
  let currentIndex = 0;
  const savedBySource = {};
  const seenInRun = new Set(unvisitedArticles);
  const MAX_SPIDER_DISCOVERIES = 600;
  let spiderDiscoveredCount = 0;

  // Parallel Worker pool
  async function worker(workerId) {
    while (currentIndex < unvisitedArticles.length) {
      const index = currentIndex++;
      const url = unvisitedArticles[index];
      const progress = `[${index + 1}/${unvisitedArticles.length}] (${Math.round(((index + 1) / unvisitedArticles.length) * 100)}%)`;

      const result = await scrapeSingleArticle(url, sessionDir);
      if (!result) {
        console.log(`${progress} ⚠️ [NOT SAVED] Returned null for: ${url.slice(0, 60)}`);
      } else if (result.status === 'skipped') {
        console.log(`${progress} ⏩ [SKIPPED] ${url.slice(0, 60)}`);
        skippedCount++;
      } else {
          savedBySource[result.source] = (savedBySource[result.source] || 0) + 1;

          // Recursive Spidering: Enqueue newly discovered suggested links from the page
          let spiderAdded = 0;
          if (result.discoveredLinks && result.discoveredLinks.length > 0 && spiderDiscoveredCount < MAX_SPIDER_DISCOVERIES) {
            for (const sugUrl of result.discoveredLinks) {
              const normSug = normalizeUrl(sugUrl);
              if (!scrapedHistory.has(normSug) && !scrapedHistory.has(sugUrl) && !seenInRun.has(sugUrl)) {
                seenInRun.add(sugUrl);
                unvisitedArticles.push(sugUrl);
                spiderDiscoveredCount++;
                spiderAdded++;
                if (spiderDiscoveredCount >= MAX_SPIDER_DISCOVERIES) break;
              }
            }
          }

          const spiderBadge = spiderAdded > 0 ? ` 🕸️ (+${spiderAdded} related)` : '';
          console.log(`${progress} ✅ [SAVED] [${result.source}] [${result.category}]: "${result.heading.slice(0, 36)}..." (${result.paragraphsCount} paras)${spiderBadge}`);
          savedCount++;
        }

        await sleep(100);
      }
    }

    const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
    await Promise.all(workers);

  console.log(`\n==========================================================`);
  console.log(`🎉 MULTI-SOURCE CRAWL COMPLETE!`);
  console.log(`   ✅ Newly Downloaded & Saved : ${savedCount}`);
  console.log(`   ⏩ Already Downloaded       : ${skippedCount}`);
  console.log(`   🕸️  Spider Deep Discoveries : ${spiderDiscoveredCount} related articles`);
  if (savedCount > 0) {
    console.log(`   📂 Saved In This Run Folder : Data/${dateFolder}/${timeFolder}/`);
    console.log(`\n📊 Breakdown of Newly Saved Articles by Website:`);
    for (const [srcName, count] of Object.entries(savedBySource)) {
      console.log(`      * ${srcName.padEnd(20)}: ${count} articles`);
    }
  } else {
    console.log(`   ℹ️ No new articles found even after deep crawling.`);
  }
  console.log(`==========================================================\n`);
}

// --------------------------------------------------------------------------
// Start Script
// Running 'node ref.js' automatically crawls ALL news websites together!
// --------------------------------------------------------------------------
const target = process.argv[2];

if (target && target.startsWith('http')) {
  console.log(`\n📌 Single article mode detected: ${target}`);
  scrapeSingleArticle(target).then(res => {
    if (res) console.log(`✅ Saved: ${res.filename}.json`);
  });
} else {
  // Master automatic run: All websites work together simultaneously!
  crawlAllArticles(8);
}