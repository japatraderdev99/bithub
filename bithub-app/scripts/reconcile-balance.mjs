#!/usr/bin/env node
// reconcile-balance.mjs — H-OVERNIGHT-READINESS-001 Gate 5
//
// Compara saldo Bybit atual (do system.json — single source of truth do monitor)
// com a soma de pnl_abs registrada no D1 desde uma baseline. Divergência fora
// da tolerância vira alerta — sinal de que ainda há trades fechando sem ser
// registradas (bug não-conhecido) ou que os fixes A/B regrediram.
//
// Estratégia:
//   1. Lê balance_usdt de ~/.bithub-monitor/system.json (publisher writes from
//      ex.fetch_balance() periodicamente — fonte autoritativa do saldo real).
//   2. Query Worker /stats?since=<baseline_iso> → SUM(pnl_abs)
//   3. Expectativa: baseline_balance + pnl_d1_sum ≈ current_balance (± tolerância)
//   4. Se divergência > max(5%, $2) → relata como problema
//
// Modos:
//   - Standalone (one-shot): roda 1× e imprime resultado
//   - Cron-friendly: exit code 0 se OK, 1 se divergência → pode ser pipeado
//     em cron + alerta externo
//   - Watchdog-integrated: stdout JSON estruturado pra watchdog ingerir
//
// Uso:
//   node bithub-app/scripts/reconcile-balance.mjs \
//     --baseline 7.32 \
//     --since-hours 24
//
//   # Ou via env:
//   RECON_BASELINE_USD=7.32 RECON_SINCE_HOURS=24 \
//     node bithub-app/scripts/reconcile-balance.mjs

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// CLI / env config
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

const STATE_DIR = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");
const WORKER_URL =
  process.env.BITHUB_WORKER_URL ??
  "https://bithub-trades-api.guiydantas.workers.dev";

const baselineUsd = parseFloat(arg("--baseline", process.env.RECON_BASELINE_USD ?? "0"));
const sinceHours = parseFloat(arg("--since-hours", process.env.RECON_SINCE_HOURS ?? "24"));
const sinceIso = arg("--since", null) ?? (
  sinceHours
    ? new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z")
    : null
);
const tolerancePct = parseFloat(process.env.RECON_TOL_PCT ?? "5");
const toleranceAbs = parseFloat(process.env.RECON_TOL_ABS ?? "2.0");

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function readCurrentBalance() {
  const path = join(STATE_DIR, "system.json");
  if (!existsSync(path)) {
    return { ok: false, reason: "system.json missing — publisher offline?" };
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return {
      ok: true,
      balance_usdt: data.balance_usdt,
      free_usdt: data.free_usdt,
      as_of: data.as_of,
    };
  } catch (e) {
    return { ok: false, reason: `system.json invalid: ${e.message}` };
  }
}

async function fetchD1Sum(since) {
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  try {
    const r = await fetch(`${WORKER_URL}/stats${qs}`, { cache: "no-store" });
    const j = await r.json();
    if (!j.ok) return { ok: false, reason: `worker stats not ok: ${JSON.stringify(j)}` };
    return {
      ok: true,
      since: j.since,
      total_trades: j.overall?.total_trades ?? 0,
      total_pnl_abs: j.overall?.total_pnl_abs ?? 0,
      winners: j.overall?.winners ?? 0,
      losers: j.overall?.losers ?? 0,
    };
  } catch (e) {
    return { ok: false, reason: `fetch failed: ${e.message}` };
  }
}

function classifyDivergence(diff, expected) {
  const absDiff = Math.abs(diff);
  if (absDiff <= toleranceAbs) return "within_abs_tolerance";
  const pctDiff = Math.abs(diff / Math.max(Math.abs(expected), 0.01)) * 100;
  if (pctDiff <= tolerancePct) return "within_pct_tolerance";
  return diff > 0 ? "balance_higher_than_d1" : "balance_lower_than_d1";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const bal = readCurrentBalance();
  const stats = sinceIso != null ? await fetchD1Sum(sinceIso) : await fetchD1Sum();

  if (!bal.ok || !stats.ok) {
    const report = {
      ts: new Date().toISOString(),
      ok: false,
      reason: bal.ok ? stats.reason : bal.reason,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(2); // distinct exit code for setup error vs divergence
  }

  if (!baselineUsd || isNaN(baselineUsd)) {
    const report = {
      ts: new Date().toISOString(),
      ok: false,
      reason: "no baseline supplied; pass --baseline <USD> or set RECON_BASELINE_USD",
      hint: "use the balance_usdt from the session you want to reconcile against",
      current_balance: bal.balance_usdt,
      d1_pnl_sum: stats.total_pnl_abs,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  const expectedBalance = baselineUsd + (stats.total_pnl_abs ?? 0);
  const diff = bal.balance_usdt - expectedBalance;
  const classification = classifyDivergence(diff, expectedBalance);
  const isOk = classification.startsWith("within_");

  const report = {
    ts: new Date().toISOString(),
    ok: isOk,
    classification,
    inputs: {
      baseline_usd: baselineUsd,
      since: stats.since,
      tolerance_pct: tolerancePct,
      tolerance_abs: toleranceAbs,
    },
    actuals: {
      bybit_balance_usdt: bal.balance_usdt,
      free_usdt: bal.free_usdt,
      bybit_as_of: bal.as_of,
      d1_pnl_sum_usd: stats.total_pnl_abs,
      d1_trades: stats.total_trades,
      d1_winners: stats.winners,
      d1_losers: stats.losers,
    },
    derived: {
      expected_balance_usd: parseFloat(expectedBalance.toFixed(4)),
      diff_usd: parseFloat(diff.toFixed(4)),
      diff_pct: parseFloat((Math.abs(diff / Math.max(Math.abs(expectedBalance), 0.01)) * 100).toFixed(2)),
    },
    interpretation: classification === "within_abs_tolerance"
      ? "OK: divergência absoluta dentro da tolerância"
      : classification === "within_pct_tolerance"
      ? "OK: divergência percentual dentro da tolerância"
      : classification === "balance_higher_than_d1"
      ? "ALERT: saldo Bybit > esperado pelo D1. Trades vencedoras NÃO foram registradas no D1 (bug A ou novo path)."
      : "ALERT: saldo Bybit < esperado pelo D1. Trades perdedoras NÃO foram registradas no D1 (mesmo bug, lado oposto) OU outras despesas (taxa, funding) consumiram saldo.",
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(isOk ? 0 : 1);
}

main().catch((e) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ok: false, error: e.message }));
  process.exit(2);
});
