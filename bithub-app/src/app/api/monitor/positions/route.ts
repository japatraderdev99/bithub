import type { PositionsFile } from "@/types/monitor";
import { snapshotRoute } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

export async function GET() {
  return snapshotRoute<PositionsFile>("positions");
}
