/**
 * FinScope - Financial Terminal Client Application
 * Powered by Yahoo Finance API with In-App Article Reader & Infinite Scroll News
 */

// Application State
let currentSymbol = 'AAPL';
let currentCompanyName = 'Apple Inc.';
let currentRange = '1y';
let stockChartInstance = null;
let searchDebounceTimer = null;
let currentCompanyData = null;

// Infinite Scroll News State
let newsPage = 1;
const newsLimit = 10;
let hasMoreNews = true;
let isLoadingMoreNews = false;
let totalNewsCount = 0;
const seenArticleTitles = new Set();
let infiniteObserver = null;

// DOM Elements
const searchInput = document.getElementById('companySearchInput');
const searchDropdown = document.getElementById('searchDropdown');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const searchSubmitBtn = document.getElementById('searchSubmitBtn');
const shortcutPills = document.querySelectorAll('.shortcut-pill');
const timeframeBtns = document.querySelectorAll('.tf-btn');
const navTabs = document.querySelectorAll('.nav-tab');
const tabPanes = document.querySelectorAll('.tab-pane');

const dashboardContent = document.getElementById('dashboardContent');
const loadingState = document.getElementById('loadingState');
const errorContainer = document.getElementById('errorContainer');
const errorTitle = document.getElementById('errorTitle');
const errorMessage = document.getElementById('errorMessage');

// News & Infinite Scroll DOM
const infiniteNewsGrid = document.getElementById('infiniteNewsGrid');
const fullNewsGrid = document.getElementById('newsGridFull');
const newsCounterText = document.getElementById('newsCounterText');
const infiniteScrollTrigger = document.getElementById('infiniteScrollTrigger');
const infiniteLoader = document.getElementById('infiniteLoader');
const infiniteEndMsg = document.getElementById('infiniteEndMsg');
const manualLoadMoreBtn = document.getElementById('manualLoadMoreBtn');
const newsCountBadge = document.getElementById('newsCountBadge');

// In-App Article Modal Elements
const articleModal = document.getElementById('articleModal');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalBottomCloseBtn = document.getElementById('modalBottomCloseBtn');
const modalLoader = document.getElementById('modalLoader');
const modalArticleContent = document.getElementById('modalArticleContent');
const modalPublisher = document.getElementById('modalPublisher');
const modalReadTime = document.getElementById('modalReadTime');
const modalPublishTime = document.getElementById('modalPublishTime');
const modalTitle = document.getElementById('modalTitle');
const modalAuthor = document.getElementById('modalAuthor');
const modalImg = document.getElementById('modalImg');
const modalImgWrap = document.getElementById('modalImgWrap');
const modalParagraphs = document.getElementById('modalParagraphs');
const modalExternalLink = document.getElementById('modalExternalLink');

// --------------------------------------------------------------------------
// Formatting Utilities
// --------------------------------------------------------------------------

function formatLargeNumber(val, currency = 'USD') {
  if (val === null || val === undefined || isNaN(val)) return 'N/A';
  const absVal = Math.abs(val);
  const sign = val < 0 ? '-' : '';

  if (currency === 'INR') {
    if (absVal >= 1e12) return `${sign}₹${(absVal / 1e12).toFixed(2)} Lakh Cr`;
    if (absVal >= 1e7) return `${sign}₹${(absVal / 1e7).toFixed(2)} Cr`;
    if (absVal >= 1e5) return `${sign}₹${(absVal / 1e5).toFixed(2)} Lakh`;
    return `${sign}₹${absVal.toLocaleString('en-IN')}`;
  }

  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '';
  if (absVal >= 1e12) return `${sign}${symbol}${(absVal / 1e12).toFixed(2)}T`;
  if (absVal >= 1e9) return `${sign}${symbol}${(absVal / 1e9).toFixed(2)}B`;
  if (absVal >= 1e6) return `${sign}${symbol}${(absVal / 1e6).toFixed(2)}M`;
  if (absVal >= 1e3) return `${sign}${symbol}${(absVal / 1e3).toFixed(2)}K`;
  return `${sign}${symbol}${absVal.toFixed(2)}`;
}

