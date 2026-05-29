#!/usr/bin/env node
// scalper-experiment-matrix-v2.mjs — research-grade scalper scoring.
//
// Read-only: public Bybit klines, no private API, no orders, no monitor.
//
// Differences vs v1:
// - Walk-forward 60/40 split. A setup only graduates beyond shadow if it is
//   profitable in BOTH halves with enough trades. Sum-over-the-whole-window
//   can hide a single lucky stretch — splitting forces it to repeat.
// - Larger sampled grid (~20 variants/strategy) to probe parameter robustness
//   rather than 3 hand-picked tunings.
// - Cost stress: every trade is also evaluated at +0.04% extra round-trip fee.
//   "magnifique" status requires surviving the higher cost (slippage budget).
// - Neighborhood count: for each market, how many variants are positive in
//   walk-forward. 1/20 = noise; 8/20 = real edge.
// - Extra metrics: trimmed mean, tail p10, Sharpe-like, max consecutive losses.
//
// Usage:
//   node scripts/scalper-experiment-matrix-v2.mjs \
//     --limit 15000 --out-dir /private/tmp/bithub-scalper-matrix-v2

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runBtcLeadAltEcho } from "./btc-lead-alt-echo.mjs";
import { runTrendSurfBacktest } from "./trend-surf-scalp.mjs";

const LEAD = "BTCUSDT";
const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "LINKUSDT", "AVAXUSDT", "SUIUSDT", "HYPEUSDT"];
const ALT_SYMBOLS = ["ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "LINKUSDT", "AVAXUSDT", "SUIUSDT", "HYPEUSDT"];
const MAX_BATCH = 1000;
const FETCH_DELAY_MS = 80;
const FEE_BASE = 0.11;
const FEE_STRESS = 0.15;
const TRAIN_FRAC = 0.6;

// Curated grid for Trend Surf: 18 variants spanning entry strictness,
// target distance, lock aggressiveness, volume floor. Designed so several
// neighbors share parameter values — if only 1/18 works, that's overfit;
// if a cluster works, there's structure.
const TREND_GRID = (() => {
  const out = [];
  let id = 0;
  for (const scoreMin of [72, 76, 80]) {
    for (const tpAtr of [1.2, 1.5, 1.8]) {
      for (const volumeMin of [0.9, 1.1]) {
        out.push({
          id: `ts_${id++}_s${scoreMin}_tp${tpAtr}_v${volumeMin}`,
          config: { scoreMin, tpAtr, volumeMin, mfeLockPct: 0.4, lockProfitPct: 0.22, slAtr: 0.95, pullbackAtrMax: 0.65 },
          params: { scoreMin, tpAtr, volumeMin },
        });
      }
    }
  }
  return out;
})();

// BTC-Lead Alt-Echo grid: 18 variants spanning score floor, beta/corr filter,
// max hold, residual target capture. Same neighborhood logic.
const ECHO_GRID = (() => {
  const out = [];
  let id = 0;
  for (const scoreMin of [66, 72, 78]) {
    for (const corrMin of [0.4, 0.55]) {
      for (const maxHoldMin of [5, 8, 12]) {
        out.push({
          id: `bl_${id++}_s${scoreMin}_c${corrMin}_h${maxHoldMin}`,
          config: { scoreMin, corrMin, maxHoldMin, betaMin: 0.6, targetResidualCapture: 0.7, minTargetPct: 0.2 },
          params: { scoreMin, corrMin, maxHoldMin },
        });
      }
    }
  }
  return out;
})();

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const res = await fetch(`https://api.bybit.com/v5/market/kline?${params}`, { headers: { accept: "application/json" } });
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`bybit ${symbol}: ${json.retMsg ?? json.retCode}`);
    const rows = json.result?.list ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      const c = normalizeKline(row);
      if (Number.isFinite(c.ts)) byTs.set(c.ts, c);
    }
    const oldest = Math.min(...rows.map((r) => Number(r[0])).filter(Number.isFinite));
    if (!Number.isFinite(oldest)) break;
    const nextEnd = oldest - 60_000;
    if (end != null && nextEnd >= end) break;
    end = nextEnd;
    await sleep(FETCH_DELAY_MS);
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-totalLimit);
}

