import type { CandidatesFile } from "@/types/monitor";
import { snapshotRoute } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

export async function GET() {
  return snapshotRoute<CandidatesFile>("candidates");
}