function formatCurrency(val, currency = 'USD', decimals = 2) {
  if (val === null || val === undefined || isNaN(val)) return 'N/A';
  const symbol = currency === 'INR' ? '₹' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
  return `${val < 0 ? '-' : ''}${symbol}${Math.abs(val).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })}`;
}

function formatPercent(val, multiplyBy100 = true) {
  if (val === null || val === undefined || isNaN(val)) return 'N/A';
  const num = multiplyBy100 ? val * 100 : val;
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(2)}%`;
}

function formatRatio(val, decimals = 2) {
  if (val === null || val === undefined || isNaN(val)) return 'N/A';
  return Number(val).toFixed(decimals);
}

function timeAgo(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);
  if (isNaN(seconds)) return '';
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// --------------------------------------------------------------------------
// UI View State Helpers
// --------------------------------------------------------------------------

function showLoading() {
  loadingState.classList.remove('hidden');
  dashboardContent.classList.add('hidden');
  errorContainer.classList.add('hidden');
}

function showDashboard() {
  loadingState.classList.add('hidden');
  dashboardContent.classList.remove('hidden');
  errorContainer.classList.add('hidden');
}

function showError(title, msg) {
  loadingState.classList.add('hidden');
  dashboardContent.classList.add('hidden');
  errorContainer.classList.remove('hidden');
  errorTitle.textContent = title;
  errorMessage.textContent = msg;
}

// --------------------------------------------------------------------------
// Fetch & Render Main Company Fundamentals
// --------------------------------------------------------------------------

async function loadCompany(symbol, range = currentRange) {
  if (!symbol) return;
  currentSymbol = symbol.toUpperCase();
  currentRange = range;
  showLoading();

  // Reset infinite scroll state for new company
  newsPage = 1;
  hasMoreNews = true;
  isLoadingMoreNews = false;
  seenArticleTitles.clear();
  if (infiniteNewsGrid) infiniteNewsGrid.innerHTML = '';
  if (fullNewsGrid) fullNewsGrid.innerHTML = '';
  if (infiniteLoader) infiniteLoader.classList.remove('hidden');
  if (infiniteEndMsg) infiniteEndMsg.classList.add('hidden');

  // Update active pill
  shortcutPills.forEach(pill => {
    if (pill.dataset.symbol.toUpperCase() === currentSymbol) {
      pill.classList.add('active');
    } else {
      pill.classList.remove('active');
    }
  });

  try {
    const response = await fetch(`/api/company/${encodeURIComponent(currentSymbol)}?range=${currentRange}`);
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Server responded with status ${response.status}`);
    }

    const data = await response.json();
    currentCompanyData = data;
    currentCompanyName = data.name || currentSymbol;
    totalNewsCount = data.totalNewsAvailable || (data.news || []).length;

    renderCompanyData(data);
    showDashboard();

    // Setup infinite scroll observer for continuous articles on scroll down
    setupInfiniteScrollObserver();
  } catch (err) {
    console.error('Failed to load company:', err);
    showError(
      `Could not load data for "${currentSymbol}"`,
      err.message || 'Please check your internet connection or try searching another company.'
    );
  }
}