function round(v, d = 3) {
  if (!Number.isFinite(v)) return 0;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function maxDrawdown(pnls) {
  let equity = 0;
  let peak = 0;
  let worst = 0;
  for (const v of pnls) {
    equity += v;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity - peak);
  }
  return worst;
}

function maxConsecLosses(pnls) {
  let cur = 0;
  let worst = 0;
  for (const v of pnls) {
    if (v <= 0) {
      cur += 1;
      worst = Math.max(worst, cur);
    } else {
      cur = 0;
    }
  }
  return worst;
}

function trimmedMean(values, trim = 0.1) {
  if (values.length < 5) return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * trim);
  const kept = sorted.slice(cut, sorted.length - cut);
  return kept.reduce((s, v) => s + v, 0) / kept.length;
}

function sharpeLike(pnls) {
  if (pnls.length < 2) return 0;
  const m = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const variance = pnls.reduce((s, v) => s + (v - m) ** 2, 0) / (pnls.length - 1);
  const sd = Math.sqrt(variance);
  return sd === 0 ? (m > 0 ? 9 : 0) : m / sd;
}

// Recompute net pnl% for each trade using a different round-trip fee. The
// original backtest applied fee_base; here we shift to fee_stress by adding
// back the original fee and subtracting the new one.
function applyFee(trades, feeBase, feeNew) {
  const delta = feeNew - feeBase;
  return trades.map((t) => ({ ...t, pnl_net_pct: round(Number(t.pnl_net_pct) - delta, 4) }));
}

function statsOf(trades) {
  const pnls = trades.map((t) => Number(t.pnl_net_pct)).filter(Number.isFinite);
  const wins = pnls.filter((v) => v > 0);
  const losses = pnls.filter((v) => v <= 0);
  const gw = wins.reduce((s, v) => s + v, 0);
  const gl = Math.abs(losses.reduce((s, v) => s + v, 0));
  const pf = gl === 0 ? (gw > 0 ? 99 : 0) : gw / gl;
  return {
    entries: pnls.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: pnls.length ? round((wins.length / pnls.length) * 100, 2) : 0,
    net_pct: round(pnls.reduce((s, v) => s + v, 0), 3),
    avg_net_pct: pnls.length ? round(pnls.reduce((s, v) => s + v, 0) / pnls.length, 4) : 0,
    median_net_pct: round(percentile(pnls, 0.5), 4),
    trimmed_mean_pct: round(trimmedMean(pnls), 4),
    p10_pct: round(percentile(pnls, 0.1), 3),
    profit_factor: round(pf, 2),
    max_dd_pct: round(maxDrawdown(pnls), 3),
    sharpe_like: round(sharpeLike(pnls), 3),
    max_consec_losses: maxConsecLosses(pnls),
  };
}

// Walk-forward split is timestamp-based, not trade-index-based, so the cutoff
// reflects calendar time rather than entry density. Indicators warm up from
// the same prefix, so neither half has a cold start.
function walkForward(trades, splitTs) {
  const train = trades.filter((t) => new Date(t.entry_ts).getTime() < splitTs);
  const test = trades.filter((t) => new Date(t.entry_ts).getTime() >= splitTs);
  return { train: statsOf(train), test: statsOf(test) };
}

function classify(full, wf, fullStress) {
  // micro_candidate: must be net positive in both halves with enough sample
  // AND survive the higher fee on the full window.
  const both = wf.train.entries >= 8 && wf.test.entries >= 8 && wf.train.net_pct > 0 && wf.test.net_pct > 0;
  const survives = fullStress.net_pct > 0 && fullStress.avg_net_pct > 0;
  const magnifique =
    wf.train.entries >= 12 &&
    wf.test.entries >= 12 &&
    wf.train.avg_net_pct >= 0.05 &&
    wf.test.avg_net_pct >= 0.05 &&
    wf.train.profit_factor >= 1.3 &&
    wf.test.profit_factor >= 1.3 &&
    full.max_dd_pct >= -1.0 &&
    survives;
  const micro = both && full.avg_net_pct >= 0.03 && full.profit_factor >= 1.15 && full.max_dd_pct >= -1.2 && survives;
  const shadow = full.entries >= 8 && full.net_pct > 0 && full.avg_net_pct > 0 && full.profit_factor >= 1;
  if (magnifique) return "magnifique";
  if (micro) return "micro_candidate";
  if (shadow) return "shadow_watch";
  return "reject";
}

