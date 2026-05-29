import { eventsRoute } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "100", 10), 1), 1000);
  return eventsRoute(limit);
}
