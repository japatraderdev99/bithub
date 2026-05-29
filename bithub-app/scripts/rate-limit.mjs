#!/usr/bin/env node
// rate-limit.mjs — H-PRE-ROUND-3 Gate C
//
// Daemon que limita quantas novas entradas o monitor pode abrir em janelas
// de tempo. NÃO mexe em posições abertas, NÃO fecha — só bloqueia ENTRY
// quando alguma janela estoura.
//
// 3 janelas, qualquer estouro = bloqueio:
//   - last_60min     (default cap: 3 trades)
//   - last_24h       (default cap: 30 trades)
//   - session        (desde --session-start; default cap: 20 trades)
//
// Round 2 fez 50 trades em 14h ≈ 3.5/h. Com defaults (3/h e 20/sessão),
// teria sido bloqueado por volta do trade #20 (entrando em modo "calma").
// Trail/exit/manage continua funcionando normal — só ENTRY trava.
//
// Como o kill switch (Gate A), o monitor lê o arquivo de estado em cada
// ciclo de decisão de entrada. Aqui não há "manual override sticky":
// rate limit reseta naturalmente pelo passar do tempo. Daemon escreve
// `can_enter: true/false` em cada tick.
//
// Uso:
//   node rate-limit.mjs \
//     --session-start "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
//     [--per-hour 3] [--per-24h 30] [--per-session 20] \
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

const SESSION_START = arg("--session-start", process.env.RL_SESSION_START ?? new Date().toISOString());
const PER_HOUR = parseInt(arg("--per-hour", process.env.RL_PER_HOUR ?? "3"), 10);
const PER_24H = parseInt(arg("--per-24h", process.env.RL_PER_24H ?? "30"), 10);
const PER_SESSION = parseInt(arg("--per-session", process.env.RL_PER_SESSION ?? "20"), 10);
const INTERVAL_SEC = parseInt(arg("--interval", process.env.RL_INTERVAL_SEC ?? "60"), 10);

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

const STATE_FILE = join(STATE_DIR, "rate_limit.json");
const TRADES_DB = join(STATE_DIR, "trades.db");
const SCHEMA_VERSION = 1;

function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, "Z"); }

function writeStateAtomic(state) {
  // tmp in same dir → rename is guaranteed atomic (same filesystem)
  const tmp = join(STATE_DIR, `.rate_limit.${process.pid}.${Date.now()}.json`);
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o644 });
  renameSync(tmp, STATE_FILE);
}

function isoAgo(ms) { return new Date(Date.now() - ms).toISOString().replace(/\.\d+Z$/, "Z"); }

function countTrades() {
  if (!existsSync(TRADES_DB)) return { ok: false, reason: "trades_db_missing" };
  try {
    const db = new DatabaseSync(TRADES_DB, { readOnly: true });
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('position_lifecycle_events','live_trades')`)
      .all()
      .map((row) => row.name);
    const hasLifecycle = tables.includes("position_lifecycle_events");
    const hasLiveTrades = tables.includes("live_trades");
    if (!hasLifecycle && !hasLiveTrades) {
      db.close();
      return { ok: false, reason: "trades_tables_missing" };
    }

    // Prefer lifecycle ENTRY_ORDER_PLACED because live_trades is written on close.
    // Falling back keeps the daemon useful against older local DBs.
    const source = hasLifecycle ? "lifecycle" : "live_trades";
    const sql =
      source === "lifecycle"
        ? `SELECT COUNT(*) AS n FROM position_lifecycle_events
           WHERE phase = 'entry' AND event_type = 'ENTRY_ORDER_PLACED' AND ts >= ?`
        : `SELECT COUNT(*) AS n FROM live_trades WHERE ts_entry >= ?`;
    const oldestSql =
      source === "lifecycle"
        ? `SELECT ts AS ts_entry FROM position_lifecycle_events
           WHERE phase = 'entry' AND event_type = 'ENTRY_ORDER_PLACED' AND ts >= ?
           ORDER BY ts ASC LIMIT 1`
        : `SELECT ts_entry FROM live_trades WHERE ts_entry >= ? ORDER BY ts_entry ASC LIMIT 1`;

    const last60min = db.prepare(sql).get(isoAgo(60 * 60 * 1000));
    const last24h = db.prepare(sql).get(isoAgo(24 * 60 * 60 * 1000));
    const session = db.prepare(sql).get(SESSION_START);
    const oldestInHour = db.prepare(oldestSql).get(isoAgo(60 * 60 * 1000));
    db.close();
    return {
      ok: true,
      source,
      last_60min: last60min.n,
      last_24h: last24h.n,
      session: session.n,
      oldest_ts_in_hour: oldestInHour?.ts_entry ?? null,
    };
  } catch (e) { return { ok: false, reason: `db_query_failed: ${e.message}` }; }
}

function nextSlotAt(counts) {
  // Se hourly estourou: próxima vaga é oldest_ts_in_hour + 60min
  if (counts.oldest_ts_in_hour && counts.last_60min >= PER_HOUR) {
    const oldest = new Date(counts.oldest_ts_in_hour).getTime();
    return new Date(oldest + 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  }
  return null;
}

function evaluate(counts) {
  const reasons = [];
  if (counts.last_60min >= PER_HOUR) reasons.push("hourly_cap");
  if (counts.last_24h >= PER_24H) reasons.push("daily_cap");
  if (counts.session >= PER_SESSION) reasons.push("session_cap");
  return { can_enter: reasons.length === 0, reasons };
}

async function tick() {
  const counts = countTrades();
  if (!counts.ok) {
    writeStateAtomic({
      schema_version: SCHEMA_VERSION,
      updated_at: nowIso(),
      can_enter: true,   // fail-open: se DB ausente, não trava monitor
      reason: null,
      degraded: true,
      degraded_reason: counts.reason,
      session_start: SESSION_START,
      limits: { per_hour: PER_HOUR, per_24h: PER_24H, per_session: PER_SESSION },
    });
    console.log(JSON.stringify({ ts: nowIso(), level: "warn", msg: "rate_limit_degraded", reason: counts.reason }));
    return;
  }

  const verdict = evaluate(counts);
  const state = {
    schema_version: SCHEMA_VERSION,
    updated_at: nowIso(),
    can_enter: verdict.can_enter,
    reason: verdict.can_enter ? null : verdict.reasons.join(","),
    counts: {
      last_60min: counts.last_60min,
      last_24h: counts.last_24h,
      session: counts.session,
    },
    source: counts.source,
    limits: { per_hour: PER_HOUR, per_24h: PER_24H, per_session: PER_SESSION },
    session_start: SESSION_START,
    next_slot_available_at: nextSlotAt(counts),
  };
  writeStateAtomic(state);
  console.log(JSON.stringify({ ts: nowIso(), can_enter: state.can_enter, reason: state.reason, counts: state.counts }));
}

async function main() {
  console.log(JSON.stringify({
    ts: nowIso(),
    msg: "rate_limit_started",
    limits: { per_hour: PER_HOUR, per_24h: PER_24H, per_session: PER_SESSION },
    session_start: SESSION_START,
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