function score(full, wf) {
  // Weighted so walk-forward survival dominates. trimmed_mean punishes
  // outlier-driven nets. negative back-half halves the score.
  const wfMin = Math.min(wf.train.avg_net_pct, wf.test.avg_net_pct);
  const entryFloor = Math.min(Math.min(wf.train.entries, wf.test.entries), 20);
  let s = 0;
  s += entryFloor * 2;
  s += Math.max(0, wfMin) * 200;
  s += Math.max(0, full.trimmed_mean_pct) * 120;
  s += Math.min(Math.max(0, full.profit_factor - 1) * 14, 20);
  s += full.max_dd_pct * 8;
  s += full.sharpe_like * 6;
  return round(s, 2);
}

function runTrend({ candles, symbol, variant, splitTs }) {
  const result = runTrendSurfBacktest(candles, { symbol, config: { ...variant.config, feePctRoundTrip: FEE_BASE } });
  const full = statsOf(result.trades);
  const wf = walkForward(result.trades, splitTs);
  const stressTrades = applyFee(result.trades, FEE_BASE, FEE_STRESS);
  const fullStress = statsOf(stressTrades);
  return {
    strategy: "Trend Surf Scalp",
    market: symbol,
    variant: variant.id,
    params: variant.params,
    full,
    walk_forward: wf,
    full_high_fee: fullStress,
    candidate_status: classify(full, wf, fullStress),
    raw_score: score(full, wf),
  };
}

function runEcho({ leadCandles, altCandles, alt, variant, splitTs }) {
  const result = runBtcLeadAltEcho({
    leadCandles,
    altCandles,
    leadSymbol: LEAD,
    altSymbol: alt,
    config: { ...variant.config, feePctRoundTrip: FEE_BASE },
  });
  const full = statsOf(result.trades);
  const wf = walkForward(result.trades, splitTs);
  const stressTrades = applyFee(result.trades, FEE_BASE, FEE_STRESS);
  const fullStress = statsOf(stressTrades);
  return {
    strategy: "BTC-Lead Alt-Echo",
    market: `${LEAD}->${alt}`,
    variant: variant.id,
    params: variant.params,
    full,
    walk_forward: wf,
    full_high_fee: fullStress,
    candidate_status: classify(full, wf, fullStress),
    raw_score: score(full, wf),
  };
}

// Neighborhood robustness: for each market+strategy, count how many of its
// variants are positive in BOTH halves of the walk-forward. A single positive
// variant in a sea of negatives is a fluke; a cluster is evidence of edge.
function attachNeighborhood(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.strategy}|${row.market}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const list of groups.values()) {
    const positive = list.filter((r) => r.walk_forward.train.net_pct > 0 && r.walk_forward.test.net_pct > 0).length;
    for (const row of list) {
      row.neighborhood_positive = positive;
      row.neighborhood_total = list.length;
      row.neighborhood_score = positive / list.length;
    }
  }
}

