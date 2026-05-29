// CoinGecko public/demo client. Server-side only: API key is never sent to UI.

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

interface GlobalResponse {
  data: {
    active_cryptocurrencies: number;
    markets: number;
    total_market_cap: Record<string, number>;
    total_volume: Record<string, number>;
    market_cap_percentage: Record<string, number>;
    market_cap_change_percentage_24h_usd: number;
  };
}

interface CategoryResponse {
  id: string;
  name: string;
  market_cap: number | null;
  market_cap_change_24h: number | null;
  volume_24h: number | null;
  top_3_coins_id?: string[];
}

interface TrendingResponse {
  coins: Array<{
    item: {
      id: string;
      coin_id: number;
      name: string;
      symbol: string;
      market_cap_rank: number | null;
      score: number;
      data?: {
        price?: number;
        price_change_percentage_24h?: Record<string, number>;
        total_volume?: string;
        market_cap?: string;
      };
    };
  }>;
}

export interface CryptoGlobal {
  active_cryptocurrencies: number;
  markets: number;
  total_market_cap_usd: number;
  total_volume_usd: number;
  btc_dominance_pct: number;
  eth_dominance_pct: number;
  market_cap_change_24h_pct: number;
}

export interface CryptoSector {
  sector: string;
  category_id: string;
  perf_24h_pct: number;
  volume_24h_usd: number;
  market_cap_usd: number;
  leaders: string[];
}

export interface TrendingCoin {
  id: string;
  name: string;
  symbol: string;
  rank: number | null;
  score: number;
  price_usd: number | null;
  change_24h_pct: number | null;
}

async function fetchCoinGecko<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const key = process.env.COINGECKO_DEMO_API_KEY;
  const headers: Record<string, string> = {
    "User-Agent": "Bithub-Research/0.1 (server-side panorama)",
  };
  if (key) headers["x-cg-demo-api-key"] = key;

  const res = await fetch(`${COINGECKO_BASE}${path}${qs ? `?${qs}` : ""}`, {
    headers,
    next: { revalidate: 60 },
  });
  if (!res.ok) {
    throw new Error(`CoinGecko ${path} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchCryptoGlobal(): Promise<CryptoGlobal> {
  const body = await fetchCoinGecko<GlobalResponse>("/global");
  const d = body.data;
  return {
    active_cryptocurrencies: d.active_cryptocurrencies,
    markets: d.markets,
    total_market_cap_usd: d.total_market_cap.usd ?? 0,
    total_volume_usd: d.total_volume.usd ?? 0,
    btc_dominance_pct: d.market_cap_percentage.btc ?? 0,
    eth_dominance_pct: d.market_cap_percentage.eth ?? 0,
    market_cap_change_24h_pct: d.market_cap_change_percentage_24h_usd ?? 0,
  };
}

const CATEGORY_ALLOWLIST = new Set([
  "layer-1",
  "smart-contract-platform",
  "decentralized-finance-defi",
  "meme-token",
  "artificial-intelligence",
  "gaming",
  "layer-2",
  "infrastructure",
  "privacy-coins",
]);

function cleanSectorName(name: string): string {
  return name
    .replace(/\s*\(.*?\)\s*/g, "")
    .replace(/ Ecosystem$/i, "")
    .replace(/^Smart Contract Platform$/i, "Smart Contract")
    .replace(/^Artificial Intelligence.*$/i, "AI")
    .replace(/^Meme$/i, "Memecoin");
}

export async function fetchCryptoSectors(): Promise<CryptoSector[]> {
  const body = await fetchCoinGecko<CategoryResponse[]>("/coins/categories", {
    order: "market_cap_desc",
  });
  return body
    .filter((c) => CATEGORY_ALLOWLIST.has(c.id))
    .map((c) => ({
      sector: cleanSectorName(c.name),
      category_id: c.id,
      perf_24h_pct: c.market_cap_change_24h ?? 0,
      volume_24h_usd: c.volume_24h ?? 0,
      market_cap_usd: c.market_cap ?? 0,
      leaders: (c.top_3_coins_id ?? []).slice(0, 3).map((s) => s.toUpperCase()),
    }))
    .sort((a, b) => b.volume_24h_usd - a.volume_24h_usd)
    .slice(0, 8);
}

export async function fetchTrendingCoins(): Promise<TrendingCoin[]> {
  const body = await fetchCoinGecko<TrendingResponse>("/search/trending");
  return body.coins.slice(0, 8).map(({ item }) => ({
    id: item.id,
    name: item.name,
    symbol: item.symbol.toUpperCase(),
    rank: item.market_cap_rank,
    score: item.score,
    price_usd: item.data?.price ?? null,
    change_24h_pct: item.data?.price_change_percentage_24h?.usd ?? null,
  }));
}

