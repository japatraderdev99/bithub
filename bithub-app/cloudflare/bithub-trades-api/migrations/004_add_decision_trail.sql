-- Research Bench decision trail
--
-- Additive schema for regime-conditioned strategy research. This migration
-- does not change execution behavior; it only gives live/shadow/backtest
-- rows stable strategy + regime identity and stores lifecycle decisions in D1.

CREATE TABLE IF NOT EXISTS regime_snapshots (
  regime_snapshot_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  btc_trend TEXT,
  eth_trend TEXT,
  btc_eth_bias TEXT,
  vol_regime TEXT,
  alt_corr_regime TEXT,
  funding_regime TEXT,
  session_utc TEXT,
  raw_features_json TEXT,
  source TEXT NOT NULL DEFAULT 'regime_classifier',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_regime_snapshots_ts ON regime_snapshots(ts DESC);
CREATE INDEX IF NOT EXISTS idx_regime_snapshots_buckets
  ON regime_snapshots(btc_trend, vol_regime, alt_corr_regime, session_utc);

CREATE TABLE IF NOT EXISTS position_lifecycle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_event_id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  client_trade_id TEXT,
  client_signal_id TEXT,
  strategy_id TEXT,
  strategy_version_id TEXT,
  regime_snapshot_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT CHECK (side IN ('long','short') OR side IS NULL),
  phase TEXT NOT NULL,
  event_type TEXT NOT NULL,
  reason TEXT,
  price REAL,
  pnl_pct REAL,
  best_pnl_pct REAL,
  mae_pct REAL,
  tape_flow_pct INTEGER,
  tape_delta_trend TEXT,
  setup_score INTEGER,
  sl REAL,
  tp REAL,
  rr REAL,
  entry_order_type TEXT,
  fill_latency_sec REAL,
  entry_slippage_pct REAL,
  exit_slippage_pct REAL,
  payload_json TEXT,
  source TEXT NOT NULL DEFAULT 'monitor_v4',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (regime_snapshot_id) REFERENCES regime_snapshots(regime_snapshot_id)
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_ts ON position_lifecycle_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_symbol_ts ON position_lifecycle_events(symbol, ts DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_trade ON position_lifecycle_events(client_trade_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_strategy_regime
  ON position_lifecycle_events(strategy_version_id, regime_snapshot_id, ts DESC);

ALTER TABLE live_trades ADD COLUMN strategy_id TEXT;
ALTER TABLE live_trades ADD COLUMN strategy_version_id TEXT;
ALTER TABLE live_trades ADD COLUMN strategy_content_hash TEXT;
ALTER TABLE live_trades ADD COLUMN regime_snapshot_id TEXT;
ALTER TABLE live_trades ADD COLUMN mae_pct REAL;
ALTER TABLE live_trades ADD COLUMN entry_order_type TEXT;
ALTER TABLE live_trades ADD COLUMN exit_order_type TEXT;
ALTER TABLE live_trades ADD COLUMN fill_latency_sec REAL;
ALTER TABLE live_trades ADD COLUMN entry_slippage_pct REAL;
ALTER TABLE live_trades ADD COLUMN exit_slippage_pct REAL;
ALTER TABLE live_trades ADD COLUMN entry_plan_json TEXT;
ALTER TABLE live_trades ADD COLUMN exit_context_json TEXT;

CREATE INDEX IF NOT EXISTS idx_trades_strategy_version
  ON live_trades(strategy_version_id, ts_entry DESC);
CREATE INDEX IF NOT EXISTS idx_trades_regime
  ON live_trades(regime_snapshot_id, ts_entry DESC);

ALTER TABLE strategy_signals ADD COLUMN regime_snapshot_id TEXT;
ALTER TABLE strategy_outcomes ADD COLUMN regime_snapshot_id TEXT;
CREATE INDEX IF NOT EXISTS idx_strategy_signals_regime
  ON strategy_signals(version_id, regime_snapshot_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_regime
  ON strategy_outcomes(regime_snapshot_id, ts DESC);
