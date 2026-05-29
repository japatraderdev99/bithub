#!/usr/bin/env node
// kill-switch.mjs — H-PRE-ROUND-3 Gate A
//
// Daemon que decide se o monitor pode abrir novas posições.
// NÃO toca o monitor diretamente. Apenas escreve um arquivo de estado
// que o monitor_all.py consulta antes de cada ENTRY.
//
// 3 triggers (qualquer um basta):
//   1. Drawdown sessão: balance atual <= baseline * (1 - drawdown_pct)
//   2. Reconcile divergence: |bybit_balance - (baseline + d1_pnl_sum)| > tol
//   3. Loss streak: últimas N trades fechadas no D1 local foram todas losses
//
// Disparo é "sticky": uma vez pausado, fica pausado até o operador rodar
// `kill-switch-status.mjs --unpause` (que seta manual_override=true).
// Daemon não re-pausa sozinho enquanto manual_override estiver true —
// o operador assumiu que sabe o que está fazendo.
//
// Output:
//   - ~/.bithub-monitor/kill_switch.json (state, atomic write)
//   - stdout: NDJSON (uma linha por tick) pra cron logs
//   - osascript notification no primeiro flip active→paused
//
// Uso:
//   node kill-switch.mjs --baseline 12.96 [--interval 30] [--dd-pct 10] \
//                        [--tol-pct 5] [--tol-abs 2] [--streak 3]

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

const STATE_DIR = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");
const WORKER_URL =
  process.env.BITHUB_WORKER_URL ?? "https://bithub-trades-api.guiydantas.workers.dev";

const BASELINE_USD = parseFloat(arg("--baseline", process.env.KS_BASELINE_USD ?? "0"));
const INTERVAL_SEC = parseInt(arg("--interval", process.env.KS_INTERVAL_SEC ?? "30"), 10);
const DD_PCT = parseFloat(arg("--dd-pct", process.env.KS_DRAWDOWN_PCT ?? "10"));
const TOL_PCT = parseFloat(arg("--tol-pct", process.env.KS_TOL_PCT ?? "5"));
const TOL_ABS = parseFloat(arg("--tol-abs", process.env.KS_TOL_ABS ?? "2.0"));
const STREAK_N = parseInt(arg("--streak", process.env.KS_STREAK_N ?? "3"), 10);
const SINCE_ISO = arg("--since", process.env.KS_SINCE_ISO ?? new Date().toISOString());

if (!BASELINE_USD || isNaN(BASELINE_USD)) {
  console.error("ERR: --baseline <USD> obrigatório (ou env KS_BASELINE_USD)");
  process.exit(2);
}

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

const STATE_FILE = join(STATE_DIR, "kill_switch.json");
const TRADES_DB = join(STATE_DIR, "trades.db");

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// State I/O (atomic write via tmp + rename)
// ---------------------------------------------------------------------------

function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); } catch { return null; }
}

function writeState(state) {
  const data = JSON.stringify(state, null, 2);
  const tmp = join(STATE_DIR, `.kill_switch.${process.pid}.${Date.now()}.json`);
  writeFileSync(tmp, data, { mode: 0o644 });
  renameSync(tmp, STATE_FILE);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function readBalance() {
  const path = join(STATE_DIR, "system.json");
  if (!existsSync(path)) return { ok: false, reason: "system_json_missing" };
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return {
      ok: true,
      balance_usdt: Number(data.balance_usdt),
      as_of: data.as_of,
    };
  } catch (e) { return { ok: false, reason: `system_json_invalid: ${e.message}` }; }
}

function readLossStreak() {
  if (!existsSync(TRADES_DB)) return { ok: false, reason: "trades_db_missing" };
  try {
    const db = new DatabaseSync(TRADES_DB, { readOnly: true });
    const rows = db
      .prepare(`
        SELECT pnl_abs
        FROM live_trades
        WHERE ts_exit IS NOT NULL AND ts_exit >= ?
        ORDER BY ts_exit DESC
        LIMIT ?
      `)
      .all(SINCE_ISO, STREAK_N);
    db.close();
    if (rows.length < STREAK_N) {
      return { ok: true, streak: 0, sample_size: rows.length, all_losses: false };
    }
    const allLosses = rows.every((r) => Number(r.pnl_abs) < 0);
    return { ok: true, streak: allLosses ? STREAK_N : 0, sample_size: STREAK_N, all_losses: allLosses };
  } catch (e) { return { ok: false, reason: `db_query_failed: ${e.message}` }; }
}

async function fetchD1Sum() {
  try {
    const r = await fetch(`${WORKER_URL}/stats?since=${encodeURIComponent(SINCE_ISO)}`, { cache: "no-store" });
    const j = await r.json();
    if (!j.ok) return { ok: false, reason: "worker_stats_not_ok" };
    return { ok: true, total_pnl_abs: Number(j.overall?.total_pnl_abs ?? 0), trades: j.overall?.total_trades ?? 0 };
  } catch (e) { return { ok: false, reason: `worker_unreachable: ${e.message}` }; }
}

