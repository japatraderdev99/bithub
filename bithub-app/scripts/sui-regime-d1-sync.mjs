#!/usr/bin/env node
// sui-regime-d1-sync.mjs
//
// Drains the shadow runner's local JSONL files into Cloudflare D1 via the
// Bithub Worker ingest endpoints. Reads what was newly recorded since the
// last sync (tracked via `.last-sync-cursor.json`), POSTs each row, and
// advances the cursor only after the row succeeds.
//
// Endpoints used:
//   POST /ingest/strategy-signal
//   POST /ingest/strategy-outcome
//
// Env required:
//   BITHUB_WORKER_URL   (e.g. https://bithub-trades-api.guiydantas.workers.dev)
//   BITHUB_INGEST_TOKEN (bearer token; never logged)
//
// Guardrails:
//   - Read-only against Bybit (does not call Bybit at all).
//   - Does not run the strategy; only drains files the shadow runner wrote.
//   - Token never echoed.
//   - Safe to re-run: idempotent via per-row cursor.
//
// Usage:
//   BITHUB_WORKER_URL=... BITHUB_INGEST_TOKEN=... \
//   node scripts/sui-regime-d1-sync.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { STRATEGY_VERSION_ID } from "./strategies/btc-lead-alt-echo-sui-regime-v1.mjs";

const STRATEGY_ID = "btc_lead_alt_echo_sui_regime";
const STATE_DIR = process.env.BITHUB_SUI_REGIME_DIR ?? join(homedir(), ".bithub-monitor", "sui-regime");
const SIGNALS_FILE = join(STATE_DIR, "signals.jsonl");
const BLOCKED_FILE = join(STATE_DIR, "signals_blocked.jsonl");
const OUTCOMES_FILE = join(STATE_DIR, "outcomes.jsonl");
const CURSOR_FILE = join(STATE_DIR, "d1-sync-cursor.json");
const SYNC_LOG = join(STATE_DIR, "d1-sync.log");

function readCursor() {
  const empty = { signals_offset: 0, blocked_offset: 0, outcomes_offset: 0 };
  if (!existsSync(CURSOR_FILE)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(CURSOR_FILE, "utf8"));
    return { ...empty, ...parsed };
  } catch { return empty; }
}

function writeCursor(cur) {
  writeFileSync(CURSOR_FILE, JSON.stringify(cur, null, 2));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); }
      catch { return null; }
    })
    .filter(Boolean);
}

async function post(url, token, path, payload) {
  const endpoint = `${url.replace(/\/$/, "")}${path}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${path} ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}

function shapeSignal(raw) {
  // Map a JSONL row to the Worker's /ingest/strategy-signal schema. The
  // canonical shape lives in bithub_state_publisher.py (signal_payload at
  // line 1053 of H-003); mode and phase MUST sit at the root, not inside
  // features_json.
  const entered = raw.entered === true;
  const decision = raw.decision ?? "skip";
  const phase = decision === "enter" ? "entry" : "evaluation";
  const blockedByGate = raw.regime_gate_passed === false;
  return {
    client_signal_id: raw.client_signal_id,
    strategy_id: STRATEGY_ID,
    version_id: raw.strategy_version_id ?? STRATEGY_VERSION_ID,
    ts: raw.ts,
    symbol: raw.symbol,
    side: raw.side,
    mode: "shadow",
    phase,
    decision,
    score: raw.setup_score ?? null,
    price: null,                              // shadow: no fill price; gate-time only
    market_regime_json: {
      regime_gate_features: raw.regime_gate_features ?? null,
      lead_features: raw.regime_snapshot_json ?? null,
    },
    features_json: {
      confidence: raw.confidence ?? null,
      expected_edge: raw.expected_edge ?? null,
      setup_score: raw.setup_score ?? null,
      regime_gate_passed: raw.regime_gate_passed,
      regime_gate_reason: raw.regime_gate_reason ?? null,
      inner_features: raw.features_json ?? null,
    },
    execution_plan_json: null,                // shadow: no plan; promotion to paper attaches one
    entered,
    rejection_reason: !entered ? (blockedByGate ? `regime_blocked:${raw.regime_gate_reason ?? "unknown"}` : raw.reason ?? "score_below_threshold") : null,
    actual_trade_id: null,                    // shadow: no trade
    regime_snapshot_id: null,                 // backfilled by Worker if classifier ran for this ts
  };
}

function shapeOutcome(raw) {
  return {
    client_signal_id: raw.client_signal_id,
    version_id: raw.strategy_version_id ?? STRATEGY_VERSION_ID,
    ts: raw.ts,
    horizon_sec: raw.horizon_sec ?? null,
    mfe_pct: raw.mfe_pct ?? null,
    mae_pct: raw.mae_pct ?? null,
    exit_reason: raw.exit_reason ?? null,
    pnl_gross_usd: raw.pnl_gross_usd ?? null,
    fee_usd: raw.fee_usd ?? null,
    pnl_net_usd: raw.pnl_net_usd ?? null,
    label: raw.label ?? null,
  };
}

function log(line) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}\n`;
  try {
    writeFileSync(SYNC_LOG, msg, { flag: "a" });
  } catch {
    /* best-effort */
  }
}

