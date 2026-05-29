#!/usr/bin/env node
// scalper-experiment-matrix.mjs — public-data scalper candidate scorer.
//
// Read-only: fetches Bybit public klines only. It does not read secrets, does
// not call private endpoints, and does not place orders.
//
// Usage:
//   node scripts/scalper-experiment-matrix.mjs --limit 3000 --out-dir /private/tmp/bithub-scalper-matrix

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runBtcLeadAltEcho } from "./btc-lead-alt-echo.mjs";
import { runTrendSurfBacktest } from "./trend-surf-scalp.mjs";

const DEFAULT_SYMBOLS = ["BNBUSDT", "ETHUSDT", "SOLUSDT", "HYPEUSDT", "XRPUSDT"];
const LEAD_SYMBOL = "BTCUSDT";
const MAX_BATCH = 1000;

const BTC_LEAD_VARIANTS = [
  { id: "base", config: {} },
  {
    id: "strict",
    config: {
      scoreMin: 76,
      minImpulsePct: 0.45,
      minRelativeImpulsePct: 0.3,
      betaMin: 0.7,
      corrMin: 0.5,
      residualZMin: 0.45,
    },
  },
  {
    id: "fee_aware",
    config: {
      scoreMin: 72,
      minTargetPct: 0.24,
      noMoveExitMin: 3,
      noMoveMinPct: 0.08,
      targetResidualCapture: 0.75,
    },
  },
];

const TREND_SURF_VARIANTS = [
  { id: "base", config: {} },
  {
    id: "strict",
    config: {
      scoreMin: 82,
      volumeMin: 1,
      pullbackAtrMax: 0.55,
    },
  },
  {
    id: "fee_aware",
    config: {
      scoreMin: 78,
      volumeMin: 0.95,
      tpAtr: 1.7,
      mfeLockPct: 0.45,
      lockProfitPct: 0.24,
    },
  },
];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
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

