import test from "node:test";
import assert from "node:assert/strict";

import { runBtcLeadAltEcho, syntheticLeadAlt } from "./btc-lead-alt-echo.mjs";

test("BTC lead alt echo emits structured shadow signals", () => {
  const { lead, alt } = syntheticLeadAlt({ minutes: 900 });
  const result = runBtcLeadAltEcho({ leadCandles: lead, altCandles: alt, leadSymbol: "BTCUSDT", altSymbol: "ECHOUSDT" });
  assert.equal(result.summary.strategy_version_id, "btc_lead_alt_echo_v1_20260528");
  assert.ok(result.summary.signals > 0);
  assert.ok(result.summary.entries > 0);
  assert.equal(result.trades.length, result.summary.entries);
  assert.ok(result.signals.every((s) => s.client_signal_id && s.features_json && s.regime_snapshot_json));
  assert.ok(result.trades.every((t) => Number.isFinite(t.pnl_net_pct) && t.exit_reason));
});

test("BTC lead alt echo stays read-only and records outcomes separately", () => {
  const { lead, alt } = syntheticLeadAlt({ minutes: 900 });
  const result = runBtcLeadAltEcho({ leadCandles: lead, altCandles: alt, leadSymbol: "BTCUSDT", altSymbol: "ECHOUSDT" });
  assert.equal(result.outcomes.length, result.trades.length);
  assert.ok(result.outcomes.every((o) => o.client_signal_id && o.label));
  assert.ok(result.signals.every((s) => s.entered === (s.decision === "enter")));
});
