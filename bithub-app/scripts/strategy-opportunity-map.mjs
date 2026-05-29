#!/usr/bin/env node
// strategy-opportunity-map.mjs — turn regime-gated research rows into a
// library-ready opportunity map.
//
// Read-only local analysis. Does not call network, private APIs, monitor, or
// D1. Input is the JSON artifact from scalper-regime-gated-v4.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function tierFor(best, variants, unique) {
  if (
    best.status === "regime_candidate" &&
    best.base.entries >= 24 &&
    best.stress.net_pct > 0 &&
    best.positive_windows >= 4 &&
    best.stress_positive_windows >= 3 &&
    unique >= 10
  ) {
    return "A-candidate";
  }
  if (
    ["regime_candidate", "regime_watch"].includes(best.status) &&
    best.base.entries >= 16 &&
    best.stress.net_pct > 0 &&
    best.positive_windows >= 3 &&
    best.stress_positive_windows >= 3 &&
    unique >= 4
  ) {
    return "B-watch";
  }
  if (
    ["regime_candidate", "regime_watch"].includes(best.status) &&
    best.base.entries >= 16 &&
    best.stress.net_pct >= 0 &&
    best.positive_windows >= 3
  ) {
    return "C-watch";
  }
  return "D-low-sample";
}

function familyName(strategy, market, bucket) {
  if (strategy === "BTC-Lead Alt-Echo" && market === "BTCUSDT->SUIUSDT" && bucket.includes("session=us")) {
    return "BTC Lead SUI US Echo";
  }
  if (strategy === "BTC-Lead Alt-Echo" && market === "BTCUSDT->SOLUSDT" && bucket.includes("session=us")) {
    return "BTC Lead SOL US Echo";
  }
  if (strategy === "BB Squeeze Breakout" && market === "HYPEUSDT") {
    return "HYPE BB Squeeze";
  }
  if (strategy === "BTC-Lead Alt-Echo" && market === "BTCUSDT->HYPEUSDT") {
    return "BTC Lead HYPE Echo";
  }
  return `${strategy} ${market}`;
}

function nextAction(tier) {
  if (tier === "A-candidate") return "Shadow forward dedicado; nao real.";
  if (tier === "B-watch") return "Adicionar ao backlog de shadow, menor prioridade.";
  if (tier === "C-watch") return "Refinar grid/regime antes de shadow.";
  return "Arquivar como baixa amostra por enquanto.";
}

