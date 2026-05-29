#!/usr/bin/env node
// trend-surf-scalp.mjs — Strategy Library shadow/backtest runner
//
// Strategy: "surfar tendencia" em vez de caçar flush isolado.
// - Regime: 15m/1h define bias.
// - Setup: 5m pullback em EMA9/EMA21.
// - Trigger: retomada curta do fluxo no 5m, proxy de tape para shadow.
// - Exit: SL menor e mais cedo que o modelo antigo, TP/trail por ATR + MFE lock.
//
// Uso:
//   node scripts/trend-surf-scalp.mjs --synthetic
//   node scripts/trend-surf-scalp.mjs --file candles.json --symbol BTCUSDT
//   node scripts/trend-surf-scalp.mjs --bybit --symbol BTCUSDT --limit 1000

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const STRATEGY_VERSION_ID = "trend_surf_scalp_v1_20260528";

const DEFAULT_CONFIG = {
  scoreMin: 75,
  volumeMin: 0.8,
  pullbackAtrMax: 0.65,
  slAtr: 0.95,
  tpAtr: 1.35,
  maxHoldBars5m: 12,
  mfeLockPct: 0.35,
  lockProfitPct: 0.18,
  feePctRoundTrip: 0.11,
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function toIso(ts) {
  return new Date(ts).toISOString().replace(/\.\d+Z$/, "Z");
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCandle(c) {
  const ts = c.ts ?? c.timestamp ?? c.time ?? c.start;
  return {
    ts: typeof ts === "number" ? ts : new Date(ts).getTime(),
    open: asNumber(c.open),
    high: asNumber(c.high),
    low: asNumber(c.low),
    close: asNumber(c.close),
    volume: asNumber(c.volume ?? c.vol),
  };
}

function normalizeBybitKline(row) {
  return {
    ts: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

export function ema(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rollingAvg(values, period) {
  const out = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function atr(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  return rollingAvg(trs, period);
}

export function resampleCandles(candles, minutes) {
  const bucketMs = minutes * 60_000;
  const sorted = [...candles].sort((a, b) => a.ts - b.ts);
  const buckets = new Map();
  for (const c of sorted) {
    const key = Math.floor(c.ts / bucketMs) * bucketMs;
    const b = buckets.get(key);
    if (!b) {
      buckets.set(key, { ts: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

function enrich(candles) {
  const close = candles.map((c) => c.close);
  const volume = candles.map((c) => c.volume);
  const ema9 = ema(close, 9);
  const ema21 = ema(close, 21);
  const ema50 = ema(close, 50);
  const atr14 = atr(candles, 14);
  const vol20 = rollingAvg(volume, 20);
  return candles.map((c, i) => ({
    ...c,
    ema9: ema9[i],
    ema21: ema21[i],
    ema50: ema50[i],
    atr14: atr14[i],
    volAvg20: vol20[i],
    volumeRatio: vol20[i] ? c.volume / vol20[i] : null,
  }));
}

function latestBefore(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (candles[mid].ts <= ts) {
      best = candles[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function pct(from, to, side) {
  const raw = ((to - from) / from) * 100;
  return side === "short" ? -raw : raw;
}

function trendSide(c) {
  if (!c?.ema9) return null;
  if (c.ema21 && c.ema50) {
    if (c.close > c.ema21 && c.ema21 > c.ema50) return "long";
    if (c.close < c.ema21 && c.ema21 < c.ema50) return "short";
    return null;
  }
  if (c.ema21) {
    if (c.close > c.ema9 && c.ema9 > c.ema21) return "long";
    if (c.close < c.ema9 && c.ema9 < c.ema21) return "short";
    return null;
  }
  if (c.close > c.ema9) return "long";
  if (c.close < c.ema9) return "short";
  return null;
}

function scoreSignal({ c, prev, h15, h60 }, config) {
  if (!c?.ema9 || !c?.ema21 || !c?.ema50 || !c?.atr14 || !prev) return null;
  const side15 = trendSide(h15);
  const side60 = trendSide(h60);
  const side5 =
    c.close > c.ema9 && c.ema9 > c.ema21 && c.ema21 > c.ema50
      ? "long"
      : c.close < c.ema9 && c.ema9 < c.ema21 && c.ema21 < c.ema50
        ? "short"
        : null;
  if (!side5 || side5 !== side15 || side5 !== side60) return null;

  const side = side5;
  const anchor = Math.abs(c.close - c.ema21) <= Math.abs(c.close - c.ema9) ? "ema21_5m" : "ema9_5m";
  const anchorPrice = anchor === "ema21_5m" ? c.ema21 : c.ema9;
  const atrPct = (c.atr14 / c.close) * 100;
  const anchorDistAtr = Math.abs(c.close - anchorPrice) / c.atr14;
  const touchedAnchor =
    side === "long"
      ? c.low <= anchorPrice * 1.0015 || prev.low <= anchorPrice * 1.0015
      : c.high >= anchorPrice * 0.9985 || prev.high >= anchorPrice * 0.9985;
  const pullbackOk = touchedAnchor && anchorDistAtr <= config.pullbackAtrMax;
  const triggerOk =
    side === "long"
      ? (c.close > prev.high || c.close > c.ema9) && c.close > prev.close
      : (c.close < prev.low || c.close < c.ema9) && c.close < prev.close;
  const volumeRatio = c.volumeRatio ?? 0;
  const volumeOk = volumeRatio >= config.volumeMin;
  const notOverextended = anchorDistAtr <= 0.8 && atrPct <= 2.5;

  let score = 0;
  score += 25; // 5m/15m/1h alignment
  score += Math.min(20, Math.max(0, 20 - anchorDistAtr * 16));
  score += pullbackOk ? 20 : touchedAnchor ? 10 : 0;
  score += triggerOk ? 20 : 0;
  score += Math.min(10, volumeRatio * 8);
  score += notOverextended ? 5 : 0;

  const decision = score >= config.scoreMin && pullbackOk && triggerOk && volumeOk ? "enter" : "skip";
  return {
    side,
    decision,
    score: Math.round(score),
    confidence: Number(Math.min(0.95, Math.max(0.2, score / 100)).toFixed(2)),
    expectedEdge: Number(((score - 50) / 100).toFixed(3)),
    reason:
      decision === "enter"
        ? `${side} trend aligned; pullback held ${anchor}; trigger resumed`
        : `score=${Math.round(score)} pullback=${pullbackOk} trigger=${triggerOk} volume=${volumeRatio.toFixed(2)}`,
    features: {
      side5,
      side15,
      side60,
      anchor,
      anchor_dist_atr: Number(anchorDistAtr.toFixed(3)),
      atr_pct: Number(atrPct.toFixed(3)),
      volume_ratio: Number(volumeRatio.toFixed(3)),
      touched_anchor: touchedAnchor,
      trigger_ok: triggerOk,
    },
  };
}

function managePosition(position, c, config) {
  const mfePct = position.side === "long" ? pct(position.entry, c.high, "long") : pct(position.entry, c.low, "short");
  const maePct = position.side === "long" ? pct(position.entry, c.low, "long") : pct(position.entry, c.high, "short");
  position.mfe_pct = Math.max(position.mfe_pct, mfePct);
  position.mae_pct = Math.min(position.mae_pct, maePct);

  if (position.mfe_pct >= config.mfeLockPct) {
    const lock =
      position.side === "long"
        ? position.entry * (1 + config.lockProfitPct / 100)
        : position.entry * (1 - config.lockProfitPct / 100);
    position.sl = position.side === "long" ? Math.max(position.sl, lock) : Math.min(position.sl, lock);
  }

  const hitSl = position.side === "long" ? c.low <= position.sl : c.high >= position.sl;
  const hitTp = position.side === "long" ? c.high >= position.tp : c.low <= position.tp;
  const softAdverse =
    position.side === "long"
      ? c.close < c.ema21 && c.close < c.open && pct(position.entry, c.close, "long") < -0.08
      : c.close > c.ema21 && c.close > c.open && pct(position.entry, c.close, "short") < -0.08;
  const timedOut = position.bars_held >= config.maxHoldBars5m;

  if (hitSl) return { exit: true, price: position.sl, reason: "sl_or_profit_lock" };
  if (hitTp) return { exit: true, price: position.tp, reason: "tp_atr" };
  if (softAdverse) return { exit: true, price: c.close, reason: "soft_sl_trend_lost" };
  if (timedOut) return { exit: true, price: c.close, reason: "time_exit" };
  return { exit: false };
}

function makeSignal(strategyVersionId, symbol, c, signal) {
  const ts = toIso(c.ts);
  const body = `${strategyVersionId}:${ts}:${symbol}:${signal.side}:${signal.score}`;
  const hash = createHash("sha1").update(body).digest("hex").slice(0, 10);
  return {
    client_signal_id: `${strategyVersionId}:${ts}:${symbol}:${hash}`,
    strategy_version_id: strategyVersionId,
    ts,
    symbol,
    side: signal.side,
    decision: signal.decision,
    confidence: signal.confidence,
    expected_edge: signal.expectedEdge,
    setup_score: signal.score,
    regime_snapshot_json: {
      trend_5m: signal.features.side5,
      trend_15m: signal.features.side15,
      trend_1h: signal.features.side60,
    },
    features_json: signal.features,
    reason: signal.reason,
    entered: signal.decision === "enter",
  };
}

export function runTrendSurfBacktest(inputCandles, opts = {}) {
  const symbol = opts.symbol ?? "SYNTHUSDT";
  const config = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
  const candles1m = inputCandles.map(normalizeCandle).filter((c) => c.ts && c.open && c.high && c.low && c.close);
  const candles5m = enrich(resampleCandles(candles1m, 5));
  const candles15m = enrich(resampleCandles(candles1m, 15));
  const candles60m = enrich(resampleCandles(candles1m, 60));

  const signals = [];
  const outcomes = [];
  const trades = [];
  let position = null;

  for (let i = 60; i < candles5m.length; i++) {
    const c = candles5m[i];
    const prev = candles5m[i - 1];

    if (position) {
      position.bars_held += 1;
      const verdict = managePosition(position, c, config);
      if (verdict.exit) {
        const pnlGrossPct = pct(position.entry, verdict.price, position.side);
        const pnlNetPct = pnlGrossPct - config.feePctRoundTrip;
        const trade = {
          ...position,
          exit_ts: toIso(c.ts),
          exit_price: Number(verdict.price.toFixed(8)),
          exit_reason: verdict.reason,
          pnl_gross_pct: Number(pnlGrossPct.toFixed(3)),
          pnl_net_pct: Number(pnlNetPct.toFixed(3)),
          mfe_pct: Number(position.mfe_pct.toFixed(3)),
          mae_pct: Number(position.mae_pct.toFixed(3)),
        };
        trades.push(trade);
        outcomes.push({
          client_signal_id: position.client_signal_id,
          ts: trade.exit_ts,
          horizon_sec: Math.round((c.ts - new Date(position.entry_ts).getTime()) / 1000),
          mfe_pct: trade.mfe_pct,
          mae_pct: trade.mae_pct,
          exit_reason: trade.exit_reason,
          pnl_gross_usd: null,
          fee_usd: null,
          pnl_net_usd: null,
          label: trade.pnl_net_pct > 0 ? "win" : "loss",
        });
        position = null;
      }
      continue;
    }

    const h15 = latestBefore(candles15m, c.ts);
    const h60 = latestBefore(candles60m, c.ts);
    const scored = scoreSignal({ c, prev, h15, h60 }, config);
    if (!scored) continue;

    const signal = makeSignal(STRATEGY_VERSION_ID, symbol, c, scored);
    signals.push(signal);
    if (signal.decision !== "enter") continue;

    const atrValue = c.atr14;
    const entry = c.close;
    const sl = scored.side === "long" ? entry - atrValue * config.slAtr : entry + atrValue * config.slAtr;
    const tp = scored.side === "long" ? entry + atrValue * config.tpAtr : entry - atrValue * config.tpAtr;
    position = {
      client_signal_id: signal.client_signal_id,
      symbol,
      side: scored.side,
      entry_ts: toIso(c.ts),
      entry: Number(entry.toFixed(8)),
      sl: Number(sl.toFixed(8)),
      tp: Number(tp.toFixed(8)),
      bars_held: 0,
      mfe_pct: 0,
      mae_pct: 0,
      setup_score: signal.setup_score,
      confidence: signal.confidence,
      features: signal.features_json,
    };
  }

  if (position) {
    const c = candles5m[candles5m.length - 1];
    const pnlGrossPct = pct(position.entry, c.close, position.side);
    const pnlNetPct = pnlGrossPct - config.feePctRoundTrip;
    trades.push({
      ...position,
      exit_ts: toIso(c.ts),
      exit_price: Number(c.close.toFixed(8)),
      exit_reason: "dataset_end",
      pnl_gross_pct: Number(pnlGrossPct.toFixed(3)),
      pnl_net_pct: Number(pnlNetPct.toFixed(3)),
      mfe_pct: Number(position.mfe_pct.toFixed(3)),
      mae_pct: Number(position.mae_pct.toFixed(3)),
    });
  }

  const wins = trades.filter((t) => t.pnl_net_pct > 0).length;
  const gross = trades.reduce((s, t) => s + t.pnl_gross_pct, 0);
  const net = trades.reduce((s, t) => s + t.pnl_net_pct, 0);
  const summary = {
    strategy_version_id: STRATEGY_VERSION_ID,
    symbol,
    candles_1m: candles1m.length,
    candles_5m: candles5m.length,
    signals: signals.length,
    entries: trades.length,
    wins,
    losses: trades.length - wins,
    win_rate_pct: trades.length ? Number(((wins / trades.length) * 100).toFixed(2)) : 0,
    pnl_gross_pct: Number(gross.toFixed(3)),
    pnl_net_pct: Number(net.toFixed(3)),
    avg_net_pct: trades.length ? Number((net / trades.length).toFixed(3)) : 0,
  };
  return { summary, signals, outcomes, trades, config };
}

export function syntheticCandles({ start = "2026-05-28T00:00:00Z", minutes = 900 } = {}) {
  const out = [];
  let price = 100;
  let seed = 42;
  function rand() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }
  const startMs = new Date(start).getTime();
  for (let i = 0; i < minutes; i++) {
    const phase = Math.floor(i / 120) % 4;
    const drift = phase === 0 ? 0.045 : phase === 1 ? -0.012 : phase === 2 ? -0.04 : 0.018;
    const wave = Math.sin(i / 9) * 0.055;
    const noise = (rand() - 0.5) * 0.08;
    const open = price;
    price = Math.max(1, price * (1 + (drift + wave + noise) / 100));
    const high = Math.max(open, price) * (1 + (0.02 + rand() * 0.06) / 100);
    const low = Math.min(open, price) * (1 - (0.02 + rand() * 0.06) / 100);
    const volume = 1000 + Math.abs(drift) * 12000 + rand() * 700;
    out.push({ ts: startMs + i * 60_000, open, high, low, close: price, volume });
  }
  return out;
}

async function loadCandlesFromBybit(symbol, limit) {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=1&limit=${limit}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.retCode !== 0) throw new Error(`Bybit kline failed: ${json.retMsg ?? json.retCode}`);
  return json.result.list.map(normalizeBybitKline).sort((a, b) => a.ts - b.ts);
}

async function main() {
  const symbol = arg("--symbol", "SYNTHUSDT");
  const limit = parseInt(arg("--limit", "1000"), 10);
  let candles;
  if (flag("--synthetic")) {
    candles = syntheticCandles({ minutes: limit });
  } else if (flag("--bybit")) {
    candles = await loadCandlesFromBybit(symbol, limit);
  } else {
    const file = arg("--file");
    if (!file) {
      console.error("Use --synthetic, --bybit, or --file candles.json");
      process.exit(2);
    }
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    candles = Array.isArray(parsed) ? parsed : parsed.candles;
  }

  const result = runTrendSurfBacktest(candles, { symbol });
  const stateDir = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");
  const outDir = arg("--out-dir", join(stateDir, "strategy-runs"));
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${STRATEGY_VERSION_ID}-${symbol}-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: true, out: outPath, summary: result.summary }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  });
}
