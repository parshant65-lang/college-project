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

// Polite delay
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Filter out noise / non-news text
const ignorePhrases = [
  'subscribed with another email',
  'account subscription benefits',
  'the view from india',
  'first day first show',
  'today\'s cache',
  'science for all',
  'data point decoding',
  'health matters',
  'gender agenda',
  'the hindu on books',
  'terms & conditions',
  'comments have to be in english',
  'we have migrated to a new commenting platform',
  'advertisement',
  'subscribe now',
  'all rights reserved',
  'published -',
  'updated -'
];

/**
 * 1. Scrapes a single article & saves it to Data folder
 */
async function scrapeSingleArticle(articleUrl) {
  try {
    // 0. Instant History Check: Skip immediately if already in master history registry
    if (scrapedHistory.has(articleUrl)) {
      return { status: 'skipped', heading: 'Already in history registry', filename: '' };
    }

    const res = await fetch(articleUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!res.ok) return null;

    const html = await res.text();
    const $ = cheerio.load(html);

    // Heading
    let heading = $('meta[property="og:title"]').attr('content') || 
                  $('h1').first().text().trim() || 
                  $('title').text().trim();
    heading = heading.replace(/\s+/g, ' ').replace(/\|\s*The Hindu.*$/i, '').trim();

    if (!heading || heading.length < 5) return null;

    // Generate filename
    let safeFilename = heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60);

    // Determine Date Subfolder (e.g. Data/2026-09-21/)
    const today = new Date().toISOString().split('T')[0];
    const dateDir = path.join(dataDir, today);
    if (!fs.existsSync(dateDir)) {
      fs.mkdirSync(dateDir, { recursive: true });
    }

    const txtFilePath = path.join(dateDir, `${safeFilename}.txt`);
    const jsonFilePath = path.join(dateDir, `${safeFilename}.json`);

    // If already downloaded previously, skip quickly!
    if (fs.existsSync(txtFilePath) || fs.existsSync(path.join(dataDir, `${safeFilename}.txt`))) {
      recordInHistory(articleUrl);
      return { status: 'skipped', heading, filename: safeFilename };
    }

    // Photo
    let photo = $('meta[property="og:image"]').attr('content') || 
                $('meta[name="twitter:image"]').attr('content') || 
                $('.lead-img img, article img, figure img').first().attr('src') || '';
    if (photo && photo.startsWith('//')) photo = 'https:' + photo;

    // Author & Date
    const author = $('meta[name="author"]').attr('content') || 
                   $('.author-name, .byline, [rel="author"]').first().text().trim() || '';
    const date = $('meta[property="article:published_time"]').attr('content') || 
                 $('time').first().text().trim() || '';

    // Article Paragraphs
    const paragraphs = [];
    const bodyContainer = $('.articlebodycontent, [itemprop="articleBody"], .story-body, article');
    const targetElements = bodyContainer.length > 0 ? bodyContainer.find('p') : $('p');

    targetElements.each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      const lower = text.toLowerCase();
      const shouldIgnore = ignorePhrases.some(phrase => lower.includes(phrase));

      if (text.length > 50 && !shouldIgnore) {
        paragraphs.push(text);
      }
    });

    if (paragraphs.length === 0) return null;

    // Readable text content
    let readableText = `==========================================================\n`;
    readableText += `📰 HEADING:\n${heading}\n\n`;
    readableText += `📸 PHOTO URL:\n${photo}\n\n`;
    if (author) readableText += `✍️ AUTHOR: ${author}\n`;
    if (date) readableText += `📅 DATE: ${date}\n`;
    readableText += `🔗 URL: ${articleUrl}\n`;
    readableText += `==========================================================\n\n`;
    readableText += `📝 CLEAN ARTICLE BODY:\n\n`;
    readableText += paragraphs.join('\n\n');
    readableText += `\n\n==========================================================\n`;

    // Save files inside date-wise folder
    fs.writeFileSync(txtFilePath, readableText);
    fs.writeFileSync(jsonFilePath, JSON.stringify({
      url: articleUrl,
      heading,
      photo,
      author,
      date,
      totalParagraphs: paragraphs.length,
      paragraphs
    }, null, 2));

    // Update latest.txt in main Data folder
    fs.writeFileSync(path.join(dataDir, 'latest.txt'), readableText);

    // Record URL in master history registry
    recordInHistory(articleUrl);

    return { status: 'saved', heading, photo, paragraphsCount: paragraphs.length, filename: `${today}/${safeFilename}` };
  } catch (err) {
    return null;
  }
}

