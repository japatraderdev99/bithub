#!/usr/bin/env node
// sui-regime-backtest-validate.mjs
//
// Runs btc-lead-alt-echo-sui-regime-v1 on the same 50,400 1m candles used
// by the v3 cross-validation matrix and prints the per-window breakdown.
//
// Expected reproduction targets (from regime-mining tri-axial analysis):
//   - aggregate entries: ~32
//   - aggregate avg_net_pct: ~+0.061%
//   - aggregate PF: ~2.00
//   - positive windows: 4/5 (W4 is the historically adverse window)
//
// If actual numbers diverge materially from these targets, the gate logic
// in the strategy module drifted from the analysis and shadow live cannot
// start until the mismatch is understood.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runStrategy, STRATEGY_VERSION_ID, STRATEGY_CONFIG } from "./strategies/btc-lead-alt-echo-sui-regime-v1.mjs";

const TOTAL_LIMIT = 50_400;
const WINDOW_LIMIT = 10_080;
const WINDOWS = 5;
const CACHE_DIR = "/private/tmp/bithub-scalper-matrix-v3";
const OUT_DIR = "/private/tmp/bithub-sui-regime-validate";

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

function normalizeBybitKline(row) {
  return { ts: Number(row[0]), open: +row[1], high: +row[2], low: +row[3], close: +row[4], volume: +row[5] };
}

async function loadKlines(symbol) {
  const cachePath = join(CACHE_DIR, `.klines-${symbol}-${TOTAL_LIMIT}.json`);
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    if (Array.isArray(cached) && cached.length >= TOTAL_LIMIT) {
      console.error(`  ${symbol}: ${cached.length} candles from cache`);
      return cached.slice(-TOTAL_LIMIT);
    }
  }
  console.error(`  ${symbol}: cache missing; fetching from Bybit public…`);
  const byTs = new Map();
  let end = null;
  while (byTs.size < TOTAL_LIMIT) {
    const batch = Math.min(1000, TOTAL_LIMIT - byTs.size);
    const params = new URLSearchParams({ category: "linear", symbol, interval: "1", limit: String(batch) });
    if (end != null) params.set("end", String(end));
    const res = await fetch(`https://api.bybit.com/v5/market/kline?${params}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`bybit ${symbol}: ${json.retMsg}`);
    const rows = json.result?.list ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      const c = normalizeBybitKline(row);
      if (Number.isFinite(c.ts)) byTs.set(c.ts, c);
    }
    const oldest = Math.min(...rows.map((r) => +r[0]));
    const ne = oldest - 60_000;
    if (end != null && ne >= end) break;
    end = ne;
    await new Promise((r) => setTimeout(r, 200));
  }
  const final = [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-TOTAL_LIMIT);
  writeFileSync(cachePath, JSON.stringify(final));
  return final;
}

function splitWindows(candles) {
  const out = [];
  for (let i = 0; i < WINDOWS; i++) {
    const end = candles.length - WINDOW_LIMIT * i;
    const start = end - WINDOW_LIMIT;
    if (start < 0) break;
    out.unshift(candles.slice(start, end));
  }
  return out;
}

function stats(trades) {
  if (!trades.length) return { n: 0, wins: 0, win_rate: 0, net: 0, avg: 0, pf: 0 };
  const pnls = trades.map((t) => Number(t.pnl_net_pct));
  const wins = pnls.filter((v) => v > 0).length;
  const grossWin = pnls.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(pnls.filter((v) => v <= 0).reduce((s, v) => s + v, 0));
  const pf = grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss;
  const net = pnls.reduce((s, v) => s + v, 0);
  return {
    n: trades.length,
    wins,
    win_rate: Number(((wins / trades.length) * 100).toFixed(1)),
    net: Number(net.toFixed(3)),
    avg: Number((net / trades.length).toFixed(4)),
    pf: Number(pf.toFixed(2)),
  };
}

async function main() {
  console.error(`Loading ${TOTAL_LIMIT} candles per symbol…`);
  const btc = await loadKlines("BTCUSDT");
  const sui = await loadKlines("SUIUSDT");
  console.error(`btc=${btc.length}, sui=${sui.length}`);

  const btcWindows = splitWindows(btc);
  const suiWindows = splitWindows(sui);

  const perWindow = [];
  const allSignals = [];
  const allTrades = [];
  for (let i = 0; i < btcWindows.length; i++) {
    const result = runStrategy({ leadCandles: btcWindows[i], altCandles: suiWindows[i] });
    perWindow.push({ window: i + 1, ...stats(result.trades), signals_total: result.signals.length, signals_blocked: result.summary.signals_blocked_by_gate });
    for (const s of result.signals) allSignals.push({ ...s, window: i + 1 });
    for (const t of result.trades) allTrades.push({ ...t, window: i + 1 });
  }
  const agg = stats(allTrades);

  console.log("\n=== Validation: strategy module reproduces regime-mining discovery ===\n");
  console.log(`STRATEGY_VERSION_ID: ${STRATEGY_VERSION_ID}\n`);
  console.log("Per-window:");
  console.log("  W | n  | win%  | net%   | avg%    | PF    | signals total | blocked by gate");
  for (const w of perWindow) {
    console.log(
      `  ${w.window} | ${String(w.n).padStart(2)} | ${String(w.win_rate).padStart(5)} | ${String(w.net).padStart(6)} | ${String(w.avg).padStart(7)} | ${String(w.pf).padStart(5)} | ${String(w.signals_total).padStart(13)} | ${w.signals_blocked}`,
    );
  }
  const positive = perWindow.filter((w) => w.net > 0).length;
  console.log(`\nAggregate: n=${agg.n}, win_rate=${agg.win_rate}%, net=${agg.net}%, avg=${agg.avg}%, PF=${agg.pf}`);
  console.log(`Positive windows: ${positive}/${perWindow.length}`);

  const targets = { n: 32, avg: 0.061, pf: 2.0, positive_windows: 4 };
  const checks = {
    entries_close: Math.abs(agg.n - targets.n) <= 3,
    avg_close: Math.abs(agg.avg - targets.avg) <= 0.015,
    pf_close: Math.abs(agg.pf - targets.pf) <= 0.3,
    positive_windows_match: positive === targets.positive_windows,
  };
  console.log("\nReproduction checks (target ± tolerance):");
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${k}: ${v ? "✓" : "✗"}`);
  }

  const allPassed = Object.values(checks).every((v) => v);
  console.log(`\n${allPassed ? "✓ ALL CHECKS PASSED — strategy module faithfully reproduces the discovery." : "✗ MISMATCH — DO NOT proceed to shadow live until reconciled."}`);

  writeFileSync(
    join(OUT_DIR, `validation-${Date.now()}.json`),
    JSON.stringify({ strategy_version_id: STRATEGY_VERSION_ID, config: STRATEGY_CONFIG, per_window: perWindow, aggregate: agg, positive_windows: positive, checks, targets, all_signals: allSignals.length, all_trades: allTrades.length }, null, 2),
  );

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
  process.exit(2);
});