async function main() {
  const url = process.env.BITHUB_WORKER_URL;
  const token = process.env.BITHUB_INGEST_TOKEN;
  if (!url) throw new Error("BITHUB_WORKER_URL env var required");
  if (!token) throw new Error("BITHUB_INGEST_TOKEN env var required");

  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

  const cursor = readCursor();
  const allSignals = readJsonl(SIGNALS_FILE);
  const allBlocked = readJsonl(BLOCKED_FILE);
  const allOutcomes = readJsonl(OUTCOMES_FILE);

  const newSignals = allSignals.slice(cursor.signals_offset);
  const newBlocked = allBlocked.slice(cursor.blocked_offset);
  const newOutcomes = allOutcomes.slice(cursor.outcomes_offset);

  log(`drain start: signals=${newSignals.length}, blocked=${newBlocked.length}, outcomes=${newOutcomes.length}`);

  let signalsPosted = 0;
  for (const raw of newSignals) {
    try {
      await post(url, token, "/ingest/strategy-signal", shapeSignal(raw));
      signalsPosted += 1;
      cursor.signals_offset += 1;
      writeCursor(cursor);
    } catch (err) {
      log(`signal ${raw.client_signal_id} failed: ${err.message}`);
      break;
    }
  }

  // Gate-blocked signals are also persisted to D1 so the Registry can audit
  // how often the gate fires and why. They are decision=skip records, so
  // they do not inflate entry stats — but they DO make the strategy appear
  // in /strategy-summary (which JOINs strategy_versions with strategy_signals)
  // before the first real entry lands.
  let blockedPosted = 0;
  for (const raw of newBlocked) {
    try {
      await post(url, token, "/ingest/strategy-signal", shapeSignal(raw));
      blockedPosted += 1;
      cursor.blocked_offset += 1;
      writeCursor(cursor);
    } catch (err) {
      log(`blocked ${raw.client_signal_id} failed: ${err.message}`);
      break;
    }
  }

  let outcomesPosted = 0;
  for (const raw of newOutcomes) {
    try {
      await post(url, token, "/ingest/strategy-outcome", shapeOutcome(raw));
      outcomesPosted += 1;
      cursor.outcomes_offset += 1;
      writeCursor(cursor);
    } catch (err) {
      log(`outcome ${raw.client_signal_id} failed: ${err.message}`);
      break;
    }
  }

  const summary = {
    ok: true,
    strategy_version_id: STRATEGY_VERSION_ID,
    signals_posted: signalsPosted,
    blocked_posted: blockedPosted,
    outcomes_posted: outcomesPosted,
    cursor: { ...cursor },
    remaining: {
      signals: allSignals.length - cursor.signals_offset,
      blocked: allBlocked.length - cursor.blocked_offset,
      outcomes: allOutcomes.length - cursor.outcomes_offset,
    },
  };
  log(`drain done: ${signalsPosted} signals, ${blockedPosted} blocked, ${outcomesPosted} outcomes`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