// ---------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------

function evalDrawdown(bal) {
  if (!bal.ok) return { trigger: false, reason: bal.reason };
  const dd = (bal.balance_usdt - BASELINE_USD) / BASELINE_USD * 100;
  const trigger = dd <= -DD_PCT;
  return { trigger, dd_pct: dd.toFixed(2), threshold_pct: -DD_PCT, balance: bal.balance_usdt };
}

function evalDivergence(bal, d1) {
  if (!bal.ok || !d1.ok) return { trigger: false, reason: "input_missing" };
  const expected = BASELINE_USD + d1.total_pnl_abs;
  const diff = bal.balance_usdt - expected;
  const absDiff = Math.abs(diff);
  const pctDiff = absDiff / Math.max(Math.abs(expected), 0.01) * 100;
  const trigger = absDiff > TOL_ABS && pctDiff > TOL_PCT;
  return { trigger, diff_usd: diff.toFixed(4), diff_pct: pctDiff.toFixed(2), tol_abs: TOL_ABS, tol_pct: TOL_PCT };
}

function evalStreak(streakInfo) {
  if (!streakInfo.ok) return { trigger: false, reason: streakInfo.reason };
  return { trigger: streakInfo.all_losses, streak: streakInfo.streak, threshold: STREAK_N, sample: streakInfo.sample_size };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let notifiedFirstFlip = false;

async function tick() {
  const bal = readBalance();
  const streak = readLossStreak();
  const d1 = await fetchD1Sum();

  const triggers = {
    drawdown: evalDrawdown(bal),
    reconcile_divergence: evalDivergence(bal, d1),
    loss_streak: evalStreak(streak),
  };

  const firstHit = Object.entries(triggers).find(([, v]) => v.trigger);
  const wantsPause = !!firstHit;
  const prev = readState();
  const manualOverride = prev?.manual_override === true;

  // Decisão:
  //   - manual_override=true → respeita. Daemon não muda estado.
  //     (operador desligou ou ligou manualmente; daemon só observa)
  //   - prev.active=false (paused) e sem manual_override → mantém pausado
  //     mesmo que condição tenha normalizado (recovery é manual)
  //   - prev.active=true e algum trigger → flip pra paused
  let nextState;
  if (manualOverride) {
    nextState = { ...prev, last_check: snapshot(triggers, bal, d1, streak), updated_at: nowIso() };
  } else if (prev?.active === false) {
    nextState = { ...prev, last_check: snapshot(triggers, bal, d1, streak), updated_at: nowIso() };
  } else if (wantsPause) {
    const [reason, detail] = firstHit;
    nextState = {
      schema_version: SCHEMA_VERSION,
      updated_at: nowIso(),
      active: false,
      paused_at: nowIso(),
      reason,
      triggered_by: detail,
      session_baseline_usd: BASELINE_USD,
      manual_override: false,
      last_check: snapshot(triggers, bal, d1, streak),
    };
    if (!notifiedFirstFlip) {
      notify(`Kill switch DISPAROU: ${reason}`);
      notifiedFirstFlip = true;
    }
  } else {
    nextState = {
      schema_version: SCHEMA_VERSION,
      updated_at: nowIso(),
      active: true,
      paused_at: null,
      reason: null,
      triggered_by: null,
      session_baseline_usd: BASELINE_USD,
      manual_override: false,
      last_check: snapshot(triggers, bal, d1, streak),
    };
  }

  writeState(nextState);
  console.log(JSON.stringify({ ts: nowIso(), active: nextState.active, reason: nextState.reason, snapshot: nextState.last_check }));
}

function snapshot(triggers, bal, d1, streak) {
  return {
    balance: bal.ok ? bal.balance_usdt : null,
    balance_as_of: bal.ok ? bal.as_of : null,
    d1_pnl_sum: d1.ok ? d1.total_pnl_abs : null,
    d1_trades: d1.ok ? d1.trades : null,
    streak_losses: streak.ok ? streak.streak : null,
    triggers,
  };
}

function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, "Z"); }

function notify(message) {
  try {
    spawnSync("osascript", ["-e", `display notification "${message.replace(/"/g, '\\"')}" with title "Bithub"`], { stdio: "ignore" });
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log(JSON.stringify({
    ts: nowIso(),
    msg: "kill_switch_started",
    baseline_usd: BASELINE_USD,
    interval_sec: INTERVAL_SEC,
    triggers: { drawdown_pct: DD_PCT, tol_pct: TOL_PCT, tol_abs: TOL_ABS, streak_n: STREAK_N },
  }));
  while (true) {
    try { await tick(); } catch (e) {
      console.error(JSON.stringify({ ts: nowIso(), level: "error", msg: "tick_failed", error: e.message }));
    }
    await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000));
  }
}

main();
