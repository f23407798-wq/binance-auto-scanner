/**
 * binance.js
 * -----------------------------------------------------------------------
 * Thin wrapper around Binance USDT-M Futures REST API.
 * - Public endpoints (klines, exchangeInfo, ticker) need no key.
 * - Trading endpoints (order, positionRisk, leverage) are HMAC-SHA256
 *   signed using BINANCE_API_KEY / BINANCE_API_SECRET from env vars.
 *
 * LIVE by default (per your choice). If you ever want to dry-run
 * against Binance's Futures Testnet instead, set BINANCE_TESTNET=true
 * and use testnet-only API keys from https://testnet.binancefuture.com
 * -----------------------------------------------------------------------
 */
const crypto = require("crypto");

const TESTNET = String(process.env.BINANCE_TESTNET || "false").toLowerCase() === "true";
const BASE_URL = TESTNET ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;

function sign(queryString) {
  return crypto.createHmac("sha256", API_SECRET).update(queryString).digest("hex");
}

function toQueryString(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

async function publicGet(path, params = {}) {
  const qs = toQueryString(params);
  const url = `${BASE_URL}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function signedRequest(method, path, params = {}) {
  if (!API_KEY || !API_SECRET) {
    throw new Error("BINANCE_API_KEY / BINANCE_API_SECRET are not set (check your GitHub Actions secrets).");
  }
  const timestamp = Date.now();
  const recvWindow = 10000;
  const fullParams = { ...params, timestamp, recvWindow };
  const qs = toQueryString(fullParams);
  const signature = sign(qs);
  const url = `${BASE_URL}${path}?${qs}&signature=${signature}`;
  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": API_KEY },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/* ---------------------------- market data ---------------------------- */

async function fetchTopSymbols(n) {
  const data = await publicGet("/fapi/v1/ticker/24hr");
  const usdt = data.filter((d) => d.symbol.endsWith("USDT") && !d.symbol.includes("_"));
  usdt.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
  return usdt.slice(0, n);
}

/**
 * Fetches klines and DROPS the last candle if it is still forming
 * (unclosed), so the scanner only ever evaluates fully-closed candles.
 * This matters for a bot — a partially-formed last candle could look
 * like a fresh trend-line break that then reverses before the candle
 * actually closes.
 */
async function fetchClosedKlines(symbol, interval, limit = 500) {
  const data = await publicGet("/fapi/v1/klines", { symbol, interval, limit });
  const candles = data.map((k) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], closeTime: k[6] }));
  const now = Date.now();
  if (candles.length && candles[candles.length - 1].closeTime > now) {
    candles.pop(); // last candle hasn't closed yet
  }
  return candles;
}

/* ---------------------------- symbol precision ---------------------------- */

let exchangeInfoCache = null;
async function getExchangeInfo() {
  if (!exchangeInfoCache) {
    exchangeInfoCache = await publicGet("/fapi/v1/exchangeInfo");
  }
  return exchangeInfoCache;
}

async function getSymbolFilters(symbol) {
  const info = await getExchangeInfo();
  const s = info.symbols.find((x) => x.symbol === symbol);
  if (!s) throw new Error(`Symbol ${symbol} not found in exchangeInfo`);
  const lotSize = s.filters.find((f) => f.filterType === "MARKET_LOT_SIZE") || s.filters.find((f) => f.filterType === "LOT_SIZE");
  return {
    stepSize: parseFloat(lotSize.stepSize),
    minQty: parseFloat(lotSize.minQty),
    quantityPrecision: s.quantityPrecision,
  };
}

function roundToStep(qty, stepSize, precision) {
  const stepped = Math.floor(qty / stepSize) * stepSize;
  return parseFloat(stepped.toFixed(precision));
}

/* ---------------------------- account / positions ---------------------------- */

async function getOpenPosition(symbol) {
  const positions = await signedRequest("GET", "/fapi/v2/positionRisk", { symbol });
  return positions.find((p) => parseFloat(p.positionAmt) !== 0) || null;
}

async function setLeverage(symbol, leverage) {
  return signedRequest("POST", "/fapi/v1/leverage", { symbol, leverage });
}

/* ---------------------------- orders ---------------------------- */

/**
 * Places a MARKET SELL (short entry) order sized by fixed USDT margin.
 * No SL/TP orders are placed — per your setup, you manage those manually.
 */
async function placeMarketShort({ symbol, marginUsdt, leverage, price }) {
  await setLeverage(symbol, leverage);
  const { stepSize, minQty, quantityPrecision } = await getSymbolFilters(symbol);

  const notional = marginUsdt * leverage;
  let quantity = roundToStep(notional / price, stepSize, quantityPrecision);
  if (quantity < minQty) {
    throw new Error(
      `Computed quantity ${quantity} for ${symbol} is below exchange minQty ${minQty}. Increase MARGIN_USDT or LEVERAGE.`
    );
  }

  const order = await signedRequest("POST", "/fapi/v1/order", {
    symbol,
    side: "SELL",
    type: "MARKET",
    quantity,
  });

  return { order, quantity, notional };
}

module.exports = {
  TESTNET,
  BASE_URL,
  fetchTopSymbols,
  fetchClosedKlines,
  getSymbolFilters,
  getOpenPosition,
  setLeverage,
  placeMarketShort,
};
