#!/usr/bin/env node
// scalper-experiment-matrix-v3.mjs — temporal cross-validation research bench.
//
// Read-only: Bybit public klines only. No private API, no secrets, no monitor,
// no orders.
//
// Adds vs v2:
// - 5 disjoint temporal windows.
// - Effective grids for BTC-Lead and Trend Surf.
// - Three additional public-OHLCV strategy families:
//   EMA-ADX scalp, Bollinger squeeze breakout, RSI/BB mean reversion.
// - Unique trade fingerprint neighborhood, so identical variants do not count
//   as robustness.
// - Promotion requires repeated edge across different windows, not one lucky
//   recent regime.
//
// Usage:
//   node scripts/scalper-experiment-matrix-v3.mjs --window-limit 10080 --windows 5

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runBtcLeadAltEcho } from "./btc-lead-alt-echo.mjs";
import { runTrendSurfBacktest } from "./trend-surf-scalp.mjs";

const LEAD = "BTCUSDT";
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "LINKUSDT", "AVAXUSDT", "SUIUSDT", "HYPEUSDT"];
const ALTS = SYMBOLS.filter((s) => s !== LEAD);
const MAX_BATCH = 1000;
const FETCH_DELAY_MS = 160;
const FEE_BASE = 0.11;
const FEE_STRESS = 0.15;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, d = 3) {
  if (!Number.isFinite(v)) return 0;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function toIso(ts) {
  return new Date(ts).toISOString().replace(/\.\d+Z$/, "Z");
}

function normalizeKline(row) {
  return {
    ts: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

async function fetchKlines(symbol, totalLimit) {
  const byTs = new Map();
  let end = null;
  while (byTs.size < totalLimit) {
    const batch = Math.min(MAX_BATCH, totalLimit - byTs.size);
    const params = new URLSearchParams({ category: "linear", symbol, interval: "1", limit: String(batch) });
    if (end != null) params.set("end", String(end));
    const url = `https://api.bybit.com/v5/market/kline?${params}`;
    let json = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      json = await fetchJsonWithRetry(url, symbol);
      if (json.retCode === 0) break;
      const msg = String(json.retMsg ?? json.retCode);
      if (!msg.toLowerCase().includes("too many")) {
        throw new Error(`Bybit public kline failed for ${symbol}: ${msg}`);
      }
      const wait = 5_000 * (attempt + 1);
      console.error(`[v3] rate limited for ${symbol}; wait ${wait}ms`);
      await sleep(wait);
    }
    if (json.retCode !== 0) throw new Error(`Bybit public kline failed for ${symbol}: ${json.retMsg ?? json.retCode}`);
    const rows = json.result?.list ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      const candle = normalizeKline(row);
      if (Number.isFinite(candle.ts)) byTs.set(candle.ts, candle);
    }
    const oldest = Math.min(...rows.map((row) => Number(row[0])).filter(Number.isFinite));
    if (!Number.isFinite(oldest)) break;
    const nextEnd = oldest - 60_000;
    if (end != null && nextEnd >= end) break;
    end = nextEnd;
    await sleep(FETCH_DELAY_MS);
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-totalLimit);
}

async function loadOrFetchKlines(symbol, totalLimit, outDir) {
  const cachePath = join(outDir, `.klines-${symbol}-${totalLimit}.json`);
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    if (Array.isArray(cached) && cached.length >= totalLimit) {
      console.error(`  ${symbol}: ${cached.length} candles from cache`);
      return cached.slice(-totalLimit);
    }
  }
  const rows = await fetchKlines(symbol, totalLimit);
  writeFileSync(cachePath, JSON.stringify(rows));
  return rows;
}

