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

if (fs.existsSync(historyFile)) {
  const lines = fs.readFileSync(historyFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) scrapedHistory.add(trimmed);
  }
}

function recordInHistory(url) {
  if (!scrapedHistory.has(url)) {
    scrapedHistory.add(url);
    fs.appendFileSync(historyFile, url + '\n');
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
    if (host.includes('timesofindia')) return 'Times of India';
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

    // Check if we hit a bot-block / paywall (common on Bloomberg) or fetch failed
    const isBlocked = !html || html.includes('please click the box below') || html.includes('robot') || html.length < 500;

    if (!isBlocked) {
      // Normal HTML extraction
      const $ = cheerio.load(html);

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

      // Universal Body Paragraph Selectors across all sites
      const bodySelectors = [
        '.articlebodycontent',
        '#pcl-full-content',
        '.story-details',
        '.story__content',
        '#ins_storybody',
        '.detail',
        '.storyDetails',
        '.story__description',
        '.it-story-body',
        '[itemprop="articleBody"]',
        'main article',
        'article'
      ];

      let bodyContainer = null;
      for (const sel of bodySelectors) {
        const el = $(sel);
        if (el.length > 0 && el.find('p').length > 0) {
          bodyContainer = el;
          break;
        }
      }

      const targetElements = bodyContainer ? bodyContainer.find('p') : $('p');

      targetElements.each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        const lower = text.toLowerCase();
        const shouldIgnore = ignorePhrases.some(phrase => lower.includes(phrase));

        if (text.length > 50 && !shouldIgnore) {
          paragraphs.push(text);
        }
      });
    }

    // Fallback: If blocked (e.g. Bloomberg bot protection), recover from RSS metadata cache!
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

    // Clean up heading
    heading = heading.replace(/\s+/g, ' ')
      .replace(/\|\s*(Bloomberg|The Hindu|Indian Express|Hindustan Times|NDTV|India Today|BBC).*$/i, '')
      .replace(/-\s*(Bloomberg|The Hindu|Indian Express|Hindustan Times|NDTV|India Today|BBC).*$/i, '')
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
      return { status: 'skipped', heading, filename: safeFilename };
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

    return { status: 'saved', source, heading, category, photo, paragraphsCount: paragraphs.length, filename: safeFilename };
  } catch (err) {
    return null;
  }
}

/**
 * 2. MASTER MULTI-SOURCE REGISTRY
 * Configured with Bloomberg News + Top Indian and Global News Networks
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
  }
];

/**
 * 3. Master Multi-Source Discovery
 * Scans ALL configured news websites via Sitemaps and RSS feeds
 */
async function discoverAllNewsSources() {
  console.log(`\n==========================================================`);
  console.log(`🌐  UNIVERSAL MULTI-SOURCE NEWS SCANNER`);
  console.log(`📡  Scanning ${NEWS_SOURCES.length} major news networks simultaneously...`);
  console.log(`==========================================================`);

  const allArticles = new Set();

  for (const src of NEWS_SOURCES) {
    console.log(`\n🔍 Source: ${src.name}`);
    let srcCount = 0;

    // 1. Sitemaps
    for (const smUrl of src.sitemaps) {
      try {
        process.stdout.write(`   Scanning Sitemap: ${smUrl} ... `);
        const res = await fetch(smUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' }
        });
        if (!res.ok) {
          console.log(`skipped (${res.status})`);
          continue;
        }

        const xml = await res.text();
        const locMatches = xml.match(/<loc>(.*?)<\/loc>/gi) || [];
        let added = 0;

        for (const locTag of locMatches) {
          const cleanUrl = locTag.replace(/<\/?loc>/gi, '').trim().split('?')[0].split('#')[0];
          if (cleanUrl.startsWith('http') && (cleanUrl.includes('/article') || cleanUrl.includes('.ece') || cleanUrl.includes('.html') || cleanUrl.match(/\/\d{5,}/))) {
            if (!allArticles.has(cleanUrl)) {
              allArticles.add(cleanUrl);
              added++;
              srcCount++;
            }
          }
        }
        console.log(`✅ +${added} articles`);
      } catch (e) {
        console.log(`failed`);
      }
    }

    // 2. RSS Feeds (Includes Bloomberg News Feeds)
    for (const feed of src.rssFeeds) {
      try {
        process.stdout.write(`   Scanning RSS: ${feed.url} ... `);
        const res = await fetch(feed.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (!res.ok) {
          console.log(`skipped (${res.status})`);
          continue;
        }

        const xml = await res.text();
        const $ = cheerio.load(xml, { xmlMode: true });
        let added = 0;

        $('item').each((_, el) => {
          let link = $(el).find('link').text().trim().split('?')[0].split('#')[0];
          const title = $(el).find('title').text().trim();
          const description = $(el).find('description').text().replace(/<[^>]+>/g, '').trim();
          const pubDate = $(el).find('pubDate').text().trim();

          if (link.startsWith('http')) {
            // Cache rich metadata for Bloomberg and paywalled news
            rssMetadataCache.set(link, {
              title,
              description,
              date: pubDate,
              category: feed.category || '',
              source: src.name
            });

            if (!allArticles.has(link)) {
              allArticles.add(link);
              added++;
              srcCount++;
            }
          }
        });
        console.log(`✅ +${added} articles`);
      } catch (e) {
        console.log(`failed`);
      }
    }

    console.log(`   📊 ${src.name} Total Contributed: ${srcCount} articles`);
  }

  return Array.from(allArticles);
}

