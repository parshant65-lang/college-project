const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const cheerio = require('cheerio');
const YahooFinance = require('yahoo-finance2').default;

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory cache for aggregated company news (5 minute TTL)
const newsCache = new Map();
const NEWS_CACHE_TTL_MS = 5 * 60 * 1000;

// Helper to calculate start date for chart periods
function getPeriod1(range) {
  const now = new Date();
  switch (range) {
    case '1d':
      now.setDate(now.getDate() - 2);
      break;
    case '5d':
      now.setDate(now.getDate() - 7);
      break;
    case '1mo':
      now.setMonth(now.getMonth() - 1);
      break;
    case '3mo':
      now.setMonth(now.getMonth() - 3);
      break;
    case '6mo':
      now.setMonth(now.getMonth() - 6);
      break;
    case '5y':
      now.setFullYear(now.getFullYear() - 5);
      break;
    case '1y':
    default:
      now.setFullYear(now.getFullYear() - 1);
      break;
  }
  return now.toISOString().split('T')[0];
}

// Scrape and extract full article content from Yahoo Finance URL
function fetchFullArticle(articleUrl) {
  return new Promise((resolve, reject) => {
    function get(targetUrl, redirects = 0) {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      
      let parsedUrl;
      try {
        parsedUrl = new URL(targetUrl);
      } catch (e) {
        return reject(new Error('Invalid URL'));
      }

      const client = parsedUrl.protocol === 'https:' ? https : http;
      
      const req = client.get(targetUrl, {
        maxHeaderSize: 128 * 1024,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, targetUrl).href;
          return get(nextUrl, redirects + 1);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Source returned status ${res.statusCode}`));
        }

        let html = '';
        res.on('data', chunk => html += chunk);
        res.on('end', () => {
          try {
            const $ = cheerio.load(html);
            
            // Clean extraction of headline
            let title = $('meta[property="og:title"]').attr('content') || '';
            if (!title) {
              $('h1').each((_, el) => {
                const t = $(el).text().trim();
                if (t && t !== 'Yahoo Finance') {
                  title = t;
                  return false;
                }
              });
            }
            if (!title) title = $('title').text().replace('- Yahoo Finance', '').trim();

            const author = $('.caas-author-byline, [data-component="author"], .byline-attr-author, .author').first().text().trim() || 'Market Analyst';
            const publishTime = $('time').first().attr('datetime') || $('time').first().text().trim() || $('meta[property="article:published_time"]').attr('content') || '';
            const publisher = $('meta[name="twitter:site"]').attr('content') || $('meta[property="og:site_name"]').attr('content') || 'Yahoo Finance';
            const image = $('meta[property="og:image"]').attr('content') || $('.caas-img-container img, article img').first().attr('src') || '';
            
            const paragraphs = [];
            $('.caas-body p, article p, .article-body p, p').each((_, el) => {
              const text = $(el).text().trim();
              if (
                text &&
                text.length > 35 &&
                !text.startsWith('Skip to') &&
                !text.includes('ADVERTISEMENT') &&
                !text.startsWith('Image Source:') &&
                !text.includes('Sign in to view your portfolio') &&
                !text.startsWith('© 202')
              ) {
                paragraphs.push(text);
              }
            });

            resolve({
              title,
              author,
              publishTime,
              publisher,
              image,
              paragraphs: paragraphs.length > 0 ? paragraphs : ['Full article content could not be rendered automatically. Please check original publication.']
            });
          } catch (parseError) {
            reject(parseError);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(12000, () => {
        req.destroy();
        reject(new Error('Article fetch timed out'));
      });
    }

    get(articleUrl);
  });
}

// Fetch RSS feed news from Yahoo Finance
function fetchRssNews(symbol) {
  return new Promise(resolve => {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
    https.get(url, {
      maxHeaderSize: 128 * 1024,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const items = [];
          const $ = cheerio.load(data, { xmlMode: true });
          $('item').each((_, el) => {
            const title = $(el).find('title').text().trim();
            const link = $(el).find('link').text().trim();
            const pubDate = $(el).find('pubDate').text().trim();
            if (title && link) {
              items.push({
                uuid: String(Math.random()),
                title,
                publisher: 'Yahoo Finance Feed',
                link,
                publishTime: pubDate ? new Date(pubDate).toISOString() : null,
                thumbnail: null
              });
            }
          });
          resolve(items);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

// Aggregates comprehensive news from multiple Yahoo Finance queries + RSS feed
async function getAggregatedNews(symbol, companyName = '') {
  const cacheKey = symbol.toUpperCase();
  const cached = newsCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < NEWS_CACHE_TTL_MS)) {
    return cached.articles;
  }

  const baseSymbol = symbol.split('.')[0];
  const cleanName = (companyName || '').replace(/Inc\.?|Ltd\.?|Corporation|Corp\.?|Limited/gi, '').trim();

  const queries = [
    yf.search(symbol, { newsCount: 25 }).catch(() => ({ news: [] })),
    yf.search(`${baseSymbol} stock`, { newsCount: 25 }).catch(() => ({ news: [] })),
    fetchRssNews(symbol),
    fetchRssNews(baseSymbol)
  ];

  if (baseSymbol !== symbol) {
    queries.push(yf.search(baseSymbol, { newsCount: 25 }).catch(() => ({ news: [] })));
  }

  if (cleanName && cleanName.length > 2) {
    queries.push(yf.search(`${cleanName} news`, { newsCount: 25 }).catch(() => ({ news: [] })));
    queries.push(yf.search(`${cleanName}`, { newsCount: 25 }).catch(() => ({ news: [] })));
  }

  const results = await Promise.allSettled(queries);
  const combinedRaw = [];

  results.forEach(res => {
    if (res.status === 'fulfilled') {
      if (Array.isArray(res.value)) {
        combinedRaw.push(...res.value);
      } else if (res.value && Array.isArray(res.value.news)) {
        combinedRaw.push(...res.value.news);
      }
    }
  });

  // De-duplicate news by normalized headline
  const uniqueArticles = [];
  const seenTitles = new Set();

  for (const item of combinedRaw) {
    if (!item.title || !item.link) continue;
    const norm = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm.length > 8 && !seenTitles.has(norm)) {
      seenTitles.add(norm);
      uniqueArticles.push({
        uuid: item.uuid || String(Math.random()),
        title: item.title,
        publisher: item.publisher || 'Yahoo Finance',
        link: item.link,
        publishTime: item.providerPublishTime || item.publishTime || null,
        thumbnail: item.thumbnail?.resolutions?.[0]?.url || item.thumbnail?.resolutions?.[1]?.url || null,
        relatedTickers: item.relatedTickers || []
      });
    }
  }

  // Sort by date (newest first)
  uniqueArticles.sort((a, b) => {
    const ta = a.publishTime ? new Date(a.publishTime).getTime() : 0;
    const tb = b.publishTime ? new Date(b.publishTime).getTime() : 0;
    return tb - ta;
  });

  newsCache.set(cacheKey, {
    articles: uniqueArticles,
    timestamp: Date.now()
  });

  return uniqueArticles;
}

// 1. Search endpoint: searches companies by name or ticker
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query || query.length < 1) {
    return res.json({ results: [] });
  }

  try {
    const searchResult = await yf.search(query, {
      quotesCount: 8,
      newsCount: 0
    });

    const results = (searchResult.quotes || [])
      .filter(q => q.symbol && (q.quoteType === 'EQUITY' || q.quoteType === 'ETF' || !q.quoteType))
      .map(q => ({
        symbol: q.symbol,
        name: q.shortname || q.longname || q.symbol,
        exchange: q.exchange || q.exchDisp || '',
        type: q.quoteType || 'EQUITY',
        score: q.score || 0
      }));

    res.json({ results });
  } catch (error) {
    console.error('Search API error:', error.message);
    res.status(500).json({ error: 'Failed to search ticker: ' + error.message });
  }
});

// 2. Infinite Scroll Paginated News endpoint
app.get('/api/news', async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  const name = (req.query.name || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, Math.min(30, parseInt(req.query.limit, 10) || 10));

  if (!symbol) {
    return res.status(400).json({ error: 'Symbol is required' });
  }

  try {
    const allArticles = await getAggregatedNews(symbol, name);
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedArticles = allArticles.slice(startIndex, endIndex);

    res.json({
      symbol,
      page,
      limit,
      totalArticles: allArticles.length,
      totalPages: Math.ceil(allArticles.length / limit),
      hasMore: endIndex < allArticles.length,
      articles: paginatedArticles
    });
  } catch (err) {
    console.error('News endpoint error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve news stream: ' + err.message });
  }
});

// 3. Fetch Full In-App Article Content
app.get('/api/article', async (req, res) => {
  const articleUrl = (req.query.url || '').trim();
  if (!articleUrl) {
    return res.status(400).json({ error: 'Article URL is required' });
  }

  try {
    const article = await fetchFullArticle(articleUrl);
    res.json(article);
  } catch (err) {
    console.error('Article fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch full article content: ' + err.message });
  }
});

// 4. Company Details & Comprehensive Fundamentals
app.get('/api/company/:symbol', async (req, res) => {
  const symbol = (req.params.symbol || '').trim().toUpperCase();
  const range = (req.query.range || '1y').toLowerCase();

  if (!symbol) {
    return res.status(400).json({ error: 'Symbol is required' });
  }

  try {
    const period1 = getPeriod1(range);
    const interval = range === '1d' ? '5m' : range === '5d' ? '15m' : range === '5y' ? '1wk' : '1d';

    const [summaryResult, chartResult] = await Promise.allSettled([
      yf.quoteSummary(symbol, {
        modules: [
          'assetProfile',
          'financialData',
          'defaultKeyStatistics',
          'summaryDetail',
          'price'
        ]
      }),
      yf.chart(symbol, { period1, interval })
    ]);

    if (summaryResult.status === 'rejected') {
      const fallbackQuote = await yf.quote(symbol).catch(() => null);
      if (!fallbackQuote) {
        return res.status(404).json({
          error: `Could not fetch company fundamentals for "${symbol}". Please check the ticker symbol.`
        });
      }
    }

    const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : {};
    const chart = chartResult.status === 'fulfilled' ? chartResult.value : null;

    const profile = summary.assetProfile || {};
    const financial = summary.financialData || {};
    const stats = summary.defaultKeyStatistics || {};
    const detail = summary.summaryDetail || {};
    const price = summary.price || {};

    // Transform historical chart data
    const historicalQuotes = (chart?.quotes || [])
      .filter(q => q.close !== null && q.close !== undefined)
      .map(q => ({
        date: q.date instanceof Date ? q.date.toISOString().split('T')[0] : String(q.date).split('T')[0],
        close: Number(q.close.toFixed(2)),
        open: q.open ? Number(q.open.toFixed(2)) : undefined,
        high: q.high ? Number(q.high.toFixed(2)) : undefined,
        low: q.low ? Number(q.low.toFixed(2)) : undefined,
        volume: q.volume || 0
      }));

    // Start prefetching / caching aggregated news for infinite scroll
    const companyDisplayName = price.longName || price.shortName || profile.name || symbol;
    const initialNewsList = await getAggregatedNews(symbol, companyDisplayName).catch(() => []);

    // Standardized fundamental payload
    const data = {
      symbol: price.symbol || symbol,
      name: companyDisplayName,
      currency: price.currency || detail.currency || 'USD',
      currencySymbol: price.currencySymbol || '$',
      exchange: price.exchangeName || price.exchange || detail.exchange || '',
      marketState: price.marketState || '',
      regularMarketPrice: price.regularMarketPrice ?? detail.regularMarketPrice ?? null,
      regularMarketChange: price.regularMarketChange ?? null,
      regularMarketChangePercent: price.regularMarketChangePercent ?? null,
      regularMarketDayHigh: price.regularMarketDayHigh ?? detail.dayHigh ?? null,
      regularMarketDayLow: price.regularMarketDayLow ?? detail.dayLow ?? null,
      regularMarketOpen: price.regularMarketOpen ?? detail.open ?? null,
      regularMarketPreviousClose: price.regularMarketPreviousClose ?? detail.previousClose ?? null,
      
      // Profile
      profile: {
        sector: profile.sector || 'N/A',
        industry: profile.industry || 'N/A',
        website: profile.website || '',
        city: profile.city || '',
        state: profile.state || '',
        country: profile.country || '',
        fullTimeEmployees: profile.fullTimeEmployees || null,
        longBusinessSummary: profile.longBusinessSummary || 'No company overview available.',
        executives: (profile.companyOfficers || []).slice(0, 6).map(o => ({
          name: o.name,
          title: o.title,
          totalPay: o.totalPay?.raw || o.totalPay || null
        }))
      },

      // Valuation & Key Ratios
      valuation: {
        marketCap: detail.marketCap || price.marketCap || null,
        enterpriseValue: stats.enterpriseValue || null,
        trailingPE: detail.trailingPE || stats.trailingPE || null,
        forwardPE: detail.forwardPE || stats.forwardPE || null,
        pegRatio: stats.pegRatio || null,
        priceToSalesTrailing12Months: detail.priceToSalesTrailing12Months || stats.priceToSalesTrailing12Months || null,
        priceToBook: detail.priceToBook || stats.priceToBook || null,
        enterpriseToRevenue: stats.enterpriseToRevenue || null,
        enterpriseToEbitda: stats.enterpriseToEbitda || null,
        bookValue: stats.bookValue || null,
        trailingEps: stats.trailingEps || null,
        forwardEps: stats.forwardEps || null
      },

      // Financials & Margins
      profitability: {
        totalRevenue: financial.totalRevenue || null,
        revenuePerShare: financial.revenuePerShare || null,
        revenueGrowth: financial.revenueGrowth || null,
        grossProfits: financial.grossProfits || null,
        grossMargins: financial.grossMargins || null,
        ebitda: financial.ebitda || null,
        ebitdaMargins: financial.ebitdaMargins || null,
        operatingMargins: financial.operatingMargins || null,
        profitMargins: financial.profitMargins || null,
        returnOnAssets: financial.returnOnAssets || null,
        returnOnEquity: financial.returnOnEquity || null,
        netIncomeToCommon: stats.netIncomeToCommon || null
      },

      // Balance Sheet & Cash Flow
      balanceSheet: {
        totalCash: financial.totalCash || null,
        totalCashPerShare: financial.totalCashPerShare || null,
        totalDebt: financial.totalDebt || null,
        debtToEquity: financial.debtToEquity || null,
        currentRatio: financial.currentRatio || null,
        quickRatio: financial.quickRatio || null,
        operatingCashflow: financial.operatingCashflow || null,
        freeCashflow: financial.freeCashflow || null
      },

      // Dividends
      dividends: {
        dividendRate: detail.dividendRate || stats.dividendRate || null,
        dividendYield: detail.dividendYield || stats.dividendYield || null,
        fiveYearAvgDividendYield: detail.fiveYearAvgDividendYield || null,
        payoutRatio: detail.payoutRatio || null,
        trailingAnnualDividendRate: detail.trailingAnnualDividendRate || null,
        trailingAnnualDividendYield: detail.trailingAnnualDividendYield || null
      },

      // Trading Statistics & Price Range
      tradingStats: {
        fiftyTwoWeekHigh: detail.fiftyTwoWeekHigh || stats.fiftyTwoWeekHigh || null,
        fiftyTwoWeekLow: detail.fiftyTwoWeekLow || stats.fiftyTwoWeekLow || null,
        fiftyDayAverage: detail.fiftyDayAverage || stats.fiftyDayAverage || null,
        twoHundredDayAverage: detail.twoHundredDayAverage || stats.twoHundredDayAverage || null,
        beta: stats.beta || detail.beta || null,
        sharesOutstanding: stats.sharesOutstanding || null,
        floatShares: stats.floatShares || null,
        averageVolume: detail.averageVolume || null,
        averageVolume10days: detail.averageVolume10days || null,
        regularMarketVolume: price.regularMarketVolume || detail.regularMarketVolume || null
      },

      // Historical Price Chart Data
      chartData: historicalQuotes,

      // Initial batch of news (page 1, 10 articles) + total available count
      news: initialNewsList.slice(0, 10),
      totalNewsAvailable: initialNewsList.length
    };

    res.json(data);
  } catch (error) {
    console.error('Company API error:', error.message);
    res.status(500).json({ error: 'Failed to retrieve company details: ' + error.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Financial Fundamental Website running at http://localhost:${PORT}`);
});
