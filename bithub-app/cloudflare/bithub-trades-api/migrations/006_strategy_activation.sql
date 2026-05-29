-- Strategy activation flag
--
-- Operator-controlled gate that lets shadow/paper runners check whether
-- they should evaluate a given strategy version. Default OFF (0): a freshly
-- registered version does nothing until the operator clicks "Activate" in
-- the Library UI. This enforces the "only runs when selected" contract.
--
-- Semantics:
--   is_active = 0 -> runner must skip this version
--   is_active = 1 -> runner may evaluate (still bound by status/collection_mode)
-- A version with status=live and is_active=1 means "selected for live", but
-- live execution path remains in the monitor process (Bithub does not send
-- orders). This column is the UI-level intent flag, not an execution permit.

ALTER TABLE strategy_versions ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE strategy_versions ADD COLUMN activated_at TEXT;
ALTER TABLE strategy_versions ADD COLUMN activated_by TEXT;

CREATE INDEX IF NOT EXISTS idx_strategy_versions_active
  ON strategy_versions(is_active, status, collection_mode);
