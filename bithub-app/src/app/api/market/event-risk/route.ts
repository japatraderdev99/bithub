import { NextResponse } from "next/server";
import { fetchEventRiskNews } from "@/lib/event-risk-news";

export const revalidate = 300;

export async function GET() {
  try {
    const snapshot = await fetchEventRiskNews();
    return NextResponse.json(snapshot);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        source: "event_risk",
        reason: (e as Error).message,
        as_of: new Date().toISOString(),
        headlines: [],
      },
      { status: 200 },
    );
  }
}