function renderCompanyData(data) {
  const curr = data.currency || 'USD';
  const currSym = data.currency === 'INR' ? '₹' : data.currency === 'EUR' ? '€' : data.currency === 'GBP' ? '£' : '$';

  // 1. Identity & Live Quote Banner
  document.getElementById('companyName').textContent = data.name || data.symbol;
  document.getElementById('companyTicker').textContent = data.symbol;
  document.getElementById('companyExchange').textContent = data.exchange || 'EQUITY';
  document.getElementById('companySector').textContent = `Sector: ${data.profile.sector || 'N/A'}`;
  document.getElementById('companyIndustry').textContent = `Industry: ${data.profile.industry || 'N/A'}`;
  document.getElementById('companyCountry').textContent = `Country: ${data.profile.country || 'N/A'}`;
  document.getElementById('marketState').textContent = data.marketState || 'Market Active';

  document.getElementById('currencySymbol').textContent = currSym;
  document.getElementById('currencyCode').textContent = curr;
  document.getElementById('currentPrice').textContent = data.regularMarketPrice !== null 
    ? data.regularMarketPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '--';

  // Price change pill
  const changePill = document.getElementById('priceChangePill');
  const changeVal = data.regularMarketChange ?? 0;
  const changePct = data.regularMarketChangePercent ?? 0;
  const isPositive = changeVal >= 0;

  changePill.className = `price-chg-pill ${isPositive ? 'positive' : 'negative'}`;
  document.getElementById('priceChangeArrow').textContent = isPositive ? '▲' : '▼';
  document.getElementById('priceChangeVal').textContent = `${isPositive ? '+' : ''}${currSym}${Math.abs(changeVal).toFixed(2)}`;
  document.getElementById('priceChangePct').textContent = `(${isPositive ? '+' : ''}${changePct.toFixed(2)}%)`;

  // 2. Day Range & 52-Week Range Sliders
  const dayL = data.regularMarketDayLow;
  const dayH = data.regularMarketDayHigh;
  const low52 = data.tradingStats.fiftyTwoWeekLow;
  const high52 = data.tradingStats.fiftyTwoWeekHigh;
  const curPrice = data.regularMarketPrice;

  document.getElementById('dayLow').textContent = formatCurrency(dayL, curr);
  document.getElementById('dayHigh').textContent = formatCurrency(dayH, curr);
  document.getElementById('fiftyTwoWeekLow').textContent = formatCurrency(low52, curr);
  document.getElementById('fiftyTwoWeekHigh').textContent = formatCurrency(high52, curr);

  if (dayL && dayH && curPrice && dayH > dayL) {
    const dayPct = Math.min(Math.max(((curPrice - dayL) / (dayH - dayL)) * 100, 0), 100);
    document.getElementById('dayRangeBar').style.width = `${dayPct}%`;
  } else {
    document.getElementById('dayRangeBar').style.width = '50%';
  }

  if (low52 && high52 && curPrice && high52 > low52) {
    const range52Pct = Math.min(Math.max(((curPrice - low52) / (high52 - low52)) * 100, 0), 100);
    document.getElementById('fiftyTwoWeekBar').style.width = `${range52Pct}%`;
  } else {
    document.getElementById('fiftyTwoWeekBar').style.width = '50%';
  }

  // 3. Quick KPI Strip
  document.getElementById('kpiMarketCap').textContent = formatLargeNumber(data.valuation.marketCap, curr);
  document.getElementById('kpiPE').textContent = formatRatio(data.valuation.trailingPE);
  document.getElementById('kpiEPS').textContent = formatCurrency(data.valuation.trailingEps, curr);
  document.getElementById('kpiRevenue').textContent = formatLargeNumber(data.profitability.totalRevenue, curr);
  document.getElementById('kpiMargin').textContent = formatPercent(data.profitability.profitMargins);
  document.getElementById('kpiBeta').textContent = formatRatio(data.tradingStats.beta);

  // 4. Side Table (Summary Tab)
  document.getElementById('statPrevClose').textContent = formatCurrency(data.regularMarketPreviousClose, curr);
  document.getElementById('statOpen').textContent = formatCurrency(data.regularMarketOpen, curr);
  document.getElementById('statDayRange').textContent = `${formatCurrency(dayL, curr)} - ${formatCurrency(dayH, curr)}`;
  document.getElementById('stat52Range').textContent = `${formatCurrency(low52, curr)} - ${formatCurrency(high52, curr)}`;
  document.getElementById('statVolume').textContent = data.tradingStats.regularMarketVolume ? data.tradingStats.regularMarketVolume.toLocaleString() : 'N/A';
  document.getElementById('statAvgVolSide').textContent = data.tradingStats.averageVolume ? data.tradingStats.averageVolume.toLocaleString() : 'N/A';
  document.getElementById('statMarketCapSide').textContent = formatLargeNumber(data.valuation.marketCap, curr);
  document.getElementById('statBetaSide').textContent = formatRatio(data.tradingStats.beta);
  document.getElementById('statPESide').textContent = formatRatio(data.valuation.trailingPE);
  document.getElementById('statEPSSide').textContent = formatCurrency(data.valuation.trailingEps, curr);
  document.getElementById('statYieldSide').textContent = formatPercent(data.dividends.dividendYield);

  // 5. Valuation Tab
  document.getElementById('valMarketCap').textContent = formatLargeNumber(data.valuation.marketCap, curr);
  document.getElementById('valEV').textContent = formatLargeNumber(data.valuation.enterpriseValue, curr);
  document.getElementById('valTrailingPE').textContent = formatRatio(data.valuation.trailingPE);
  document.getElementById('valForwardPE').textContent = formatRatio(data.valuation.forwardPE);
  document.getElementById('valPEG').textContent = formatRatio(data.valuation.pegRatio);
  document.getElementById('valPriceToSales').textContent = formatRatio(data.valuation.priceToSalesTrailing12Months);
  document.getElementById('valPriceToBook').textContent = formatRatio(data.valuation.priceToBook);
  document.getElementById('valEvToRev').textContent = formatRatio(data.valuation.enterpriseToRevenue);
  document.getElementById('valEvToEbitda').textContent = formatRatio(data.valuation.enterpriseToEbitda);
  document.getElementById('valTrailingEPS').textContent = formatCurrency(data.valuation.trailingEps, curr);
  document.getElementById('valForwardEPS').textContent = formatCurrency(data.valuation.forwardEps, curr);
  document.getElementById('valBookValue').textContent = formatCurrency(data.valuation.bookValue, curr);
  document.getElementById('profRevPerShare').textContent = formatCurrency(data.profitability.revenuePerShare, curr);
  document.getElementById('balCashPerShare').textContent = formatCurrency(data.balanceSheet.totalCashPerShare, curr);
  document.getElementById('statSharesOut').textContent = formatLargeNumber(data.tradingStats.sharesOutstanding, '');
  document.getElementById('statFloat').textContent = formatLargeNumber(data.tradingStats.floatShares, '');

  // 6. Financials Tab
  document.getElementById('profRevenue').textContent = formatLargeNumber(data.profitability.totalRevenue, curr);
  document.getElementById('profGrossProfit').textContent = formatLargeNumber(data.profitability.grossProfits, curr);
  document.getElementById('profEbitda').textContent = formatLargeNumber(data.profitability.ebitda, curr);
  document.getElementById('profNetIncome').textContent = formatLargeNumber(data.profitability.netIncomeToCommon, curr);
  document.getElementById('profRevenueGrowth').textContent = formatPercent(data.profitability.revenueGrowth);
  document.getElementById('profGrossMargin').textContent = formatPercent(data.profitability.grossMargins);
  document.getElementById('profOperatingMargin').textContent = formatPercent(data.profitability.operatingMargins);
  document.getElementById('profProfitMargin').textContent = formatPercent(data.profitability.profitMargins);
  document.getElementById('profROA').textContent = formatPercent(data.profitability.returnOnAssets);
  document.getElementById('profROE').textContent = formatPercent(data.profitability.returnOnEquity);

  // 7. Balance Sheet Tab
  document.getElementById('balTotalCash').textContent = formatLargeNumber(data.balanceSheet.totalCash, curr);
  document.getElementById('balTotalDebt').textContent = formatLargeNumber(data.balanceSheet.totalDebt, curr);
  document.getElementById('balDebtToEquity').textContent = formatRatio(data.balanceSheet.debtToEquity);
  document.getElementById('balCurrentRatio').textContent = formatRatio(data.balanceSheet.currentRatio);
  document.getElementById('balQuickRatio').textContent = formatRatio(data.balanceSheet.quickRatio);
  document.getElementById('balOperatingCash').textContent = formatLargeNumber(data.balanceSheet.operatingCashflow, curr);
  document.getElementById('balFreeCashflow').textContent = formatLargeNumber(data.balanceSheet.freeCashflow, curr);
  document.getElementById('divRate').textContent = formatCurrency(data.dividends.dividendRate, curr);
  document.getElementById('divYield').textContent = formatPercent(data.dividends.dividendYield);
  document.getElementById('divPayoutRatio').textContent = formatPercent(data.dividends.payoutRatio);
  document.getElementById('div5YrAvg').textContent = formatPercent(data.dividends.fiveYearAvgDividendYield, false);
  document.getElementById('stat50DMA').textContent = formatCurrency(data.tradingStats.fiftyDayAverage, curr);
  document.getElementById('stat200DMA').textContent = formatCurrency(data.tradingStats.twoHundredDayAverage, curr);

  // 8. Company Profile Tab
  const locParts = [data.profile.city, data.profile.state, data.profile.country].filter(Boolean);
  document.getElementById('profileLocation').textContent = locParts.length > 0 ? locParts.join(', ') : 'N/A';
  document.getElementById('profileEmployees').textContent = data.profile.fullTimeEmployees ? data.profile.fullTimeEmployees.toLocaleString() : 'N/A';
  document.getElementById('profileSectorText').textContent = data.profile.sector || 'N/A';
  document.getElementById('profileIndustryText').textContent = data.profile.industry || 'N/A';
  document.getElementById('businessSummary').textContent = data.profile.longBusinessSummary || 'No summary available.';

  const websiteLink = document.getElementById('companyWebsiteLink');
  if (data.profile.website) {
    websiteLink.href = data.profile.website;
    websiteLink.style.display = 'inline-block';
  } else {
    websiteLink.style.display = 'none';
  }

  const execGrid = document.getElementById('executivesGrid');
  execGrid.innerHTML = '';
  if (data.profile.executives && data.profile.executives.length > 0) {
    data.profile.executives.forEach(exec => {
      const card = document.createElement('div');
      card.className = 'exec-card';
      card.innerHTML = `
        <div class="exec-name">${exec.name}</div>
        <span class="exec-title">${exec.title || 'Executive'}</span>
      `;
      execGrid.appendChild(card);
    });
  } else {
    execGrid.innerHTML = '<span style="color: var(--text-muted); font-size: 0.88rem;">Key executives not listed.</span>';
  }

  // 9. Render Stock Chart
  renderChart(data.chartData, data.symbol, currSym);

  // 10. Append Initial Batch of News (Page 1)
  appendNewsCards(data.news || []);
}

