import test from "node:test";
import assert from "node:assert/strict";

import { resampleCandles, runTrendSurfBacktest, syntheticCandles } from "./trend-surf-scalp.mjs";

test("resamples 1m candles into stable 5m candles", () => {
  const candles = syntheticCandles({ minutes: 15 });
  const five = resampleCandles(candles, 5);
  assert.equal(five.length, 3);
  assert.equal(five[0].open, candles[0].open);
  assert.equal(five[0].close, candles[4].close);
  assert.equal(five[1].close, candles[9].close);
});

test("trend surf strategy emits shadow signals and structured outcomes", () => {
  const candles = syntheticCandles({ minutes: 1000 });
  const result = runTrendSurfBacktest(candles, { symbol: "SYNTHUSDT" });
  assert.equal(result.summary.strategy_version_id, "trend_surf_scalp_v1_20260528");
  assert.ok(result.summary.signals > 0);
  assert.ok(result.summary.entries > 0);
  assert.equal(result.trades.length, result.summary.entries);
  assert.ok(result.signals.every((s) => s.client_signal_id && s.strategy_version_id && s.features_json));
  assert.ok(result.trades.every((t) => Number.isFinite(t.pnl_net_pct) && t.exit_reason));
});
