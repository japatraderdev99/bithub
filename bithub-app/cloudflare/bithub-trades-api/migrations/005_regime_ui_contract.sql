-- Research Bench UI contract
--
-- Add explicit degraded state to regime snapshots so the UI can distinguish
-- "classified as range" from "classifier ran with missing/degraded inputs".

ALTER TABLE regime_snapshots ADD COLUMN degraded INTEGER DEFAULT 0;
ALTER TABLE regime_snapshots ADD COLUMN degraded_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_regime_snapshots_degraded
  ON regime_snapshots(degraded, ts DESC);
