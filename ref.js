const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');
const queueManager = require('./queue_manager');

// Ensure 'Data' directory exists
const dataDir = path.join(__dirname, 'Data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// High-Performance Reusable HTTPS Connection Pool
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 8000
});

// Throttled non-blocking preview writer
let lastLatestWrite = 0;
function updateLatestJson(data) {
  const now = Date.now();
  if (now - lastLatestWrite > 1000) {
    lastLatestWrite = now;
    fs.promises.writeFile(path.join(dataDir, 'latest.json'), JSON.stringify(data, null, 2), 'utf8').catch(() => {});
  }
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
    queueManager.recordInHistory(clean);
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
  'to continue, please click the box below',
  'etprime',
  'et prime',
  'unlock all',
  'login using your',
  'pdf version',
  'choose your reason below',
  'stock queries',
  'manage your money',
  'read your daily newspaper',
  'whatsapp channel',
  'for reprint rights',
  'exclusive story from new york times'
];

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

/**
 * 1. Universal Article Scraper
 * Extracts clean, ad-free article from ANY news website (including Bloomberg)!
 */
async function scrapeSingleArticle(articleUrl, targetFolder = null, force = false) {
  try {
    // 0. Instant History Check: Skip immediately if already in master history registry
    if (!force && (scrapedHistory.has(articleUrl) || scrapedHistory.has(normalizeUrl(articleUrl)))) {
      return { status: 'skipped', heading: 'Already in history registry', filename: '' };
    }

    const source = getSourceName(articleUrl);
    let heading = '';
    let category = '';
    let photo = '';
    let author = '';
    let date = '';
    let paragraphs = [];

    // Attempt web fetch with full browser emulation headers (6s timeout)
    let html = '';
    try {
      const res = await fetch(articleUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        html = await res.text();
      }
    } catch (e) {
      // Fast Fallback with pooled agent & maxHeaderSize (e.g. Yahoo Finance oversized headers)
      try {
        html = await new Promise((resolve) => {
          const req = https.get(articleUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html'
            },
            agent: httpsAgent,
            maxHeaderSize: 150000
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
          });
          req.setTimeout(6000, () => {
            req.destroy();
            resolve('');
          });
          req.on('error', () => resolve(''));
        });
      } catch(err2) {}
    }

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

      // 1. Primary for The Economic Times (.artText clean extraction)
      if (articleUrl.includes('economictimes')) {
        $('.artText').each((_, el) => {
          if (paragraphs.length > 0) return;
          const clone = $(el).clone();
          clone.find('script, style, noscript, .hidden, #sr_widget, #stock_pro, .clearfix, .report_error, div, .etprime_widget').remove();
          clone.find('br').replaceWith('\n');
          const lines = clone.text().split('\n')
            .map(s => s.replace(/\s+/g, ' ').trim())
            .filter(s => s.length > 45 && !ignorePhrases.some(ph => s.toLowerCase().includes(ph)));
          if (lines.length >= 2) paragraphs = lines;
        });
      }

      // 2. Primary for Times of India custom article containers
      if (paragraphs.length < 2 && (articleUrl.includes('timesofindia') || articleUrl.includes('indiatimes'))) {
        $('div._s30J, div.ihgno, div.article_content').each((_, el) => {
          if (paragraphs.length > 0) return;
          const clone = $(el).clone();
          clone.find('script, style, noscript, .hidden, div').remove();
          clone.find('br').replaceWith('\n');
          const lines = clone.text().split(/\n+|\.\s+(?=[A-Z])/)
            .map(s => s.replace(/\s+/g, ' ').trim())
            .filter(s => s.length > 45 && !ignorePhrases.some(ph => s.toLowerCase().includes(ph)));
          if (lines.length >= 2) paragraphs = lines;
        });
      }

      // 3. Primary for Yahoo Finance (div.caas-body, div.body)
      if (paragraphs.length < 2 && articleUrl.includes('yahoo.com')) {
        $('div.caas-body, div.body, article').find('p').each((_, el) => {
          const text = $(el).text().replace(/\s+/g, ' ').trim();
          if (text.length > 40 && !ignorePhrases.some(ph => text.toLowerCase().includes(ph))) {
            paragraphs.push(text);
          }
        });
      }

      // 4. Targeted Containers for Hindu, Express, HT, NDTV, BBC, Mint, etc.
      if (paragraphs.length < 2) {
        const container = $('div.articlebodycontent, div#pcl-full-content, div.story-details, div.storyDetails, div.story-body, div.ins_storybody, div.mainArea, article, main').first();
        const scope = container.length > 0 ? container : $('body');
        scope.find('p').each((_, el) => {
          const text = $(el).text().replace(/\s+/g, ' ').trim();
          const lower = text.toLowerCase();
          const shouldIgnore = ignorePhrases.some(phrase => lower.includes(phrase));
          if (text.length > 45 && !shouldIgnore) {
            paragraphs.push(text);
          }
        });
      }

      // 4. Secondary: Check JSON-LD articleBody if available
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
      }

      // 5. Fallback: Page-wide <p> tags
      if (paragraphs.length < 2) {
        $('p').each((_, el) => {
          const text = $(el).text().replace(/\s+/g, ' ').trim();
          const lower = text.toLowerCase();
          const shouldIgnore = ignorePhrases.some(phrase => lower.includes(phrase));
          if (text.length > 45 && !shouldIgnore) {
            paragraphs.push(text);
          }
        });
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
      const discoveredSet = new Set();

      // 1. High-Priority: Links inside Article Body and Related/Recommendation blocks
      const priorityContainers = $(
        'div.artText, div._s30J, div.story-details, div.storyDetails, div.articlebodycontent, ' +
        'div.ins_storybody, div.caas-body, div.article_wrapper, div.article_consum_wrapper, ' +
        'div.bigstory, div.storyBox, div.storyContent, div[class*="related"], div[class*="recommend"], ' +
        'div[class*="also-read"], div[class*="more-news"], div[class*="read-next"], article'
      );

      priorityContainers.find('a[href]').each((_, el) => {
        try {
          const rawHref = $(el).attr('href');
          if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) return;

          const absUrl = new URL(rawHref, articleUrl).href;
          const clean = normalizeUrl(absUrl);
          if (clean && isSameOrSupportedNetwork(clean, articleUrl) && isRealStory(clean)) {
            if (!scrapedHistory.has(clean) && !scrapedHistory.has(absUrl)) {
              discoveredSet.add(clean);
            }
          }
        } catch (e) {}
      });

      // 2. Secondary: Across page for any additional real story links
      $('a[href]').each((_, el) => {
        try {
          const rawHref = $(el).attr('href');
          if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) return;

          const absUrl = new URL(rawHref, articleUrl).href;
          const clean = normalizeUrl(absUrl);
          if (clean && isSameOrSupportedNetwork(clean, articleUrl) && isRealStory(clean)) {
            if (!scrapedHistory.has(clean) && !scrapedHistory.has(absUrl)) {
              discoveredSet.add(clean);
            }
          }
        } catch (e) {}
      });

      for (const link of discoveredSet) {
        discoveredLinks.push(link);
      }
    }

    // Clean up heading
    heading = heading.replace(/\s+/g, ' ')
      .replace(/\|\s*(Bloomberg|The Hindu|Indian Express|Hindustan Times|NDTV|India Today|BBC|Aaj Tak|LiveMint|Times of India).*$/i, '')
      .replace(/-\s*(Bloomberg|The Hindu|Indian Express|Hindustan Times|NDTV|India Today|BBC|Aaj Tak|LiveMint|Times of India).*$/i, '')
      .trim();

    if (!heading || heading.length < 5 || paragraphs.length === 0) return null;

    // Strict Financial Relevance Guard:
    // Drop murder, crime, rape, accidents, sports, and gossip that lack financial/economic context
    const headingLower = heading.toLowerCase();
    const categoryLower = (category || '').toLowerCase();
    const textSample = (heading + ' ' + paragraphs.slice(0, 3).join(' ')).toLowerCase();

    // 1. ABSOLUTE ZERO TOLERANCE: Any headline/category mentioning violence, crime, murder, sports or gossip is discarded!
    const strictlyForbiddenInTitle = [
      'murder', 'stabbed', 'knife', 'dead body', 'dead-body', 'dead bodies', 'rape', 'gangrape', 'gang-rape',
      'suicide', 'hanged', 'shot dead', 'bullets', 'pistol', 'encounter', 'terrorist', 'terrorists', 'kidnap',
      'kidnapped', 'lynched', 'bomber', 'bomb blast', 'accused of murder', 'convicted of rape',
      'cricket', 'wicket', 'batsman', 'bowler', 'ipl', 'test match', 'odi match', 'world cup winner',
      'fifa', 'football match', 'tennis', 'us open', 'wimbledon', 'badminton', 'hockey', 'olympics',
      'premier league', 'tournament', 'bollywood', 'hollywood', 'dating rumors', 'bikini', 'divorce',
      'box office', 'box-office', 'movie review', 'film review', 'actor', 'actress', 'star cast',
      'horoscope', 'astrology', 'zodiac', 'rashifal', 'kundali'
    ];

    if (strictlyForbiddenInTitle.some(w => headingLower.includes(w) || categoryLower.includes(w))) {
      return null; // Silently reject non-financial crime / sports / gossip content
    }

    // 2. Body sample check: If body mentions brutal crime/sports without solid financial indicators, reject!
    const crimeWords = ['murder', 'gang-rape', 'stabbed to death', 'dead body was found', 'hanged from', 'shot dead'];
    const solidFinancialKeywords = [
      'stock', 'market', 'share', 'shares', 'sensex', 'nifty', 'rupee', 'dollar', 'gdp',
      'inflation', 'rbi', 'fed', 'economy', 'economic', 'profit', 'revenue', 'loss', 'ipo',
      'banking', 'mutual fund', 'investment', 'investor', 'tax', 'gst', 'finance', 'financial',
      'wealth', 'sebi', 'trillion', 'billion', 'crore', 'lakh', 'tariffs', 'export', 'import',
      'corporate', 'earnings', 'merger', 'acquisition', 'dividend'
    ];

    if (crimeWords.some(w => textSample.includes(w)) && !solidFinancialKeywords.some(w => textSample.includes(w))) {
      return null;
    }

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

    // Fallback to URL pathname slug if heading has non-latin characters (e.g. Hindi / Aaj Tak)
    if (safeHeading.length < 3) {
      try {
        const urlObj = new URL(articleUrl);
        const parts = urlObj.pathname.split('/').filter(Boolean);
        const lastPart = parts[parts.length - 1] || parts[parts.length - 2] || '';
        safeHeading = lastPart
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 50);
      } catch(e) {}
    }
    if (!safeHeading || safeHeading.length < 2) {
      safeHeading = 'story_' + Math.abs(articleUrl.split('').reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a; }, 0)).toString(36);
    }

    const safeFilename = `${sourceSlug}_${safeHeading}`;

    // Canonical website slug and target directory hierarchy: Data/<News_Website>/<YYYY>/<MM>/<DD>.json
    const sourceCanonicalSlug = queueManager.getCanonicalSource(source, articleUrl);

    let articleDateObj = new Date();
    if (date) {
      const parsed = new Date(date);
      if (!isNaN(parsed.getTime())) articleDateObj = parsed;
    }
    const yearStr = String(articleDateObj.getFullYear());
    const monthStr = String(articleDateObj.getMonth() + 1).padStart(2, '0');
    const dayStr = String(articleDateObj.getDate()).padStart(2, '0');

    const dayDir = path.join(dataDir, sourceCanonicalSlug, yearStr, monthStr);
    if (!fs.existsSync(dayDir)) {
      fs.mkdirSync(dayDir, { recursive: true });
    }
    const jsonFilePath = path.join(dayDir, `${dayStr}.json`);

    // Read existing articles for today
    let dailyArticles = [];
    if (fs.existsSync(jsonFilePath)) {
      try {
        dailyArticles = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
        if (!Array.isArray(dailyArticles)) dailyArticles = [];
      } catch(e) {
        dailyArticles = [];
      }
    }

    // Deduplication check
    const alreadySaved = dailyArticles.some(a => a && a.url === articleUrl);
    if (alreadySaved) {
      recordInHistory(articleUrl);
      queueManager.markLinkOpened(articleUrl, { heading, source });
      if (discoveredLinks && discoveredLinks.length > 0) {
        queueManager.enqueueLinks(discoveredLinks, source);
      }
      return { status: 'skipped', heading, filename: `${sourceSlug}_${dayStr}`, discoveredLinks };
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

    dailyArticles.push(articleData);

    // Asynchronously save daily file without blocking the event loop
    await fs.promises.writeFile(jsonFilePath, JSON.stringify(dailyArticles, null, 2), 'utf8');

    // Throttled preview update
    updateLatestJson(articleData);

    // Record URL in master history registry
    recordInHistory(articleUrl);

    // Update persistent queue: mark opened & enqueue discovered suggestion links
    queueManager.markLinkOpened(articleUrl, { heading, source });
    let queuedNewCount = 0;
    if (discoveredLinks && discoveredLinks.length > 0) {
      queuedNewCount = queueManager.enqueueLinks(discoveredLinks, source);
    }

    return { status: 'saved', source, heading, category, photo, paragraphsCount: paragraphs.length, filename: safeFilename, discoveredLinks, queuedNewCount };
  } catch (err) {
    return null;
  }
}