async function fetchJsonWithRetry(url, symbol, attempts = 4) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      return await res.json();
    } catch (err) {
      lastError = err;
      const wait = 500 * 2 ** i;
      console.error(`[v3] retry ${i + 1}/${attempts} for ${symbol}: ${err.message}; wait ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastError;
}

function splitWindows(candles, windows, windowLimit) {
  const out = [];
  for (let i = 0; i < windows; i++) {
    const end = candles.length - windowLimit * i;
    const start = end - windowLimit;
    if (start < 0) break;
    out.unshift(candles.slice(start, end));
  }
  return out;
}

function pct(from, to, side = "long") {
  const raw = ((to - from) / from) * 100;
  return side === "short" ? -raw : raw;
}

function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function std(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

function ema(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = mean(values.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rolling(values, period, fn) {
  return values.map((_, i) => (i + 1 >= period ? fn(values.slice(i + 1 - period, i + 1)) : null));
}

function rsi(values, period) {
  const out = Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    let gain = 0;
    let loss = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const delta = values[j] - values[j - 1];
      if (delta >= 0) gain += delta;
      else loss += Math.abs(delta);
    }
    const rs = loss === 0 ? 99 : gain / loss;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function atr(candles, period) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  return rolling(tr, period, mean);
}

function adx(candles, period) {
  const plusDm = [0];
  const minusDm = [0];
  const tr = [candles[0]?.high - candles[0]?.low || 0];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    const prev = candles[i - 1].close;
    tr.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - prev), Math.abs(candles[i].low - prev)));
  }
  const out = Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    const trSum = tr.slice(i + 1 - period, i + 1).reduce((s, v) => s + v, 0);
    if (!trSum) continue;
    const pdi = (100 * plusDm.slice(i + 1 - period, i + 1).reduce((s, v) => s + v, 0)) / trSum;
    const mdi = (100 * minusDm.slice(i + 1 - period, i + 1).reduce((s, v) => s + v, 0)) / trSum;
    out[i] = pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  }
  return rolling(out.map((v) => v ?? 0), period, mean);
}

function resample(candles, minutes) {
  const bucketMs = minutes * 60_000;
  const buckets = new Map();
  for (const c of candles) {
    const key = Math.floor(c.ts / bucketMs) * bucketMs;
    const b = buckets.get(key);
    if (!b) buckets.set(key, { ts: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

function finishTrade({ signalId, symbol, side, entry, entryTs, exit, exitTs, reason, feePct, mfe, mae }) {
  const gross = pct(entry, exit, side);
  return {
    client_signal_id: signalId,
    symbol,
    side,
    entry_ts: toIso(entryTs),
    entry: round(entry, 8),
    exit_ts: toIso(exitTs),
    exit_price: round(exit, 8),
    exit_reason: reason,
    pnl_gross_pct: round(gross, 4),
    pnl_net_pct: round(gross - feePct, 4),
    mfe_pct: round(mfe, 4),
    mae_pct: round(mae, 4),
  };
}

function simulateBracket({ candles, startIndex, symbol, side, slPct, tpPct, maxBars, feePct, signalId }) {
  const entryC = candles[startIndex];
  if (!entryC) return null;
  const entry = entryC.close;
  let mfe = 0;
  let mae = 0;
  for (let offset = 1; offset <= maxBars && startIndex + offset < candles.length; offset++) {
    const c = candles[startIndex + offset];
    const highPnl = side === "long" ? pct(entry, c.high, side) : pct(entry, c.low, side);
    const lowPnl = side === "long" ? pct(entry, c.low, side) : pct(entry, c.high, side);
    mfe = Math.max(mfe, highPnl);
    mae = Math.min(mae, lowPnl);
    const hitTp = side === "long" ? c.high >= entry * (1 + tpPct / 100) : c.low <= entry * (1 - tpPct / 100);
    const hitSl = side === "long" ? c.low <= entry * (1 - slPct / 100) : c.high >= entry * (1 + slPct / 100);
    if (hitTp) return finishTrade({ signalId, symbol, side, entry, entryTs: entryC.ts, exit: side === "long" ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100), exitTs: c.ts, reason: "tp", feePct, mfe, mae });
    if (hitSl) return finishTrade({ signalId, symbol, side, entry, entryTs: entryC.ts, exit: side === "long" ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100), exitTs: c.ts, reason: "sl", feePct, mfe, mae });
  }
  const last = candles[Math.min(startIndex + maxBars, candles.length - 1)];
  return finishTrade({ signalId, symbol, side, entry, entryTs: entryC.ts, exit: last.close, exitTs: last.ts, reason: "time", feePct, mfe, mae });
}

function runEmaAdxScalp(input, { symbol, config }) {
  const candles = resample(input, 5);
  const close = candles.map((c) => c.close);
  const fast = ema(close, config.fast);
  const slow = ema(close, config.slow);
  const atr14 = atr(candles, 14);
  const adx14 = adx(candles, 14);
  const trades = [];
  let activeUntil = 0;
  for (let i = Math.max(config.slow, 40); i < candles.length - config.maxBars; i++) {
    const c = candles[i];
    if (c.ts <= activeUntil || !fast[i] || !slow[i] || !atr14[i] || !adx14[i]) continue;
    const trendLong = fast[i] > slow[i] && fast[i - 1] <= slow[i - 1];
    const trendShort = fast[i] < slow[i] && fast[i - 1] >= slow[i - 1];
    const continuationLong = fast[i] > slow[i] && c.close > fast[i] && candles[i - 1].low <= fast[i - 1];
    const continuationShort = fast[i] < slow[i] && c.close < fast[i] && candles[i - 1].high >= fast[i - 1];
    const side = trendLong || continuationLong ? "long" : trendShort || continuationShort ? "short" : null;
    if (!side || adx14[i] < config.adxMin) continue;
    const atrPct = (atr14[i] / c.close) * 100;
    if (atrPct < config.atrMinPct || atrPct > config.atrMaxPct) continue;
    const trade = simulateBracket({
      candles,
      startIndex: i,
      symbol,
      side,
      slPct: atrPct * config.slAtr,
      tpPct: Math.max(config.tpMinPct, atrPct * config.tpAtr),
      maxBars: config.maxBars,
      feePct: config.feePctRoundTrip,
      signalId: `ema_adx:${symbol}:${c.ts}:${side}`,
    });
    if (trade) {
      trades.push(trade);
      activeUntil = new Date(trade.exit_ts).getTime();
    }
  }
  return { trades, summary: { signals: trades.length, entries: trades.length } };
}

function runBbSqueezeBreakout(input, { symbol, config }) {
  const candles = resample(input, config.timeframeMin);
  const close = candles.map((c) => c.close);
  const mid = rolling(close, config.bbPeriod, mean);
  const sd = rolling(close, config.bbPeriod, std);
  const volumeAvg = rolling(candles.map((c) => c.volume), 20, mean);
  const width = close.map((v, i) => (mid[i] && sd[i] ? ((4 * sd[i]) / v) * 100 : null));
  const trades = [];
  let activeUntil = 0;
  for (let i = Math.max(config.bbPeriod + config.widthLookback, 60); i < candles.length - config.maxBars; i++) {
    const c = candles[i];
    if (c.ts <= activeUntil || !mid[i] || !sd[i] || !volumeAvg[i] || !width[i]) continue;
    const widths = width.slice(i - config.widthLookback, i).filter(Number.isFinite);
    const squeeze = widths.length && width[i - 1] <= percentile(widths, config.widthQuantile);
    if (!squeeze || c.volume / volumeAvg[i] < config.volumeRatioMin) continue;
    const upper = mid[i] + config.bbMult * sd[i];
    const lower = mid[i] - config.bbMult * sd[i];
    const side = c.close > upper ? "long" : c.close < lower ? "short" : null;
    if (!side) continue;
    const trade = simulateBracket({
      candles,
      startIndex: i,
      symbol,
      side,
      slPct: config.slPct,
      tpPct: config.tpPct,
      maxBars: config.maxBars,
      feePct: config.feePctRoundTrip,
      signalId: `bb_breakout:${symbol}:${c.ts}:${side}`,
    });
    if (trade) {
      trades.push(trade);
      activeUntil = new Date(trade.exit_ts).getTime();
    }
  }
  return { trades, summary: { signals: trades.length, entries: trades.length } };
}

function runRsiBbMeanReversion(input, { symbol, config }) {
  const candles = resample(input, config.timeframeMin);
  const close = candles.map((c) => c.close);
  const mid = rolling(close, config.bbPeriod, mean);
  const sd = rolling(close, config.bbPeriod, std);
  const rsi14 = rsi(close, config.rsiPeriod);
  const atr14 = atr(candles, 14);
  const trades = [];
  let activeUntil = 0;
  for (let i = Math.max(config.bbPeriod, config.rsiPeriod, 40); i < candles.length - config.maxBars; i++) {
    const c = candles[i];
    if (c.ts <= activeUntil || !mid[i] || !sd[i] || !rsi14[i] || !atr14[i]) continue;
    const atrPct = (atr14[i] / c.close) * 100;
    if (atrPct > config.atrMaxPct) continue;
    const lower = mid[i] - config.bbMult * sd[i];
    const upper = mid[i] + config.bbMult * sd[i];
    const side = c.close < lower && rsi14[i] <= config.rsiLow ? "long" : c.close > upper && rsi14[i] >= config.rsiHigh ? "short" : null;
    if (!side) continue;
    const trade = simulateBracket({
      candles,
      startIndex: i,
      symbol,
      side,
      slPct: config.slPct,
      tpPct: config.tpPct,
      maxBars: config.maxBars,
      feePct: config.feePctRoundTrip,
      signalId: `rsi_bb_mr:${symbol}:${c.ts}:${side}`,
    });
    if (trade) {
      trades.push(trade);
      activeUntil = new Date(trade.exit_ts).getTime();
    }
  }
  return { trades, summary: { signals: trades.length, entries: trades.length } };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function profitFactor(pnls) {
  const wins = pnls.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const losses = Math.abs(pnls.filter((v) => v <= 0).reduce((s, v) => s + v, 0));
  return losses === 0 ? (wins > 0 ? 99 : 0) : wins / losses;
}

function maxDrawdown(pnls) {
  let equity = 0;
  let peak = 0;
  let worst = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity - peak);
  }
  return worst;
}

function maxConsecLosses(pnls) {
  let cur = 0;
  let worst = 0;
  for (const pnl of pnls) {
    if (pnl <= 0) {
      cur += 1;
      worst = Math.max(worst, cur);
    } else {
      cur = 0;
    }
  }
  return worst;
}

function trimmedMean(values, trim = 0.1) {
  if (values.length < 5) return mean(values);
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * trim);
  return mean(sorted.slice(cut, sorted.length - cut));
}

function stats(trades) {
  const pnls = trades.map((t) => Number(t.pnl_net_pct)).filter(Number.isFinite);
  const net = pnls.reduce((s, v) => s + v, 0);
  const wins = pnls.filter((v) => v > 0).length;
  const pf = profitFactor(pnls);
  return {
    entries: trades.length,
    wins,
    losses: trades.length - wins,
    win_rate_pct: trades.length ? round((wins / trades.length) * 100, 2) : 0,
    net_pct: round(net, 3),
    avg_net_pct: trades.length ? round(net / trades.length, 4) : 0,
    trimmed_mean_pct: round(trimmedMean(pnls), 4),
    p10_pct: round(percentile(pnls, 0.1), 4),
    profit_factor: round(pf, 2),
    max_dd_pct: round(maxDrawdown(pnls), 3),
    max_consec_losses: maxConsecLosses(pnls),
  };
}

function applyFee(trades, baseFee, stressFee) {
  const delta = stressFee - baseFee;
  return trades.map((t) => ({ ...t, pnl_net_pct: round(Number(t.pnl_net_pct) - delta, 4) }));
}

function fingerprint(trades) {
  const body = trades
    .map((t) => `${t.symbol}:${t.side}:${t.entry_ts}:${t.exit_reason}`)
    .sort()
    .join("|");
  return createHash("sha1").update(body).digest("hex").slice(0, 12);
}

function summarizeWindows({ strategy, market, variant, config, windows, stressWindows }) {
  const windowStats = windows.map((trades, i) => ({ window: i + 1, ...stats(trades), fingerprint: fingerprint(trades) }));
  const stressStats = stressWindows.map((trades, i) => ({ window: i + 1, ...stats(trades) }));
  const allTrades = windows.flat();
  const allStressTrades = stressWindows.flat();
  const full = stats(allTrades);
  const fullStress = stats(allStressTrades);
  const positive = windowStats.filter((w) => w.entries > 0 && w.net_pct > 0).length;
  const active = windowStats.filter((w) => w.entries > 0).length;
  const stressPositive = stressStats.filter((w) => w.entries > 0 && w.net_pct > 0).length;
  const enough = windowStats.filter((w) => w.entries >= 8).length;
  const activeStats = windowStats.filter((w) => w.entries > 0);
  const minAvg = activeStats.length ? Math.min(...activeStats.map((w) => w.avg_net_pct)) : 0;
  const minPf = activeStats.length ? Math.min(...activeStats.map((w) => w.profit_factor)) : 0;
  const worstNet = Math.min(...windowStats.map((w) => w.net_pct), 0);
  const uniqueFingerprints = new Set(windowStats.map((w) => w.fingerprint)).size;
  const status =
    enough >= 4 &&
    positive >= 4 &&
    stressPositive >= 4 &&
    full.entries >= 60 &&
    full.avg_net_pct >= 0.04 &&
    full.profit_factor >= 1.3 &&
    minAvg >= 0.015 &&
    minPf >= 1 &&
    fullStress.net_pct > 0
      ? "magnifique"
      : enough >= 3 &&
          positive >= 3 &&
          stressPositive >= 3 &&
          full.entries >= 40 &&
          full.avg_net_pct >= 0.025 &&
          full.profit_factor >= 1.15 &&
          fullStress.net_pct > 0
        ? "research_candidate"
        : active >= 3 && positive >= 3 && full.net_pct > 0 && fullStress.net_pct >= 0
          ? "shadow_watch"
          : "reject";

  const score =
    positive * 25 +
    stressPositive * 18 +
    enough * 8 +
    Math.max(full.avg_net_pct, -0.15) * 180 +
    Math.max(full.trimmed_mean_pct, -0.15) * 120 +
    Math.max(Math.min(full.profit_factor - 1, 3), -1) * 14 +
    Math.max(full.max_dd_pct, -5) * 5 +
    Math.max(minAvg, -0.15) * 90 +
    Math.max(worstNet, -2) * 4 +
    (status === "magnifique" ? 80 : status === "research_candidate" ? 35 : status === "shadow_watch" ? 10 : 0);

  return {
    strategy,
    market,
    variant,
    config,
    status,
    score: round(score, 2),
    full,
    full_stress: fullStress,
    windows: windowStats,
    stress_windows: stressStats,
    positive_windows: positive,
    active_windows: active,
    stress_positive_windows: stressPositive,
    enough_sample_windows: enough,
    min_window_avg_net_pct: round(minAvg, 4),
    min_window_profit_factor: round(minPf, 2),
    worst_window_net_pct: round(worstNet, 3),
    unique_window_fingerprints: uniqueFingerprints,
  };
}

function btcLeadVariants() {
  const out = [];
  for (const residualZMin of [0.3, 0.55, 0.8]) {
    for (const impulseSigmaMin of [1.4, 1.8, 2.2]) {
      for (const volumeRatioMin of [1.15, 1.35]) {
        for (const minTargetPct of [0.24, 0.34]) {
          out.push({
            id: `ble_rz${residualZMin}_is${impulseSigmaMin}_vol${volumeRatioMin}_t${minTargetPct}`,
            config: {
              scoreMin: 70,
              residualZMin,
              impulseSigmaMin,
              volumeRatioMin,
              minTargetPct,
              maxTargetPct: 0.75,
              maxHoldMin: 8,
              noMoveExitMin: 3,
              noMoveMinPct: 0.08,
              feePctRoundTrip: FEE_BASE,
            },
          });
        }
      }
    }
  }
  return out;
}

function trendVariants() {
  const out = [];
  for (const pullbackAtrMax of [0.45, 0.6, 0.75]) {
    for (const slAtr of [0.65, 0.85]) {
      for (const tpAtr of [1.5, 1.9]) {
        for (const mfeLockPct of [0.4, 0.55]) {
          out.push({
            id: `tss_pb${pullbackAtrMax}_sl${slAtr}_tp${tpAtr}_lock${mfeLockPct}`,
            config: {
              scoreMin: 78,
              volumeMin: 1,
              pullbackAtrMax,
              slAtr,
              tpAtr,
              mfeLockPct,
              lockProfitPct: mfeLockPct >= 0.55 ? 0.28 : 0.22,
              feePctRoundTrip: FEE_BASE,
            },
          });
        }
      }
    }
  }
  return out;
}

const EXTRA_FAMILIES = [
  {
    strategy: "EMA-ADX Scalp 5m",
    variants: [
      { id: "ema_adx_9_21_a18", config: { fast: 9, slow: 21, adxMin: 18, atrMinPct: 0.04, atrMaxPct: 1.2, slAtr: 0.8, tpAtr: 1.6, tpMinPct: 0.24, maxBars: 10, feePctRoundTrip: FEE_BASE } },
      { id: "ema_adx_9_34_a22", config: { fast: 9, slow: 34, adxMin: 22, atrMinPct: 0.04, atrMaxPct: 1.2, slAtr: 0.8, tpAtr: 1.8, tpMinPct: 0.28, maxBars: 12, feePctRoundTrip: FEE_BASE } },
      { id: "ema_adx_12_34_a25", config: { fast: 12, slow: 34, adxMin: 25, atrMinPct: 0.05, atrMaxPct: 1.1, slAtr: 0.7, tpAtr: 1.8, tpMinPct: 0.3, maxBars: 10, feePctRoundTrip: FEE_BASE } },
    ],
    run: runEmaAdxScalp,
  },
  {
    strategy: "BB Squeeze Breakout",
    variants: [
      { id: "bb_sq_5m_q20_tp035", config: { timeframeMin: 5, bbPeriod: 20, bbMult: 2, widthLookback: 72, widthQuantile: 0.2, volumeRatioMin: 1.2, slPct: 0.28, tpPct: 0.35, maxBars: 10, feePctRoundTrip: FEE_BASE } },
      { id: "bb_sq_5m_q15_tp045", config: { timeframeMin: 5, bbPeriod: 20, bbMult: 2, widthLookback: 96, widthQuantile: 0.15, volumeRatioMin: 1.35, slPct: 0.3, tpPct: 0.45, maxBars: 12, feePctRoundTrip: FEE_BASE } },
      { id: "bb_sq_15m_q20_tp06", config: { timeframeMin: 15, bbPeriod: 20, bbMult: 2, widthLookback: 48, widthQuantile: 0.2, volumeRatioMin: 1.15, slPct: 0.42, tpPct: 0.6, maxBars: 8, feePctRoundTrip: FEE_BASE } },
    ],
    run: runBbSqueezeBreakout,
  },
  {
    strategy: "RSI-BB Mean Reversion",
    variants: [
      { id: "rsi_bb_5m_28_72", config: { timeframeMin: 5, bbPeriod: 20, bbMult: 2, rsiPeriod: 14, rsiLow: 28, rsiHigh: 72, atrMaxPct: 1.1, slPct: 0.35, tpPct: 0.28, maxBars: 8, feePctRoundTrip: FEE_BASE } },
      { id: "rsi_bb_5m_25_75", config: { timeframeMin: 5, bbPeriod: 20, bbMult: 2.1, rsiPeriod: 14, rsiLow: 25, rsiHigh: 75, atrMaxPct: 1, slPct: 0.35, tpPct: 0.34, maxBars: 10, feePctRoundTrip: FEE_BASE } },
      { id: "rsi_bb_15m_30_70", config: { timeframeMin: 15, bbPeriod: 20, bbMult: 2, rsiPeriod: 14, rsiLow: 30, rsiHigh: 70, atrMaxPct: 1.4, slPct: 0.5, tpPct: 0.45, maxBars: 6, feePctRoundTrip: FEE_BASE } },
    ],
    run: runRsiBbMeanReversion,
  },
];

function attachNeighborhood(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.strategy}|${row.market}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    const positive = list.filter((r) => ["magnifique", "research_candidate", "shadow_watch"].includes(r.status));
    const uniquePositiveFingerprints = new Set(positive.map((r) => r.windows.map((w) => w.fingerprint).join(":")));
    for (const row of list) {
      row.neighborhood_positive = positive.length;
      row.neighborhood_unique_positive = uniquePositiveFingerprints.size;
      row.neighborhood_total = list.length;
    }
  }
}

function statusRank(status) {
  return { magnifique: 4, research_candidate: 3, shadow_watch: 2, reject: 1 }[status] ?? 0;
}

function compareRows(a, b) {
  return statusRank(b.status) - statusRank(a.status) || b.score - a.score;
}

function renderMarkdown(payload) {
  const rows = [...payload.rows].sort(compareRows);
  const top = rows.slice(0, 40);
  const byStatus = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
  const ln = [];
  ln.push("---");
  ln.push("tags: [report, research-bench, scalper, temporal-cv, public-data]");
  ln.push(`created: ${payload.generated_at.slice(0, 10)}`);
  ln.push("status: complete");
  ln.push("author: Codex");
  ln.push("---");
  ln.push("");
  ln.push(`# ${payload.generated_at.slice(0, 10)} — Scalper Experiment Matrix v3`);
  ln.push("");
  ln.push("## Escopo");
  ln.push("");
  ln.push("- Dados: Bybit public `/v5/market/kline`, 1m.");
  ln.push("- Sem credencial, sem Bybit private, sem monitor, sem ordens.");
  ln.push(`- ${payload.windows} janelas disjuntas de ${payload.window_limit} candles por simbolo.`);
  ln.push(`- Simbolos: ${payload.symbols.join(", ")}.`);
  ln.push(`- Variantes avaliadas: ${payload.rows.length}.`);
  ln.push("");
  ln.push("## Status");
  ln.push("");
  ln.push(`- magnifique: ${byStatus.magnifique ?? 0}`);
  ln.push(`- research_candidate: ${byStatus.research_candidate ?? 0}`);
  ln.push(`- shadow_watch: ${byStatus.shadow_watch ?? 0}`);
  ln.push(`- reject: ${byStatus.reject ?? 0}`);
  ln.push("");
  ln.push("## Veredicto");
  ln.push("");
  const best = rows[0];
  if (!best || statusRank(best.status) < 3) {
    ln.push("Nenhum setup passou como `research_candidate` ou `magnifique`. Nao ha autorizacao cientifica para real automatico.");
  } else {
    ln.push(`Melhor candidato: **${best.strategy} ${best.market} ${best.variant}** (${best.status}).`);
  }
  if (best) {
    ln.push("");
    ln.push(`Topo do ranking: ${best.strategy} ${best.market}, status ${best.status}, full net ${best.full.net_pct}%, avg ${best.full.avg_net_pct}%, PF ${best.full.profit_factor}, stress net ${best.full_stress.net_pct}%, janelas positivas ${best.positive_windows}/${payload.windows}.`);
  }
  ln.push("");
  ln.push("## Top 40");
  ln.push("");
  ln.push("| # | Status | Strategy | Market | Variant | Entries | Net % | Avg % | PF | Stress % | Win Windows | Unique Neigh | Score |");
  ln.push("|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  top.forEach((r, i) => {
    ln.push(`| ${i + 1} | ${r.status} | ${r.strategy} | ${r.market} | ${r.variant} | ${r.full.entries} | ${r.full.net_pct} | ${r.full.avg_net_pct} | ${r.full.profit_factor} | ${r.full_stress.net_pct} | ${r.positive_windows}/${payload.windows} | ${r.neighborhood_unique_positive}/${r.neighborhood_total} | ${r.score} |`);
  });
  ln.push("");
  ln.push("## Barras");
  ln.push("");
  ln.push("- `magnifique`: >=4 janelas com amostra e lucro, stress positivo em >=4, full >=60 trades, avg >=0.04%, PF >=1.3, fee stress positivo.");
  ln.push("- `research_candidate`: >=3 janelas com amostra e lucro, stress positivo em >=3, full >=40 trades, avg >=0.025%, PF >=1.15, fee stress positivo.");
  ln.push("- `shadow_watch`: >=3 janelas ativas/positivas, full e stress nao negativos.");
  ln.push("");
  ln.push("## Guardrails");
  ln.push("");
  ln.push("- Monitor nao foi rodado.");
  ln.push("- `monitor_all.py` nao foi alterado.");
  ln.push("- Bybit private nao foi chamado.");
  ln.push("- Nenhuma ordem foi enviada.");
  ln.push("");
  return `${ln.join("\n")}\n`;
}

