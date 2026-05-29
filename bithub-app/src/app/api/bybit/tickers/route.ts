import { NextResponse } from "next/server";
import { fetchLinearTickers } from "@/lib/bybit-public";

// Cached at the Next.js layer — server-side revalidation handles freshness.
export const revalidate = 30;

// Pinned to a handful of marquee perps so the panorama is meaningful out of
// the box. Operator can extend later via query param if needed.
const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const explicit = url.searchParams.get("symbols");
  const symbols = explicit ? explicit.split(",").map((s) => s.trim().toUpperCase()) : DEFAULT_SYMBOLS;
  try {
    const tickers = await fetchLinearTickers(symbols);
    return NextResponse.json({ ok: true, tickers, as_of: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: (e as Error).message, as_of: new Date().toISOString() },
      { status: 200 } // keep client polling; surface error in UI without 5xx
    );
  }
}
