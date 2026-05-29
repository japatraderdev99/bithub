// bithub-trades-api — Cloudflare Worker that bridges the local Freqtrade
// monitor with the D1 `bithub-trades` database.
//
// - Ingest endpoints (POST) require a Bearer token. The token is generated
//   locally (`openssl rand -hex 32`) and stored both in the publisher's
//   environment (BITHUB_INGEST_TOKEN) and as a Wrangler secret here.
//   The Cloudflare account API token is NEVER used by the local publisher.
//
// - Read endpoints (GET) are public. They expose aggregated PnL / trade
//   history. Nothing in the schema reveals credentials, balances, or order
//   ids. If we ever want to gate reads, add Bearer auth here too.

interface Env {
  DB: D1Database;
  INGEST_TOKEN: string;
}

type TradeRow = {
  client_trade_id: string;
  ts_entry: string;
  ts_exit: string | null;
  symbol: string;
  side: "long" | "short";
  entry: number;
  exit: number | null;
  qty: number;
  pnl_abs: number | null;
  pnl_pct: number | null;
  best_pnl_pct: number | null;
  size_usd: number | null;
  leverage: number | null;
  strategy_tag: string | null;
  regime: string | null;
  exit_reason: string | null;
  duration_sec: number | null;
  tape_entry_flow_pct: number | null;
  tape_entry_confirm: number | null;
  setup_score: number | null;
  // Gate B (pre-Round-3): net PnL accounting. Nullable — old ingests still
  // valid; new ingests / backfill enrich.
  fee_usd: number | null;
  funding_usd: number | null;
  pnl_net_usd: number | null;
  // Research Bench decision trail. Nullable and additive — old ingests stay valid.
  strategy_id: string | null;
  strategy_version_id: string | null;
  strategy_content_hash: string | null;
  regime_snapshot_id: string | null;
  mae_pct: number | null;
  entry_order_type: string | null;
  exit_order_type: string | null;
  fill_latency_sec: number | null;
  entry_slippage_pct: number | null;
  exit_slippage_pct: number | null;
  entry_plan_json: string | null;
  exit_context_json: string | null;
};

type EventRow = {
  client_event_id: string;
  ts: string;
  symbol: string;
  event_type: string;
  detail: string | null;
  pnl_realized: number | null;
};

type StrategyVersionRow = {
  version_id: string;
  strategy_id: string;
  name: string;
  regime: "scalp" | "swing" | "position" | "fade";
  status: "draft" | "shadow" | "paper" | "live_canary" | "live" | "deprecated";
  collection_mode: "backtest" | "shadow" | "paper" | "live_canary" | "live";
  timeframe: string;
  timeframes_json: string | null;
  pair_universe_json: string | null;
  tags_json: string | null;
  spec_json: string;
  content_hash: string;
};

type StrategySignalRow = {
  client_signal_id: string;
  ts: string;
  strategy_id: string;
  version_id: string;
  symbol: string;
  side: "long" | "short";
  mode: "backtest" | "shadow" | "paper" | "live_canary" | "live";
  phase: string;
  decision: string;
  score: number | null;
  price: number | null;
  market_regime_json: string | null;
  features_json: string | null;
  gates_json: string | null;
  execution_plan_json: string | null;
  entered: number | boolean | null;
  rejection_reason: string | null;
  actual_trade_id: string | null;
  regime_snapshot_id: string | null;
};

type StrategyOutcomeRow = {
  client_outcome_id: string;
  client_signal_id: string;
  ts: string;
  horizon_sec: number;
  mfe_pct: number | null;
  mae_pct: number | null;
  pnl_pct: number | null;
  pnl_abs: number | null;
  hit_tp: number | boolean | null;
  hit_sl: number | boolean | null;
  exit_reason: string | null;
  actual_trade_id: string | null;
  labels_json: string | null;
  regime_snapshot_id: string | null;
};

type RegimeSnapshotRow = {
  regime_snapshot_id: string;
  ts: string;
  btc_trend: string | null;
  eth_trend: string | null;
  btc_eth_bias: string | null;
  vol_regime: string | null;
  alt_corr_regime: string | null;
  funding_regime: string | null;
  session_utc: string | null;
  raw_features_json: string | null;
  degraded: number | boolean | null;
  degraded_reason: string | null;
  source: string | null;
};

type LifecycleEventRow = {
  client_event_id: string;
  ts: string;
  client_trade_id: string | null;
  client_signal_id: string | null;
  strategy_id: string | null;
  strategy_version_id: string | null;
  regime_snapshot_id: string | null;
  symbol: string;
  side: "long" | "short" | null;
  phase: string;
  event_type: string;
  reason: string | null;
  price: number | null;
  pnl_pct: number | null;
  best_pnl_pct: number | null;
  mae_pct: number | null;
  tape_flow_pct: number | null;
  tape_delta_trend: string | null;
  setup_score: number | null;
  sl: number | null;
  tp: number | null;
  rr: number | null;
  entry_order_type: string | null;
  fill_latency_sec: number | null;
  entry_slippage_pct: number | null;
  exit_slippage_pct: number | null;
  payload_json: string | null;
  source: string | null;
};