/**
 * 2. Master Sitemap, RSS & Section Scanner
 * Automatically checks Google News XML Sitemaps, Update Sitemaps,
 * Section Pages, and RSS feeds to discover 500+ to 1,000+ articles!
 */
async function discoverAllWebsiteArticles(baseUrl) {
  const origin = new URL(baseUrl).origin;
  console.log(`\n==========================================================`);
  console.log(`🗺️  MASTER SITEMAP & SECTION SCANNER`);
  console.log(`🎯 Target Domain: ${origin}`);
  console.log(`==========================================================`);

  const allArticles = new Set();

  // 1. High-Yield XML Sitemaps (Official Google News & Update feeds - 500+ articles each)
  const sitemaps = [
    `${origin}/sitemap/googlenews/all/all.xml`,
    `${origin}/sitemap/update/all.xml`,
    `${origin}/sitemap.xml`,
    `${origin}/news-sitemap.xml`
  ];

  console.log(`\n📡 PHASE 1: Scanning XML Sitemaps (Fast Bulk Discovery)...`);
  for (const sitemapUrl of sitemaps) {
    try {
      process.stdout.write(`   Scanning Sitemap: ${sitemapUrl} ... `);
      const res = await fetch(sitemapUrl, {
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
        }
      });

      if (!res.ok) {
        console.log(`skipped (${res.status})`);
        continue;
      }

      const xml = await res.text();
      // Match all <loc>...</loc> tags
      const locMatches = xml.match(/<loc>(.*?)<\/loc>/gi) || [];
      let addedFromThis = 0;

      for (const locTag of locMatches) {
        const cleanUrl = locTag.replace(/<\/?loc>/gi, '').trim().split('?')[0].split('#')[0];
        // Ensure it's a valid article URL
        if (cleanUrl.startsWith('http') && (cleanUrl.includes('/article') || cleanUrl.endsWith('.ece') || cleanUrl.match(/\/\d{6,}/))) {
          if (!allArticles.has(cleanUrl)) {
            allArticles.add(cleanUrl);
            addedFromThis++;
          }
        }
      }

      console.log(`✅ +${addedFromThis} articles found!`);
    } catch (err) {
      console.log(`failed`);
    }
  }

  // 2. Scan Standard Sections & RSS Feeds for any remaining or breaking news
  console.log(`\n📡 PHASE 2: Scanning Section Categories & RSS Feeds...`);
  const sections = [
    origin,
    `${origin}/news/national/`,
    `${origin}/news/international/`,
    `${origin}/business/`,
    `${origin}/sport/`,
    `${origin}/sci-tech/`,
    `${origin}/opinion/`,
    `${origin}/feeder/default.rss`,
    `${origin}/news/national/feeder/default.rss`,
    `${origin}/business/feeder/default.rss`,
    `${origin}/sport/feeder/default.rss`
  ];

  for (const targetUrl of sections) {
    try {
      process.stdout.write(`   Scanning: ${targetUrl} ... `);
      const res = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (!res.ok) {
        console.log(`skipped (${res.status})`);
        continue;
      }

      const content = await res.text();
      let beforeCount = allArticles.size;

      if (targetUrl.endsWith('.rss') || content.includes('<rss') || content.includes('<feed')) {
        // Parse RSS Feed
        const $ = cheerio.load(content, { xmlMode: true });
        $('item link, entry link').each((_, el) => {
          let link = ($(el).text() || $(el).attr('href') || '').trim().split('?')[0].split('#')[0];
          if (link.startsWith('http')) allArticles.add(link);
        });
      } else {
        // Parse HTML Page
        const $ = cheerio.load(content);
        $('a').each((_, el) => {
          let href = $(el).attr('href');
          if (href) {
            const isArticle = (href.includes('/article') || href.includes('/news/')) && 
                              (href.endsWith('.ece') || href.includes('/202'));
            if (isArticle) {
              if (!href.startsWith('http')) {
                href = origin + (href.startsWith('/') ? '' : '/') + href;
              }
              href = href.split('?')[0].split('#')[0];
              allArticles.add(href);
            }
          }
        });
      }

      let newFound = allArticles.size - beforeCount;
      console.log(`+${newFound} new articles (Running Total: ${allArticles.size})`);
    } catch (e) {
      console.log('failed');
    }
  }

  return Array.from(allArticles);
}

