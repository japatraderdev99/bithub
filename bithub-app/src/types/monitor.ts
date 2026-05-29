// Types mirror what `bithub_state_publisher.py` writes into
// ~/.bithub-monitor/*.json. See integration/HOW-TO-CONNECT-FREQTRADE.md.

export type MomentumState = "STRONG" | "NORMAL" | "WANING" | "REVERSING";
export type DeltaTrend = "ACELERANDO" | "DESACELERANDO" | "ESTAVEL";
export type WSStatus = "connected" | "reconnecting" | "down";

export interface OpenPosition {
  symbol: string;
  side: "long" | "short";
  entry: number;
  current_price: number;
  sl: number;
  tp: number;
  qty: number;
  pnl_pct: number;
  best_pnl_pct: number;
  size_usd: number;
  leverage: number;
  momentum_state: MomentumState;
  tape_bias: number;
  tape_flow_pct: number;
  tape_delta_trend: DeltaTrend;
  be_set: boolean;
  partial_done: boolean;
  tp_extended: boolean;
  opened_at: string; // ISO
}

export interface PositionsFile {
  as_of: string;
  open_count: number;
  max_slots: number;
  positions: OpenPosition[];
}

export interface CandidateGates {
  g_atr: boolean;
  g_bb: boolean;
  g_vol: boolean;
  g_ema: boolean;
  g_rsi: boolean;
  g_poc: boolean;
  g_fund: boolean;
  g_book: boolean;
  liq_ok: boolean;
}

export interface CandidateIndicators {
  atr_pct: number;
  bb_pct?: number;
  vol_x?: number;
  rsi5: number;
  rsi15?: number;
  dist9: number;
  dist21?: number;
  book_imb_pct: number | null;
  funding_rate: number | null;
  poc_dist_pct: number | null;
  liq_align_pct?: number | null;
  price: number;
}

export interface Candidate {
  symbol: string;
  direction: "long" | "short";
  score: number;
  gates: CandidateGates;
  indicators: CandidateIndicators;
  tf_alignment: string;
  gate_ok: boolean;
  rejection_reason?: string | null;
  r_r?: number | null;
}

export interface CandidatesFile {
  as_of: string;
  last_t1_scan_ts: string | null;
  last_t2_scan_ts: string | null;
  total: number;
  passing: number;
  above_min_score: number;
  candidates: Candidate[];
}

export interface SystemAlert {
  severity: "info" | "warn" | "error";
  msg: string;
}

export interface SystemFile {
  as_of: string;
  balance_usdt: number;
  free_usdt: number;
  open_slots: number;
  max_slots: number;
  ws_private_status: WSStatus;
  last_heartbeat_ts: string;
  alerts: SystemAlert[];
}

export type EventType =
  | "ENTRY"
  | "EXIT_FULL"
  | "EXIT_PARTIAL"
  | "TRAIL"
  | "EXTEND_TP"
  | "TIGHT_TP"
  | "TAPE_SIGNAL"
  | "T1_SCAN"
  | "T2_SIGNAL";

export interface MonitorEvent {
  ts: string;
  symbol: string;
  event_type: EventType;
  detail: string;
  pnl_realized?: number;
}

export interface ContextAsset {
  price: number;
  tf_class: string;
  tf_aligned: boolean;
  bias: string;
  rsi5: number;
  adx: number;
  atr_pct: number;
  vol_x: number;
  ema_spread_pct: number;
  funding_rate: number | null;
}

export interface ContextFile {
  as_of: string;
  btc: ContextAsset | null;
  eth: ContextAsset | null;
  macro_block: "LONG_BLOCKED" | "SHORT_BLOCKED" | null;
  capitulation_mode: boolean;
  last_t1_scan_ts: string | null;
  tape_layer0_active: boolean;
}

export interface PublisherStatus {
  ok: boolean;
  reason?: string;
  age_ms?: number;
}
