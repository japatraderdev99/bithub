// FRED client. Server-side only: FRED_API_KEY is never sent to UI.

const FRED_BASE = "https://api.stlouisfed.org/fred";

interface ObservationsResponse {
  observations: Array<{
    date: string;
    value: string;
  }>;
}

export interface MacroSeriesPoint {
  date: string;
  value: number;
}

export interface MacroIndicator {
  id: string;
  label: string;
  value: number;
  previous: number | null;
  change: number | null;
  unit: "pct" | "index" | "usd_m" | "usd_b" | "spread";
  date: string;
  sparkline: number[];
  interpretation: "risk_on" | "risk_off" | "neutral";
}

export interface MacroRegime {
  regime: "risk_on" | "neutral" | "risk_off";
  risk_score: number;
  confidence: "low" | "medium" | "high";
  as_of: string;
  drivers: string[];
  blockers: string[];
}

const SERIES = [
  // Rates and dollar: crypto tends to dislike rising real/nominal yields and USD strength.
  { id: "DGS10", label: "US 10Y", unit: "pct" as const, risingRiskOff: true },
  { id: "DGS2", label: "US 2Y", unit: "pct" as const, risingRiskOff: true },
  { id: "DFF", label: "Fed funds", unit: "pct" as const, risingRiskOff: true },
  { id: "T10Y2Y", label: "10Y-2Y", unit: "spread" as const, risingRiskOff: false },
  { id: "DTWEXBGS", label: "USD broad", unit: "index" as const, risingRiskOff: true },

  // Cross-asset stress: liquidity dries up fast when vol/spreads/financial stress rise.
  { id: "VIXCLS", label: "VIX", unit: "index" as const, risingRiskOff: true },
  { id: "NFCI", label: "NFCI", unit: "index" as const, risingRiskOff: true },
  { id: "BAMLH0A0HYM2", label: "HY spread", unit: "spread" as const, risingRiskOff: true },

  // Liquidity: crypto often trades like a high-beta liquidity asset.
  { id: "RRPONTSYD", label: "Reverse repo", unit: "usd_b" as const, risingRiskOff: true },
  { id: "WALCL", label: "Fed assets", unit: "usd_m" as const, risingRiskOff: false },
  { id: "M2SL", label: "M2 money", unit: "usd_b" as const, risingRiskOff: false },
];

function parseObservationValue(v: string): number | null {
  if (v === ".") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchFred<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error("FRED_API_KEY missing");
  const qs = new URLSearchParams({
    ...params,
    api_key: key,
    file_type: "json",
  }).toString();
  const res = await fetch(`${FRED_BASE}${path}?${qs}`, {
    headers: { "User-Agent": "Bithub-Research/0.1 (server-side macro)" },
    next: { revalidate: 3600 },
  });
  if (!res.ok) {
    throw new Error(`FRED ${path} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

async function fetchSeries(id: string): Promise<MacroSeriesPoint[]> {
  const body = await fetchFred<ObservationsResponse>("/series/observations", {
    series_id: id,
    sort_order: "desc",
    limit: "32",
  });
  return body.observations
    .map((o) => ({ date: o.date, value: parseObservationValue(o.value) }))
    .filter((o): o is MacroSeriesPoint => o.value !== null)
    .reverse();
}

function interpretation(change: number | null, risingRiskOff: boolean): MacroIndicator["interpretation"] {
  if (change === null || Math.abs(change) < 0.01) return "neutral";
  const riskOff = risingRiskOff ? change > 0 : change < 0;
  return riskOff ? "risk_off" : "risk_on";
}

export async function fetchMacroIndicators(): Promise<MacroIndicator[]> {
  const settled = await Promise.allSettled(
    SERIES.map(async (s): Promise<MacroIndicator> => {
      const points = await fetchSeries(s.id);
      const latest = points[points.length - 1];
      const previous = points[points.length - 2] ?? null;
      if (!latest) throw new Error(`FRED ${s.id} returned no observations`);
      const change = previous ? latest.value - previous.value : null;
      return {
        id: s.id,
        label: s.label,
        value: latest.value,
        previous: previous?.value ?? null,
        change,
        unit: s.unit,
        date: latest.date,
        sparkline: points.slice(-12).map((p) => p.value),
        interpretation: interpretation(change, s.risingRiskOff),
      };
    })
  );

  return settled
    .filter((r): r is PromiseFulfilledResult<MacroIndicator> => r.status === "fulfilled")
    .map((r) => r.value);
}

export function classifyMacroRegime(indicators: MacroIndicator[]): MacroRegime {
  const weights: Record<string, number> = {
    VIXCLS: 2,
    NFCI: 2,
    BAMLH0A0HYM2: 2,
    DTWEXBGS: 1.5,
    DGS10: 1,
    DGS2: 1,
    DFF: 1,
    T10Y2Y: 1,
    RRPONTSYD: 1,
    WALCL: 1.25,
    M2SL: 1.25,
  };
  let weighted = 0;
  let total = 0;
  const drivers: string[] = [];
  const blockers: string[] = [];

  for (const i of indicators) {
    const weight = weights[i.id] ?? 1;
    total += weight;
    if (i.interpretation === "risk_off") {
      weighted += weight;
      drivers.push(`${i.label} ${formatDirection(i.change)} risk-off`);
    } else if (i.interpretation === "risk_on") {
      weighted -= weight;
      blockers.push(`${i.label} ${formatDirection(i.change)} risk-on`);
    }
  }

  const normalized = total > 0 ? Math.round(((weighted / total) * 50 + 50) * 10) / 10 : 50;
  const risk_score = Math.max(0, Math.min(100, normalized));
  const regime = risk_score >= 62 ? "risk_off" : risk_score <= 38 ? "risk_on" : "neutral";
  const confidence =
    Math.abs(risk_score - 50) >= 24 ? "high" : Math.abs(risk_score - 50) >= 12 ? "medium" : "low";
  const as_of = indicators
    .map((i) => i.date)
    .sort()
    .at(-1) ?? new Date().toISOString().slice(0, 10);

  return {
    regime,
    risk_score,
    confidence,
    as_of,
    drivers: drivers.slice(0, 4),
    blockers: blockers.slice(0, 4),
  };
}

function formatDirection(change: number | null): string {
  if (change == null) return "sem delta";
  if (Math.abs(change) < 0.01) return "flat";
  return change > 0 ? "subindo" : "caindo";
}
