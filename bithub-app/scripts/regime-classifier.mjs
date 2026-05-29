#!/usr/bin/env node
// regime-classifier.mjs — H-RESEARCH-BENCH-001
//
// Local, read-only market context classifier for the Research Bench.
// It reads the monitor publisher files, writes one atomic snapshot to
// ~/.bithub-monitor/regime_snapshot.json, and optionally ingests it into D1.
//
// It does not touch the monitor process, positions, orders, sizing, SL/TP, or
// any execution path. If inputs are missing, it writes a degraded snapshot
// instead of blocking the system.
//
// Usage:
//   node bithub-app/scripts/regime-classifier.mjs --once --no-ingest
//   BITHUB_INGEST_TOKEN=... node bithub-app/scripts/regime-classifier.mjs

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

const STATE_DIR = arg("--state-dir", process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor"));
const INTERVAL_SEC = parseInt(arg("--interval", process.env.REGIME_INTERVAL_SEC ?? "300"), 10);
const ONCE = process.argv.includes("--once");
const NO_INGEST = process.argv.includes("--no-ingest") || process.env.REGIME_NO_INGEST === "1";
const WORKER_URL = (process.env.BITHUB_WORKER_URL ?? "https://bithub-trades-api.guiydantas.workers.dev").replace(/\/$/, "");
const INGEST_TOKEN = process.env.BITHUB_INGEST_TOKEN ?? "";

const STATE_FILE = join(STATE_DIR, "regime_snapshot.json");
const CONTEXT_FILE = join(STATE_DIR, "context.json");
const CANDIDATES_FILE = join(STATE_DIR, "candidates.json");
const SCHEMA_VERSION = 1;

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function floorIsoToMinutes(stepMinutes) {
  const d = new Date();
  d.setUTCSeconds(0, 0);
  const m = d.getUTCMinutes();
  d.setUTCMinutes(m - (m % stepMinutes));
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

function readJson(path) {
  if (!existsSync(path)) return { ok: false, reason: "missing" };
  try {
    return { ok: true, data: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (e) {
    return { ok: false, reason: `invalid_json: ${e.message}` };
  }
}

function writeStateAtomic(state) {
  const tmp = join(STATE_DIR, `.regime_snapshot.${process.pid}.${Date.now()}.json`);
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o644 });
  renameSync(tmp, STATE_FILE);
}

function normalizeTf(value) {
  const s = String(value ?? "").toUpperCase();
  const bull = (s.match(/BULL/g) ?? []).length;
  const bear = (s.match(/BEAR/g) ?? []).length;
  if (bull >= 2 && bear === 0) return "strong-up";
  if (bull > bear) return "weak-up";
  if (bear >= 2 && bull === 0) return "strong-down";
  if (bear > bull) return "weak-down";
  return "range";
}

function classifyTrend(asset) {
  if (!asset) return "unknown";
  const byTf = normalizeTf(asset.tf_class);
  const ema = Number(asset.ema_spread_pct ?? 0);
  const adx = Number(asset.adx ?? 0);
  if (byTf !== "range") return byTf;
  if (adx >= 25 && ema > 0.05) return "weak-up";
  if (adx >= 25 && ema < -0.05) return "weak-down";
  return "range";
}

function classifyBias(btcTrend, ethTrend) {
  const up = new Set(["strong-up", "weak-up"]);
  const down = new Set(["strong-down", "weak-down"]);
  if (up.has(btcTrend) && up.has(ethTrend)) return "aligned-bull";
  if (down.has(btcTrend) && down.has(ethTrend)) return "aligned-bear";
  if ((up.has(btcTrend) && down.has(ethTrend)) || (down.has(btcTrend) && up.has(ethTrend))) return "divergent";
  if (btcTrend === "range" && ethTrend === "range") return "range";
  return "mixed";
}

function classifyVol(context, candidates) {
  const values = [
    Number(context?.btc?.atr_pct),
    Number(context?.eth?.atr_pct),
    ...(candidates?.candidates ?? []).map((c) => Number(c?.indicators?.atr_pct)),
  ].filter(Number.isFinite);
  if (!values.length) return "unknown";
  values.sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  if (median < 0.12) return "low";
  if (median < 0.65) return "mid";
  return "high";
}

function classifyFunding(context, candidates) {
  const values = [
    Number(context?.btc?.funding_rate),
    Number(context?.eth?.funding_rate),
    ...(candidates?.candidates ?? []).map((c) => Number(c?.indicators?.funding_rate)),
  ].filter(Number.isFinite);
  if (!values.length) return "unknown";
  values.sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  if (median >= 0.00015) return "long-heavy";
  if (median <= -0.00015) return "short-heavy";
  return "neutral";
}

function classifySessionUtc(ts = new Date()) {
  const hour = ts.getUTCHours();
  if (hour >= 0 && hour < 7) return "asia";
  if (hour >= 7 && hour < 12) return "eu";
  if (hour >= 12 && hour < 16) return "overlap";
  if (hour >= 16 && hour < 21) return "us";
  return "dead";
}

function buildSnapshot() {
  const contextRead = readJson(CONTEXT_FILE);
  const candidatesRead = readJson(CANDIDATES_FILE);
  const context = contextRead.ok ? contextRead.data : null;
  const candidates = candidatesRead.ok ? candidatesRead.data : null;
  const bucketTs = floorIsoToMinutes(5);
  const btcTrend = classifyTrend(context?.btc);
  const ethTrend = classifyTrend(context?.eth);

  const snapshot = {
    schema_version: SCHEMA_VERSION,
    regime_snapshot_id: `regime_${bucketTs.replace(/[-:]/g, "").replace("T", "_").replace("Z", "Z")}`,
    ts: bucketTs,
    generated_at: nowIso(),
    btc_trend: btcTrend,
    eth_trend: ethTrend,
    btc_eth_bias: classifyBias(btcTrend, ethTrend),
    vol_regime: classifyVol(context, candidates),
    alt_corr_regime: "unknown",
    funding_regime: classifyFunding(context, candidates),
    session_utc: classifySessionUtc(),
    source: "regime-classifier-v0",
    degraded: !contextRead.ok,
    degraded_reason: contextRead.ok ? null : `context_json_${contextRead.reason}`,
    raw_features_json: {
      context_as_of: context?.as_of ?? null,
      candidates_as_of: candidates?.as_of ?? null,
      btc: context?.btc ?? null,
      eth: context?.eth ?? null,
      candidates_total: candidates?.total ?? null,
      candidates_passing: candidates?.passing ?? null,
    },
  };
  return snapshot;
}

async function ingestSnapshot(snapshot) {
  if (NO_INGEST || !INGEST_TOKEN) {
    return { ok: true, skipped: true, reason: NO_INGEST ? "disabled" : "missing_token" };
  }
  const payload = {
    regime_snapshot_id: snapshot.regime_snapshot_id,
    ts: snapshot.ts,
    btc_trend: snapshot.btc_trend,
    eth_trend: snapshot.eth_trend,
    btc_eth_bias: snapshot.btc_eth_bias,
    vol_regime: snapshot.vol_regime,
    alt_corr_regime: snapshot.alt_corr_regime,
    funding_regime: snapshot.funding_regime,
    session_utc: snapshot.session_utc,
    raw_features_json: snapshot.raw_features_json,
    degraded: snapshot.degraded,
    degraded_reason: snapshot.degraded_reason,
    source: snapshot.source,
  };
  try {
    const res = await fetch(`${WORKER_URL}/ingest/regime-snapshot`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${INGEST_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function tick() {
  const snapshot = buildSnapshot();
  writeStateAtomic(snapshot);
  const ingest = await ingestSnapshot(snapshot);
  console.log(JSON.stringify({
    ts: nowIso(),
    regime_snapshot_id: snapshot.regime_snapshot_id,
    btc_trend: snapshot.btc_trend,
    eth_trend: snapshot.eth_trend,
    btc_eth_bias: snapshot.btc_eth_bias,
    vol_regime: snapshot.vol_regime,
    funding_regime: snapshot.funding_regime,
    session_utc: snapshot.session_utc,
    degraded: snapshot.degraded,
    ingest,
  }));
}

async function main() {
  console.log(JSON.stringify({
    ts: nowIso(),
    msg: "regime_classifier_started",
    state_dir: STATE_DIR,
    interval_sec: INTERVAL_SEC,
    once: ONCE,
    ingest_enabled: !NO_INGEST && Boolean(INGEST_TOKEN),
  }));
  while (true) {
    try {
      await tick();
    } catch (e) {
      console.error(JSON.stringify({ ts: nowIso(), level: "error", msg: "tick_failed", error: e.message }));
    }
    if (ONCE) break;
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_SEC * 1000));
  }
}

main();