// --------------------------------------------------------------------------
// Stock Chart (Chart.js)
// --------------------------------------------------------------------------

function renderChart(quotes, symbol, currSym) {
  const canvas = document.getElementById('stockChart');
  const ctx = canvas.getContext('2d');

  if (stockChartInstance) {
    stockChartInstance.destroy();
  }

  if (!quotes || quotes.length === 0) return;

  const labels = quotes.map(q => q.date);
  const prices = quotes.map(q => q.close);
  const firstPrice = prices[0];
  const lastPrice = prices[prices.length - 1];
  const isUp = lastPrice >= firstPrice;

  const lineColor = isUp ? '#10b981' : '#f43f5e';
  const gradientFill = ctx.createLinearGradient(0, 0, 0, 360);
  gradientFill.addColorStop(0, isUp ? 'rgba(16, 185, 129, 0.32)' : 'rgba(244, 63, 94, 0.32)');
  gradientFill.addColorStop(1, 'rgba(0, 0, 0, 0.0)');

  stockChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: `${symbol} Price`,
        data: prices,
        borderColor: lineColor,
        borderWidth: 2,
        backgroundColor: gradientFill,
        fill: true,
        tension: 0.15,
        pointRadius: quotes.length > 90 ? 0 : 2,
        pointHoverRadius: 6,
        pointHoverBackgroundColor: lineColor,
        pointHoverBorderColor: '#ffffff',
        pointHoverBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(10, 15, 28, 0.95)',
          titleColor: '#94a3b8',
          bodyColor: '#ffffff',
          titleFont: { family: 'Inter', size: 12 },
          bodyFont: { family: 'JetBrains Mono', size: 14, weight: 'bold' },
          borderColor: 'rgba(255, 255, 255, 0.12)',
          borderWidth: 1,
          padding: 12,
          displayColors: false,
          callbacks: {
            label: function(context) {
              return `Close: ${currSym}${context.parsed.y.toFixed(2)}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.03)', drawBorder: false },
          ticks: { color: '#64748b', font: { family: 'Inter', size: 11 }, maxTicksLimit: 7 }
        },
        y: {
          position: 'right',
          grid: { color: 'rgba(255, 255, 255, 0.04)', drawBorder: false },
          ticks: {
            color: '#94a3b8',
            font: { family: 'JetBrains Mono', size: 11 },
            callback: value => `${currSym}${value}`
          }
        }
      }
    }
  });
}

// --------------------------------------------------------------------------
// Infinite Scroll News Stream Logic
// --------------------------------------------------------------------------

function createNewsCard(item) {
  const card = document.createElement('div');
  card.className = 'article-card';

  const thumbHtml = item.thumbnail
    ? `<img src="${item.thumbnail}" alt="${item.title}" class="article-card-thumb" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'article-card-thumb-fallback\\'>📰</div>'"/>`
    : `<div class="article-card-thumb-fallback">📰</div>`;

  const timeFormatted = item.publishTime ? timeAgo(item.publishTime) : '';

  card.innerHTML = `
    <div class="article-card-thumb-wrap">
      ${thumbHtml}
    </div>
    <div class="article-card-content">
      <div class="article-card-meta">
        <span class="article-card-pub">${item.publisher}</span>
        <span class="article-card-time">${timeFormatted}</span>
      </div>
      <h4 class="article-card-title">${item.title}</h4>
      <span class="article-card-read-action">Read Full Story Inside FinScope →</span>
    </div>
  `;

  // Clicking opens in-app reader modal, NEVER redirects to Yahoo
  card.addEventListener('click', (e) => {
    e.preventDefault();
    openArticleReader(item);
  });

  return card;
}

function appendNewsCards(articles) {
  let newlyAdded = 0;

  articles.forEach(item => {
    if (!item.title) return;
    const norm = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seenArticleTitles.has(norm)) return;
    seenArticleTitles.add(norm);

    if (infiniteNewsGrid) {
      infiniteNewsGrid.appendChild(createNewsCard(item));
    }
    if (fullNewsGrid) {
      fullNewsGrid.appendChild(createNewsCard(item));
    }
    newlyAdded++;
  });

  const totalLoaded = seenArticleTitles.size;
  if (newsCounterText) {
    newsCounterText.textContent = `Showing ${totalLoaded} of ${totalNewsCount} articles`;
  }
  if (newsCountBadge) {
    newsCountBadge.textContent = totalLoaded;
  }
}

// Fetch next page of news as user scrolls down
async function loadMoreNews() {
  if (isLoadingMoreNews || !hasMoreNews) return;
  isLoadingMoreNews = true;

  if (infiniteLoader) infiniteLoader.classList.remove('hidden');
  if (manualLoadMoreBtn) manualLoadMoreBtn.disabled = true;

  const nextPage = newsPage + 1;

  try {
    const res = await fetch(`/api/news?symbol=${encodeURIComponent(currentSymbol)}&name=${encodeURIComponent(currentCompanyName)}&page=${nextPage}&limit=${newsLimit}`);
    if (!res.ok) throw new Error(`Status ${res.status}`);

    const data = await res.json();
    newsPage = nextPage;
    totalNewsCount = data.totalArticles || totalNewsCount;
    hasMoreNews = data.hasMore;

    appendNewsCards(data.articles || []);

    if (!hasMoreNews) {
      if (infiniteLoader) infiniteLoader.classList.add('hidden');
      if (infiniteEndMsg) infiniteEndMsg.classList.remove('hidden');
      if (manualLoadMoreBtn) manualLoadMoreBtn.style.display = 'none';
      if (infiniteObserver && infiniteScrollTrigger) {
        infiniteObserver.unobserve(infiniteScrollTrigger);
      }
    }
  } catch (err) {
    console.error('Failed to load more news:', err);
  } finally {
    isLoadingMoreNews = false;
    if (manualLoadMoreBtn) manualLoadMoreBtn.disabled = false;
  }
}

// Attach IntersectionObserver to sentinel element at bottom of page
function setupInfiniteScrollObserver() {
  if (infiniteObserver) {
    infiniteObserver.disconnect();
  }

  if (!infiniteScrollTrigger) return;

  infiniteObserver = new IntersectionObserver((entries) => {
    const target = entries[0];
    if (target.isIntersecting && hasMoreNews && !isLoadingMoreNews) {
      loadMoreNews();
    }
  }, {
    root: null,
    rootMargin: '300px', // Pre-fetch 300px before user hits bottom
    threshold: 0.1
  });

  infiniteObserver.observe(infiniteScrollTrigger);
}

// Manual load more button backup
if (manualLoadMoreBtn) {
  manualLoadMoreBtn.addEventListener('click', loadMoreNews);
}

// --------------------------------------------------------------------------
// In-App Article Reader Modal
// --------------------------------------------------------------------------

async function openArticleReader(newsItem) {
  articleModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  modalLoader.classList.remove('hidden');
  modalArticleContent.classList.add('hidden');

  modalPublisher.textContent = newsItem.publisher || 'Yahoo Finance';
  modalPublishTime.textContent = newsItem.publishTime ? timeAgo(newsItem.publishTime) : '';
  modalTitle.textContent = newsItem.title;
  modalExternalLink.href = newsItem.link;

  try {
    const res = await fetch(`/api/article?url=${encodeURIComponent(newsItem.link)}`);
    if (!res.ok) throw new Error(`Failed with status ${res.status}`);

    const articleData = await res.json();
    renderModalArticle(articleData, newsItem);
  } catch (err) {
    console.warn('Could not scrape full article, using fallback:', err);
    renderModalArticle({
      title: newsItem.title,
      author: 'Financial Correspondent',
      publisher: newsItem.publisher,
      image: newsItem.thumbnail,
      paragraphs: [
        'The full syndicated story is summarized above. You can also view the original publisher link below.'
      ]
    }, newsItem);
  }
}

function renderModalArticle(articleData, origItem) {
  modalTitle.textContent = articleData.title || origItem.title;
  modalAuthor.textContent = articleData.author || 'Financial Correspondent';
  modalPublisher.textContent = articleData.publisher || origItem.publisher || 'Yahoo Finance';
  
  const totalWords = (articleData.paragraphs || []).join(' ').split(' ').length;
  const readMin = Math.max(1, Math.ceil(totalWords / 180));
  modalReadTime.textContent = `${readMin} min read`;

  const coverImg = articleData.image || origItem.thumbnail;
  if (coverImg) {
    modalImg.src = coverImg;
    modalImgWrap.style.display = 'block';
  } else {
    modalImgWrap.style.display = 'none';
  }

  modalParagraphs.innerHTML = '';
  (articleData.paragraphs || []).forEach(pText => {
    const p = document.createElement('p');
    p.textContent = pText;
    modalParagraphs.appendChild(p);
  });

  modalLoader.classList.add('hidden');
  modalArticleContent.classList.remove('hidden');
}

function closeArticleReader() {
  articleModal.classList.add('hidden');
  document.body.style.overflow = '';
}

modalCloseBtn.addEventListener('click', closeArticleReader);
modalBottomCloseBtn.addEventListener('click', closeArticleReader);

articleModal.addEventListener('click', (e) => {
  if (e.target === articleModal) {
    closeArticleReader();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !articleModal.classList.contains('hidden')) {
    closeArticleReader();
  }
});

// --------------------------------------------------------------------------
// Tab Navigation
// --------------------------------------------------------------------------

navTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const targetTabId = tab.dataset.tab;
    navTabs.forEach(t => t.classList.remove('active'));
    tabPanes.forEach(p => p.classList.remove('active'));

    tab.classList.add('active');
    const targetPane = document.getElementById(targetTabId);
    if (targetPane) {
      targetPane.classList.add('active');
    }
  });
});

timeframeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    timeframeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const range = btn.dataset.range;
    loadCompany(currentSymbol, range);
  });
});

// --------------------------------------------------------------------------
// Search & Autocomplete
// --------------------------------------------------------------------------

async function handleSearchInput(query) {
  const q = query.trim();
  if (q.length === 0) {
    searchDropdown.classList.add('hidden');
    clearSearchBtn.style.display = 'none';
    return;
  }

  clearSearchBtn.style.display = 'block';
  searchDropdown.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">Searching companies on Yahoo Finance...</div>';
  searchDropdown.classList.remove('hidden');

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    const results = data.results || [];

    if (results.length === 0) {
      searchDropdown.innerHTML = `<div style="padding: 16px; text-align: center; color: var(--text-secondary); font-size: 0.85rem;">No matching companies found for "${q}"</div>`;
      return;
    }

    searchDropdown.innerHTML = '';
    results.forEach(item => {
      const div = document.createElement('div');
      div.className = 'dropdown-item';
      div.innerHTML = `
        <div>
          <div class="dropdown-symbol">${item.symbol}</div>
          <div class="dropdown-name">${item.name}</div>
        </div>
        <span class="dropdown-exchange">${item.exchange || 'EQUITY'}</span>
      `;
      div.addEventListener('click', () => {
        searchDropdown.classList.add('hidden');
        searchInput.value = `${item.name} (${item.symbol})`;
        loadCompany(item.symbol);
      });
      searchDropdown.appendChild(div);
    });
  } catch (err) {
    console.error('Search error:', err);
    searchDropdown.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--color-down);">Error searching tickers.</div>';
  }
}

searchInput.addEventListener('input', (e) => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    handleSearchInput(e.target.value);
  }, 280);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    searchDropdown.classList.add('hidden');
    const val = searchInput.value.trim();
    if (val) {
      const match = val.match(/\(([^)]+)\)/);
      const symbol = match ? match[1] : val;
      loadCompany(symbol);
    }
  }
});

searchSubmitBtn.addEventListener('click', () => {
  searchDropdown.classList.add('hidden');
  const val = searchInput.value.trim();
  if (val) {
    const match = val.match(/\(([^)]+)\)/);
    const symbol = match ? match[1] : val;
    loadCompany(symbol);
  }
});

clearSearchBtn.addEventListener('click', () => {
  searchInput.value = '';
  clearSearchBtn.style.display = 'none';
  searchDropdown.classList.add('hidden');
  searchInput.focus();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.header-search-wrap')) {
    searchDropdown.classList.add('hidden');
  }
});

shortcutPills.forEach(pill => {
  pill.addEventListener('click', () => {
    const sym = pill.dataset.symbol;
    searchInput.value = '';
    loadCompany(sym);
  });
});

// Initial boot
document.addEventListener('DOMContentLoaded', () => {
  loadCompany(currentSymbol);
});