const ALLOWED_EVENT_TYPES = new Set([
  "ENTRY",
  "EXIT_FULL",
  "EXIT_PARTIAL",
  "TRAIL",
  "EXTEND_TP",
  "TIGHT_TP",
  "TAPE_SIGNAL",
  "T1_SCAN",
  "T2_SIGNAL",
  "BE_SET",
]);

const ALLOWED_REGIMES = new Set(["scalp", "swing", "position", "fade"]);
const ALLOWED_STRATEGY_STATUSES = new Set(["draft", "shadow", "paper", "live_canary", "live", "deprecated"]);
const ALLOWED_COLLECTION_MODES = new Set(["backtest", "shadow", "paper", "live_canary", "live"]);
const REGIME_STALE_AFTER_SEC = 15 * 60;

function stringifyJsonField(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function boolInt(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return value === true || value === 1 ? 1 : 0;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stalenessSec(ts: unknown, nowMs = Date.now()): number | null {
  if (typeof ts !== "string") return null;
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

function deriveRegimeDegraded(regime: Record<string, unknown> | null): boolean {
  if (!regime) return false;
  if (boolInt(regime.degraded) === 1) return true;
  const criticalBuckets = ["btc_trend", "eth_trend", "btc_eth_bias", "vol_regime", "funding_regime", "session_utc"];
  return criticalBuckets.some((key) => {
    const value = regime[key];
    return value === undefined || value === null || value === "" || value === "unknown";
  });
}

function deriveRegimeDegradedReason(regime: Record<string, unknown> | null): string | null {
  if (!regime) return null;
  if (typeof regime.degraded_reason === "string" && regime.degraded_reason) return regime.degraded_reason;
  const raw = parseJsonObject(regime.raw_features_json);
  const rawReason = raw?.degraded_reason;
  if (typeof rawReason === "string" && rawReason) return rawReason;
  return deriveRegimeDegraded(regime) ? "critical_bucket_unknown" : null;
}

function json(body: unknown, init: number | ResponseInit = 200): Response {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : init;
  return new Response(JSON.stringify(body), {
    ...responseInit,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      ...(responseInit.headers ?? {}),
    },
  });
}

function checkAuth(req: Request, env: Env): boolean {
  if (!env.INGEST_TOKEN) return false;
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return false;
  // Constant-time-ish compare (length first, then byte sum). Not perfect, but
  // good enough for a Bearer-token API behind TLS.
  const got = m[1].trim();
  if (got.length !== env.INGEST_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ env.INGEST_TOKEN.charCodeAt(i);
  return diff === 0;
}

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function handleIngestTrade(req: Request, env: Env): Promise<Response> {
  if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
  let body: Partial<TradeRow>;
  try {
    body = (await req.json()) as Partial<TradeRow>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // Required fields
  const required: (keyof TradeRow)[] = ["client_trade_id", "ts_entry", "symbol", "side", "entry", "qty"];
  for (const key of required) {
    if (body[key] === undefined || body[key] === null || body[key] === "") {
      return json({ error: "missing_field", field: key }, 400);
    }
  }
  if (body.side !== "long" && body.side !== "short") {
    return json({ error: "invalid_side" }, 400);
  }

  // ON CONFLICT uses COALESCE so partial backfills don't overwrite known
  // values with nulls. Publishers can send the trade at close-time with
  // fees, OR send pre-close without fees and have a backfill script PATCH
  // the fee_usd/funding_usd/pnl_net_usd fields later — both flows are safe.
  const stmt = env.DB.prepare(
    `INSERT INTO live_trades (
      client_trade_id, ts_entry, ts_exit, symbol, side, entry, exit, qty,
      pnl_abs, pnl_pct, best_pnl_pct, size_usd, leverage, strategy_tag,
      regime, exit_reason, duration_sec, tape_entry_flow_pct,
      tape_entry_confirm, setup_score, fee_usd, funding_usd, pnl_net_usd,
      strategy_id, strategy_version_id, strategy_content_hash, regime_snapshot_id,
      mae_pct, entry_order_type, exit_order_type, fill_latency_sec,
      entry_slippage_pct, exit_slippage_pct, entry_plan_json, exit_context_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(client_trade_id) DO UPDATE SET
      ts_exit = COALESCE(excluded.ts_exit, ts_exit),
      exit = COALESCE(excluded.exit, exit),
      pnl_abs = COALESCE(excluded.pnl_abs, pnl_abs),
      pnl_pct = COALESCE(excluded.pnl_pct, pnl_pct),
      best_pnl_pct = COALESCE(excluded.best_pnl_pct, best_pnl_pct),
      exit_reason = COALESCE(excluded.exit_reason, exit_reason),
      duration_sec = COALESCE(excluded.duration_sec, duration_sec),
      fee_usd = COALESCE(excluded.fee_usd, fee_usd),
      funding_usd = COALESCE(excluded.funding_usd, funding_usd),
      pnl_net_usd = COALESCE(excluded.pnl_net_usd, pnl_net_usd),
      strategy_id = COALESCE(excluded.strategy_id, strategy_id),
      strategy_version_id = COALESCE(excluded.strategy_version_id, strategy_version_id),
      strategy_content_hash = COALESCE(excluded.strategy_content_hash, strategy_content_hash),
      regime_snapshot_id = COALESCE(excluded.regime_snapshot_id, regime_snapshot_id),
      mae_pct = COALESCE(excluded.mae_pct, mae_pct),
      entry_order_type = COALESCE(excluded.entry_order_type, entry_order_type),
      exit_order_type = COALESCE(excluded.exit_order_type, exit_order_type),
      fill_latency_sec = COALESCE(excluded.fill_latency_sec, fill_latency_sec),
      entry_slippage_pct = COALESCE(excluded.entry_slippage_pct, entry_slippage_pct),
      exit_slippage_pct = COALESCE(excluded.exit_slippage_pct, exit_slippage_pct),
      entry_plan_json = COALESCE(excluded.entry_plan_json, entry_plan_json),
      exit_context_json = COALESCE(excluded.exit_context_json, exit_context_json)`
  );

  try {
    await stmt
      .bind(
        body.client_trade_id,
        body.ts_entry,
        body.ts_exit ?? null,
        body.symbol,
        body.side,
        body.entry,
        body.exit ?? null,
        body.qty,
        body.pnl_abs ?? null,
        body.pnl_pct ?? null,
        body.best_pnl_pct ?? null,
        body.size_usd ?? null,
        body.leverage ?? null,
        body.strategy_tag ?? null,
        body.regime ?? null,
        body.exit_reason ?? null,
        body.duration_sec ?? null,
        body.tape_entry_flow_pct ?? null,
        body.tape_entry_confirm ?? null,
        body.setup_score ?? null,
        body.fee_usd ?? null,
        body.funding_usd ?? null,
        body.pnl_net_usd ?? null,
        body.strategy_id ?? null,
        body.strategy_version_id ?? null,
        body.strategy_content_hash ?? null,
        body.regime_snapshot_id ?? null,
        body.mae_pct ?? null,
        body.entry_order_type ?? null,
        body.exit_order_type ?? null,
        body.fill_latency_sec ?? null,
        body.entry_slippage_pct ?? null,
        body.exit_slippage_pct ?? null,
        stringifyJsonField(body.entry_plan_json),
        stringifyJsonField(body.exit_context_json)
      )
      .run();
    return json({ ok: true, client_trade_id: body.client_trade_id });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleIngestEvent(req: Request, env: Env): Promise<Response> {
  if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
  let body: Partial<EventRow>;
  try {
    body = (await req.json()) as Partial<EventRow>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body.client_event_id || !body.ts || !body.symbol || !body.event_type) {
    return json({ error: "missing_field" }, 400);
  }
  if (!ALLOWED_EVENT_TYPES.has(body.event_type)) {
    return json({ error: "invalid_event_type", value: body.event_type }, 400);
  }
  const stmt = env.DB.prepare(
    `INSERT INTO monitor_events (client_event_id, ts, symbol, event_type, detail, pnl_realized)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(client_event_id) DO NOTHING`
  );
  try {
    await stmt
      .bind(
        body.client_event_id,
        body.ts,
        body.symbol,
        body.event_type,
        body.detail ?? null,
        body.pnl_realized ?? null
      )
      .run();
    return json({ ok: true, client_event_id: body.client_event_id });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleIngestRegimeSnapshot(req: Request, env: Env): Promise<Response> {
  if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
  let body: Partial<RegimeSnapshotRow>;
  try {
    body = (await req.json()) as Partial<RegimeSnapshotRow>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body.regime_snapshot_id || !body.ts) {
    return json({ error: "missing_field", required: ["regime_snapshot_id", "ts"] }, 400);
  }

  const stmt = env.DB.prepare(
    `INSERT INTO regime_snapshots (
      regime_snapshot_id, ts, btc_trend, eth_trend, btc_eth_bias,
      vol_regime, alt_corr_regime, funding_regime, session_utc,
      raw_features_json, degraded, degraded_reason, source
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(regime_snapshot_id) DO UPDATE SET
      btc_trend = COALESCE(excluded.btc_trend, btc_trend),
      eth_trend = COALESCE(excluded.eth_trend, eth_trend),
      btc_eth_bias = COALESCE(excluded.btc_eth_bias, btc_eth_bias),
      vol_regime = COALESCE(excluded.vol_regime, vol_regime),
      alt_corr_regime = COALESCE(excluded.alt_corr_regime, alt_corr_regime),
      funding_regime = COALESCE(excluded.funding_regime, funding_regime),
      session_utc = COALESCE(excluded.session_utc, session_utc),
      raw_features_json = COALESCE(excluded.raw_features_json, raw_features_json),
      degraded = COALESCE(excluded.degraded, degraded),
      degraded_reason = COALESCE(excluded.degraded_reason, degraded_reason),
      source = COALESCE(excluded.source, source)`
  );

  try {
    const bodyRecord = body as Record<string, unknown>;
    const degraded = body.degraded === undefined
      ? boolInt(deriveRegimeDegraded(bodyRecord))
      : boolInt(body.degraded);
    const degradedReason = body.degraded_reason ?? deriveRegimeDegradedReason(bodyRecord);
    await stmt
      .bind(
        body.regime_snapshot_id,
        body.ts,
        body.btc_trend ?? null,
        body.eth_trend ?? null,
        body.btc_eth_bias ?? null,
        body.vol_regime ?? null,
        body.alt_corr_regime ?? null,
        body.funding_regime ?? null,
        body.session_utc ?? null,
        stringifyJsonField(body.raw_features_json),
        degraded,
        degradedReason,
        body.source ?? "regime_classifier"
      )
      .run();
    return json({ ok: true, regime_snapshot_id: body.regime_snapshot_id });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleIngestLifecycleEvent(req: Request, env: Env): Promise<Response> {
  if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
  let body: Partial<LifecycleEventRow>;
  try {
    body = (await req.json()) as Partial<LifecycleEventRow>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const required: (keyof LifecycleEventRow)[] = ["client_event_id", "ts", "symbol", "phase", "event_type"];
  for (const key of required) {
    if (body[key] === undefined || body[key] === null || body[key] === "") {
      return json({ error: "missing_field", field: key }, 400);
    }
  }
  if (body.side !== undefined && body.side !== null && body.side !== "long" && body.side !== "short") {
    return json({ error: "invalid_side" }, 400);
  }

  const stmt = env.DB.prepare(
    `INSERT INTO position_lifecycle_events (
      client_event_id, ts, client_trade_id, client_signal_id, strategy_id,
      strategy_version_id, regime_snapshot_id, symbol, side, phase, event_type,
      reason, price, pnl_pct, best_pnl_pct, mae_pct, tape_flow_pct,
      tape_delta_trend, setup_score, sl, tp, rr, entry_order_type,
      fill_latency_sec, entry_slippage_pct, exit_slippage_pct, payload_json,
      source
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(client_event_id) DO UPDATE SET
      client_trade_id = COALESCE(excluded.client_trade_id, client_trade_id),
      client_signal_id = COALESCE(excluded.client_signal_id, client_signal_id),
      strategy_id = COALESCE(excluded.strategy_id, strategy_id),
      strategy_version_id = COALESCE(excluded.strategy_version_id, strategy_version_id),
      regime_snapshot_id = COALESCE(excluded.regime_snapshot_id, regime_snapshot_id),
      reason = COALESCE(excluded.reason, reason),
      price = COALESCE(excluded.price, price),
      pnl_pct = COALESCE(excluded.pnl_pct, pnl_pct),
      best_pnl_pct = COALESCE(excluded.best_pnl_pct, best_pnl_pct),
      mae_pct = COALESCE(excluded.mae_pct, mae_pct),
      payload_json = COALESCE(excluded.payload_json, payload_json)`
  );

  try {
    await stmt
      .bind(
        body.client_event_id,
        body.ts,
        body.client_trade_id ?? null,
        body.client_signal_id ?? null,
        body.strategy_id ?? null,
        body.strategy_version_id ?? null,
        body.regime_snapshot_id ?? null,
        body.symbol,
        body.side ?? null,
        body.phase,
        body.event_type,
        body.reason ?? null,
        body.price ?? null,
        body.pnl_pct ?? null,
        body.best_pnl_pct ?? null,
        body.mae_pct ?? null,
        body.tape_flow_pct ?? null,
        body.tape_delta_trend ?? null,
        body.setup_score ?? null,
        body.sl ?? null,
        body.tp ?? null,
        body.rr ?? null,
        body.entry_order_type ?? null,
        body.fill_latency_sec ?? null,
        body.entry_slippage_pct ?? null,
        body.exit_slippage_pct ?? null,
        stringifyJsonField(body.payload_json),
        body.source ?? "monitor_v4"
      )
      .run();
    return json({ ok: true, client_event_id: body.client_event_id });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleIngestStrategyVersion(req: Request, env: Env): Promise<Response> {
  if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
  let body: Partial<StrategyVersionRow>;
  try {
    body = (await req.json()) as Partial<StrategyVersionRow>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const required: (keyof StrategyVersionRow)[] = [
    "version_id",
    "strategy_id",
    "name",
    "regime",
    "status",
    "collection_mode",
    "timeframe",
    "spec_json",
    "content_hash",
  ];
  for (const key of required) {
    if (body[key] === undefined || body[key] === null || body[key] === "") {
      return json({ error: "missing_field", field: key }, 400);
    }
  }
  if (!ALLOWED_REGIMES.has(String(body.regime))) return json({ error: "invalid_regime" }, 400);
  if (!ALLOWED_STRATEGY_STATUSES.has(String(body.status))) return json({ error: "invalid_status" }, 400);
  if (!ALLOWED_COLLECTION_MODES.has(String(body.collection_mode))) return json({ error: "invalid_collection_mode" }, 400);

  const stmt = env.DB.prepare(
    `INSERT INTO strategy_versions (
      version_id, strategy_id, name, regime, status, collection_mode,
      timeframe, timeframes_json, pair_universe_json, tags_json, spec_json,
      content_hash
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(version_id) DO UPDATE SET
      status = excluded.status,
      collection_mode = excluded.collection_mode,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`
  );

  try {
    await stmt
      .bind(
        body.version_id,
        body.strategy_id,
        body.name,
        body.regime,
        body.status,
        body.collection_mode,
        body.timeframe,
        stringifyJsonField(body.timeframes_json),
        stringifyJsonField(body.pair_universe_json),
        stringifyJsonField(body.tags_json),
        stringifyJsonField(body.spec_json),
        body.content_hash
      )
      .run();
    return json({ ok: true, version_id: body.version_id });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleIngestStrategySignal(req: Request, env: Env): Promise<Response> {
  if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
  let body: Partial<StrategySignalRow>;
  try {
    body = (await req.json()) as Partial<StrategySignalRow>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const required: (keyof StrategySignalRow)[] = [
    "client_signal_id",
    "ts",
    "strategy_id",
    "version_id",
    "symbol",
    "side",
    "mode",
    "phase",
    "decision",
  ];
  for (const key of required) {
    if (body[key] === undefined || body[key] === null || body[key] === "") {
      return json({ error: "missing_field", field: key }, 400);
    }
  }
  if (body.side !== "long" && body.side !== "short") return json({ error: "invalid_side" }, 400);
  if (!ALLOWED_COLLECTION_MODES.has(String(body.mode))) return json({ error: "invalid_mode" }, 400);

  const stmt = env.DB.prepare(
    `INSERT INTO strategy_signals (
      client_signal_id, ts, strategy_id, version_id, symbol, side, mode,
      phase, decision, score, price, market_regime_json, features_json,
      gates_json, execution_plan_json, entered, rejection_reason, actual_trade_id,
      regime_snapshot_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(client_signal_id) DO UPDATE SET
      entered = COALESCE(excluded.entered, entered),
      actual_trade_id = COALESCE(excluded.actual_trade_id, actual_trade_id),
      rejection_reason = COALESCE(excluded.rejection_reason, rejection_reason),
      regime_snapshot_id = COALESCE(excluded.regime_snapshot_id, regime_snapshot_id)`
  );

  try {
    await stmt
      .bind(
        body.client_signal_id,
        body.ts,
        body.strategy_id,
        body.version_id,
        body.symbol,
        body.side,
        body.mode,
        body.phase,
        body.decision,
        body.score ?? null,
        body.price ?? null,
        stringifyJsonField(body.market_regime_json),
        stringifyJsonField(body.features_json),
        stringifyJsonField(body.gates_json),
        stringifyJsonField(body.execution_plan_json),
        boolInt(body.entered) ?? 0,
        body.rejection_reason ?? null,
        body.actual_trade_id ?? null,
        body.regime_snapshot_id ?? null
      )
      .run();
    return json({ ok: true, client_signal_id: body.client_signal_id });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleIngestStrategyOutcome(req: Request, env: Env): Promise<Response> {
  if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
  let body: Partial<StrategyOutcomeRow>;
  try {
    body = (await req.json()) as Partial<StrategyOutcomeRow>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const required: (keyof StrategyOutcomeRow)[] = ["client_outcome_id", "client_signal_id", "ts", "horizon_sec"];
  for (const key of required) {
    if (body[key] === undefined || body[key] === null || body[key] === "") {
      return json({ error: "missing_field", field: key }, 400);
    }
  }

  const stmt = env.DB.prepare(
    `INSERT INTO strategy_outcomes (
      client_outcome_id, client_signal_id, ts, horizon_sec, mfe_pct, mae_pct,
      pnl_pct, pnl_abs, hit_tp, hit_sl, exit_reason, actual_trade_id,
      labels_json, regime_snapshot_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(client_outcome_id) DO UPDATE SET
      mfe_pct = COALESCE(excluded.mfe_pct, mfe_pct),
      mae_pct = COALESCE(excluded.mae_pct, mae_pct),
      pnl_pct = COALESCE(excluded.pnl_pct, pnl_pct),
      pnl_abs = COALESCE(excluded.pnl_abs, pnl_abs),
      hit_tp = COALESCE(excluded.hit_tp, hit_tp),
      hit_sl = COALESCE(excluded.hit_sl, hit_sl),
      exit_reason = COALESCE(excluded.exit_reason, exit_reason),
      actual_trade_id = COALESCE(excluded.actual_trade_id, actual_trade_id),
      labels_json = COALESCE(excluded.labels_json, labels_json),
      regime_snapshot_id = COALESCE(excluded.regime_snapshot_id, regime_snapshot_id)`
  );

  try {
    await stmt
      .bind(
        body.client_outcome_id,
        body.client_signal_id,
        body.ts,
        body.horizon_sec,
        body.mfe_pct ?? null,
        body.mae_pct ?? null,
        body.pnl_pct ?? null,
        body.pnl_abs ?? null,
        boolInt(body.hit_tp),
        boolInt(body.hit_sl),
        body.exit_reason ?? null,
        body.actual_trade_id ?? null,
        stringifyJsonField(body.labels_json),
        body.regime_snapshot_id ?? null
      )
      .run();
    return json({ ok: true, client_outcome_id: body.client_outcome_id });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleListTrades(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 100);
  const symbol = url.searchParams.get("symbol");
  const since = url.searchParams.get("since"); // ISO

  let sql = `SELECT * FROM live_trades WHERE 1=1`;
  const params: (string | number)[] = [];
  if (symbol) {
    sql += ` AND symbol = ?`;
    params.push(symbol);
  }
  if (since) {
    sql += ` AND ts_entry >= ?`;
    params.push(since);
  }
  sql += ` ORDER BY ts_entry DESC LIMIT ?`;
  params.push(limit);

  try {
    const result = await env.DB.prepare(sql).bind(...params).all();
    return json({ ok: true, count: result.results.length, trades: result.results });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleListEvents(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 200);
  const type = url.searchParams.get("type");
  const symbol = url.searchParams.get("symbol");

  let sql = `SELECT * FROM monitor_events WHERE 1=1`;
  const params: (string | number)[] = [];
  if (type) {
    sql += ` AND event_type = ?`;
    params.push(type);
  }
  if (symbol) {
    sql += ` AND symbol = ?`;
    params.push(symbol);
  }
  sql += ` ORDER BY ts DESC LIMIT ?`;
  params.push(limit);

  try {
    const result = await env.DB.prepare(sql).bind(...params).all();
    return json({ ok: true, count: result.results.length, events: result.results });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleListLifecycleEvents(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 200);
  const clientTradeId = url.searchParams.get("client_trade_id");
  const clientSignalId = url.searchParams.get("client_signal_id");
  const symbol = url.searchParams.get("symbol");
  const strategyVersionId = url.searchParams.get("strategy_version_id");
  const regimeSnapshotId = url.searchParams.get("regime_snapshot_id");
  const eventType = url.searchParams.get("event_type");
  const phase = url.searchParams.get("phase");
  const since = url.searchParams.get("since");
  const sort = url.searchParams.get("sort") === "asc" ? "ASC" : "DESC";

  let sql = `SELECT * FROM position_lifecycle_events WHERE 1=1`;
  const params: (string | number)[] = [];
  if (clientTradeId) {
    sql += ` AND client_trade_id = ?`;
    params.push(clientTradeId);
  }
  if (clientSignalId) {
    sql += ` AND client_signal_id = ?`;
    params.push(clientSignalId);
  }
  if (symbol) {
    sql += ` AND symbol = ?`;
    params.push(symbol);
  }
  if (strategyVersionId) {
    sql += ` AND strategy_version_id = ?`;
    params.push(strategyVersionId);
  }
  if (regimeSnapshotId) {
    sql += ` AND regime_snapshot_id = ?`;
    params.push(regimeSnapshotId);
  }
  if (eventType) {
    sql += ` AND event_type = ?`;
    params.push(eventType);
  }
  if (phase) {
    sql += ` AND phase = ?`;
    params.push(phase);
  }
  if (since) {
    sql += ` AND ts >= ?`;
    params.push(since);
  }
  sql += ` ORDER BY ts ${sort}, id ${sort} LIMIT ?`;
  params.push(limit);

  try {
    const result = await env.DB.prepare(sql).bind(...params).all();
    return json({ ok: true, count: result.results.length, events: result.results });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleListStrategySignals(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 200);
  const versionId = url.searchParams.get("version_id");
  const symbol = url.searchParams.get("symbol");
  const mode = url.searchParams.get("mode");
  const since = url.searchParams.get("since");
  const regimeSnapshotId = url.searchParams.get("regime_snapshot_id");

  let sql = `SELECT * FROM strategy_signals WHERE 1=1`;
  const params: (string | number)[] = [];
  if (versionId) {
    sql += ` AND version_id = ?`;
    params.push(versionId);
  }
  if (symbol) {
    sql += ` AND symbol = ?`;
    params.push(symbol);
  }
  if (mode) {
    sql += ` AND mode = ?`;
    params.push(mode);
  }
  if (since) {
    sql += ` AND ts >= ?`;
    params.push(since);
  }
  if (regimeSnapshotId) {
    sql += ` AND regime_snapshot_id = ?`;
    params.push(regimeSnapshotId);
  }
  sql += ` ORDER BY ts DESC LIMIT ?`;
  params.push(limit);

  try {
    const result = await env.DB.prepare(sql).bind(...params).all();
    return json({ ok: true, count: result.results.length, signals: result.results });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleListStrategyOutcomes(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 200);
  const clientSignalId = url.searchParams.get("client_signal_id");
  const regimeSnapshotId = url.searchParams.get("regime_snapshot_id");

  let sql = `SELECT * FROM strategy_outcomes WHERE 1=1`;
  const params: (string | number)[] = [];
  if (clientSignalId) {
    sql += ` AND client_signal_id = ?`;
    params.push(clientSignalId);
  }
  if (regimeSnapshotId) {
    sql += ` AND regime_snapshot_id = ?`;
    params.push(regimeSnapshotId);
  }
  sql += ` ORDER BY ts DESC LIMIT ?`;
  params.push(limit);

  try {
    const result = await env.DB.prepare(sql).bind(...params).all();
    return json({ ok: true, count: result.results.length, outcomes: result.results });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleSetStrategyActivation(
  req: Request,
  env: Env,
  versionId: string,
  active: 0 | 1,
): Promise<Response> {
  if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
  let body: { actor?: string } = {};
  try { body = await req.json() as { actor?: string }; } catch { /* empty body ok */ }
  const actor = (body.actor ?? "operator").slice(0, 64);
  const now = new Date().toISOString();
  try {
    const result = await env.DB
      .prepare(
        `UPDATE strategy_versions
         SET is_active = ?,
             activated_at = CASE WHEN ? = 1 THEN ? ELSE activated_at END,
             activated_by = CASE WHEN ? = 1 THEN ? ELSE activated_by END,
             updated_at = ?
         WHERE version_id = ?`
      )
      .bind(active, active, now, active, actor, now, versionId)
      .run();
    if (!result.success || (result.meta as { changes?: number })?.changes === 0) {
      return json({ error: "not_found", version_id: versionId }, 404);
    }
    return json({ ok: true, version_id: versionId, is_active: active, actor, ts: now });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleListStrategyVersions(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = clampInt(url.searchParams.get("limit"), 1, 500, 100);
  const versionId = url.searchParams.get("version_id");
  const strategyId = url.searchParams.get("strategy_id");
  const status = url.searchParams.get("status");
  const regime = url.searchParams.get("regime");
  const collectionMode = url.searchParams.get("collection_mode");

  let sql = `SELECT * FROM strategy_versions WHERE 1=1`;
  const params: (string | number)[] = [];
  if (versionId) {
    sql += ` AND version_id = ?`;
    params.push(versionId);
  }
  if (strategyId) {
    sql += ` AND strategy_id = ?`;
    params.push(strategyId);
  }
  if (status) {
    sql += ` AND status = ?`;
    params.push(status);
  }
  if (regime) {
    sql += ` AND regime = ?`;
    params.push(regime);
  }
  if (collectionMode) {
    sql += ` AND collection_mode = ?`;
    params.push(collectionMode);
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  try {
    const result = await env.DB.prepare(sql).bind(...params).all();
    return json({ ok: true, count: result.results.length, versions: result.results });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleStrategySummary(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const since = url.searchParams.get("since");
  const regimeSnapshotId = url.searchParams.get("regime_snapshot_id");
  const versionId = url.searchParams.get("version_id") ?? url.searchParams.get("strategy_version_id");
  const filters: string[] = [];
  const params: string[] = [];
  if (since) {
    filters.push(`s.ts >= ?`);
    params.push(since);
  }
  if (regimeSnapshotId) {
    filters.push(`s.regime_snapshot_id = ?`);
    params.push(regimeSnapshotId);
  }
  if (versionId) {
    filters.push(`s.version_id = ?`);
    params.push(versionId);
  }
  const filter = filters.length ? `AND ${filters.join(" AND ")}` : "";
  try {
    const result = await env.DB
      .prepare(
        `SELECT
          s.strategy_id,
          s.version_id,
          v.name,
          v.status,
          v.regime,
          s.mode,
          COUNT(*) AS signals,
          SUM(CASE WHEN s.entered = 1 THEN 1 ELSE 0 END) AS entered,
          SUM(CASE WHEN o.pnl_pct > 0 THEN 1 ELSE 0 END) AS winners,
          SUM(CASE WHEN o.pnl_pct < 0 THEN 1 ELSE 0 END) AS losers,
          ROUND(AVG(o.pnl_pct), 3) AS avg_pnl_pct,
          ROUND(AVG(o.mfe_pct), 3) AS avg_mfe_pct,
          ROUND(AVG(o.mae_pct), 3) AS avg_mae_pct,
          MAX(s.ts) AS last_signal_ts
        FROM strategy_signals s
        LEFT JOIN strategy_versions v ON v.version_id = s.version_id
        LEFT JOIN strategy_outcomes o ON o.client_signal_id = s.client_signal_id
        WHERE 1=1 ${filter}
        GROUP BY s.strategy_id, s.version_id, v.name, v.status, v.regime, s.mode
        ORDER BY signals DESC
        LIMIT 100`
      )
      .bind(...params)
      .all();
    return json({ ok: true, since, regime_snapshot_id: regimeSnapshotId, strategies: result.results });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleCurrentRegime(_req: Request, env: Env): Promise<Response> {
  try {
    const regime = await env.DB
      .prepare(`SELECT * FROM regime_snapshots ORDER BY ts DESC LIMIT 1`)
      .first();
    const regimeRecord = regime ? regime as Record<string, unknown> : null;
    const staleness = stalenessSec(regimeRecord?.ts);
    const degraded = deriveRegimeDegraded(regimeRecord);
    const degradedReason = deriveRegimeDegradedReason(regimeRecord);
    return json({
      ok: true,
      regime,
      staleness_sec: staleness,
      is_stale: staleness === null ? false : staleness > REGIME_STALE_AFTER_SEC,
      degraded,
      degraded_reason: degradedReason,
    });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

async function handleStats(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const since = url.searchParams.get("since"); // ISO; if absent → all time
  try {
    const filter = since ? `AND ts_exit >= ?` : "";
    const params = since ? [since] : [];

    const overall = await env.DB
      .prepare(
        `SELECT
          COUNT(*) AS total_trades,
          SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS winners,
          SUM(CASE WHEN pnl_pct < 0 THEN 1 ELSE 0 END) AS losers,
          ROUND(AVG(pnl_pct), 3) AS avg_pnl_pct,
          ROUND(SUM(pnl_abs), 4) AS total_pnl_abs,
          ROUND(SUM(fee_usd), 4) AS total_fee_usd,
          ROUND(SUM(funding_usd), 4) AS total_funding_usd,
          ROUND(SUM(pnl_net_usd), 4) AS total_pnl_net_usd,
          SUM(CASE WHEN pnl_net_usd IS NOT NULL THEN 1 ELSE 0 END) AS trades_with_net,
          MIN(ts_entry) AS first_trade_ts,
          MAX(ts_exit) AS last_exit_ts
        FROM live_trades
        WHERE ts_exit IS NOT NULL ${filter}`
      )
      .bind(...params)
      .first();

    const bySymbol = await env.DB
      .prepare(
        `SELECT symbol, COUNT(*) AS n, ROUND(SUM(pnl_pct), 2) AS pnl_total
         FROM live_trades WHERE ts_exit IS NOT NULL ${filter}
         GROUP BY symbol ORDER BY n DESC LIMIT 20`
      )
      .bind(...params)
      .all();

    const recent = await env.DB
      .prepare(
        `SELECT ts_exit AS ts, pnl_abs, pnl_net_usd, fee_usd, funding_usd FROM live_trades
         WHERE ts_exit IS NOT NULL ${filter}
         ORDER BY ts_exit DESC LIMIT 200`
      )
      .bind(...params)
      .all();

    return json({
      ok: true,
      since,
      overall,
      by_symbol: bySymbol.results,
      recent: recent.results.reverse(), // chronological for equity curve
    });
  } catch (e) {
    return json({ error: "db_error", detail: String(e) }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-max-age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/ingest/trade") return handleIngestTrade(request, env);
    if (request.method === "POST" && path === "/ingest/event") return handleIngestEvent(request, env);
    if (request.method === "POST" && path === "/ingest/regime-snapshot") return handleIngestRegimeSnapshot(request, env);
    if (request.method === "POST" && path === "/ingest/lifecycle-event") return handleIngestLifecycleEvent(request, env);
    if (request.method === "POST" && path === "/ingest/strategy-version") return handleIngestStrategyVersion(request, env);
    if (request.method === "POST" && path === "/ingest/strategy-signal") return handleIngestStrategySignal(request, env);
    if (request.method === "POST" && path === "/ingest/strategy-outcome") return handleIngestStrategyOutcome(request, env);
    {
      const activate = path.match(/^\/strategy-versions\/([^/]+)\/(activate|pause)$/);
      if (request.method === "POST" && activate) {
        return handleSetStrategyActivation(request, env, decodeURIComponent(activate[1]), activate[2] === "activate" ? 1 : 0);
      }
    }
    if (request.method === "GET" && path === "/trades") return handleListTrades(request, env);
    if (request.method === "GET" && path === "/events") return handleListEvents(request, env);
    if (request.method === "GET" && path === "/lifecycle-events") return handleListLifecycleEvents(request, env);
    if (request.method === "GET" && path === "/strategy-versions") return handleListStrategyVersions(request, env);
    if (request.method === "GET" && path === "/strategy-signals") return handleListStrategySignals(request, env);
    if (request.method === "GET" && path === "/strategy-outcomes") return handleListStrategyOutcomes(request, env);
    if (request.method === "GET" && path === "/strategy-summary") return handleStrategySummary(request, env);
    if (request.method === "GET" && path === "/regime/current") return handleCurrentRegime(request, env);
    if (request.method === "GET" && path === "/stats") return handleStats(request, env);
    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return json({ ok: true, service: "bithub-trades-api", version: "0.1.0" });
    }

    return json({ error: "not_found", path }, 404);
  },
};
