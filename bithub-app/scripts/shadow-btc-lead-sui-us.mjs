#!/usr/bin/env node
// shadow-btc-lead-sui-us.mjs — read-only forward/shadow scout.
//
// Tese v4:
// BTC-Lead Alt-Echo in SUIUSDT only during US session.
//
// Default mode is local-only: reads cached/public klines, emits structured
// strategy_signal payloads, and writes a JSON artifact. It never places orders.
// Remote D1 ingest requires explicit --ingest plus WORKER_URL and
// BITHUB_INGEST_TOKEN.
//
// Usage:
//   node scripts/shadow-btc-lead-sui-us.mjs --cache-dir /private/tmp/bithub-scalper-matrix-v3 --limit 50400
//   node scripts/shadow-btc-lead-sui-us.mjs --bybit --limit 1200

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runBtcLeadAltEcho } from "./btc-lead-alt-echo.mjs";

const STRATEGY_ID = "btc_lead_alt_echo";
const VERSION_ID = "btc_lead_alt_echo_sui_us_v4_20260529";
const LEAD = "BTCUSDT";
const ALT = "SUIUSDT";
const CONFIG = {
  scoreMin: 70,
  residualZMin: 0.3,
  impulseSigmaMin: 1.8,
  volumeRatioMin: 1.35,
  minTargetPct: 0.44,
  maxTargetPct: 0.9,
  maxHoldMin: 8,
  noMoveExitMin: 3,
  noMoveMinPct: 0.08,
  feePctRoundTrip: 0.11,
};

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

function sessionUtc(ts) {
  const h = new Date(ts).getUTCHours();
  if (h >= 14 && h < 21) return "us";
  if (h >= 8 && h < 14) return "europe";
  if (h >= 0 && h < 8) return "asia";
  return "late";
}

