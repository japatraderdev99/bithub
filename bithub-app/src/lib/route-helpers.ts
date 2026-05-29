import { NextResponse } from "next/server";
import {
  CredentialLeakError,
  PublisherOfflineError,
  readSnapshot,
  readEvents,
  SNAPSHOTS,
} from "@/lib/monitor-reader";

// Note: never include filesystem paths (state_dir, file paths) in API responses.
// Operator's absolute paths are local-machine specific PII; cockpit-tail of the
// MVP-001 explicitly tested against this leak (see `bithub-ui/tests/dev-server.test.mjs`).
// We strip path info from both success and error responses here.

export async function snapshotRoute<T>(file: keyof typeof SNAPSHOTS) {
  try {
    const { data, age_ms } = await readSnapshot<T>(SNAPSHOTS[file]);
    return NextResponse.json({ ok: true, age_ms, data });
  } catch (e) {
    if (e instanceof PublisherOfflineError) {
      return NextResponse.json({ ok: false, reason: e.reason }, { status: 200 });
    }
    if (e instanceof CredentialLeakError) {
      return NextResponse.json(
        {
          ok: false,
          reason: "publisher payload contained credential-shaped fields — refusing to serve",
          findings: e.findings,
        },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 });
  }
}

export async function eventsRoute(limit = 100) {
  try {
    const { events, age_ms } = await readEvents(limit);
    return NextResponse.json({ ok: true, age_ms, events });
  } catch (e) {
    if (e instanceof PublisherOfflineError) {
      return NextResponse.json({ ok: false, reason: e.reason }, { status: 200 });
    }
    if (e instanceof CredentialLeakError) {
      return NextResponse.json(
        { ok: false, reason: "events stream contained credential-shaped fields", findings: e.findings },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 });
  }
}
