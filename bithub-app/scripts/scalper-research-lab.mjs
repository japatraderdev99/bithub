#!/usr/bin/env node
// scalper-research-lab.mjs — public-data research bench for scalper variants.
//
// Read-only. Fetches Bybit public klines only; no secrets, no private API,
// no monitor, no orders.
//
// Usage:
//   node scripts/scalper-research-lab.mjs --limit 10000 --folds 5

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runBtcLeadAltEcho } from "./btc-lead-alt-echo.mjs";
import { runTrendSurfBacktest } from "./trend-surf-scalp.mjs";

const LEAD_SYMBOL = "BTCUSDT";
const DEFAULT_SYMBOLS = ["BNBUSDT", "ETHUSDT", "SOLUSDT", "HYPEUSDT", "XRPUSDT"];
const MAX_BATCH = 1000;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
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

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return 0;
  const m = 10 ** digits;
  return Math.round(value * m) / m;
}

function cartesian(fields) {
  const entries = Object.entries(fields);
  return entries.reduce(
    (rows, [key, values]) => rows.flatMap((row) => values.map((value) => ({ ...row, [key]: value }))),
    [{}],
  );
}

function variantId(prefix, config) {
  return `${prefix}_${Object.entries(config)
    .map(([key, value]) => `${key}:${value}`)
    .join("_")}`;
}

function btcLeadVariants() {
  return cartesian({
    scoreMin: [70, 76, 82],
    corrMin: [0.45, 0.55],
    betaMin: [0.65, 0.8],
    residualZMin: [0.3, 0.55],
    minTargetPct: [0.18, 0.28],
    maxHoldMin: [6, 8],
  }).map((config) => ({
    id: variantId("ble", config),
    config: {
      ...config,
      targetResidualCapture: config.minTargetPct >= 0.28 ? 0.75 : 0.65,
      noMoveExitMin: config.maxHoldMin >= 8 ? 3 : 2,
      noMoveMinPct: config.minTargetPct >= 0.28 ? 0.08 : 0.05,
    },
  }));
}

function trendSurfVariants() {
  return cartesian({
    scoreMin: [75, 80, 84],
    volumeMin: [0.8, 1.0],
    pullbackAtrMax: [0.55, 0.7],
    slAtr: [0.75, 0.95],
    tpAtr: [1.35, 1.7, 2.1],
    lockProfitPct: [0.18, 0.24],
  }).map((config) => ({
    id: variantId("tss", config),
    config: {
      ...config,
      mfeLockPct: config.lockProfitPct >= 0.24 ? 0.45 : 0.35,
    },
  }));
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

function netPct(trade) {
  return Number(trade.pnl_net_pct ?? 0);
}

function tradeTs(trade) {
  return new Date(trade.entry_ts ?? trade.ts ?? trade.exit_ts).getTime();
}

function profitFactor(trades) {
  const pnls = trades.map(netPct).filter(Number.isFinite);
  const wins = pnls.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const losses = Math.abs(pnls.filter((v) => v <= 0).reduce((s, v) => s + v, 0));
  if (!losses) return wins > 0 ? 99 : 0;
  return wins / losses;
}

function maxDrawdown(trades) {
  let equity = 0;
  let peak = 0;
  let worst = 0;
  for (const trade of [...trades].sort((a, b) => tradeTs(a) - tradeTs(b))) {
    equity += netPct(trade);
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity - peak);
  }
  return worst;
}

function stats(trades) {
  const pnls = trades.map(netPct).filter(Number.isFinite);
  const net = pnls.reduce((s, v) => s + v, 0);
  const wins = pnls.filter((v) => v > 0).length;
  return {
    entries: trades.length,
    wins,
    losses: trades.length - wins,
    win_rate_pct: trades.length ? round((wins / trades.length) * 100, 2) : 0,
    pnl_net_pct: round(net, 3),
    avg_net_pct: trades.length ? round(net / trades.length, 3) : 0,
    profit_factor: round(profitFactor(trades), 2),
    max_drawdown_pct: round(maxDrawdown(trades), 3),
  };
}

function splitByTime(trades, startTs, endTs, folds) {
  const width = (endTs - startTs) / folds;
  return Array.from({ length: folds }, (_, i) => {
    const from = startTs + width * i;
    const to = i === folds - 1 ? endTs + 1 : startTs + width * (i + 1);
    const rows = trades.filter((trade) => {
      const ts = tradeTs(trade);
      return ts >= from && ts < to;
    });
    return {
      fold: i + 1,
      from: new Date(from).toISOString().replace(/\.\d+Z$/, "Z"),
      to: new Date(to).toISOString().replace(/\.\d+Z$/, "Z"),
      ...stats(rows),
    };
  });
}