function buildOpportunities(rows) {
  const groups = new Map();
  for (const row of rows.filter((r) => r.status !== "reject")) {
    const key = JSON.stringify([row.strategy, row.market, row.bucket]);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const out = [];
  for (const [key, list] of groups.entries()) {
    list.sort((a, b) => b.score - a.score);
    const [strategy, market, bucket] = JSON.parse(key);
    const best = list[0];
    const unique = new Set(list.map((r) => r.fingerprint)).size;
    const tier = tierFor(best, list.length, unique);
    out.push({
      tier,
      family_name: familyName(strategy, market, bucket),
      strategy,
      market,
      bucket,
      variants_positive: list.length,
      unique_fingerprints: unique,
      best_variant: best.variant,
      status: best.status,
      entries: best.base.entries,
      net_pct: best.base.net_pct,
      avg_net_pct: best.base.avg_net_pct,
      profit_factor: best.base.profit_factor,
      max_dd_pct: best.base.max_dd_pct,
      stress_net_pct: best.stress.net_pct,
      stress_avg_net_pct: best.stress.avg_net_pct,
      stress_profit_factor: best.stress.profit_factor,
      positive_windows: best.positive_windows,
      stress_positive_windows: best.stress_positive_windows,
      worst_window_net_pct: best.worst_window_net_pct,
      worst_stress_window_net_pct: best.worst_stress_window_net_pct,
      score: best.score,
      next_action: nextAction(tier),
      library_status: tier === "A-candidate" ? "shadow-ready" : tier === "B-watch" ? "watchlist" : "research",
    });
  }

  return out.sort(
    (a, b) =>
      a.tier.localeCompare(b.tier) ||
      b.score - a.score ||
      b.unique_fingerprints - a.unique_fingerprints ||
      b.entries - a.entries,
  );
}

function renderMarkdown(payload) {
  const cell = (value) => String(value).replaceAll("|", "\\|");
  const lines = [];
  lines.push("---");
  lines.push("tags: [report, research-bench, strategy-library, opportunity-map]");
  lines.push(`created: ${payload.generated_at.slice(0, 10)}`);
  lines.push("status: complete");
  lines.push("author: Codex");
  lines.push("---");
  lines.push("");
  lines.push(`# ${payload.generated_at.slice(0, 10)} — Strategy Opportunity Map`);
  lines.push("");
  lines.push("## Escopo");
  lines.push("");
  lines.push("- Fonte: resultado regime-gated v4.");
  lines.push("- Sem rede, sem Bybit private, sem monitor, sem ordens.");
  lines.push("- Objetivo: nutrir Strategy Library com hipoteses classificadas por evidencia.");
  lines.push("");
  lines.push("## Tiers");
  lines.push("");
  lines.push("- `A-candidate`: pronto para shadow forward dedicado, ainda nao real.");
  lines.push("- `B-watch`: bom o suficiente para backlog de shadow, menor prioridade.");
  lines.push("- `C-watch`: pista interessante, precisa refinamento antes de shadow.");
  lines.push("- `D-low-sample`: baixa amostra ou fragilidade alta.");
  lines.push("");
  lines.push("## Oportunidades");
  lines.push("");
  lines.push("| Tier | Family | Market | Bucket | Entries | Net % | Stress % | PF | Win Windows | Unique | Next |");
  lines.push("|---|---|---|---|---:|---:|---:|---:|---:|---:|---|");
  payload.opportunities.forEach((o) => {
    lines.push(
      `| ${cell(o.tier)} | ${cell(o.family_name)} | ${cell(o.market)} | ${cell(o.bucket)} | ${o.entries} | ${o.net_pct} | ${o.stress_net_pct} | ${o.profit_factor} | ${o.positive_windows}/${payload.windows} | ${o.unique_fingerprints} | ${cell(o.next_action)} |`,
    );
  });
  lines.push("");
  lines.push("## Leitura");
  lines.push("");
  lines.push("O mapa confirma que a biblioteca ainda e estreita: quase todo edge util veio de `BTC-Lead Alt-Echo` em SUI/SOL/HYPE sob regimes especificos. `BB Squeeze` em HYPE aparece como tese separada, mas com vizinhanca fraca.");
  lines.push("");
  lines.push("Nada aqui autoriza real. O valor e priorizar shadow e novas familias.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const input = arg("--input", "/private/tmp/bithub-scalper-regime-v4/scalper-regime-gated-v4-20260529T022914Z.json");
  const outDir = arg("--out-dir", "/private/tmp/bithub-strategy-opportunities");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const source = JSON.parse(readFileSync(input, "utf8"));
  const opportunities = buildOpportunities(source.rows);
  const payload = {
    generated_at: new Date().toISOString(),
    source: input,
    windows: source.windows,
    opportunities,
    counts: opportunities.reduce((acc, o) => {
      acc[o.tier] = (acc[o.tier] ?? 0) + 1;
      return acc;
    }, {}),
  };

  const base = `strategy-opportunity-map-${nowStamp()}`;
  const jsonPath = join(outDir, `${base}.json`);
  const mdPath = join(outDir, `${base}.md`);
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeFileSync(mdPath, renderMarkdown(payload));
  console.log(JSON.stringify({ ok: true, json: jsonPath, markdown: mdPath, counts: payload.counts, top: opportunities.slice(0, 6) }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
    process.exit(1);
  });
}