/**
 * 4. Master Parallel Crawler Engine
 */
async function crawlAllArticles(concurrency = 6) {
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

  console.log(`\n==========================================================`);
  console.log(`🎯 TOTAL ARTICLES DISCOVERED ACROSS ALL SOURCES: ${total}`);
  console.log(`⏰ Run Session Folder: Data/${dateFolder}/${timeFolder}/`);
  console.log(`⚡ Concurrency: ${concurrency} parallel workers`);
  console.log(`🚀 Starting multi-source download of ALL ${total} articles...`);
  console.log(`==========================================================\n`);

  let savedCount = 0;
  let skippedCount = 0;
  let currentIndex = 0;

  // Worker queue
  async function worker(workerId) {
    while (currentIndex < articleLinks.length) {
      const index = currentIndex++;
      const url = articleLinks[index];
      const progress = `[${index + 1}/${total}] (${Math.round(((index + 1) / total) * 100)}%)`;

      // Instant history check: skip without sending HTTP request!
      if (scrapedHistory.has(url)) {
        skippedCount++;
        continue;
      }

      const result = await scrapeSingleArticle(url, sessionDir);
      if (result) {
        if (result.status === 'skipped') {
          skippedCount++;
        } else {
          console.log(`${progress} ✅ [SAVED] [${result.source}] [${result.category}]: "${result.heading.slice(0, 38)}..." (${result.paragraphsCount} paras)`);
          savedCount++;
        }
      } else {
        // Not a standard article or video link
      }

      await sleep(150);
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  console.log(`\n==========================================================`);
  console.log(`🎉 MULTI-SOURCE CRAWL COMPLETE!`);
  console.log(`   ✅ Newly Downloaded & Saved : ${savedCount}`);
  console.log(`   ⏩ Already Downloaded       : ${skippedCount}`);
  if (savedCount > 0) {
    console.log(`   📂 Saved In This Run Folder : Data/${dateFolder}/${timeFolder}/`);
  } else {
    console.log(`   ℹ️ No new articles were published since the last run.`);
  }
  console.log(`==========================================================\n`);
}

// --------------------------------------------------------------------------
// Start Script
// --------------------------------------------------------------------------
const target = process.argv[2];

if (target && target.startsWith('http')) {
  console.log(`\n📌 Single article mode detected: ${target}`);
  scrapeSingleArticle(target).then(res => {
    if (res) console.log(`✅ Saved: ${res.filename}.json`);
  });
} else {
  // Crawl ALL configured news sources (Bloomberg News, The Hindu, Indian Express, Hindustan Times, NDTV, India Today, BBC)
  crawlAllArticles(6);
}