// Crypto Fear & Greed Index via alternative.me public API.
// Server-side only, no API key.

const FNG_URL = "https://api.alternative.me/fng/";

interface FearGreedResponse {
  data?: Array<{
    value?: string;
    value_classification?: string;
    timestamp?: string;
    time_until_update?: string;
  }>;
}

export interface FearGreedReading {
  value: number;
  classification: "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed" | string;
  as_of: string;
  time_until_update_sec: number | null;
  interpretation: "contrarian_bullish" | "neutral" | "crowded_long";
  source: "alternative.me";
}

export async function fetchFearGreed(): Promise<FearGreedReading> {
  const res = await fetch(FNG_URL, {
    headers: { "User-Agent": "Bithub-Research/0.1 (server-side fear-greed)" },
    next: { revalidate: 3600 },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Alternative.me FNG returned ${res.status}`);
  const body = (await res.json()) as FearGreedResponse;
  const latest = body.data?.[0];
  if (!latest?.value) throw new Error("Alternative.me FNG returned no reading");
  const value = Number(latest.value);
  if (!Number.isFinite(value)) throw new Error("Alternative.me FNG returned invalid value");

  return {
    value,
    classification: latest.value_classification ?? classify(value),
    as_of: latest.timestamp ? new Date(Number(latest.timestamp) * 1000).toISOString() : new Date().toISOString(),
    time_until_update_sec: latest.time_until_update ? Number(latest.time_until_update) : null,
    interpretation: interpret(value),
    source: "alternative.me",
  };
}

function classify(value: number): FearGreedReading["classification"] {
  if (value <= 24) return "Extreme Fear";
  if (value <= 44) return "Fear";
  if (value <= 54) return "Neutral";
  if (value <= 74) return "Greed";
  return "Extreme Greed";
}

function interpret(value: number): FearGreedReading["interpretation"] {
  if (value <= 24) return "contrarian_bullish";
  if (value >= 75) return "crowded_long";
  return "neutral";
}
