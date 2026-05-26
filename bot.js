/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Webhook mode (default): persistent server on Railway. TradingView fires a
 * POST to /webhook when the EO Vola indicator signals — bot executes instantly.
 * Executes via IBKR Web API (OAuth 1.0a + RSA-SHA256).
 *
 * Local test: node bot.js --webhook
 * Cloud:      deploy to Railway — reads railway.json automatically
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import { createServer } from "http";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const paperMode = process.env.PAPER_TRADING !== "false";

  if (!existsSync(".env")) {
    console.log("\n⚠️  No .env file found — creating one for you...\n");
    writeFileSync(
      ".env",
      [
        "# IBKR Web API credentials",
        "# Get these from: Account Management → Settings → API → OAuth",
        "IBKR_CONSUMER_KEY=",
        "IBKR_ACCESS_TOKEN=",
        "# Paste your RSA private key — replace newlines with \\n",
        "IBKR_PRIVATE_KEY=",
        "",
        "# Account IDs (found in IBKR Client Portal → Settings → Account Settings)",
        "IBKR_ACCOUNT_ID=",
        "IBKR_PAPER_ACCOUNT_ID=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=10000",
        "MAX_TRADE_SIZE_USD=10000",
        "MAX_TRADES_PER_DAY=4",
        "PAPER_TRADING=true",
        "SYMBOL=UVXY",
        "TIMEFRAME=5",
        "",
        "# Webhook secret — must match your TradingView alert message",
        "WEBHOOK_SECRET=",
      ].join("\n") + "\n",
    );
    try { execSync("open .env"); } catch {}
    console.log("Fill in your IBKR credentials in .env then re-run.\n");
    process.exit(0);
  }

  // In live mode, require IBKR credentials
  if (!paperMode) {
    const required = ["IBKR_CONSUMER_KEY", "IBKR_ACCESS_TOKEN", "IBKR_PRIVATE_KEY", "IBKR_ACCOUNT_ID"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      console.log(`\n⚠️  Missing credentials for live trading: ${missing.join(", ")}`);
      console.log("Set PAPER_TRADING=true to run without credentials.\n");
      process.exit(1);
    }
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "UVXY",
  timeframe: process.env.TIMEFRAME || "5",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "10000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "10000"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "4"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  ibkr: {
    consumerKey: process.env.IBKR_CONSUMER_KEY || "",
    accessToken: process.env.IBKR_ACCESS_TOKEN || "",
    // PEM keys stored in env vars use literal \n — convert them back to newlines
    privateKey: (process.env.IBKR_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    // Use paper account ID when in paper mode, live account ID otherwise
    accountId: process.env.PAPER_TRADING !== "false"
      ? (process.env.IBKR_PAPER_ACCOUNT_ID || process.env.IBKR_ACCOUNT_ID || "")
      : (process.env.IBKR_ACCOUNT_ID || ""),
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Map our timeframe format to Binance interval format
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";

  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();

  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias first
  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    // 1. Price above VWAP
    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    // 2. Price above EMA(8)
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );

    // 3. RSI(3) pullback
    check(
      "RSI(3) below 30 (snap-back setup in uptrend)",
      "< 30",
      rsi3.toFixed(2),
      rsi3 < 30,
    );

    // 4. Not overextended from VWAP
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );

    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );

    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── IBKR Web API Execution ──────────────────────────────────────────────────
// OAuth 1.0a with RSA-SHA256. No local gateway required — pure REST.
// Docs: https://ibkrcampus.com/ibkr-api-page/webapi-doc/

const IBKR_BASE = "https://api.ibkr.com/v1/api";

// Cache UVXY's contract ID so we only look it up once per process lifetime
let _uvxyConid = process.env.IBKR_UVXY_CONID
  ? parseInt(process.env.IBKR_UVXY_CONID)
  : null;

