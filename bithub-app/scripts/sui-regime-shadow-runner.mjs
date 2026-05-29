#!/usr/bin/env node
// sui-regime-shadow-runner.mjs
//
// Shadow-only collector for btc-lead-alt-echo-sui-regime-v1. Runs as a
// one-shot tick that the operator schedules (cron/screen). It:
//   1. Fetches the last 500 1m candles from Bybit public for BTC and SUI.
//   2. Runs the regime-gated strategy.
//   3. Records every new signal (entered or blocked-by-gate) and every
//      newly-closed trade into JSONL files in ~/.bithub-monitor/sui-regime/.
//
// Guardrails enforced by design:
//   - Bybit public klines only. No private API, no orders, no monitor.
//   - No control over monitor_all.py. Operator runs this separately.
//   - Signals/trades go to local JSONL files; D1 sync is a separate step
//     (sui-regime-d1-sync.mjs) so credentials never live in this process.
//
// Usage:
//   node scripts/sui-regime-shadow-runner.mjs                    # one tick
//   node scripts/sui-regime-shadow-runner.mjs --since-min 60     # wider scan
//   node scripts/sui-regime-shadow-runner.mjs --dry-run          # no write
//
// Operator-side cron suggestion (1 tick / min):
//   * * * * * cd /path/to/bithub-app && node scripts/sui-regime-shadow-runner.mjs >> /tmp/sui-regime-shadow.log 2>&1

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { runStrategy, STRATEGY_VERSION_ID } from "./strategies/btc-lead-alt-echo-sui-regime-v1.mjs";

const STATE_DIR = process.env.BITHUB_SUI_REGIME_DIR ?? join(homedir(), ".bithub-monitor", "sui-regime");
const SIGNALS_FILE = join(STATE_DIR, "signals.jsonl");
const BLOCKED_FILE = join(STATE_DIR, "signals_blocked.jsonl");
const TRADES_FILE = join(STATE_DIR, "trades.jsonl");
const OUTCOMES_FILE = join(STATE_DIR, "outcomes.jsonl");
const STATE_FILE = join(STATE_DIR, "shadow-state.json");
const TICK_LOG = join(STATE_DIR, "ticks.jsonl");

const FETCH_LIMIT = 500;          // ~8.3 hours of 1m candles per symbol
const KLINE_DELAY_MS = 200;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
function flag(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeBybitKline(row) {
  return { ts: Number(row[0]), open: +row[1], high: +row[2], low: +row[3], close: +row[4], volume: +row[5] };
}

async function fetchBybit(symbol, limit) {
  const byTs = new Map();
  let end = null;
  while (byTs.size < limit) {
    const batch = Math.min(1000, limit - byTs.size);
    const params = new URLSearchParams({ category: "linear", symbol, interval: "1", limit: String(batch) });
    if (end != null) params.set("end", String(end));
    const res = await fetch(`https://api.bybit.com/v5/market/kline?${params}`, { headers: { accept: "application/json" } });
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`bybit ${symbol}: ${json.retMsg ?? json.retCode}`);
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
    await sleep(KLINE_DELAY_MS);
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-limit);
}

// Persisted dedup set built from prior JSONL files so we never write the
// same signal/trade twice across ticks. Cap is implicit — the files grow
// linearly with real activity (~10/day after gate), so memory stays small.
function readJsonlIds(path, idKey) {
  if (!existsSync(path)) return new Set();
  const ids = new Set();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj[idKey]) ids.add(obj[idKey]);
    } catch {
      /* corrupt line — skip */
    }
  }
  return ids;
}

function ensureStateDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function readState() {
  if (!existsSync(STATE_FILE)) {
    return { first_seen_at: new Date().toISOString(), strategy_version_id: STRATEGY_VERSION_ID, last_tick_at: null, last_signal_id_emitted: null };
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function writeState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const WORKER_URL = process.env.BITHUB_WORKER_URL ?? "https://bithub-trades-api.guiydantas.workers.dev";

async function checkActivation(versionId) {
  // Gate: shadow runner only evaluates when the operator has clicked
  // "Activate" in the Library UI (is_active=1 in D1). --force bypasses
  // for debugging. If the Worker is unreachable we DO NOT run by default
  // (fail-closed); pass --force to override.
  if (flag("--force")) return { active: true, reason: "force_flag" };
  try {
    const url = `${WORKER_URL}/strategy-versions?version_id=${encodeURIComponent(versionId)}&limit=1`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { active: false, reason: `worker_${res.status}` };
    const body = await res.json();
    const row = body?.versions?.[0];
    if (!row) return { active: false, reason: "not_in_registry" };
    return { active: Number(row.is_active) === 1, reason: `is_active=${row.is_active}`, status: row.status };
  } catch (e) {
    return { active: false, reason: `worker_unreachable:${e.message ?? e}` };
  }
}

async function main() {
  ensureStateDir();
  const dryRun = flag("--dry-run");
  const sinceMin = Number.parseInt(arg("--since-min", "120"), 10);
  const sinceCutoff = Date.now() - sinceMin * 60_000;

  const tickStartedAt = new Date().toISOString();
  console.error(`[shadow] ${tickStartedAt} tick (since_min=${sinceMin}, dry=${dryRun})`);

  const activation = await checkActivation(STRATEGY_VERSION_ID);
  if (!activation.active) {
    const skipRecord = {
      tick_at: tickStartedAt,
      strategy_version_id: STRATEGY_VERSION_ID,
      skipped: true,
      reason: activation.reason,
    };
    if (!dryRun) appendFileSync(TICK_LOG, JSON.stringify(skipRecord) + "\n");
    console.log(JSON.stringify({ ok: true, skipped: true, reason: activation.reason, strategy_version_id: STRATEGY_VERSION_ID }, null, 2));
    return;
  }

  const [btc, sui] = await Promise.all([fetchBybit("BTCUSDT", FETCH_LIMIT), fetchBybit("SUIUSDT", FETCH_LIMIT)]);
  if (btc.length < 100 || sui.length < 100) throw new Error(`insufficient candles: btc=${btc.length} sui=${sui.length}`);

  const result = runStrategy({ leadCandles: btc, altCandles: sui });

  const knownSignalIds = readJsonlIds(SIGNALS_FILE, "client_signal_id");
  const knownBlockedIds = readJsonlIds(BLOCKED_FILE, "client_signal_id");
  const knownTradeIds = readJsonlIds(TRADES_FILE, "client_signal_id");
  const knownOutcomeIds = readJsonlIds(OUTCOMES_FILE, "client_signal_id");

  const newEntered = [];
  const newBlocked = [];
  for (const sig of result.signals) {
    const sigTs = new Date(sig.ts).getTime();
    if (sigTs < sinceCutoff) continue;          // only consider very recent signals
    if (sig.decision === "enter") {
      if (knownSignalIds.has(sig.client_signal_id)) continue;
      newEntered.push(sig);
    } else if (sig.regime_gate_passed === false) {
      // Track gate-blocked signals separately so drift in the gate is auditable.
      if (knownBlockedIds.has(sig.client_signal_id)) continue;
      newBlocked.push(sig);
    }
  }

  const newTrades = [];
  const newOutcomes = [];
  for (const trade of result.trades) {
    if (knownTradeIds.has(trade.client_signal_id)) continue;
    newTrades.push(trade);
  }
  for (const outcome of result.outcomes) {
    if (knownOutcomeIds.has(outcome.client_signal_id)) continue;
    newOutcomes.push(outcome);
  }

  if (!dryRun) {
    for (const s of newEntered) appendFileSync(SIGNALS_FILE, JSON.stringify({ ...s, recorded_at: tickStartedAt }) + "\n");
    for (const s of newBlocked) appendFileSync(BLOCKED_FILE, JSON.stringify({ ...s, recorded_at: tickStartedAt }) + "\n");
    for (const t of newTrades) appendFileSync(TRADES_FILE, JSON.stringify({ ...t, recorded_at: tickStartedAt }) + "\n");
    for (const o of newOutcomes) appendFileSync(OUTCOMES_FILE, JSON.stringify({ ...o, recorded_at: tickStartedAt }) + "\n");
    const tickRecord = {
      tick_at: tickStartedAt,
      strategy_version_id: STRATEGY_VERSION_ID,
      candles: { btc: btc.length, sui: sui.length },
      result_summary: result.summary,
      new_entered: newEntered.length,
      new_blocked: newBlocked.length,
      new_trades: newTrades.length,
      new_outcomes: newOutcomes.length,
    };
    appendFileSync(TICK_LOG, JSON.stringify(tickRecord) + "\n");
    const state = readState();
    state.last_tick_at = tickStartedAt;
    if (newEntered.length) state.last_signal_id_emitted = newEntered[newEntered.length - 1].client_signal_id;
    writeState(state);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        tick_at: tickStartedAt,
        strategy_version_id: STRATEGY_VERSION_ID,
        new_entered: newEntered.length,
        new_blocked_by_gate: newBlocked.length,
        new_trades: newTrades.length,
        new_outcomes: newOutcomes.length,
        summary: result.summary,
        dry_run: dryRun,
        state_dir: STATE_DIR,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  const tickAt = new Date().toISOString();
  ensureStateDir();
  appendFileSync(TICK_LOG, JSON.stringify({ tick_at: tickAt, ok: false, error: err.message }) + "\n");
  console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
  process.exit(1);
});
