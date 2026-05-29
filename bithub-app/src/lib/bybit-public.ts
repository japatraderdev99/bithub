// Bybit V5 public-only client. NO credentials, NO authenticated endpoints.
// Hard stop reminder: Bithub never reads private account/order/position data
// from Bybit. Anything that needs auth goes through the local monitor instead.

const BYBIT_PUBLIC_BASE = "https://api.bybit.com";

interface BybitEnvelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
  time: number;
}

export interface BybitTicker {
  symbol: string;
  lastPrice: string;
  prevPrice24h: string;
  price24hPcnt: string; // signed fraction, e.g. "0.012"
  highPrice24h: string;
  lowPrice24h: string;
  volume24h: string;
  turnover24h: string;
  openInterest: string;
  openInterestValue: string;
  fundingRate: string; // signed fraction, e.g. "0.0001"
  nextFundingTime: string; // ms
}

interface TickerListResult {
  category: string;
  list: BybitTicker[];
}

async function fetchPublic<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BYBIT_PUBLIC_BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Bithub-Research/0.1 (public endpoints only)" },
    next: { revalidate: 30 }, // Next.js server-side cache, 30s
  });
  if (!res.ok) {
    throw new Error(`Bybit ${path} returned ${res.status}`);
  }
  const json = (await res.json()) as BybitEnvelope<T>;
  if (json.retCode !== 0) {
    throw new Error(`Bybit ${path} retCode=${json.retCode} ${json.retMsg}`);
  }
  return json.result;
}

export async function fetchLinearTicker(symbol: string): Promise<BybitTicker | null> {
  const r = await fetchPublic<TickerListResult>("/v5/market/tickers", {
    category: "linear",
    symbol,
  });
  return r.list?.[0] ?? null;
}

export async function fetchLinearTickers(symbols: string[]): Promise<BybitTicker[]> {
  // V5 tickers endpoint returns all symbols when called without `symbol`.
  // We fetch the full set once and filter — fewer requests than N round-trips.
  const r = await fetchPublic<TickerListResult>("/v5/market/tickers", {
    category: "linear",
  });
  const set = new Set(symbols);
  return r.list.filter((t) => set.has(t.symbol));
}

export function bybitPctToNumber(s: string): number {
  return parseFloat(s) * 100;
}

export function bybitFundingPctToNumber(s: string): number {
  return parseFloat(s) * 100;
}
