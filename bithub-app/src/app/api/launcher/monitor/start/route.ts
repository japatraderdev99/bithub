import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  consumeIntentToken,
  findMonitorProcesses,
  isProcessAlive,
  readPid,
  writeAudit,
  writePid,
  PRESETS,
  withLauncherLock,
} from "@/lib/launcher-state";

export const dynamic = "force-dynamic";

const FREQTRADE_DIR = "/Users/gabrielcasarin/Documents/Project Trading Agora Vai/freqtrade";
const BITHUB_ENV = "/Users/gabrielcasarin/Documents/Bithub Project/.env";
const STATE_DIR = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");
const BITHUB_APP_DIR = "/Users/gabrielcasarin/Documents/Bithub Project/bithub-app";
// Concat at runtime to avoid Turbopack treating it as a static import path
function watchdogScriptPath(): string {
  return [BITHUB_APP_DIR, "scripts", "monitor-watchdog.mjs"].join("/");
}

interface StartBody {
  intent_token: string;
  preset?: string;
  spawn_watchdog?: boolean;
  watchdog_autorestart?: boolean;
}

export async function POST(request: Request) {
  let body: StartBody;
  try { body = (await request.json()) as StartBody; } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }
  try {
    return await withLauncherLock(async () => startLocked(body));
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "launcher_busy" ? 409 : 500;
    return NextResponse.json({ ok: false, reason: msg }, { status });
  }
}

async function startLocked(body: StartBody) {
  if (!body.intent_token) {
    return NextResponse.json({ ok: false, reason: "missing_intent_token" }, { status: 401 });
  }
  if (!consumeIntentToken(body.intent_token)) {
    writeAudit({ ts: new Date().toISOString(), event: "start_failed", reason: "intent_token_invalid_or_expired" });
    return NextResponse.json({ ok: false, reason: "intent_token_invalid_or_expired" }, { status: 401 });
  }

  // Double-check no other monitor running (concurrent start protection)
  const runningProcesses = findMonitorProcesses();
  if (runningProcesses.length > 0) {
    writeAudit({
      ts: new Date().toISOString(),
      event: "start_failed",
      reason: "monitor_process_already_running",
      details: { pids: runningProcesses.map((p) => p.pid) },
    });
    return NextResponse.json({
      ok: false,
      reason: "monitor_process_already_running",
      pids: runningProcesses.map((p) => p.pid),
    }, { status: 409 });
  }
  const existing = readPid();
  if (existing && isProcessAlive(existing.pid)) {
    writeAudit({ ts: new Date().toISOString(), event: "start_failed", reason: "already_running", pid: existing.pid });
    return NextResponse.json({ ok: false, reason: "monitor_already_running", pid: existing.pid }, { status: 409 });
  }

  const presetName = body.preset ?? "overnight";
  const preset = PRESETS[presetName];
  if (!preset) {
    return NextResponse.json({ ok: false, reason: `unknown_preset:${presetName}` }, { status: 400 });
  }

  writeAudit({
    ts: new Date().toISOString(),
    event: "start_initiated",
    preset: presetName,
    details: { config: preset, watchdog: !!body.spawn_watchdog, autorestart: !!body.watchdog_autorestart },
  });

  // The actual command: run python with same env shape the operator uses
  // manually. We do NOT load .env via shell because the file may contain
  // secrets that don't need to live in the spawned process group's env
  // dump — keep it tight.
  if (!existsSync(`${FREQTRADE_DIR}/user_data/monitor_all.py`)) {
    writeAudit({ ts: new Date().toISOString(), event: "start_failed", reason: "monitor_py_missing" });
    return NextResponse.json({ ok: false, reason: "monitor_py_missing" }, { status: 500 });
  }
  if (!existsSync(BITHUB_ENV)) {
    writeAudit({ ts: new Date().toISOString(), event: "start_failed", reason: "env_missing" });
    return NextResponse.json({ ok: false, reason: "env_missing" }, { status: 500 });
  }

  // Build child env: only the publisher-related vars from .env plus monitor's
  // own bybit_keys.json (which is read by bybit_common.py within Freqtrade).
  const envSubset = await readEnvVarsFromFile(BITHUB_ENV, [
    "BITHUB_WORKER_URL",
    "BITHUB_INGEST_TOKEN",
  ]);
  const childEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? homedir(),
    USER: process.env.USER ?? "gabrielcasarin",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "gabrielcasarin",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ...envSubset,
    BITHUB_STATE_DIR: STATE_DIR,
    PYTHONUNBUFFERED: "1",
  };

  const stdoutLog = join(STATE_DIR, "monitor.log");
  const out = openSync(stdoutLog, "a", 0o600);

  let child: ChildProcess;
  try {
    child = spawn("python3", ["user_data/monitor_all.py"], {
      cwd: FREQTRADE_DIR,
      env: childEnv as unknown as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", out, out] as StdioOptions,
    });
  } catch (e) {
    writeAudit({ ts: new Date().toISOString(), event: "start_failed", reason: (e as Error).message });
    return NextResponse.json({ ok: false, reason: `spawn_failed: ${(e as Error).message}` }, { status: 500 });
  }

  child.unref();

  if (!child.pid) {
    writeAudit({ ts: new Date().toISOString(), event: "start_failed", reason: "no_pid_returned" });
    return NextResponse.json({ ok: false, reason: "no_pid_returned" }, { status: 500 });
  }

  // Optionally spawn watchdog as well
  let watchdog_pid: number | null = null;
  if (body.spawn_watchdog !== false) {
    try {
      if (existsSync(watchdogScriptPath())) {
        const wdOut = openSync(join(STATE_DIR, "watchdog.log"), "a", 0o600);
        const wdEnv: Record<string, string> = { ...childEnv };
        if (body.watchdog_autorestart !== false) wdEnv.WATCHDOG_AUTORESTART = "1";
        const wdChild = spawn("node", [watchdogScriptPath()], {
          cwd: BITHUB_APP_DIR,
          env: wdEnv as unknown as NodeJS.ProcessEnv,
          detached: true,
          stdio: ["ignore", wdOut, wdOut] as StdioOptions,
        });
        wdChild.unref();
        watchdog_pid = wdChild.pid ?? null;
      }
    } catch {
      // watchdog is best-effort; do not fail the start
    }
  }

  writePid({
    pid: child.pid,
    started_at: new Date().toISOString(),
    preset: presetName,
    config_snapshot: { ...preset, spawn_watchdog: !!body.spawn_watchdog },
    watchdog_pid,
  });

  writeAudit({
    ts: new Date().toISOString(),
    event: "start_success",
    pid: child.pid,
    preset: presetName,
    details: { watchdog_pid },
  });

  return NextResponse.json({ ok: true, pid: child.pid, watchdog_pid, preset: presetName });
}

async function readEnvVarsFromFile(path: string, names: string[]): Promise<Record<string, string>> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path, "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m && names.includes(m[1])) {
        out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
      }
    }
    return out;
  } catch {
    return {};
  }
}
