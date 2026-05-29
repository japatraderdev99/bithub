-- Strategy Intelligence Registry
--
-- Stores immutable strategy versions plus decision/outcome rows for live,
-- paper, and shadow evaluation. D1 keeps queryable indexes and compact JSON;
-- large feature windows can later move to R2.

CREATE TABLE IF NOT EXISTS strategy_versions (
  version_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  name TEXT NOT NULL,
  regime TEXT NOT NULL CHECK (regime IN ('scalp','swing','position','fade')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','shadow','paper','live_canary','live','deprecated')),
  collection_mode TEXT NOT NULL DEFAULT 'shadow' CHECK (collection_mode IN ('backtest','shadow','paper','live_canary','live')),
  timeframe TEXT NOT NULL,
  timeframes_json TEXT,
  pair_universe_json TEXT,
  tags_json TEXT,
  spec_json TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_strategy_versions_strategy ON strategy_versions(strategy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_versions_regime_status ON strategy_versions(regime, status);

CREATE TABLE IF NOT EXISTS strategy_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_signal_id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long','short')),
  mode TEXT NOT NULL CHECK (mode IN ('backtest','shadow','paper','live_canary','live')),
  phase TEXT NOT NULL,
  decision TEXT NOT NULL,
  score REAL,
  price REAL,
  market_regime_json TEXT,
  features_json TEXT,
  gates_json TEXT,
  execution_plan_json TEXT,
  entered INTEGER NOT NULL DEFAULT 0,
  rejection_reason TEXT,
  actual_trade_id TEXT,
  source TEXT NOT NULL DEFAULT 'strategy_evaluator',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_strategy_signals_ts ON strategy_signals(ts DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_signals_version_ts ON strategy_signals(version_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_signals_symbol_ts ON strategy_signals(symbol, ts DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_signals_decision ON strategy_signals(decision, ts DESC);

CREATE TABLE IF NOT EXISTS strategy_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_outcome_id TEXT NOT NULL UNIQUE,
  client_signal_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  horizon_sec INTEGER NOT NULL,
  mfe_pct REAL,
  mae_pct REAL,
  pnl_pct REAL,
  pnl_abs REAL,
  hit_tp INTEGER,
  hit_sl INTEGER,
  exit_reason TEXT,
  actual_trade_id TEXT,
  labels_json TEXT,
  source TEXT NOT NULL DEFAULT 'strategy_evaluator',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (client_signal_id) REFERENCES strategy_signals(client_signal_id)
);
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_signal ON strategy_outcomes(client_signal_id, horizon_sec);
CREATE INDEX IF NOT EXISTS idx_strategy_outcomes_ts ON strategy_outcomes(ts DESC);
