// Client for the bithub-trades-api Worker on Cloudflare. Read-only endpoints
// are public; writes (ingest) happen only from the local monitor publisher,
// never from this UI.

const WORKER_URL =
  process.env.NEXT_PUBLIC_BITHUB_WORKER_URL ??
  "https://bithub-trades-api.guiydantas.workers.dev";

export interface Trade {
  id: number;
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
  setup_score: number | null;
  fee_usd: number | null;
  funding_usd: number | null;
  pnl_net_usd: number | null;
  source: string;
  ingested_at: string;
  client_trade_id: string;
}

export interface MonitorEvent {
  id: number;
  ts: string;
  symbol: string;
  event_type: string;
  detail: string | null;
  pnl_realized: number | null;
}

export interface StatsOverall {
  total_trades: number;
  winners: number | null;
  losers: number | null;
  avg_pnl_pct: number | null;
  total_pnl_abs: number | null;
  total_fee_usd: number | null;
  total_funding_usd: number | null;
  total_pnl_net_usd: number | null;
  trades_with_net: number | null;
  first_trade_ts: string | null;
  last_exit_ts: string | null;
}

export interface StatsBySymbol {
  symbol: string;
  n: number;
  pnl_total: number | null;
}

export interface StatsResponse {
  ok: true;
  overall: StatsOverall;
  by_symbol: StatsBySymbol[];
  recent: Array<{
    ts: string;
    pnl_abs: number | null;
    pnl_net_usd: number | null;
    fee_usd: number | null;
    funding_usd: number | null;
  }>;
}

interface TradesResponse {
  ok: true;
  count: number;
  trades: Trade[];
}
interface EventsResponse {
  ok: true;
  count: number;
  events: MonitorEvent[];
}

export async function fetchTrades(params: { limit?: number; symbol?: string; since?: string } = {}): Promise<TradesResponse> {
  const qs = new URLSearchParams();
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.symbol) qs.set("symbol", params.symbol);
  if (params.since) qs.set("since", params.since);
  const r = await fetch(`${WORKER_URL}/trades?${qs}`, { cache: "no-store" });
  return (await r.json()) as TradesResponse;
}

export async function fetchEvents(params: { limit?: number; type?: string; symbol?: string } = {}): Promise<EventsResponse> {
  const qs = new URLSearchParams();
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.type) qs.set("type", params.type);
  if (params.symbol) qs.set("symbol", params.symbol);
  const r = await fetch(`${WORKER_URL}/events?${qs}`, { cache: "no-store" });
  return (await r.json()) as EventsResponse;
}

export async function fetchStats(since?: string): Promise<StatsResponse> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  const r = await fetch(`${WORKER_URL}/stats${qs}`, { cache: "no-store" });
  return (await r.json()) as StatsResponse;
}

// Research Bench — regime snapshot returned by GET /regime/current.
// Worker computes staleness_sec on the server so UIs all see the same state.
export interface RegimeSnapshot {
  regime_snapshot_id: string;
  ts: string;
  btc_trend: string | null;
  eth_trend: string | null;
  btc_eth_bias: string | null;
  vol_regime: string | null;
  alt_corr_regime: string | null;
  funding_regime: string | null;
  session_utc: string | null;
  degraded: number | null;        // 0/1 from D1 — UI normalises to boolean
  degraded_reason: string | null;
  raw_features_json: string | null;
  source: string | null;
  ingested_at: string | null;
}

export interface RegimeCurrentResponse {
  ok: true;
  regime: RegimeSnapshot | null;
  staleness_sec: number | null;
  is_stale: boolean;
  degraded: boolean;
  degraded_reason: string | null;
}

export async function fetchRegimeCurrent(): Promise<RegimeCurrentResponse> {
  const r = await fetch(`${WORKER_URL}/regime/current`, { cache: "no-store" });
  return (await r.json()) as RegimeCurrentResponse;
}

// Decision trail row — one lifecycle event for a position.
export interface LifecycleEvent {
  id: number;
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
  ingested_at: string | null;
}

interface LifecycleEventsResponse {
  ok: true;
  count: number;
  events: LifecycleEvent[];
}

export async function fetchLifecycleEvents(params: {
  client_trade_id?: string;
  symbol?: string;
  strategy_version_id?: string;
  regime_snapshot_id?: string;
  event_type?: string;
  since?: string;
  limit?: number;
  sort?: "asc" | "desc";
} = {}): Promise<LifecycleEventsResponse> {
  const qs = new URLSearchParams();
  if (params.client_trade_id) qs.set("client_trade_id", params.client_trade_id);
  if (params.symbol) qs.set("symbol", params.symbol);
  if (params.strategy_version_id) qs.set("strategy_version_id", params.strategy_version_id);
  if (params.regime_snapshot_id) qs.set("regime_snapshot_id", params.regime_snapshot_id);
  if (params.event_type) qs.set("event_type", params.event_type);
  if (params.since) qs.set("since", params.since);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.sort) qs.set("sort", params.sort);
  const r = await fetch(`${WORKER_URL}/lifecycle-events?${qs}`, { cache: "no-store" });
  return (await r.json()) as LifecycleEventsResponse;
}

// /strategy-summary row — JOINed with strategy_versions so UI has the human name.
export interface StrategySummaryRow {
  strategy_id: string;
  version_id: string;
  name: string | null;
  status: string | null;
  regime: string | null;
  mode: string;
  signals: number;
  entered: number;
  winners: number | null;
  losers: number | null;
  avg_pnl_pct: number | null;
  avg_mfe_pct: number | null;
  avg_mae_pct: number | null;
  last_signal_ts: string | null;
}

interface StrategySummaryResponse {
  ok: true;
  since?: string | null;
  regime_snapshot_id?: string | null;
  strategies: StrategySummaryRow[];
}

export async function fetchStrategySummary(params: {
  since?: string;
  regime_snapshot_id?: string;
  strategy_version_id?: string;
  version_id?: string;
} = {}): Promise<StrategySummaryResponse> {
  const qs = new URLSearchParams();
  if (params.since) qs.set("since", params.since);
  if (params.regime_snapshot_id) qs.set("regime_snapshot_id", params.regime_snapshot_id);
  if (params.strategy_version_id) qs.set("strategy_version_id", params.strategy_version_id);
  if (params.version_id) qs.set("version_id", params.version_id);
  const r = await fetch(`${WORKER_URL}/strategy-summary?${qs}`, { cache: "no-store" });
  return (await r.json()) as StrategySummaryResponse;
}