/**
 * 3. Master Multi-Threaded Crawler
 * Downloads ALL discovered articles without arbitrary limit!
 */
async function crawlAllArticles(baseUrl, concurrency = 5) {
  const articleLinks = await discoverAllWebsiteArticles(baseUrl);
  const total = articleLinks.length;

  console.log(`\n==========================================================`);
  console.log(`🎯 TOTAL UNIQUE ARTICLES DISCOVERED: ${total}`);
  console.log(`⚡ Concurrency: ${concurrency} parallel workers`);
  console.log(`🚀 Starting processing of ALL ${total} articles into "Data/" folder...`);
  console.log(`==========================================================\n`);

  let savedCount = 0;
  let skippedCount = 0;
  let currentIndex = 0;

  // Worker queue for fast parallel downloading
  async function worker(workerId) {
    while (currentIndex < articleLinks.length) {
      const index = currentIndex++;
      const url = articleLinks[index];
      const progress = `[${index + 1}/${total}] (${Math.round(((index + 1) / total) * 100)}%)`;

      // Instant history check: skip without making network request!
      if (scrapedHistory.has(url)) {
        console.log(`${progress} ⏩ Skipped (already in history.txt): ${url.slice(0, 50)}...`);
        skippedCount++;
        continue;
      }

      const result = await scrapeSingleArticle(url);
      if (result) {
        if (result.status === 'skipped') {
          console.log(`${progress} ⏩ Skipped (already exists): "${result.heading.slice(0, 48)}..."`);
          skippedCount++;
        } else {
          console.log(`${progress} ✅ [SAVED]: "${result.heading.slice(0, 48)}..." (${result.paragraphsCount} paras)`);
          savedCount++;
        }
      } else {
        console.log(`${progress} ⚠️ Skipped invalid: ${url.slice(0, 50)}...`);
      }

      // Small delay between requests to remain polite
      await sleep(200);
    }
  }

  // Launch parallel workers
  const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  console.log(`\n==========================================================`);
  console.log(`🎉 COMPLETE! ALL SITEMAP & WEBSITE ARTICLES PROCESSED!`);
  console.log(`   ✅ Newly Downloaded & Saved : ${savedCount}`);
  console.log(`   ⏩ Already Downloaded       : ${skippedCount}`);
  console.log(`   📁 Total Files in Data/     : ${fs.readdirSync(dataDir).length}`);
  console.log(`==========================================================\n`);
}

// --------------------------------------------------------------------------
// Start Script
// --------------------------------------------------------------------------
const target = process.argv[2] || 'https://www.thehindu.com/';

// If single article URL passed, download just that one
if (target.includes('/article') && target.endsWith('.ece')) {
  console.log(`\n📌 Single article mode detected: ${target}`);
  scrapeSingleArticle(target).then(res => {
    if (res) console.log(`✅ Saved: Data/${res.filename}.txt`);
  });
} else {
  // Crawl ALL articles via Sitemaps + Sections with 5 parallel workers
  crawlAllArticles(target, 5);
}