/**
 * 2. MASTER FINANCIAL & BUSINESS NEWS REGISTRY
 * 100% Focused on Economy, Markets, Corporate, Finance & Technology
 */
const NEWS_SOURCES = [
  {
    name: 'The Economic Times',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://economictimes.indiatimes.com/rssfeedstopstories.cms', category: 'Top Business' },
      { url: 'https://economictimes.indiatimes.com/news/rssfeeds/1715249553.cms', category: 'Economy' },
      { url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', category: 'Markets' },
      { url: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms', category: 'Stocks' },
      { url: 'https://economictimes.indiatimes.com/markets/ipos/rssfeeds/10774780.cms', category: 'IPOs' },
      { url: 'https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms', category: 'Industry' },
      { url: 'https://economictimes.indiatimes.com/wealth/rssfeeds/837555174.cms', category: 'Wealth' },
      { url: 'https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms', category: 'Technology' }
    ]
  },
  {
    name: 'LiveMint',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://www.livemint.com/rss/markets', category: 'Markets' },
      { url: 'https://www.livemint.com/rss/companies', category: 'Companies' },
      { url: 'https://www.livemint.com/rss/money', category: 'Personal Finance' },
      { url: 'https://www.livemint.com/rss/industry', category: 'Industry' },
      { url: 'https://www.livemint.com/rss/economy', category: 'Economy' },
      { url: 'https://www.livemint.com/rss/technology', category: 'Technology' },
      { url: 'https://www.livemint.com/rss/budget', category: 'Budget' },
      { url: 'https://www.livemint.com/rss/mutual-funds', category: 'Mutual Funds' }
    ]
  },
  {
    name: 'Moneycontrol',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://www.moneycontrol.com/rss/MCtopnews.xml', category: 'Top Market News' },
      { url: 'https://www.moneycontrol.com/rss/business.xml', category: 'Business' },
      { url: 'https://www.moneycontrol.com/rss/economy.xml', category: 'Economy' },
      { url: 'https://www.moneycontrol.com/rss/marketreports.xml', category: 'Market Reports' }
    ]
  },
  {
    name: 'Business Standard',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://www.business-standard.com/rss/home_page_top_stories.rss', category: 'Top Finance' },
      { url: 'https://www.business-standard.com/rss/markets-106.rss', category: 'Markets' },
      { url: 'https://www.business-standard.com/rss/companies-101.rss', category: 'Companies' },
      { url: 'https://www.business-standard.com/rss/economy-policy-102.rss', category: 'Economy' },
      { url: 'https://www.business-standard.com/rss/finance-103.rss', category: 'Banking & Finance' }
    ]
  },
  {
    name: 'Bloomberg News',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://feeds.bloomberg.com/markets/news.rss', category: 'Markets' },
      { url: 'https://feeds.bloomberg.com/technology/news.rss', category: 'Technology' },
      { url: 'https://feeds.bloomberg.com/wealth/news.rss', category: 'Wealth' },
      { url: 'https://feeds.bloomberg.com/economics/news.rss', category: 'Economics' },
      { url: 'https://feeds.bloomberg.com/industries/news.rss', category: 'Industries' },
      { url: 'https://feeds.bloomberg.com/crypto/news.rss', category: 'Crypto' },
      { url: 'https://feeds.bloomberg.com/businessweek/news.rss', category: 'Businessweek' }
    ]
  },
  {
    name: 'Yahoo Finance',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://finance.yahoo.com/news/rssindex', category: 'Markets' },
      { url: 'https://finance.yahoo.com/rss/topstories', category: 'Top Stories' },
      { url: 'https://finance.yahoo.com/news/rss/', category: 'Latest' }
    ]
  },
  {
    name: 'The Hindu',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://www.thehindu.com/business/feeder/default.rss', category: 'Business' }
    ]
  },
  {
    name: 'The Indian Express',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://indianexpress.com/section/business/feed/', category: 'Business' }
    ]
  },
  {
    name: 'Hindustan Times',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://www.hindustantimes.com/feeds/rss/business/rssfeed.xml', category: 'Business' }
    ]
  },
  {
    name: 'NDTV Profit',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://feeds.feedburner.com/ndtvprofit-latest', category: 'Business' }
    ]
  },
  {
    name: 'Times of India',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://timesofindia.indiatimes.com/rssfeeds/1898055.cms', category: 'Business' }
    ]
  },
  {
    name: 'BBC News',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'Business' }
    ]
  },

  {
    name: 'India Today',
    sitemaps: [],
    rssFeeds: [
      { url: 'https://www.indiatoday.in/rss/1206550', category: 'Business' }
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

        const pContainers = $(
          'div.artText, div._s30J, div.story-details, div.storyDetails, div.articlebodycontent, ' +
          'div.ins_storybody, div.caas-body, div[class*="related"], div[class*="recommend"], ' +
          'div[class*="also-read"], div[class*="more-news"], div[class*="read-next"], article'
        );

        pContainers.find('a[href]').each((_, el) => {
          try {
            const raw = $(el).attr('href');
            if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return;
            const abs = new URL(raw, vUrl).href.split('?')[0].split('#')[0];
            if (isSameOrSupportedNetwork(abs, vUrl)) {
              const normAbs = normalizeUrl(abs);
              if (isRealStory(abs) && !scrapedHistory.has(normAbs) && !scrapedHistory.has(abs)) {
                newDiscoveredSet.add(abs);
              }
            }
          } catch(e) {}
        });

        $('a[href]').each((_, el) => {
          try {
            const raw = $(el).attr('href');
            if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return;
            const abs = new URL(raw, vUrl).href.split('?')[0].split('#')[0];
            if (isSameOrSupportedNetwork(abs, vUrl)) {
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

  // Pure Producer: Enqueue all discovered articles into the persistent queue
  const newEnqueued = queueManager.enqueueLinks(unvisitedArticles);
  queueManager.saveQueueSync();
  const queueStats = queueManager.getQueueStats();

  console.log(`\n==========================================================`);
  console.log(`🎉 MULTI-SOURCE HARVEST COMPLETE!`);
  console.log(`   ✨ New Articles Enqueued : +${newEnqueued}`);
  console.log(`   📊 Queue Status          : ${queueStats.unopened} unopened | ${queueStats.opened} opened`);

  const harvestOnly = process.argv.includes('--harvest-only');
  if (harvestOnly) {
    console.log(`   💡 Harvest-only mode active. 'queue_worker.js' will download these articles into Data/!`);
    console.log(`==========================================================\n`);
    return;
  }

  console.log(`   🚀 Direct Download Mode Active: Starting parallel multi-source workers...`);
  console.log(`==========================================================\n`);

  let savedCount = 0;
  let skippedCount = visitedArticles.length;
  let currentIndex = 0;
  const savedBySource = {};
  const seenInRun = new Set(unvisitedArticles);
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

        // Recursive Spidering: Continuously enqueue newly discovered suggested links (Infinite mode)
        let spiderAdded = 0;
        if (result.discoveredLinks && result.discoveredLinks.length > 0) {
          for (const sugUrl of result.discoveredLinks) {
            const normSug = normalizeUrl(sugUrl);
            if (!scrapedHistory.has(normSug) && !scrapedHistory.has(sugUrl) && !seenInRun.has(sugUrl)) {
              seenInRun.add(sugUrl);
              unvisitedArticles.push(sugUrl);
              spiderDiscoveredCount++;
              spiderAdded++;
            }
          }
        }

        const spiderBadge = spiderAdded > 0 ? ` 🕸️ (+${spiderAdded} related)` : '';
        console.log(`${progress} ✅ [SAVED] [${result.source}] [${result.category}]: "${result.heading.slice(0, 36)}..." (${result.paragraphsCount} paras)${spiderBadge}`);
        savedCount++;
      }

      await sleep(50);
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  console.log(`\n==========================================================`);
  console.log(`🎉 MULTI-SOURCE CRAWL WAVE COMPLETE!`);
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
    console.log(`   ℹ️ No new articles found in this wave.`);
  }
  console.log(`==========================================================\n`);
}

// --------------------------------------------------------------------------
// Start Script
// Running 'node ref.js' automatically crawls ALL news websites continuously!
// --------------------------------------------------------------------------
if (require.main === module) {
  const target = process.argv[2];

  if (target && target.startsWith('http')) {
    console.log(`\n📌 Single article mode detected: ${target}`);
    scrapeSingleArticle(target, null, true).then(res => {
      if (res) console.log(`✅ Saved: ${res.filename}.json (${res.paragraphsCount} paras)`);
    });
  } else {
    // Parse CLI concurrency if provided, default to 16 parallel streaming workers
    let concurrency = 16;
    for (let i = 0; i < process.argv.length; i++) {
      if (process.argv[i] === '--concurrency' || process.argv[i] === '-c') {
        concurrency = parseInt(process.argv[i + 1], 10) || concurrency;
      }
    }

    // Master Continuous Infinite Crawler: Zero wait time between waves
    (async () => {
      let wave = 1;
      while (true) {
        console.log(`\n==========================================================`);
        console.log(`🌀 STARTING CONTINUOUS CRAWL WAVE #${wave}`);
        console.log(`==========================================================\n`);
        await crawlAllArticles(concurrency);
        console.log(`⚡ Wave #${wave} finished! Waiting 60s for financial publications to post fresh updates...\n`);
        await sleep(60000);
        wave++;
      }
    })();
  }
}

module.exports = {
  scrapeSingleArticle,
  discoverAllNewsSources,
  normalizeUrl,
  recordInHistory,
  isRealStory,
  getSourceName,
  isSameOrSupportedNetwork,
  dataDir
};