function loadCached(symbol, limit, cacheDir) {
  const path = join(cacheDir, `.klines-${symbol}-${limit}.json`);
  if (!existsSync(path)) throw new Error(`missing cache: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")).slice(-limit);
}

function normalizeBybit(row) {
  return {
    ts: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

async function fetchBybit(symbol, limit) {
  const params = new URLSearchParams({ category: "linear", symbol, interval: "1", limit: String(limit) });
  const res = await fetch(`https://api.bybit.com/v5/market/kline?${params}`, { headers: { accept: "application/json" } });
  const json = await res.json();
  if (json.retCode !== 0) throw new Error(`Bybit public kline failed for ${symbol}: ${json.retMsg ?? json.retCode}`);
  return json.result.list.map(normalizeBybit).sort((a, b) => a.ts - b.ts);
}

function versionPayload() {
  return {
    version_id: VERSION_ID,
    strategy_id: STRATEGY_ID,
    name: "BTC-Lead Alt-Echo SUI US v4",
    regime: "scalp",
    status: "shadow",
    collection_mode: "shadow",
    timeframe: "1m/5m",
    timeframes_json: ["1m", "5m"],
    pair_universe_json: ["BTCUSDT", "SUIUSDT"],
    tags_json: ["btc-lead", "sui", "session-us", "regime-gated", "v4"],
    spec_json: {
      thesis: "SUI catches up to BTC lead impulse during US session only.",
      config: CONFIG,
      source: "2026-05-29 Scalper Regime-Gated v4",
      real_orders: false,
    },
    content_hash: `sha256:${createHash("sha256").update(JSON.stringify(CONFIG)).digest("hex")}`,
  };
}

function signalPayload(signal, trade = null) {
  const price = trade?.entry ?? null;
  return {
    client_signal_id: signal.client_signal_id.replace("btc_lead_alt_echo_v1_20260528", VERSION_ID),
    ts: signal.ts,
    strategy_id: STRATEGY_ID,
    version_id: VERSION_ID,
    symbol: signal.symbol,
    side: signal.side,
    mode: "shadow",
    phase: "signal",
    decision: signal.decision,
    score: signal.setup_score,
    price,
    market_regime_json: {
      session_utc: sessionUtc(signal.ts),
      lead_symbol: LEAD,
      alt_symbol: ALT,
      v4_bucket: "session=us",
    },
    features_json: signal.features_json,
    gates_json: signal.reason,
    execution_plan_json: {
      read_only: true,
      max_hold_min: CONFIG.maxHoldMin,
      min_target_pct: CONFIG.minTargetPct,
      no_order: true,
    },
    entered: signal.entered,
    rejection_reason: signal.entered ? null : signal.reason,
  };
}

function outcomePayload(payloadSignal, trade) {
  const hash = createHash("sha1").update(`${payloadSignal.client_signal_id}:${trade.exit_ts}`).digest("hex").slice(0, 12);
  return {
    client_outcome_id: `outcome:${VERSION_ID}:${hash}`,
    client_signal_id: payloadSignal.client_signal_id,
    ts: trade.exit_ts,
    horizon_sec: Math.max(0, Math.round((new Date(trade.exit_ts).getTime() - new Date(trade.entry_ts).getTime()) / 1000)),
    mfe_pct: trade.mfe_pct,
    mae_pct: trade.mae_pct,
    pnl_pct: trade.pnl_net_pct,
    pnl_abs: null,
    hit_tp: trade.exit_reason === "residual_converged",
    hit_sl: trade.exit_reason === "sl_lag_failed",
    exit_reason: trade.exit_reason,
    actual_trade_id: null,
    labels_json: {
      label: trade.pnl_net_pct > 0 ? "win" : "loss",
      shadow_backtest: true,
    },
  };
}

async function postJson(path, body) {
  const workerUrl = process.env.WORKER_URL;
  const token = process.env.BITHUB_INGEST_TOKEN ?? process.env.BITHUB_WORKER_TOKEN;
  if (!workerUrl || !token) throw new Error("missing WORKER_URL or BITHUB_INGEST_TOKEN");
  const res = await fetch(`${workerUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} failed ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  const limit = Number.parseInt(arg("--limit", "1200"), 10);
  const cacheDir = arg("--cache-dir", "/private/tmp/bithub-scalper-matrix-v3");
  const outDir = arg("--out-dir", "/private/tmp/bithub-shadow-sui-us");
  const lookbackMin = Number.parseInt(arg("--lookback-min", "1440"), 10);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  let lead;
  let alt;
  if (flag("--bybit")) {
    [lead, alt] = await Promise.all([fetchBybit(LEAD, Math.min(limit, 1000)), fetchBybit(ALT, Math.min(limit, 1000))]);
  } else {
    lead = loadCached(LEAD, limit, cacheDir);
    alt = loadCached(ALT, limit, cacheDir);
  }

  const result = runBtcLeadAltEcho({ leadCandles: lead, altCandles: alt, leadSymbol: LEAD, altSymbol: ALT, config: CONFIG });
  const tradesBySignal = new Map(result.trades.map((trade) => [trade.client_signal_id, trade]));
  const cutoff = Date.now() - lookbackMin * 60_000;
  const usSignals = result.signals
    .filter((signal) => signal.decision === "enter")
    .filter((signal) => sessionUtc(signal.ts) === "us")
    .filter((signal) => new Date(signal.ts).getTime() >= cutoff || !flag("--recent-only"));

  const signals = usSignals.map((signal) => signalPayload(signal, tradesBySignal.get(signal.client_signal_id)));
  const outcomes = signals
    .map((payloadSignal) => {
      const originalId = payloadSignal.client_signal_id.replace(VERSION_ID, "btc_lead_alt_echo_v1_20260528");
      const trade = tradesBySignal.get(originalId);
      return trade ? outcomePayload(payloadSignal, trade) : null;
    })
    .filter(Boolean);

  const payload = {
    generated_at: new Date().toISOString(),
    guardrails: {
      read_only: true,
      private_bybit_called: false,
      monitor_started: false,
      orders_sent: false,
    },
    mode: flag("--bybit") ? "bybit_public" : "cache",
    strategy_version: versionPayload(),
    config: CONFIG,
    counts: {
      all_signals: result.signals.length,
      all_entries: result.trades.length,
      us_entries_selected: signals.length,
      outcomes: outcomes.length,
    },
    signals,
    outcomes,
  };

  const outPath = join(outDir, `shadow-btc-lead-sui-us-${nowStamp()}.json`);
  writeFileSync(outPath, JSON.stringify(payload, null, 2));

  if (flag("--ingest")) {
    await postJson("/ingest/strategy-version", payload.strategy_version);
    for (const signal of signals) await postJson("/ingest/strategy-signal", signal);
    if (flag("--ingest-outcomes")) {
      for (const outcome of outcomes) await postJson("/ingest/strategy-outcome", outcome);
    }
  }

  console.log(JSON.stringify({ ok: true, out: outPath, counts: payload.counts, ingest: flag("--ingest") }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
    process.exit(1);
  });
}