function summarizeRun(result, meta, startTs, endTs, folds) {
  const trades = [...result.trades].sort((a, b) => tradeTs(a) - tradeTs(b));
  const all = stats(trades);
  const splitTs = startTs + (endTs - startTs) * 0.7;
  const trainTrades = trades.filter((trade) => tradeTs(trade) < splitTs);
  const testTrades = trades.filter((trade) => tradeTs(trade) >= splitTs);
  const train = stats(trainTrades);
  const test = stats(testTrades);
  const foldStats = splitByTime(trades, startTs, endTs, folds);
  const positiveFolds = foldStats.filter((fold) => fold.entries > 0 && fold.pnl_net_pct > 0).length;
  const activeFolds = foldStats.filter((fold) => fold.entries > 0).length;
  const worstFoldNet = foldStats.reduce((worst, fold) => Math.min(worst, fold.pnl_net_pct), 0);
  const signalCount = result.summary.signals ?? result.signals?.length ?? 0;

  const status =
    all.entries >= 30 &&
    test.entries >= 8 &&
    all.pnl_net_pct > 0 &&
    all.avg_net_pct >= 0.035 &&
    all.profit_factor >= 1.3 &&
    all.max_drawdown_pct >= -1.0 &&
    test.pnl_net_pct > 0.15 &&
    test.profit_factor >= 1 &&
    positiveFolds >= Math.ceil(folds * 0.6) &&
    worstFoldNet >= -0.5
      ? "micro_candidate"
      : all.entries >= 20 &&
          test.entries >= 5 &&
          all.pnl_net_pct > 0 &&
          all.avg_net_pct >= 0.025 &&
          all.profit_factor >= 1.15 &&
          all.max_drawdown_pct >= -1.5 &&
          test.pnl_net_pct > 0 &&
          positiveFolds >= Math.ceil(folds * 0.5)
        ? "research_candidate"
        : all.entries >= 8 && all.pnl_net_pct > 0 && test.pnl_net_pct >= 0
          ? "shadow_watch"
          : "reject";

  const pfScore = all.pnl_net_pct > 0 ? Math.min(Math.max(all.profit_factor - 1, -1), 3) * 12 : -20;
  const testPfScore = test.pnl_net_pct > 0 ? Math.min(Math.max(test.profit_factor - 1, -1), 3) * 8 : -12;
  const score =
    Math.min(all.entries, 60) * 0.8 +
    Math.max(all.avg_net_pct, -0.2) * 180 +
    Math.max(test.avg_net_pct, -0.2) * 160 +
    pfScore +
    testPfScore +
    Math.max(all.max_drawdown_pct, -3) * 8 +
    positiveFolds * 6 +
    activeFolds * 2 +
    (status === "micro_candidate" ? 30 : status === "research_candidate" ? 15 : status === "shadow_watch" ? 5 : 0);

  return {
    ...meta,
    status,
    score: round(score, 2),
    signals: signalCount,
    ...all,
    train,
    test,
    active_folds: activeFolds,
    positive_folds: positiveFolds,
    worst_fold_net_pct: round(worstFoldNet, 3),
    fold_stats: foldStats,
  };
}

function statusRank(status) {
  return {
    micro_candidate: 4,
    research_candidate: 3,
    shadow_watch: 2,
    reject: 1,
  }[status] ?? 0;
}

function compareRows(a, b) {
  return statusRank(b.status) - statusRank(a.status) || b.score - a.score;
}

function clusterRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.strategy}|${row.market}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const [strategy, market] = key.split("|");
      const positive = group.filter((row) => row.pnl_net_pct > 0);
      const robust = group.filter((row) => ["micro_candidate", "research_candidate"].includes(row.status));
      const watch = group.filter((row) => row.status === "shadow_watch");
      const best = [...group].sort(compareRows)[0];
      return {
        strategy,
        market,
        variants: group.length,
        positive_variants: positive.length,
        watch_variants: watch.length,
        robust_variants: robust.length,
        best_status: best.status,
        best_variant: best.variant,
        best_score: best.score,
        best_entries: best.entries,
        best_net_pct: best.pnl_net_pct,
        best_test_net_pct: best.test.pnl_net_pct,
      };
    })
    .sort((a, b) => b.robust_variants - a.robust_variants || b.watch_variants - a.watch_variants || b.best_score - a.best_score);
}

