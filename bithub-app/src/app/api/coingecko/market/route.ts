import { NextResponse } from "next/server";
import { fetchCryptoGlobal, fetchCryptoSectors, fetchTrendingCoins } from "@/lib/coingecko-public";

export const revalidate = 60;

export async function GET() {
  try {
    const [global, sectors, trending] = await Promise.all([
      fetchCryptoGlobal(),
      fetchCryptoSectors(),
      fetchTrendingCoins(),
    ]);
    return NextResponse.json({
      ok: true,
      source: "coingecko",
      as_of: new Date().toISOString(),
      global,
      sectors,
      trending,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        source: "coingecko",
        reason: (e as Error).message,
        as_of: new Date().toISOString(),
      },
      { status: 200 }
    );
  }
}

