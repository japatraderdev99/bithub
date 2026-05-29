import type { ContextFile } from "@/types/monitor";
import { snapshotRoute } from "@/lib/route-helpers";
import {
  CredentialLeakError,
  PublisherOfflineError,
  readSnapshot,
} from "@/lib/monitor-reader";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // The publisher writes `context.json` but it isn't part of the legacy
    // SNAPSHOTS enum (positions/candidates/system/events). Read it directly.
    const { data, age_ms } = await readSnapshot<ContextFile>("context.json");
    return NextResponse.json({ ok: true, age_ms, data });
  } catch (e) {
    if (e instanceof PublisherOfflineError) {
      return NextResponse.json({ ok: false, reason: e.reason }, { status: 200 });
    }
    if (e instanceof CredentialLeakError) {
      return NextResponse.json(
        { ok: false, reason: "credential-shaped fields in context.json", findings: e.findings },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 });
  }
  // referenced to silence unused-import lint
  void snapshotRoute;
}