function renderMarkdown(payload) {
  const rows = payload.rows;
  const top = rows.slice(0, 40);
  const micro = rows.filter((row) => row.status === "micro_candidate");
  const research = rows.filter((row) => row.status === "research_candidate");
  const watch = rows.filter((row) => row.status === "shadow_watch");
  const lines = [];
  lines.push("---");
  lines.push("tags: [report, research-bench, scalper, research-lab, public-data]");
  lines.push(`created: ${payload.generated_at.slice(0, 10)}`);
  lines.push("status: complete");
  lines.push("author: Codex");
  lines.push("---");
  lines.push("");
  lines.push(`# ${payload.generated_at.slice(0, 10)} — Scalper Research Lab`);
  lines.push("");
  lines.push("## Escopo");
  lines.push("");
  lines.push("- Dados: Bybit public `/v5/market/kline`, 1m.");
  lines.push("- Sem credencial, sem Bybit private, sem monitor, sem ordens.");
  lines.push(`- Limite: ${payload.limit} candles por simbolo.`);
  lines.push(`- Folds temporais: ${payload.folds}. Split OOS: ultimos 30% do periodo.`);
  lines.push(`- Variantes avaliadas: ${rows.length}.`);
  lines.push("");
  lines.push("## Cobertura");
  lines.push("");
  for (const [symbol, meta] of Object.entries(payload.coverage)) {
    lines.push(`- ${symbol}: ${meta.count} candles, ${meta.from} -> ${meta.to}.`);
  }
  lines.push("");
  lines.push("## Decisao");
  lines.push("");
  if (micro.length) {
    const best = micro[0];
    lines.push(`Ha ${micro.length} micro_candidate(s). Melhor: **${best.strategy} ${best.market} ${best.variant}**.`);
    lines.push("");
    lines.push(
      `All: ${best.entries} trades, net ${best.pnl_net_pct}%, avg ${best.avg_net_pct}%, PF ${best.profit_factor}, DD ${best.max_drawdown_pct}%.`,
    );
    lines.push(
      `OOS: ${best.test.entries} trades, net ${best.test.pnl_net_pct}%, avg ${best.test.avg_net_pct}%, PF ${best.test.profit_factor}.`,
    );
  } else if (research.length) {
    const best = research[0];
    lines.push(`Nenhum micro_candidate. Ha ${research.length} research_candidate(s). Melhor: **${best.strategy} ${best.market} ${best.variant}**.`);
    lines.push("");
    lines.push("Recomendacao: shadow/paper primeiro; micro-real so com aprovacao manual e cap duro.");
  } else if (watch.length) {
    const best = watch[0];
    lines.push("Nenhum micro_candidate nem research_candidate.");
    lines.push("");
    lines.push(`Melhor shadow_watch: **${best.strategy} ${best.market} ${best.variant}**.`);
    lines.push("");
    lines.push("Recomendacao: nao rodar real automatico; coletar mais shadow.");
  } else {
    lines.push("Nenhuma variante ficou positiva de forma minimamente aceitavel. Nao rodar real.");
  }
  lines.push("");
  lines.push("## Cluster Health");
  lines.push("");
  lines.push("| Rank | Strategy | Market | Variants | Positive | Watch | Robust | Best Status | Best Net % | Best OOS Net % |");
  lines.push("|---:|---|---|---:|---:|---:|---:|---|---:|---:|");
  payload.clusters.slice(0, 20).forEach((row, i) => {
    lines.push(
      `| ${i + 1} | ${row.strategy} | ${row.market} | ${row.variants} | ${row.positive_variants} | ${row.watch_variants} | ${row.robust_variants} | ${row.best_status} | ${row.best_net_pct} | ${row.best_test_net_pct} |`,
    );
  });
  lines.push("");
  lines.push("## Ranking Top 40");
  lines.push("");
  lines.push("| Rank | Status | Strategy | Market | Entries | Net % | Avg % | PF | DD % | OOS Entries | OOS Net % | Folds +/active | Score | Variant |");
  lines.push("|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  top.forEach((row, i) => {
    lines.push(
      `| ${i + 1} | ${row.status} | ${row.strategy} | ${row.market} | ${row.entries} | ${row.pnl_net_pct} | ${row.avg_net_pct} | ${row.profit_factor} | ${row.max_drawdown_pct} | ${row.test.entries} | ${row.test.pnl_net_pct} | ${row.positive_folds}/${row.active_folds} | ${row.score} | ${row.variant} |`,
    );
  });
  lines.push("");
  lines.push("## Barra");
  lines.push("");
  lines.push("`micro_candidate`: >=30 trades, >=8 OOS, avg >=0.035%, PF >=1.3, DD >=-1.0%, OOS net >0.15%, folds positivos >=60%, worst fold >=-0.5%.");
  lines.push("");
  lines.push("`research_candidate`: >=20 trades, >=5 OOS, avg >=0.025%, PF >=1.15, DD >=-1.5%, OOS net >0, folds positivos >=50%.");
  lines.push("");
  lines.push("`shadow_watch`: >=8 trades, net >0, OOS net >=0.");
  lines.push("");
  lines.push("## Guardrails");
  lines.push("");
  lines.push("- Monitor nao foi rodado.");
  lines.push("- `monitor_all.py` nao foi alterado.");
  lines.push("- Bybit private nao foi chamado.");
  lines.push("- Nenhuma ordem foi enviada.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const limit = Number.parseInt(arg("--limit", "10000"), 10);
  const folds = Number.parseInt(arg("--folds", "5"), 10);
  const outDir = arg("--out-dir", "/private/tmp/bithub-scalper-research-lab");
  const symbols = arg("--symbols", DEFAULT_SYMBOLS.join(","))
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (!Number.isFinite(limit) || limit < 3000) throw new Error("--limit must be >= 3000");
  if (!Number.isFinite(folds) || folds < 3) throw new Error("--folds must be >= 3");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const allSymbols = [...new Set([LEAD_SYMBOL, ...symbols])];
  const candles = {};
  for (const symbol of allSymbols) {
    candles[symbol] = await fetchBybitKlines(symbol, limit);
  }

  const startTs = Math.max(...Object.values(candles).map((rows) => rows[0]?.ts ?? 0));
  const endTs = Math.min(...Object.values(candles).map((rows) => rows[rows.length - 1]?.ts ?? 0));
  const coverage = Object.fromEntries(
    Object.entries(candles).map(([symbol, rows]) => [
      symbol,
      {
        count: rows.length,
        from: new Date(rows[0]?.ts ?? 0).toISOString().replace(/\.\d+Z$/, "Z"),
        to: new Date(rows[rows.length - 1]?.ts ?? 0).toISOString().replace(/\.\d+Z$/, "Z"),
      },
    ]),
  );

  const rows = [];
  const btcVariants = btcLeadVariants();
  const trendVariants = trendSurfVariants();

  for (const symbol of symbols) {
    for (const variant of btcVariants) {
      const result = runBtcLeadAltEcho({
        leadCandles: candles[LEAD_SYMBOL],
        altCandles: candles[symbol],
        leadSymbol: LEAD_SYMBOL,
        altSymbol: symbol,
        config: variant.config,
      });
      rows.push(
        summarizeRun(
          result,
          {
            strategy: "BTC-Lead Alt-Echo",
            market: `${LEAD_SYMBOL}->${symbol}`,
            symbol,
            variant: variant.id,
            config: variant.config,
          },
          startTs,
          endTs,
          folds,
        ),
      );
    }
  }

  for (const symbol of symbols) {
    for (const variant of trendVariants) {
      const result = runTrendSurfBacktest(candles[symbol], { symbol, config: variant.config });
      rows.push(
        summarizeRun(
          result,
          {
            strategy: "Trend Surf Scalp",
            market: symbol,
            symbol,
            variant: variant.id,
            config: variant.config,
          },
          startTs,
          endTs,
          folds,
        ),
      );
    }
  }

  rows.sort(compareRows);
  const payload = {
    generated_at: new Date().toISOString(),
    guardrails: {
      public_bybit_only: true,
      private_bybit_called: false,
      monitor_started: false,
      orders_sent: false,
    },
    limit,
    folds,
    symbols,
    start: new Date(startTs).toISOString().replace(/\.\d+Z$/, "Z"),
    end: new Date(endTs).toISOString().replace(/\.\d+Z$/, "Z"),
    coverage,
    variant_counts: {
      btc_lead_alt_echo_per_market: btcVariants.length,
      trend_surf_per_market: trendVariants.length,
    },
    rows,
    clusters: clusterRows(rows),
  };

  const base = `scalper-research-lab-${nowStamp()}`;
  const jsonPath = join(outDir, `${base}.json`);
  const mdPath = join(outDir, `${base}.md`);
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeFileSync(mdPath, renderMarkdown(payload));

  const byStatus = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    JSON.stringify(
      {
        ok: true,
        json: jsonPath,
        markdown: mdPath,
        period: { start: payload.start, end: payload.end },
        rows: rows.length,
        by_status: byStatus,
        best: rows[0] ?? null,
        top_clusters: payload.clusters.slice(0, 5),
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
