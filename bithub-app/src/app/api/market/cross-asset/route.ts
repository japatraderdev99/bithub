import { NextResponse } from "next/server";
import { fetchCrossAssetSnapshot } from "@/lib/cross-asset-public";

export const revalidate = 60;

export async function GET() {
  try {
    const snapshot = await fetchCrossAssetSnapshot();
    return NextResponse.json({
      ok: true,
      ...snapshot,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        source: "yahoo",
        reason: (e as Error).message,
        as_of: new Date().toISOString(),
        quotes: [],
      },
      { status: 200 },
    );
  }
}