async function fetchBybitKlines(symbol, totalLimit) {
  const candlesByTs = new Map();
  let end = null;

  while (candlesByTs.size < totalLimit) {
    const batchLimit = Math.min(MAX_BATCH, totalLimit - candlesByTs.size);
    const params = new URLSearchParams({
      category: "linear",
      symbol,
      interval: "1",
      limit: String(batchLimit),
    });
    if (end != null) params.set("end", String(end));

    const url = `https://api.bybit.com/v5/market/kline?${params.toString()}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const json = await res.json();
    if (json.retCode !== 0) {
      throw new Error(`Bybit public kline failed for ${symbol}: ${json.retMsg ?? json.retCode}`);
    }

    const rows = json.result?.list ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      const candle = normalizeBybitKline(row);
      if (Number.isFinite(candle.ts)) candlesByTs.set(candle.ts, candle);
    }

    const oldest = Math.min(...rows.map((row) => Number(row[0])).filter(Number.isFinite));
    if (!Number.isFinite(oldest)) break;
    const nextEnd = oldest - 60_000;
    if (end != null && nextEnd >= end) break;
    end = nextEnd;
  }

  return [...candlesByTs.values()].sort((a, b) => a.ts - b.ts).slice(-totalLimit);
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return 0;
  const m = 10 ** digits;
  return Math.round(value * m) / m;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function maxDrawdown(values) {
  let equity = 0;
  let peak = 0;
  let worst = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity - peak);
  }
  return worst;
}

function exitReasonCounts(trades) {
  const counts = {};
  for (const trade of trades) {
    counts[trade.exit_reason] = (counts[trade.exit_reason] ?? 0) + 1;
  }
  return counts;
}

function scoreResult(result, meta) {
  const pnls = result.trades.map((trade) => Number(trade.pnl_net_pct)).filter(Number.isFinite);
  const wins = pnls.filter((v) => v > 0);
  const losses = pnls.filter((v) => v <= 0);
  const grossWin = wins.reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0));
  const profitFactor = grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss;
  const first = result.trades[0]?.entry_ts ?? null;
  const last = result.trades[result.trades.length - 1]?.exit_ts ?? null;
  const midpoint = result.trades.length ? Math.floor(result.trades.length / 2) : 0;
  const backHalf = result.trades.slice(midpoint).reduce((s, trade) => s + Number(trade.pnl_net_pct ?? 0), 0);
  const entries = result.summary.entries;
  const avgNet = result.summary.avg_net_pct;
  const net = result.summary.pnl_net_pct;
  const dd = maxDrawdown(pnls);
  const eligible =
    entries >= 8 &&
    net > 0 &&
    avgNet >= 0.025 &&
    profitFactor >= 1.15 &&
    dd >= -0.7 &&
    backHalf >= 0;
  const watchOnly = entries >= 3 && net > 0 && avgNet > 0 && profitFactor >= 1;

  let candidateStatus = "reject";
  if (eligible) candidateStatus = "micro_candidate";
  else if (watchOnly) candidateStatus = "shadow_watch";

  const stabilityScore =
    Math.min(entries, 20) * 2 +
    Math.min(Math.max(avgNet, 0) * 220, 30) +
    Math.min(Math.max(profitFactor - 1, 0) * 18, 22) +
    Math.max(dd, -2) * 8 +
    (backHalf >= 0 ? 8 : -8);

  return {
    ...meta,
    candidate_status: candidateStatus,
    score: round(stabilityScore, 2),
    signals: result.summary.signals,
    entries,
    wins: result.summary.wins,
    losses: result.summary.losses,
    win_rate_pct: result.summary.win_rate_pct,
    pnl_net_pct: result.summary.pnl_net_pct,
    avg_net_pct: avgNet,
    profit_factor: round(profitFactor, 2),
    max_drawdown_pct: round(dd, 3),
    median_net_pct: round(percentile(pnls, 0.5), 3),
    p25_net_pct: round(percentile(pnls, 0.25), 3),
    p75_net_pct: round(percentile(pnls, 0.75), 3),
    back_half_net_pct: round(backHalf, 3),
    first_trade_ts: first,
    last_trade_ts: last,
    exit_reasons: exitReasonCounts(result.trades),
  };
}

function renderMarkdown({ generated_at, limit, symbols, candles, rows }) {
  const top = [...rows].sort((a, b) => b.score - a.score);
  const micro = top.filter((row) => row.candidate_status === "micro_candidate");
  const watch = top.filter((row) => row.candidate_status === "shadow_watch");
  const lines = [];
  lines.push("---");
  lines.push("tags: [report, research-bench, scalper, experiment-matrix, public-data]");
  lines.push(`created: ${generated_at.slice(0, 10)}`);
  lines.push("status: complete");
  lines.push("author: Codex");
  lines.push("---");
  lines.push("");
  lines.push(`# ${generated_at.slice(0, 10)} — Scalper Experiment Matrix`);
  lines.push("");
  lines.push("## Escopo");
  lines.push("");
  lines.push("- Dados: Bybit public `/v5/market/kline`, 1m, sem credencial.");
  lines.push("- Sem monitor, sem Bybit private, sem ordens.");
  lines.push(`- Limite solicitado: ${limit} candles por simbolo.`);
  lines.push(`- Simbolos: ${[LEAD_SYMBOL, ...symbols].join(", ")}.`);
  lines.push("");
  lines.push("## Cobertura");
  lines.push("");
  for (const [symbol, count] of Object.entries(candles)) {
    lines.push(`- ${symbol}: ${count} candles 1m.`);
  }
  lines.push("");
  lines.push("## Decisao");
  lines.push("");
  if (micro.length) {
    const best = micro[0];
    lines.push(`Melhor candidato micro-real: **${best.strategy} ${best.market} ${best.variant}**.`);
    lines.push("");
    lines.push(
      `Motivo: ${best.entries} trades, net ${best.pnl_net_pct}%, avg ${best.avg_net_pct}%, PF ${best.profit_factor}, DD ${best.max_drawdown_pct}%.`,
    );
    lines.push("");
    lines.push("Isto e candidato operacional para aprovacao manual do operador, nao promocao automatica.");
  } else {
    lines.push("Nenhuma variante passou a barra `micro_candidate`.");
    if (watch.length) {
      const best = watch[0];
      lines.push("");
      lines.push(
        `Melhor watchlist: **${best.strategy} ${best.market} ${best.variant}** com ${best.entries} trades, net ${best.pnl_net_pct}%, avg ${best.avg_net_pct}%, PF ${best.profit_factor}.`,
      );
    }
    lines.push("");
    lines.push("Recomendacao: manter shadow/watch, ou rodar micro-real apenas como experimento manual de risco conhecido.");
  }
  lines.push("");
  lines.push("## Ranking");
  lines.push("");
  lines.push("| Rank | Status | Strategy | Market | Variant | Entries | Win % | Net % | Avg % | PF | DD % | Back Half % | Score |");
  lines.push("|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  top.forEach((row, i) => {
    lines.push(
      `| ${i + 1} | ${row.candidate_status} | ${row.strategy} | ${row.market} | ${row.variant} | ${row.entries} | ${row.win_rate_pct} | ${row.pnl_net_pct} | ${row.avg_net_pct} | ${row.profit_factor} | ${row.max_drawdown_pct} | ${row.back_half_net_pct} | ${row.score} |`,
    );
  });
  lines.push("");
  lines.push("## Barra");
  lines.push("");
  lines.push("`micro_candidate`: entries >= 8, net > 0, avg_net >= 0.025%, PF >= 1.15, max DD >= -0.7%, back half >= 0.");
  lines.push("");
  lines.push("`shadow_watch`: entries >= 3, net > 0, avg_net > 0, PF >= 1.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const limit = Number.parseInt(arg("--limit", "3000"), 10);
  const outDir = arg("--out-dir", "/private/tmp/bithub-scalper-matrix");
  const symbols = arg("--symbols", DEFAULT_SYMBOLS.join(","))
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const includeTrendBtc = flag("--include-trend-btc");

  if (!Number.isFinite(limit) || limit < 1000) throw new Error("--limit must be >= 1000");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const allSymbols = [...new Set([LEAD_SYMBOL, ...symbols])];
  const candles = {};
  for (const symbol of allSymbols) {
    candles[symbol] = await fetchBybitKlines(symbol, limit);
  }

  const rows = [];
  for (const symbol of symbols) {
    for (const variant of BTC_LEAD_VARIANTS) {
      const result = runBtcLeadAltEcho({
        leadCandles: candles[LEAD_SYMBOL],
        altCandles: candles[symbol],
        leadSymbol: LEAD_SYMBOL,
        altSymbol: symbol,
        config: variant.config,
      });
      rows.push(scoreResult(result, { strategy: "BTC-Lead Alt-Echo", market: `${LEAD_SYMBOL}->${symbol}`, variant: variant.id }));
    }
  }

  const trendSymbols = includeTrendBtc ? [LEAD_SYMBOL, ...symbols] : symbols;
  for (const symbol of trendSymbols) {
    for (const variant of TREND_SURF_VARIANTS) {
      const result = runTrendSurfBacktest(candles[symbol], { symbol, config: variant.config });
      rows.push(scoreResult(result, { strategy: "Trend Surf Scalp", market: symbol, variant: variant.id }));
    }
  }

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
    symbols,
    candles: Object.fromEntries(Object.entries(candles).map(([symbol, list]) => [symbol, list.length])),
    rows: rows.sort((a, b) => b.score - a.score),
  };
  const base = `scalper-experiment-matrix-${nowStamp()}`;
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
        best,
        micro_candidates: payload.rows.filter((row) => row.candidate_status === "micro_candidate").length,
        shadow_watch: payload.rows.filter((row) => row.candidate_status === "shadow_watch").length,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  });
}
