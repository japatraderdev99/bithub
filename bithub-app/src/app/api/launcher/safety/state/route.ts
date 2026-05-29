import { NextResponse } from "next/server";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const dynamic = "force-dynamic";

const STATE_DIR = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");

function readJsonFile<T>(filename: string): { ok: boolean; data?: T; mtime?: string; reason?: string } {
  const path = join(STATE_DIR, filename);
  if (!existsSync(path)) return { ok: false, reason: "missing" };
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as T;
    const mtime = statSync(path).mtime.toISOString();
    return { ok: true, data, mtime };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

function readPlainFile(filename: string): { exists: boolean; mtime?: string; size?: number } {
  const path = join(STATE_DIR, filename);
  if (!existsSync(path)) return { exists: false };
  const stat = statSync(path);
  return { exists: true, mtime: stat.mtime.toISOString(), size: stat.size };
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    as_of: new Date().toISOString(),
    state_dir: STATE_DIR,
    kill_switch: readJsonFile("kill_switch.json"),
    rate_limit: readJsonFile("rate_limit.json"),
    cooldowns: readJsonFile("cooldowns.json"),
    // system.json é fonte do balance; sua freshness diz se publisher (monitor)
    // está vivo. Watchdog não escreve state JSON — sua liveness é o próprio
    // arquivo de log. Aqui registramos só freshness do system.json como proxy
    // do "monitor heartbeat".
    monitor_heartbeat: readJsonFile("system.json"),
  });
}