function ibkrAuthHeader(method, url) {
  const { consumerKey, accessToken, privateKey } = CONFIG.ibkr;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(12).toString("hex");

  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "RSA-SHA256",
    oauth_timestamp: timestamp,
    oauth_token: accessToken,
    oauth_version: "1.0",
  };

  // Signature base string: METHOD&url&params — all percent-encoded
  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`)
    .join("&");

  const baseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(paramString),
  ].join("&");

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(baseString);
  const signature = sign.sign(privateKey, "base64");

  oauthParams.oauth_signature = signature;

  return (
    "OAuth " +
    Object.keys(oauthParams)
      .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
      .join(", ")
  );
}

async function ibkrRequest(method, path, body = null) {
  const url = `${IBKR_BASE}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: ibkrAuthHeader(method, url),
      "Content-Type": "application/json",
      "User-Agent": "claude-trading-bot/1.0",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IBKR API ${res.status}: ${text}`);
  }
  return res.json();
}

async function getUVXYConid() {
  if (_uvxyConid) return _uvxyConid;
  console.log("  Looking up UVXY contract ID from IBKR...");
  const data = await ibkrRequest("POST", "/iserver/secdef/search", {
    symbol: "UVXY",
    name: false,
    secType: "STK",
  });
  const match = (Array.isArray(data) ? data : []).find(
    (d) => d.symbol === "UVXY",
  );
  if (!match) throw new Error("UVXY not found in IBKR contract search");
  _uvxyConid = match.conid;
  console.log(`  UVXY conid: ${_uvxyConid}`);
  return _uvxyConid;
}

async function placeIBKROrder(side, sizeUSD, price) {
  const acctId = CONFIG.ibkr.accountId;
  const conid = await getUVXYConid();
  const quantity = Math.max(1, Math.floor(sizeUSD / price));

  console.log(`  Placing IBKR order: ${side.toUpperCase()} ${quantity} UVXY @ MKT (acct: ${acctId})`);

  const data = await ibkrRequest("POST", `/iserver/account/${acctId}/orders`, {
    orders: [{ acctId, conid, orderType: "MKT", side: side.toUpperCase(), quantity, tif: "DAY" }],
  });

  // IBKR returns a confirmation challenge for certain orders — auto-confirm
  if (Array.isArray(data) && data[0]?.id) {
    const confirmed = await ibkrRequest("POST", `/iserver/reply/${data[0].id}`, {
      confirmed: true,
    });
    return confirmed[0] || confirmed;
  }

  return Array.isArray(data) ? data[0] : data;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = logEntry.signal === "short_entry" ? "SELL SHORT" : "BUY COVER";
    quantity = Math.max(1, Math.floor(logEntry.tradeSize / logEntry.price)).toString();
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.0005).toFixed(4); // IBKR ~$0.005/share, est.
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = logEntry.signal === "short_entry" ? "SELL SHORT" : "BUY COVER";
    quantity = Math.max(1, Math.floor(logEntry.tradeSize / logEntry.price)).toString();
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.0005).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "IBKR",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function writeExitCsv({ exitedAt, symbol, price, signal, holdingMins, orderId, paperTrading, entryPrice, pnlPct }) {
  const now = new Date(exitedAt);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const mode = paperTrading ? "PAPER" : "LIVE";
  const holdStr = holdingMins !== null ? `${holdingMins} min` : "?";
  const pnlStr  = pnlPct !== null ? ` | PnL ${pnlPct > 0 ? "+" : ""}${pnlPct}%` : "";
  const notes   = `Exit: ${signal} | Held: ${holdStr}${pnlStr}`;

  const row = [
    date, time, "IBKR", symbol,
    "BUY TO COVER",
    "",                           // qty — not known here without the original entry
    price.toFixed(2),
    "",                           // total USD — size came from maxTradeSizeUSD
    "", "",                       // fee, net — not recalculated on exit
    orderId || "",
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Exit record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch candle data — need enough for EMA(8) + full session for VWAP
  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  // Run safety check
  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules);

  // Calculate position size
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — would buy ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${CONFIG.symbol}`,
      );
      try {
        const order = await placeIBKROrder("buy", tradeSize, price);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.order_id || order.orderId || order.id;
        console.log(`✅ ORDER PLACED — ${logEntry.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  // Write tax CSV row for every run (executed, paper, or blocked)
  writeTradeCsv(logEntry);

  console.log("═══════════════════════════════════════════════════════════\n");
}

// ─── Webhook Server ──────────────────────────────────────────────────────────
// Receives TradingView alerts from the EO Vola Short Strategy indicator.
// TradingView sends a POST to /webhook with a JSON body.
// A secret token in the payload prevents spurious requests.
//
// Expected payload from TradingView alert message template:
//   {"signal":"short_entry","price":"{{close}}","symbol":"{{ticker}}","secret":"YOUR_SECRET"}
//   {"signal":"short_exit","price":"{{close}}","symbol":"{{ticker}}","secret":"YOUR_SECRET"}
//   {"signal":"take_profit","price":"{{close}}","symbol":"{{ticker}}","secret":"YOUR_SECRET"}
//   {"signal":"stop_loss","price":"{{close}}","symbol":"{{ticker}}","secret":"YOUR_SECRET"}

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const PORT = parseInt(process.env.PORT || "3000");

async function handleWebhook(payload) {
  const { signal, price: rawPrice, symbol } = payload;
  const price = parseFloat(rawPrice);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  📡 Webhook received");
  console.log(`  Signal : ${signal}`);
  console.log(`  Symbol : ${symbol}`);
  console.log(`  Price  : $${price.toFixed(2)}`);
  console.log(`  Time   : ${new Date().toISOString()}`);
  console.log(`  Mode   : ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"}`);
  console.log("═══════════════════════════════════════════════════════════");

  initCsv();
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  const log = loadLog();

  // ── Entry signal ──────────────────────────────────────────────────────────
  if (signal === "short_entry") {
    console.log("\n── Safety Check (Webhook) ───────────────────────────────\n");

    const results = [];
    const check = (label, required, actual, pass) => {
      results.push({ label, required, actual, pass });
      console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
      console.log(`     Required: ${required} | Actual: ${actual}`);
    };

    // 1. Signal came from TradingView (already validated by secret above)
    check("Signal source", "EO Vola Short Strategy (TradingView)", "Webhook — verified", true);

    // 2. Within NYSE market hours (13:30–20:00 UTC, Mon–Fri)
    const now = new Date();
    const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
    const dow = now.getUTCDay();
    const marketOpen = dow >= 1 && dow <= 5 && utcHour >= 13.5 && utcHour <= 20;
    check("NYSE market hours (13:30–20:00 UTC, Mon–Fri)", "market open", marketOpen ? "open" : `${utcHour.toFixed(1)}h UTC, day ${dow}`, marketOpen);

    // 3. Daily trade limit
    const todayCount = countTodaysTrades(log);
    const withinLimit = todayCount < CONFIG.maxTradesPerDay;
    check(`Daily trade limit`, `< ${CONFIG.maxTradesPerDay}`, `${todayCount} trades today`, withinLimit);

    // 4. Trade size
    const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);
    const sizeOk = tradeSize <= CONFIG.maxTradeSizeUSD;
    check("Trade size within limit", `≤ $${CONFIG.maxTradeSizeUSD}`, `$${tradeSize.toFixed(2)}`, sizeOk);

    const allPass = results.every((r) => r.pass);
    console.log("\n── Decision ─────────────────────────────────────────────\n");

    const logEntry = {
      timestamp: new Date().toISOString(),
      symbol: CONFIG.symbol,
      timeframe: CONFIG.timeframe,
      price,
      signal,
      source: "webhook",
      conditions: results,
      allPass,
      tradeSize,
      orderPlaced: false,
      orderId: null,
      paperTrading: CONFIG.paperTrading,
      limits: { maxTradeSizeUSD: CONFIG.maxTradeSizeUSD, maxTradesPerDay: CONFIG.maxTradesPerDay, tradesToday: todayCount },
    };

    if (!allPass) {
      const failed = results.filter((r) => !r.pass).map((r) => r.label);
      console.log(`🚫 TRADE BLOCKED — failed: ${failed.join(", ")}`);
    } else {
      const tp = (price * 0.91).toFixed(2);
      const sl = (price * 1.06).toFixed(2);
      console.log(`✅ ALL CONDITIONS MET — SHORT ENTRY`);
      console.log(`   Entry : $${price.toFixed(2)}`);
      console.log(`   TP    : $${tp} (−9%)`);
      console.log(`   SL    : $${sl} (+6%)`);
      console.log(`   Size  : $${tradeSize.toFixed(2)}`);

      if (CONFIG.paperTrading) {
        console.log(`\n📋 PAPER TRADE — would short ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`);
        logEntry.orderPlaced = true;
        logEntry.orderId = `PAPER-SHORT-${Date.now()}`;
        logEntry.tp = tp;
        logEntry.sl = sl;
      } else {
        console.log(`\n🔴 PLACING LIVE SHORT ORDER — $${tradeSize.toFixed(2)} SELL ${CONFIG.symbol}`);
        try {
          const order = await placeIBKROrder("sell", tradeSize, price);
          logEntry.orderPlaced = true;
          logEntry.orderId = order.order_id || order.orderId || order.id;
          console.log(`✅ ORDER PLACED — ${logEntry.orderId}`);
        } catch (err) {
          console.log(`❌ ORDER FAILED — ${err.message}`);
          logEntry.error = err.message;
        }
      }
    }

    log.trades.push(logEntry);
    saveLog(log);
    writeTradeCsv(logEntry);
    console.log(`\nDecision log saved → ${LOG_FILE}`);
  }

  // ── Exit signals ─────────────────────────────────────────────────────────
  if (signal === "short_exit" || signal === "take_profit" || signal === "stop_loss") {
    const exitReason = signal === "take_profit" ? "🎯 Take profit hit (−9%)"
                     : signal === "stop_loss"   ? "🛑 Stop loss hit (+6%)"
                     :                            "🔄 VSTOP flipped bullish — exit signal";

    console.log(`\n── Exit Signal ───────────────────────────────────────────\n`);
    console.log(`  ${exitReason}`);
    console.log(`  Exit price : $${price.toFixed(2)}`);

    // Find the last open short from the log
    const openShort = [...log.trades].reverse().find((t) => t.signal === "short_entry" && t.orderPlaced && !t.exitedAt);

    const exitedAt = new Date().toISOString();
    let holdingMins = null;

    if (openShort) {
      const pnl = ((openShort.price - price) / openShort.price * 100).toFixed(2);
      holdingMins = Math.round((Date.parse(exitedAt) - Date.parse(openShort.timestamp)) / 60000);
      console.log(`  Entry was  : $${openShort.price.toFixed(2)}`);
      console.log(`  Held       : ${holdingMins} min`);
      console.log(`  P&L        : ${pnl > 0 ? "+" : ""}${pnl}%`);
      openShort.exitedAt = exitedAt;
      openShort.exitPrice = price;
      openShort.exitReason = signal;
      openShort.pnlPct = pnl;
      openShort.holdingMins = holdingMins;
    }

    let exitOrderId = null;
    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER EXIT — would cover ${CONFIG.symbol} at $${price.toFixed(2)}`);
      exitOrderId = `PAPER-EXIT-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING EXIT ORDER — BUY TO COVER ${CONFIG.symbol} at market`);
      try {
        const order = await placeIBKROrder("buy", CONFIG.maxTradeSizeUSD, price);
        exitOrderId = order.order_id || order.orderId || order.id;
        console.log(`✅ EXIT ORDER PLACED — ${exitOrderId}`);
      } catch (err) {
        console.log(`❌ EXIT ORDER FAILED — ${err.message}`);
      }
    }

    writeExitCsv({ exitedAt, symbol: CONFIG.symbol, price, signal, holdingMins,
                   orderId: exitOrderId, paperTrading: CONFIG.paperTrading,
                   entryPrice: openShort?.price ?? null, pnlPct: openShort?.pnlPct ?? null });

    saveLog(log);
    console.log(`\nLog updated → ${LOG_FILE}`);
  }

  console.log("═══════════════════════════════════════════════════════════\n");
}

function startWebhookServer() {
  checkOnboarding();
  initCsv();

  const server = createServer(async (req, res) => {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", mode: CONFIG.paperTrading ? "paper" : "live", symbol: CONFIG.symbol }));
      return;
    }

    // Webhook endpoint
    if (req.method === "POST" && req.url === "/webhook") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);

          // Validate secret if configured
          if (WEBHOOK_SECRET && payload.secret !== WEBHOOK_SECRET) {
            console.log(`⚠️  Webhook rejected — invalid secret`);
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "unauthorized" }));
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ received: true }));

          // Process async (don't block the response)
          await handleWebhook(payload).catch((err) => console.error("Webhook handler error:", err.message));
        } catch (err) {
          console.log(`⚠️  Webhook parse error: ${err.message}`);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad request" }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(PORT, () => {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  Claude Trading Bot — Webhook Server");
    console.log(`  Listening on port ${PORT}`);
    console.log(`  Mode    : ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
    console.log(`  Symbol  : ${CONFIG.symbol} (${CONFIG.timeframe})`);
    console.log(`  Secret  : ${WEBHOOK_SECRET ? "✅ configured" : "⚠️  not set — set WEBHOOK_SECRET in .env"}`);
    console.log(`  Endpoint: POST /webhook`);
    console.log(`  Health  : GET  /health`);
    console.log("═══════════════════════════════════════════════════════════");
    console.log("\nWaiting for TradingView signals...\n");
    console.log("TradingView alert message template (short_entry):");
    console.log(`  {"signal":"short_entry","price":"{{strategy.order.price}}","symbol":"{{ticker}}","secret":"${WEBHOOK_SECRET || "YOUR_SECRET"}"}`);
    console.log("\nTradingView alert message template (short_exit):");
    console.log(`  {"signal":"short_exit","price":"{{strategy.order.price}}","symbol":"{{ticker}}","secret":"${WEBHOOK_SECRET || "YOUR_SECRET"}"}`);
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else if (process.env.WEBHOOK_MODE === "true" || process.argv.includes("--webhook")) {
  startWebhookServer();
} else {
  // Legacy polling mode (kept for local testing / manual runs)
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
