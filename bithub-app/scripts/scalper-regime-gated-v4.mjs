#!/usr/bin/env node
// scalper-regime-gated-v4.mjs — conditional/regime analysis for scalp setups.
//
// Read-only. Uses cached Bybit public klines from the v3 experiment by
// default. Does not read secrets, call private APIs, start monitor, or order.
//
// Goal: stop asking "does this setup always work?" and ask "does this setup
// work inside a repeatable regime bucket?"
//
// Usage:
//   node scripts/scalper-regime-gated-v4.mjs \
//     --cache-dir /private/tmp/bithub-scalper-matrix-v3 \
//     --limit 50400

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runBtcLeadAltEcho } from "./btc-lead-alt-echo.mjs";

const LEAD = "BTCUSDT";
const ETH = "ETHUSDT";
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "LINKUSDT", "SUIUSDT", "HYPEUSDT"];
const ALTS = ["SUIUSDT", "LINKUSDT", "SOLUSDT", "BNBUSDT", "HYPEUSDT"];
const FEE_BASE = 0.11;
const FEE_STRESS = 0.15;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function round(v, d = 3) {
  if (!Number.isFinite(v)) return 0;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

function toIso(ts) {
  return new Date(ts).toISOString().replace(/\.\d+Z$/, "Z");
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function std(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

function pct(from, to, side = "long") {
  const raw = ((to - from) / from) * 100;
  return side === "short" ? -raw : raw;
}

function loadCached(symbol, limit, cacheDir) {
  const path = join(cacheDir, `.klines-${symbol}-${limit}.json`);
  if (!existsSync(path)) throw new Error(`missing cache for ${symbol}: ${path}`);
  const rows = JSON.parse(readFileSync(path, "utf8"));
  return rows.slice(-limit).sort((a, b) => a.ts - b.ts);
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

function rolling(values, period, fn) {
  return values.map((_, i) => (i + 1 >= period ? fn(values.slice(i + 1 - period, i + 1)) : null));
}

function nearestBefore(candles, ts) {
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

function indexBefore(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (candles[mid].ts <= ts) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function sessionUtc(ts) {
  const h = new Date(ts).getUTCHours();
  if (h >= 0 && h < 8) return "asia";
  if (h >= 8 && h < 14) return "europe";
  if (h >= 14 && h < 21) return "us";
  return "late";
}

function trendLabel(retPct) {
  if (retPct >= 1.0) return "up";
  if (retPct <= -1.0) return "down";
  return "flat";
}

function biasLabel(btcTrend, ethTrend) {
  if (btcTrend === "up" && ethTrend === "up") return "aligned_bull";
  if (btcTrend === "down" && ethTrend === "down") return "aligned_bear";
  if (btcTrend === "flat" && ethTrend === "flat") return "flat";
  return "mixed";
}

function volLabel(atrPct) {
  if (atrPct >= 1.2) return "high";
  if (atrPct <= 0.55) return "low";
  return "normal";
}

function relStrengthLabel(altRet, btcRet) {
  const diff = altRet - btcRet;
  if (diff >= 1.2) return "alt_strong";
  if (diff <= -1.2) return "alt_weak";
  return "alt_neutral";
}

function buildRegimeContext(candlesBySymbol) {
  const btc1h = resample(candlesBySymbol[LEAD], 60);
  const eth1h = resample(candlesBySymbol[ETH], 60);
  const byAlt = Object.fromEntries(ALTS.map((s) => [s, resample(candlesBySymbol[s], 60)]));
  const btcRange = btc1h.map((c, i) => {
    if (i === 0) return 0;
    const prev = btc1h[i - 1].close;
    return (Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)) / c.close) * 100;
  });
  const btcAtr24 = rolling(btcRange, 24, mean);

  return function labelTrade(trade) {
    const ts = new Date(trade.entry_ts).getTime();
    const bi = indexBefore(btc1h, ts);
    const ei = indexBefore(eth1h, ts);
    const alt1h = byAlt[trade.symbol];
    const ai = indexBefore(alt1h ?? [], ts);
    const btc4hRet = bi >= 4 ? pct(btc1h[bi - 4].close, btc1h[bi].close) : 0;
    const eth4hRet = ei >= 4 ? pct(eth1h[ei - 4].close, eth1h[ei].close) : 0;
    const alt4hRet = ai >= 4 ? pct(alt1h[ai - 4].close, alt1h[ai].close) : 0;
    const btcTrend = trendLabel(btc4hRet);
    const ethTrend = trendLabel(eth4hRet);
    const bias = biasLabel(btcTrend, ethTrend);
    const vol = volLabel(btcAtr24[bi] ?? 0);
    const rel = relStrengthLabel(alt4hRet, btc4hRet);
    const sess = sessionUtc(ts);
    return {
      session: sess,
      btc_trend_4h: btcTrend,
      eth_trend_4h: ethTrend,
      btc_eth_bias: bias,
      btc_vol_24h: vol,
      alt_rel_4h: rel,
      keys: {
        session: `session=${sess}`,
        bias: `bias=${bias}`,
        vol: `vol=${vol}`,
        rel: `rel=${rel}`,
        bias_vol: `bias=${bias}|vol=${vol}`,
        bias_rel: `bias=${bias}|rel=${rel}`,
        session_bias: `session=${sess}|bias=${bias}`,
        vol_rel: `vol=${vol}|rel=${rel}`,
        full: `session=${sess}|bias=${bias}|vol=${vol}|rel=${rel}`,
      },
    };
  };
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
  return { trades };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function applyFee(trades, baseFee, stressFee) {
  const delta = stressFee - baseFee;
  return trades.map((t) => ({ ...t, pnl_net_pct: round(Number(t.pnl_net_pct) - delta, 4) }));
}

function stats(trades) {
  const pnls = trades.map((t) => Number(t.pnl_net_pct)).filter(Number.isFinite);
  const wins = pnls.filter((v) => v > 0).length;
  const grossWin = pnls.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(pnls.filter((v) => v <= 0).reduce((s, v) => s + v, 0));
  const net = pnls.reduce((s, v) => s + v, 0);
  return {
    entries: trades.length,
    wins,
    losses: trades.length - wins,
    win_rate_pct: trades.length ? round((wins / trades.length) * 100, 2) : 0,
    net_pct: round(net, 3),
    avg_net_pct: trades.length ? round(net / trades.length, 4) : 0,
    profit_factor: round(grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss, 2),
    max_dd_pct: round(maxDrawdown(pnls), 3),
  };
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

function splitWindowsByTs(trades, startTs, endTs, windows) {
  const width = (endTs - startTs) / windows;
  return Array.from({ length: windows }, (_, i) => {
    const from = startTs + width * i;
    const to = i === windows - 1 ? endTs + 1 : startTs + width * (i + 1);
    return trades.filter((t) => {
      const ts = new Date(t.entry_ts).getTime();
      return ts >= from && ts < to;
    });
  });
}

function hashTrades(trades) {
  return createHash("sha1")
    .update(trades.map((t) => `${t.symbol}:${t.side}:${t.entry_ts}:${t.exit_ts}`).sort().join("|"))
    .digest("hex")
    .slice(0, 12);
}

function scoreBucket({ base, stress, windowStats, stressWindowStats }) {
  const positiveWindows = windowStats.filter((w) => w.entries > 0 && w.net_pct > 0).length;
  const stressPositiveWindows = stressWindowStats.filter((w) => w.entries > 0 && w.net_pct > 0).length;
  const enoughWindows = windowStats.filter((w) => w.entries >= 5).length;
  const worstWindow = Math.min(...windowStats.map((w) => w.net_pct), 0);
  const worstStressWindow = Math.min(...stressWindowStats.map((w) => w.net_pct), 0);
  const status =
    base.entries >= 24 &&
    stress.net_pct > 0 &&
    base.avg_net_pct >= 0.04 &&
    base.profit_factor >= 1.25 &&
    positiveWindows >= 4 &&
    stressPositiveWindows >= 3 &&
    enoughWindows >= 3 &&
    worstWindow >= -0.8
      ? "regime_candidate"
      : base.entries >= 16 && base.net_pct > 0 && stress.net_pct >= 0 && positiveWindows >= 3 && stressPositiveWindows >= 2
        ? "regime_watch"
        : "reject";
  const score =
    positiveWindows * 28 +
    stressPositiveWindows * 20 +
    enoughWindows * 8 +
    Math.max(base.avg_net_pct, -0.2) * 220 +
    Math.max(stress.avg_net_pct, -0.2) * 160 +
    Math.max(base.profit_factor - 1, -1) * 14 +
    Math.max(base.max_dd_pct, -5) * 4 +
    Math.max(worstStressWindow, -2) * 8 +
    (status === "regime_candidate" ? 60 : status === "regime_watch" ? 20 : 0);
  return {
    status,
    score: round(score, 2),
    positiveWindows,
    stressPositiveWindows,
    enoughWindows,
    worstWindow: round(worstWindow, 3),
    worstStressWindow: round(worstStressWindow, 3),
  };
}

function evaluateRegimeBuckets({ strategy, market, variant, trades, labelTrade, startTs, endTs, windows }) {
  const enriched = trades.map((trade) => ({ ...trade, regime: labelTrade(trade) }));
  const byKey = new Map();
  for (const trade of enriched) {
    for (const [scope, key] of Object.entries(trade.regime.keys)) {
      const bucketKey = `${scope}:${key}`;
      const list = byKey.get(bucketKey) ?? [];
      list.push(trade);
      byKey.set(bucketKey, list);
    }
  }
  const rows = [];
  for (const [bucket, bucketTrades] of byKey.entries()) {
    const base = stats(bucketTrades);
    const stressTrades = applyFee(bucketTrades, FEE_BASE, FEE_STRESS);
    const stress = stats(stressTrades);
    const windowStats = splitWindowsByTs(bucketTrades, startTs, endTs, windows).map((w, i) => ({ window: i + 1, ...stats(w) }));
    const stressWindowStats = splitWindowsByTs(stressTrades, startTs, endTs, windows).map((w, i) => ({ window: i + 1, ...stats(w) }));
    const scored = scoreBucket({ base, stress, windowStats, stressWindowStats });
    rows.push({
      strategy,
      market,
      variant,
      bucket,
      status: scored.status,
      score: scored.score,
      positive_windows: scored.positiveWindows,
      stress_positive_windows: scored.stressPositiveWindows,
      enough_windows: scored.enoughWindows,
      worst_window_net_pct: scored.worstWindow,
      worst_stress_window_net_pct: scored.worstStressWindow,
      fingerprint: hashTrades(bucketTrades),
      base,
      stress,
      windows: windowStats,
      stress_windows: stressWindowStats,
    });
  }
  return rows;
}

function btcLeadVariants() {
  const out = [];
  for (const residualZMin of [0.3, 0.55, 0.8]) {
    for (const impulseSigmaMin of [1.8, 2.2, 2.6]) {
      for (const volumeRatioMin of [1.25, 1.35, 1.55]) {
        for (const minTargetPct of [0.34, 0.44]) {
          out.push({
            id: `ble_rz${residualZMin}_is${impulseSigmaMin}_vol${volumeRatioMin}_t${minTargetPct}`,
            config: {
              scoreMin: 70,
              residualZMin,
              impulseSigmaMin,
              volumeRatioMin,
              minTargetPct,
              maxTargetPct: 0.9,
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

function bbVariants() {
  return [
    { id: "bb_sq_15m_q20_tp06", config: { timeframeMin: 15, bbPeriod: 20, bbMult: 2, widthLookback: 48, widthQuantile: 0.2, volumeRatioMin: 1.15, slPct: 0.42, tpPct: 0.6, maxBars: 8, feePctRoundTrip: FEE_BASE } },
    { id: "bb_sq_15m_q15_tp075", config: { timeframeMin: 15, bbPeriod: 20, bbMult: 2, widthLookback: 72, widthQuantile: 0.15, volumeRatioMin: 1.25, slPct: 0.5, tpPct: 0.75, maxBars: 8, feePctRoundTrip: FEE_BASE } },
    { id: "bb_sq_5m_q15_tp045", config: { timeframeMin: 5, bbPeriod: 20, bbMult: 2, widthLookback: 96, widthQuantile: 0.15, volumeRatioMin: 1.35, slPct: 0.3, tpPct: 0.45, maxBars: 12, feePctRoundTrip: FEE_BASE } },
  ];
}

function statusRank(status) {
  return { regime_candidate: 3, regime_watch: 2, reject: 1 }[status] ?? 0;
}

function compareRows(a, b) {
  return statusRank(b.status) - statusRank(a.status) || b.score - a.score;
}

function attachNeighborhood(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.strategy}|${row.market}|${row.bucket}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    const positive = list.filter((r) => r.status !== "reject");
    const unique = new Set(positive.map((r) => r.fingerprint));
    for (const row of list) {
      row.neighborhood_positive = positive.length;
      row.neighborhood_unique_positive = unique.size;
      row.neighborhood_total = list.length;
    }
  }
}

function renderMarkdown(payload) {
  const rows = [...payload.rows].sort(compareRows);
  const byStatus = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const ln = [];
  ln.push("---");
  ln.push("tags: [report, research-bench, scalper, regime-gated, public-data]");
  ln.push(`created: ${payload.generated_at.slice(0, 10)}`);
  ln.push("status: complete");
  ln.push("author: Codex");
  ln.push("---");
  ln.push("");
  ln.push(`# ${payload.generated_at.slice(0, 10)} — Scalper Regime-Gated v4`);
  ln.push("");
  ln.push("## Escopo");
  ln.push("");
  ln.push("- Dados: cache local de klines publicos Bybit gerado pela v3.");
  ln.push("- Sem credencial, sem Bybit private, sem monitor, sem ordens.");
  ln.push(`- Candles por simbolo: ${payload.limit}.`);
  ln.push(`- Buckets avaliados: ${payload.rows.length}.`);
  ln.push("");
  ln.push("## Status");
  ln.push("");
  ln.push(`- regime_candidate: ${byStatus.regime_candidate ?? 0}`);
  ln.push(`- regime_watch: ${byStatus.regime_watch ?? 0}`);
  ln.push(`- reject: ${byStatus.reject ?? 0}`);
  ln.push("");
  ln.push("## Veredicto");
  ln.push("");
  const best = rows[0];
  if (!best || best.status !== "regime_candidate") {
    ln.push("Nenhum bucket virou `regime_candidate`. Ainda nao ha autorizacao cientifica para real automatico.");
  } else {
    ln.push(`Melhor candidato: **${best.strategy} ${best.market} ${best.bucket}**.`);
  }
  if (best) {
    ln.push("");
    ln.push(`Topo: ${best.strategy} ${best.market} ${best.variant} em \`${best.bucket}\`, status ${best.status}, entries ${best.base.entries}, net ${best.base.net_pct}%, avg ${best.base.avg_net_pct}%, PF ${best.base.profit_factor}, stress ${best.stress.net_pct}%, janelas positivas ${best.positive_windows}/${payload.windows}, stress positivas ${best.stress_positive_windows}/${payload.windows}.`);
  }
  ln.push("");
  ln.push("## Top 30");
  ln.push("");
  ln.push("| # | Status | Strategy | Market | Bucket | Variant | Entries | Net % | Avg % | PF | Stress % | Win Windows | Stress Windows | Unique Neigh | Score |");
  ln.push("|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  rows.slice(0, 30).forEach((r, i) => {
    ln.push(`| ${i + 1} | ${r.status} | ${r.strategy} | ${r.market} | ${r.bucket} | ${r.variant} | ${r.base.entries} | ${r.base.net_pct} | ${r.base.avg_net_pct} | ${r.base.profit_factor} | ${r.stress.net_pct} | ${r.positive_windows}/${payload.windows} | ${r.stress_positive_windows}/${payload.windows} | ${r.neighborhood_unique_positive}/${r.neighborhood_total} | ${r.score} |`);
  });
  ln.push("");
  ln.push("## Barras");
  ln.push("");
  ln.push("- `regime_candidate`: >=24 trades no bucket, stress positivo, avg >=0.04%, PF >=1.25, >=4 janelas positivas, >=3 janelas stress positivas, worst window >= -0.8%.");
  ln.push("- `regime_watch`: >=16 trades, net positivo, stress nao negativo, >=3 janelas positivas, >=2 janelas stress positivas.");
  ln.push("");
  return `${ln.join("\n")}\n`;
}

async function main() {
  const cacheDir = arg("--cache-dir", "/private/tmp/bithub-scalper-matrix-v3");
  const outDir = arg("--out-dir", "/private/tmp/bithub-scalper-regime-v4");
  const limit = Number.parseInt(arg("--limit", "50400"), 10);
  const windows = Number.parseInt(arg("--windows", "5"), 10);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const candlesBySymbol = Object.fromEntries(SYMBOLS.map((symbol) => [symbol, loadCached(symbol, limit, cacheDir)]));
  const startTs = Math.max(...Object.values(candlesBySymbol).map((rows) => rows[0].ts));
  const endTs = Math.min(...Object.values(candlesBySymbol).map((rows) => rows.at(-1).ts));
  const labelTrade = buildRegimeContext(candlesBySymbol);
  const rows = [];

  for (const alt of ALTS) {
    for (const variant of btcLeadVariants()) {
      const result = runBtcLeadAltEcho({
        leadCandles: candlesBySymbol[LEAD],
        altCandles: candlesBySymbol[alt],
        leadSymbol: LEAD,
        altSymbol: alt,
        config: variant.config,
      });
      rows.push(
        ...evaluateRegimeBuckets({
          strategy: "BTC-Lead Alt-Echo",
          market: `${LEAD}->${alt}`,
          variant: variant.id,
          trades: result.trades,
          labelTrade,
          startTs,
          endTs,
          windows,
        }),
      );
    }
  }

  for (const symbol of ["SUIUSDT", "HYPEUSDT", "LINKUSDT", "SOLUSDT"]) {
    for (const variant of bbVariants()) {
      const result = runBbSqueezeBreakout(candlesBySymbol[symbol], { symbol, config: variant.config });
      rows.push(
        ...evaluateRegimeBuckets({
          strategy: "BB Squeeze Breakout",
          market: symbol,
          variant: variant.id,
          trades: result.trades,
          labelTrade,
          startTs,
          endTs,
          windows,
        }),
      );
    }
  }

  attachNeighborhood(rows);
  rows.sort(compareRows);

  const payload = {
    generated_at: new Date().toISOString(),
    guardrails: {
      public_bybit_cache_only: true,
      private_bybit_called: false,
      monitor_started: false,
      orders_sent: false,
    },
    cache_dir: cacheDir,
    limit,
    windows,
    start: toIso(startTs),
    end: toIso(endTs),
    rows,
  };

  const base = `scalper-regime-gated-v4-${nowStamp()}`;
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
        by_status: rows.reduce((acc, r) => {
          acc[r.status] = (acc[r.status] ?? 0) + 1;
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
