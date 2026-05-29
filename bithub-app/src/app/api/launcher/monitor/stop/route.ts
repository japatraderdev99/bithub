import { NextResponse } from "next/server";
import {
  clearPid,
  consumeIntentToken,
  isProcessAlive,
  readPid,
  withLauncherLock,
  writeAudit,
} from "@/lib/launcher-state";

export const dynamic = "force-dynamic";

interface StopBody {
  intent_token: string;
  force?: boolean;
}

const GRACEFUL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

export async function POST(request: Request) {
  let body: StopBody;
  try { body = (await request.json()) as StopBody; } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }
  try {
    return await withLauncherLock(async () => stopLocked(body));
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "launcher_busy" ? 409 : 500;
    return NextResponse.json({ ok: false, reason: msg }, { status });
  }
}

async function stopLocked(body: StopBody) {
  if (!body.intent_token) {
    return NextResponse.json({ ok: false, reason: "missing_intent_token" }, { status: 401 });
  }
  if (!consumeIntentToken(body.intent_token)) {
    writeAudit({ ts: new Date().toISOString(), event: "stop_failed", reason: "intent_token_invalid_or_expired" });
    return NextResponse.json({ ok: false, reason: "intent_token_invalid_or_expired" }, { status: 401 });
  }

  const record = readPid();
  if (!record) {
    return NextResponse.json({ ok: false, reason: "no_monitor_pid_on_record" }, { status: 404 });
  }
  if (!isProcessAlive(record.pid)) {
    clearPid();
    writeAudit({ ts: new Date().toISOString(), event: "stop_success", pid: record.pid, reason: "already_dead" });
    return NextResponse.json({ ok: true, reason: "already_dead", pid: record.pid });
  }

  writeAudit({ ts: new Date().toISOString(), event: "stop_initiated", pid: record.pid, details: { force: !!body.force, watchdog_pid: record.watchdog_pid } });

  const signal: NodeJS.Signals = body.force ? "SIGKILL" : "SIGTERM";

  try {
    process.kill(record.pid, signal);
  } catch (e) {
    writeAudit({ ts: new Date().toISOString(), event: "stop_failed", pid: record.pid, reason: (e as Error).message });
    return NextResponse.json({ ok: false, reason: `kill_failed: ${(e as Error).message}` }, { status: 500 });
  }

  // Also stop watchdog if we spawned it
  if (record.watchdog_pid && isProcessAlive(record.watchdog_pid)) {
    try { process.kill(record.watchdog_pid, "SIGTERM"); } catch { /* noop */ }
  }

  // Wait graceful (SIGTERM only)
  if (!body.force) {
    const deadline = Date.now() + GRACEFUL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!isProcessAlive(record.pid)) break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (isProcessAlive(record.pid)) {
      // Escalate
      try { process.kill(record.pid, "SIGKILL"); } catch { /* noop */ }
      writeAudit({ ts: new Date().toISOString(), event: "stop_success", pid: record.pid, reason: "sigkill_after_timeout" });
    } else {
      writeAudit({ ts: new Date().toISOString(), event: "stop_success", pid: record.pid, reason: "sigterm_clean" });
    }
  } else {
    writeAudit({ ts: new Date().toISOString(), event: "stop_success", pid: record.pid, reason: "sigkill_forced" });
  }

  clearPid();
  return NextResponse.json({ ok: true, pid: record.pid });
}
