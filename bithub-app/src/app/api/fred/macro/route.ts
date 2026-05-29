import { NextResponse } from "next/server";
import { classifyMacroRegime, fetchMacroIndicators } from "@/lib/fred-public";

export const revalidate = 3600;

export async function GET() {
  try {
    const indicators = await fetchMacroIndicators();
    const regime = classifyMacroRegime(indicators);
    return NextResponse.json({
      ok: true,
      source: "fred",
      as_of: new Date().toISOString(),
      regime,
      indicators,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        source: "fred",
        reason: (e as Error).message,
        as_of: new Date().toISOString(),
      },
      { status: 200 }
    );
  }
}
