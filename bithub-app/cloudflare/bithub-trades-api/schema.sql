CREATE TABLE IF NOT EXISTS live_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_entry TEXT NOT NULL,
  ts_exit TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long','short')),
  entry REAL NOT NULL,
  exit REAL,
  qty REAL NOT NULL,
  pnl_abs REAL,
  pnl_pct REAL,
  best_pnl_pct REAL,
  size_usd REAL,
  leverage INTEGER,
  strategy_tag TEXT,
  regime TEXT,
  exit_reason TEXT,
  duration_sec INTEGER,
  tape_entry_flow_pct INTEGER,
  tape_entry_confirm INTEGER,
  setup_score INTEGER,
  fee_usd REAL,
  funding_usd REAL,
  pnl_net_usd REAL,
  source TEXT NOT NULL DEFAULT 'monitor_v4',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  client_trade_id TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_trades_ts_entry ON live_trades(ts_entry DESC);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON live_trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_strategy ON live_trades(strategy_tag);
CREATE INDEX IF NOT EXISTS idx_trades_exit_reason ON live_trades(exit_reason);
CREATE INDEX IF NOT EXISTS idx_trades_pnl_net ON live_trades(pnl_net_usd);

CREATE TABLE IF NOT EXISTS monitor_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  symbol TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('ENTRY','EXIT_FULL','EXIT_PARTIAL','TRAIL','EXTEND_TP','TIGHT_TP','TAPE_SIGNAL','T1_SCAN','T2_SIGNAL','BE_SET')),
  detail TEXT,
  pnl_realized REAL,
  source TEXT NOT NULL DEFAULT 'monitor_v4',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  client_event_id TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON monitor_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_symbol_type ON monitor_events(symbol, event_type);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON monitor_events(event_type, ts DESC);
