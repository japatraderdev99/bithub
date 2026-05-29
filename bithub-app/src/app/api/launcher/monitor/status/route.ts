import { NextResponse } from "next/server";
import { findMonitorProcesses, findWatchdogProcesses, isProcessAlive, readPid, readRecentAudit, readCredStore } from "@/lib/launcher-state";

export const dynamic = "force-dynamic";

export async function GET() {
  const record = readPid();
  const alive = record ? isProcessAlive(record.pid) : false;
  const externalProcesses = findMonitorProcesses().filter((p) => p.pid !== record?.pid);
  const externalWatchdogs = findWatchdogProcesses().filter((p) => p.pid !== record?.watchdog_pid);
  const watchdog_alive = record?.watchdog_pid ? isProcessAlive(record.watchdog_pid) : externalWatchdogs.length > 0;
  const watchdog_pid = record?.watchdog_pid && isProcessAlive(record.watchdog_pid)
    ? record.watchdog_pid
    : externalWatchdogs[0]?.pid ?? null;
  const credStore = readCredStore();
  const credentialCount = credStore.credentials.length;

  return NextResponse.json({
    ok: true,
    running: alive,
    external_running: externalProcesses.length > 0,
    external_pids: externalProcesses.map((p) => p.pid),
    pid: alive && record ? record.pid : null,
    started_at: alive && record ? record.started_at : null,
    preset: alive && record ? record.preset : null,
    watchdog: {
      configured: !!record?.watchdog_pid || externalWatchdogs.length > 0,
      alive: watchdog_alive,
      pid: watchdog_alive ? watchdog_pid : null,
      external_pids: externalWatchdogs.map((p) => p.pid),
    },
    auth: { registered: credentialCount > 0, count: credentialCount },
    recent_audit: readRecentAudit(20),
  });
}
