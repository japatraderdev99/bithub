#!/usr/bin/env node
// cooldowns.mjs — H-PRE-ROUND-3 Gate D
//
// Daemon que mantém um mapa de "cooldown por símbolo" — bloqueio de
// re-entrada na mesma moeda logo após uma saída. Bloqueio é local ao símbolo:
// outras moedas continuam livres para entrar (sujeito a kill-switch +
// rate-limit).
//
// Política:
//   - Após QUALQUER exit fechado: cooldown LEVE (default 5 min) no símbolo.
//     Evita revenge re-entry / churn — Round 2 viu UB/PLAYSOUT/JELLY com
//     3-4 entradas cada em ~12h.
//   - Após exit com pnl_pct <= LOSS_THRESHOLD (default 0.0%, i.e. qualquer
//     saída negativa): cooldown PESADO (default 60 min). "Não tente vingar o stop."
//
// Diferente do rate-limit: cooldown é gatilhado por FECHAMENTO de posição
// (registrado em live_trades.ts_exit), então live_trades é a fonte correta
// — não tem o problema temporal de "só popula no close" porque o que nos
// interessa É o close.
//
// Como kill-switch / rate-limit, o monitor lê o arquivo em cada ciclo de
// entry-decision: `cooldowns[symbol].until > now` → bloqueia.
//
// Uso:
//   node cooldowns.mjs \
//     [--cooldown-any-exit-min 5] [--cooldown-loss-min 60] \
//     [--loss-threshold-pct -1.0] [--max-tracked-min 120] \
//     [--interval 60]

import { existsSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

const STATE_DIR = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");

const COOLDOWN_ANY_EXIT_MIN = parseInt(arg("--cooldown-any-exit-min", process.env.CD_ANY_EXIT_MIN ?? "5"), 10);
const COOLDOWN_LOSS_MIN = parseInt(arg("--cooldown-loss-min", process.env.CD_LOSS_MIN ?? "60"), 10);
const LOSS_THRESHOLD_PCT = parseFloat(arg("--loss-threshold-pct", process.env.CD_LOSS_THRESHOLD ?? "0.0"));
const MAX_TRACKED_MIN = parseInt(arg("--max-tracked-min", process.env.CD_MAX_TRACKED_MIN ?? "120"), 10);
const INTERVAL_SEC = parseInt(arg("--interval", process.env.CD_INTERVAL_SEC ?? "60"), 10);

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

const STATE_FILE = join(STATE_DIR, "cooldowns.json");
const TRADES_DB = join(STATE_DIR, "trades.db");
const SCHEMA_VERSION = 1;

function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, "Z"); }
function isoAgo(ms) { return new Date(Date.now() - ms).toISOString().replace(/\.\d+Z$/, "Z"); }
function addMinutes(isoTs, minutes) {
  return new Date(new Date(isoTs).getTime() + minutes * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
}

function writeStateAtomic(state) {
  const tmp = join(STATE_DIR, `.cooldowns.${process.pid}.${Date.now()}.json`);
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o644 });
  renameSync(tmp, STATE_FILE);
}

function computeCooldowns() {
  if (!existsSync(TRADES_DB)) return { ok: false, reason: "trades_db_missing", cooldowns: {} };
  try {
    const db = new DatabaseSync(TRADES_DB, { readOnly: true });
    // Pega o exit mais recente por símbolo dentro da janela max_tracked.
    // Cooldown LIGHT máximo é COOLDOWN_LOSS_MIN, então qualquer trade mais
    // velho que isso já não pode estar em cooldown.
    const horizonIso = isoAgo(MAX_TRACKED_MIN * 60_000);
    const rows = db.prepare(`
      SELECT symbol, ts_exit, pnl_pct
      FROM (
        SELECT
          symbol,
          ts_exit,
          pnl_pct,
          ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY ts_exit DESC, id DESC) AS rn
        FROM live_trades
        WHERE ts_exit IS NOT NULL AND ts_exit >= ?
      )
      WHERE rn = 1
    `).all(horizonIso);
    db.close();

    const nowMs = Date.now();
    const cooldowns = {};
    for (const r of rows) {
      const lossPct = Number(r.pnl_pct);
      const isLoss = Number.isFinite(lossPct) && lossPct <= LOSS_THRESHOLD_PCT;
      const minutes = isLoss ? COOLDOWN_LOSS_MIN : COOLDOWN_ANY_EXIT_MIN;
      const until = addMinutes(r.ts_exit, minutes);
      if (new Date(until).getTime() > nowMs) {
        cooldowns[r.symbol] = {
          until,
          reason: isLoss ? `loss_${lossPct.toFixed(2)}pct` : "recent_exit",
          applied_at: r.ts_exit,
          pnl_pct: Number.isFinite(lossPct) ? lossPct : null,
          minutes,
        };
      }
    }
    return { ok: true, cooldowns };
  } catch (e) { return { ok: false, reason: `db_query_failed: ${e.message}`, cooldowns: {} }; }
}

async function tick() {
  const res = computeCooldowns();
  const state = {
    schema_version: SCHEMA_VERSION,
    updated_at: nowIso(),
    degraded: !res.ok,
    degraded_reason: res.ok ? null : res.reason,
    config: {
      cooldown_any_exit_min: COOLDOWN_ANY_EXIT_MIN,
      cooldown_loss_min: COOLDOWN_LOSS_MIN,
      loss_threshold_pct: LOSS_THRESHOLD_PCT,
      max_tracked_min: MAX_TRACKED_MIN,
    },
    cooldowns: res.cooldowns,
    active_count: Object.keys(res.cooldowns).length,
  };
  writeStateAtomic(state);
  console.log(JSON.stringify({
    ts: nowIso(),
    active_count: state.active_count,
    symbols: Object.keys(res.cooldowns),
    degraded: state.degraded,
  }));
}

async function main() {
  console.log(JSON.stringify({
    ts: nowIso(),
    msg: "cooldowns_started",
    config: {
      cooldown_any_exit_min: COOLDOWN_ANY_EXIT_MIN,
      cooldown_loss_min: COOLDOWN_LOSS_MIN,
      loss_threshold_pct: LOSS_THRESHOLD_PCT,
      max_tracked_min: MAX_TRACKED_MIN,
    },
    interval_sec: INTERVAL_SEC,
  }));
  while (true) {
    try { await tick(); } catch (e) {
      console.error(JSON.stringify({ ts: nowIso(), level: "error", msg: "tick_failed", error: e.message }));
    }
    await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000));
  }
}

main();
