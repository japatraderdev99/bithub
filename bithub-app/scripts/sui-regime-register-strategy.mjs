#!/usr/bin/env node
// sui-regime-register-strategy.mjs
//
// Registers `btc_lead_alt_echo_sui_regime_v1_20260529` as a strategy_version
// on the Bithub Worker (D1). Idempotent — the Worker uses content_hash to
// upsert. Run once when bringing the strategy online; safe to re-run.
//
// Reads BITHUB_WORKER_URL and BITHUB_INGEST_TOKEN from env. Never logs the
// token. Does not call Bybit, monitor, or any private API.
//
// Usage:
//   BITHUB_WORKER_URL=https://bithub-trades-api.guiydantas.workers.dev \
//   BITHUB_INGEST_TOKEN=... \
//   node scripts/sui-regime-register-strategy.mjs

import { createHash } from "node:crypto";

import { STRATEGY_VERSION_ID, STRATEGY_NAME, STRATEGY_CONFIG } from "./strategies/btc-lead-alt-echo-sui-regime-v1.mjs";

const STRATEGY_ID = "btc_lead_alt_echo_sui_regime";

function contentHash(versionId, spec) {
  const payload = JSON.stringify({ version_id: versionId, spec }, Object.keys({ version_id: 1, spec: 1 }).sort());
  return createHash("sha256").update(payload).digest("hex");
}

async function main() {
  const url = process.env.BITHUB_WORKER_URL;
  const token = process.env.BITHUB_INGEST_TOKEN;
  if (!url) throw new Error("BITHUB_WORKER_URL env var required");
  if (!token) throw new Error("BITHUB_INGEST_TOKEN env var required");

  const spec = {
    source: "bithub-app/scripts/strategies/btc-lead-alt-echo-sui-regime-v1.mjs",
    purpose: "Regime-gated BTC-Lead Alt-Echo specialized for SUI. Discovered 2026-05-29 via temporal cross-validation + regime mining.",
    notes: "Shadow-only until 30+ live signals confirm avg_net >= 0.04% and win_rate >= 55%. See H-RESEARCH-BENCH-004.",
    gates: STRATEGY_CONFIG.gates,
    inner_config: STRATEGY_CONFIG.inner,
    discovery: {
      backtest_window_days: 35,
      historical_windows: 5,
      positive_windows: 4,
      historical_entries: 31,
      historical_avg_net_pct: 0.0695,
      historical_pf: 2.22,
      historical_fee_stress_avg_net_pct: 0.0295,
    },
  };

  const payload = {
    version_id: STRATEGY_VERSION_ID,
    strategy_id: STRATEGY_ID,
    name: STRATEGY_NAME,
    regime: "scalp",
    status: "shadow",
    collection_mode: "shadow",
    timeframe: "1m",
    timeframes_json: { execution: "1m", lead_context: "5m", regime_window: "60m", atr_window_min: 14 },
    pair_universe_json: { leads: ["BTCUSDT"], targets: ["SUIUSDT"] },
    tags_json: ["btc_lead", "regime_gated", "scalp", "research_bench", "shadow", "h_research_bench_004"],
    spec_json: spec,
    content_hash: contentHash(STRATEGY_VERSION_ID, spec),
  };

  const endpoint = `${url.replace(/\/$/, "")}/ingest/strategy-version`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  if (!res.ok) {
    console.error(JSON.stringify({ ok: false, status: res.status, body }, null, 2));
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        endpoint,
        version_id: payload.version_id,
        strategy_id: payload.strategy_id,
        status: payload.status,
        content_hash: payload.content_hash,
        response: body,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
