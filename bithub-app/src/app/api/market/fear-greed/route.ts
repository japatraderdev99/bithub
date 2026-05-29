import { NextResponse } from "next/server";
import { fetchFearGreed } from "@/lib/fear-greed-public";

export const revalidate = 3600;

export async function GET() {
  try {
    const reading = await fetchFearGreed();
    return NextResponse.json({
      ok: true,
      ...reading,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        source: "alternative.me",
        reason: (e as Error).message,
        as_of: new Date().toISOString(),
      },
      { status: 200 },
    );
  }
}