async function main() {
  const windows = Number.parseInt(arg("--windows", "5"), 10);
  const windowLimit = Number.parseInt(arg("--window-limit", "10080"), 10);
  const outDir = arg("--out-dir", "/private/tmp/bithub-scalper-matrix-v3");
  const dryRun = flag("--dry-run");
  if (!Number.isFinite(windows) || windows < 3) throw new Error("--windows must be >= 3");
  if (!Number.isFinite(windowLimit) || windowLimit < 3000) throw new Error("--window-limit must be >= 3000");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const totalLimit = windows * windowLimit;
  const candles = {};
  if (!dryRun) {
    console.error(`[v3] fetching ${SYMBOLS.length} symbols, ${windows}x${windowLimit}=${totalLimit} candles each`);
    for (const symbol of SYMBOLS) {
      const started = Date.now();
      candles[symbol] = await loadOrFetchKlines(symbol, totalLimit, outDir);
      console.error(`  ${symbol}: ${candles[symbol].length} candles in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  } else {
    console.error("[v3] dry-run: syntax and planning only");
    for (const symbol of SYMBOLS) candles[symbol] = [];
  }

  const symbolWindows = Object.fromEntries(Object.entries(candles).map(([symbol, rows]) => [symbol, splitWindows(rows, windows, windowLimit)]));
  const rows = [];

  if (!dryRun) {
    for (const alt of ALTS) {
      for (const variant of btcLeadVariants()) {
        const tradeWindows = [];
        const stressWindows = [];
        for (let i = 0; i < windows; i++) {
          const result = runBtcLeadAltEcho({
            leadCandles: symbolWindows[LEAD][i],
            altCandles: symbolWindows[alt][i],
            leadSymbol: LEAD,
            altSymbol: alt,
            config: variant.config,
          });
          tradeWindows.push(result.trades);
          stressWindows.push(applyFee(result.trades, FEE_BASE, FEE_STRESS));
        }
        rows.push(summarizeWindows({ strategy: "BTC-Lead Alt-Echo", market: `${LEAD}->${alt}`, variant: variant.id, config: variant.config, windows: tradeWindows, stressWindows }));
      }
    }

    for (const symbol of SYMBOLS) {
      for (const variant of trendVariants()) {
        const tradeWindows = [];
        const stressWindows = [];
        for (let i = 0; i < windows; i++) {
          const result = runTrendSurfBacktest(symbolWindows[symbol][i], { symbol, config: variant.config });
          tradeWindows.push(result.trades);
          stressWindows.push(applyFee(result.trades, FEE_BASE, FEE_STRESS));
        }
        rows.push(summarizeWindows({ strategy: "Trend Surf Scalp", market: symbol, variant: variant.id, config: variant.config, windows: tradeWindows, stressWindows }));
      }

      for (const family of EXTRA_FAMILIES) {
        for (const variant of family.variants) {
          const tradeWindows = [];
          const stressWindows = [];
          for (let i = 0; i < windows; i++) {
            const result = family.run(symbolWindows[symbol][i], { symbol, config: variant.config });
            tradeWindows.push(result.trades);
            stressWindows.push(applyFee(result.trades, FEE_BASE, FEE_STRESS));
          }
          rows.push(summarizeWindows({ strategy: family.strategy, market: symbol, variant: variant.id, config: variant.config, windows: tradeWindows, stressWindows }));
        }
      }
    }
  }

  attachNeighborhood(rows);
  rows.sort(compareRows);

  const payload = {
    generated_at: new Date().toISOString(),
    guardrails: {
      public_bybit_only: true,
      private_bybit_called: false,
      monitor_started: false,
      orders_sent: false,
    },
    windows,
    window_limit: windowLimit,
    total_limit: totalLimit,
    fee_base: FEE_BASE,
    fee_stress: FEE_STRESS,
    symbols: SYMBOLS,
    coverage: Object.fromEntries(
      Object.entries(symbolWindows).map(([symbol, lists]) => [
        symbol,
        lists.map((list, i) => ({ window: i + 1, count: list.length, from: list[0] ? toIso(list[0].ts) : null, to: list.at(-1) ? toIso(list.at(-1).ts) : null })),
      ]),
    ),
    rows,
  };

  const base = `scalper-experiment-matrix-v3-${nowStamp()}`;
  const jsonPath = join(outDir, `${base}.json`);
  const mdPath = join(outDir, `${base}.md`);
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeFileSync(mdPath, renderMarkdown(payload));

  console.log(
    JSON.stringify(
      {
        ok: true,
        json: jsonPath,
        markdown: mdPath,
        rows: rows.length,
        by_status: rows.reduce((acc, row) => {
          acc[row.status] = (acc[row.status] ?? 0) + 1;
          return acc;
        }, {}),
        best: rows[0] ?? null,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
    process.exit(1);
  });
}