function renderMarkdown(payload) {
  const { generated_at, limit, candles, rows, split_ts, fee_base, fee_stress } = payload;
  const sorted = [...rows].sort((a, b) => b.raw_score - a.raw_score);
  const magnifique = sorted.filter((r) => r.candidate_status === "magnifique");
  const micro = sorted.filter((r) => r.candidate_status === "micro_candidate");
  const shadow = sorted.filter((r) => r.candidate_status === "shadow_watch");
  const ln = [];
  ln.push("---");
  ln.push("tags: [report, research-bench, scalper, experiment-matrix, walk-forward, public-data]");
  ln.push(`created: ${generated_at.slice(0, 10)}`);
  ln.push("status: complete");
  ln.push("author: Claude (Opus 4.7)");
  ln.push("---");
  ln.push("");
  ln.push(`# ${generated_at.slice(0, 10)} — Scalper Experiment Matrix v2 (walk-forward)`);
  ln.push("");
  ln.push("## Escopo");
  ln.push("");
  ln.push("- Dados: Bybit public `/v5/market/kline`, 1m, sem credencial.");
  ln.push("- Sem monitor, sem Bybit private, sem ordens.");
  ln.push(`- Limit: ${limit} candles 1m por simbolo (~${Math.round(limit / 1440)} dias).`);
  ln.push(`- Split walk-forward: train 60% ate \`${new Date(split_ts).toISOString()}\`, test 40% depois.`);
  ln.push(`- Fee base: ${fee_base}% round-trip. Stress: ${fee_stress}% round-trip (slippage buffer).`);
  ln.push("");
  ln.push("## Cobertura");
  ln.push("");
  for (const [s, n] of Object.entries(candles)) ln.push(`- ${s}: ${n} candles 1m.`);
  ln.push("");
  ln.push("## Veredicto");
  ln.push("");
  if (magnifique.length) {
    const b = magnifique[0];
    ln.push(`**Magnifique encontrado:** ${b.strategy} · ${b.market} · ${b.variant}.`);
    ln.push("");
    ln.push(`Vizinhanca positiva: ${b.neighborhood_positive}/${b.neighborhood_total}. Train ${b.walk_forward.train.entries} trades avg ${b.walk_forward.train.avg_net_pct}%. Test ${b.walk_forward.test.entries} trades avg ${b.walk_forward.test.avg_net_pct}%. PF train ${b.walk_forward.train.profit_factor} / test ${b.walk_forward.test.profit_factor}. DD ${b.full.max_dd_pct}%. Sobrevive fee ${fee_stress}%: net ${b.full_high_fee.net_pct}%.`);
    ln.push("");
    ln.push("Aprovacao: candidato para micro-real **sob autorizacao manual do operador**. Nao e promocao automatica.");
  } else if (micro.length) {
    const b = micro[0];
    ln.push(`Nenhum candidato \`magnifique\`. Melhor \`micro_candidate\`: ${b.strategy} · ${b.market} · ${b.variant}.`);
    ln.push("");
    ln.push(`Train ${b.walk_forward.train.entries} trades avg ${b.walk_forward.train.avg_net_pct}%. Test ${b.walk_forward.test.entries} trades avg ${b.walk_forward.test.avg_net_pct}%. PF train ${b.walk_forward.train.profit_factor} / test ${b.walk_forward.test.profit_factor}. Vizinhanca ${b.neighborhood_positive}/${b.neighborhood_total}.`);
    ln.push("");
    ln.push("Recomendacao: shadow live primeiro. Real ainda nao.");
  } else if (shadow.length) {
    const b = shadow[0];
    ln.push(`Nenhum candidato passou walk-forward com sample minimo. Topo do score combinado: ${b.strategy} · ${b.market} · ${b.variant}.`);
    ln.push("");
    ln.push(`Full ${b.full.entries} trades, net ${b.full.net_pct}%, PF ${b.full.profit_factor}. Mas train/test: ${b.walk_forward.train.entries}/${b.walk_forward.test.entries} trades, net ${b.walk_forward.train.net_pct}%/${b.walk_forward.test.net_pct}%.`);
    ln.push("");
    ln.push("Recomendacao: nao colocar real. Continuar shadow ou refinar tese.");
  } else {
    ln.push("Nenhum candidato positivo nas duas metades com sample minimo. Real nao autorizado.");
  }
  ln.push("");
  ln.push("## Top 25 por raw_score");
  ln.push("");
  ln.push("| # | Status | Strategy | Market | Variant | Vizinhanca | Train n/avg/PF | Test n/avg/PF | Full DD | Stress net | Score |");
  ln.push("|---:|---|---|---|---|---:|---|---|---:|---:|---:|");
  sorted.slice(0, 25).forEach((r, i) => {
    ln.push(
      `| ${i + 1} | ${r.candidate_status} | ${r.strategy} | ${r.market} | ${r.variant} | ${r.neighborhood_positive}/${r.neighborhood_total} | ${r.walk_forward.train.entries}/${r.walk_forward.train.avg_net_pct}/${r.walk_forward.train.profit_factor} | ${r.walk_forward.test.entries}/${r.walk_forward.test.avg_net_pct}/${r.walk_forward.test.profit_factor} | ${r.full.max_dd_pct} | ${r.full_high_fee.net_pct} | ${r.raw_score} |`,
    );
  });
  ln.push("");
  ln.push("## Barras");
  ln.push("");
  ln.push("- `magnifique`: train+test >= 12 trades, avg_net >= 0.05% em ambos, PF >= 1.30 em ambos, DD >= -1.0%, sobrevive fee stress.");
  ln.push("- `micro_candidate`: train+test >= 8 trades, net positivo em ambos, avg_net_full >= 0.03%, PF_full >= 1.15, DD >= -1.2%, sobrevive fee stress.");
  ln.push("- `shadow_watch`: full >= 8 trades, net positivo, PF >= 1. (Pode nao sobreviver walk-forward.)");
  ln.push("");
  return `${ln.join("\n")}\n`;
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

async function main() {
  const limit = Number.parseInt(arg("--limit", "15000"), 10);
  const outDir = arg("--out-dir", "/private/tmp/bithub-scalper-matrix-v2");
  if (!Number.isFinite(limit) || limit < 3000) throw new Error("--limit must be >= 3000");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  console.error(`[v2] fetching ${DEFAULT_SYMBOLS.length} symbols, limit=${limit}…`);
  const candles = {};
  for (const symbol of DEFAULT_SYMBOLS) {
    const start = Date.now();
    candles[symbol] = await fetchKlines(symbol, limit);
    console.error(`  ${symbol}: ${candles[symbol].length} candles in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }

  // Use the lead's median timestamp as the split point so train/test windows
  // align across symbols (avoids different splits per coin).
  const leadTs = candles[LEAD].map((c) => c.ts);
  const splitTs = leadTs[Math.floor(leadTs.length * TRAIN_FRAC)];
  console.error(`[v2] split_ts = ${new Date(splitTs).toISOString()}`);

  const rows = [];
  for (const symbol of DEFAULT_SYMBOLS) {
    for (const variant of TREND_GRID) {
      rows.push(runTrend({ candles: candles[symbol], symbol, variant, splitTs }));
    }
  }
  for (const alt of ALT_SYMBOLS) {
    for (const variant of ECHO_GRID) {
      rows.push(runEcho({ leadCandles: candles[LEAD], altCandles: candles[alt], alt, variant, splitTs }));
    }
  }
  attachNeighborhood(rows);

  const generated_at = new Date().toISOString();
  const payload = {
    generated_at,
    guardrails: {
      public_bybit_only: true,
      private_bybit_called: false,
      monitor_started: false,
      orders_sent: false,
    },
    limit,
    fee_base: FEE_BASE,
    fee_stress: FEE_STRESS,
    split_ts: splitTs,
    candles: Object.fromEntries(Object.entries(candles).map(([s, list]) => [s, list.length])),
    rows: rows.sort((a, b) => b.raw_score - a.raw_score),
  };

  const base = `scalper-experiment-matrix-v2-${nowStamp()}`;
  const jsonPath = join(outDir, `${base}.json`);
  const mdPath = join(outDir, `${base}.md`);
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeFileSync(mdPath, renderMarkdown(payload));

  const best = payload.rows[0] ?? null;
  console.log(
    JSON.stringify(
      {
        ok: true,
        json: jsonPath,
        markdown: mdPath,
        magnifique: payload.rows.filter((r) => r.candidate_status === "magnifique").length,
        micro_candidates: payload.rows.filter((r) => r.candidate_status === "micro_candidate").length,
        shadow_watch: payload.rows.filter((r) => r.candidate_status === "shadow_watch").length,
        best,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
    process.exit(1);
  });
}
