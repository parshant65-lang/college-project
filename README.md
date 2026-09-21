# FinScope - Professional Financial Terminal & Fundamental Analysis Platform

FinScope is a modern financial analysis web application modeled after **Bloomberg Terminal** and **Yahoo Finance**. Built with **HTML5, CSS3, Vanilla JavaScript**, and a **Node.js Express** backend powered by **Yahoo Finance** (`yahoo-finance2`).

---

## 🌟 Key Features

1. **Market Indices Ticker Marquee**:
   - Live continuous marquee ticker at the top displaying real-time indices (`S&P 500`, `NASDAQ`, `DOW 30`, `NIFTY 50`, `SENSEX`, `GOLD`, `CRUDE OIL`, `BITCOIN`).

2. **Yahoo Finance-Style Tabbed Dashboard**:
   - **Summary & Chart**: Real-time stock price, 24h change, Day range slider, 52-Week range gauge, interactive historical chart (1M, 3M, 6M, 1Y, 5Y), and key statistics at a glance.
   - **Valuation & Multiples**: Market Cap, Enterprise Value, Trailing P/E, Forward P/E, PEG Ratio, Price-to-Sales (P/S), Price-to-Book (P/B), EV/Revenue, EV/EBITDA, Book Value per Share, Diluted EPS, Forward EPS.
   - **Financials & Margins**: Total Revenue, Gross Profit, EBITDA, Net Income to Common, YoY Revenue Growth, Gross Margin, Operating Margin, Profit Margin, ROA, ROE.
   - **Balance Sheet & Solvency**: Total Cash, Total Debt, Debt-to-Equity (D/E), Current Ratio, Quick Ratio, Operating Cash Flow, Free Cash Flow, Dividend Yield, Payout Ratio, 50DMA, 200DMA.
   - **Company Profile**: Sector, Industry, Headquarters, Full-time Employees, Full Business Overview, Key Corporate Officers, and Official Website link.
   - **News & Articles**: Full stream of 15–20 real-time company press releases and stories.

3. **📰 In-App Full Article Reader (No External Redirects)**:
   - Clicking any news article **opens it directly inside the website** in a clean, distraction-free reading modal.
   - Parses and displays:
     - Full news headline
     - Publisher name and published time ago
     - Author byline
     - High-resolution lead article image
     - Complete article body paragraphs with drop-cap styling and reading-time calculation
     - Close button (`✕`), "Return to Dashboard", or press `ESC` key.

4. **Smart Autocomplete Search**:
   - Instant debounced search for global and Indian stocks (e.g. *Apple, Tesla, Reliance, Tata Motors, Microsoft, Nvidia, Infosys*).
   - Quick one-click trending company shortcut pills.

---

## 🛠️ How to Run Locally

### 1. Open Terminal in the project folder:
```bash
cd "/home/parshant_01/Desktop/College Project"
```

### 2. Start the Server:
```bash
npm start
```
*(Or `node server.js`)*

### 3. Open in Your Browser:
Visit:
👉 **`http://localhost:3000`**
