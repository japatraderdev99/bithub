// Cross-asset market tape via Yahoo Finance public chart API.
// Server-side only, no API key.

const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";

type CrossAssetGroup = "us_futures" | "asia" | "rates" | "fx_commodities";

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        previousClose?: number;
        chartPreviousClose?: number;
        regularMarketTime?: number;
        exchangeName?: string;
        instrumentType?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: Array<number | null>;
        }>;
      };
    }>;
    error?: { code?: string; description?: string } | null;
  };
}

export interface CrossAssetQuote {
  symbol: string;
  label: string;
  group: CrossAssetGroup;
  value: number;
  previous: number | null;
  change_abs: number | null;
  change_pct: number | null;
  as_of: string;
  source: "yahoo";
  interpretation: "risk_on" | "risk_off" | "neutral";
}

export interface CrossAssetSnapshot {
  source: "yahoo";
  as_of: string;
  quotes: CrossAssetQuote[];
  breadth: {
    risk_on_count: number;
    risk_off_count: number;
    neutral_count: number;
    dominant: "risk_on" | "risk_off" | "mixed";
  };
}

const WATCHLIST: Array<{
  symbol: string;
  label: string;
  group: CrossAssetGroup;
  risingRiskOff: boolean;
}> = [
  // US equity beta: crypto usually follows Nasdaq/S&P risk appetite.
  { symbol: "ES=F", label: "S&P fut", group: "us_futures", risingRiskOff: false },
  { symbol: "NQ=F", label: "Nasdaq fut", group: "us_futures", risingRiskOff: false },
  { symbol: "RTY=F", label: "Russell fut", group: "us_futures", risingRiskOff: false },

  // Asia often sets overnight liquidity/risk tone before US opens.
  { symbol: "^N225", label: "Nikkei", group: "asia", risingRiskOff: false },
  { symbol: "^HSI", label: "Hang Seng", group: "asia", risingRiskOff: false },
  { symbol: "000001.SS", label: "Shanghai", group: "asia", risingRiskOff: false },
  { symbol: "^KS11", label: "KOSPI", group: "asia", risingRiskOff: false },

  // Market-implied yields: faster than FRED daily series.
  { symbol: "^TNX", label: "US 10Y mkt", group: "rates", risingRiskOff: true },
  { symbol: "^FVX", label: "US 5Y mkt", group: "rates", risingRiskOff: true },
  { symbol: "^IRX", label: "US 13W", group: "rates", risingRiskOff: true },

  // Dollar and macro hedges.
  { symbol: "DX-Y.NYB", label: "DXY", group: "fx_commodities", risingRiskOff: true },
  { symbol: "GC=F", label: "Gold", group: "fx_commodities", risingRiskOff: true },
  { symbol: "CL=F", label: "Oil WTI", group: "fx_commodities", risingRiskOff: true },
];

export async function fetchCrossAssetSnapshot(): Promise<CrossAssetSnapshot> {
  const settled = await Promise.allSettled(WATCHLIST.map(fetchQuote));
  const quotes = settled
    .filter((r): r is PromiseFulfilledResult<CrossAssetQuote> => r.status === "fulfilled")
    .map((r) => r.value);
  const risk_on_count = quotes.filter((q) => q.interpretation === "risk_on").length;
  const risk_off_count = quotes.filter((q) => q.interpretation === "risk_off").length;
  const neutral_count = quotes.filter((q) => q.interpretation === "neutral").length;
  const dominant =
    risk_on_count >= risk_off_count + 2 ? "risk_on" : risk_off_count >= risk_on_count + 2 ? "risk_off" : "mixed";

  return {
    source: "yahoo",
    as_of: new Date().toISOString(),
    quotes,
    breadth: { risk_on_count, risk_off_count, neutral_count, dominant },
  };
}

async function fetchQuote(item: (typeof WATCHLIST)[number]): Promise<CrossAssetQuote> {
  const qs = new URLSearchParams({
    interval: "5m",
    range: "1d",
  });
  const res = await fetch(`${YAHOO_CHART}/${encodeURIComponent(item.symbol)}?${qs}`, {
    headers: { "User-Agent": "Bithub-Research/0.1 (server-side cross-asset)" },
    next: { revalidate: 60 },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Yahoo ${item.symbol} returned ${res.status}`);
  const body = (await res.json()) as YahooChartResponse;
  const result = body.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${item.symbol} returned no result`);
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const lastClose = [...closes].reverse().find((v): v is number => typeof v === "number" && Number.isFinite(v));
  const value = result.meta?.regularMarketPrice ?? lastClose;
  if (value == null || !Number.isFinite(value)) throw new Error(`Yahoo ${item.symbol} missing price`);
  const previous = result.meta?.previousClose ?? result.meta?.chartPreviousClose ?? null;
  const change_abs = previous != null ? value - previous : null;
  const change_pct = previous && previous !== 0 ? ((value - previous) / previous) * 100 : null;

  return {
    symbol: item.symbol,
    label: item.label,
    group: item.group,
    value,
    previous,
    change_abs,
    change_pct,
    as_of: result.meta?.regularMarketTime ? new Date(result.meta.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
    source: "yahoo",
    interpretation: interpret(change_pct, item.risingRiskOff),
  };
}

function interpret(changePct: number | null, risingRiskOff: boolean): CrossAssetQuote["interpretation"] {
  if (changePct == null || Math.abs(changePct) < 0.05) return "neutral";
  const riskOff = risingRiskOff ? changePct > 0 : changePct < 0;
  return riskOff ? "risk_off" : "risk_on";
}
