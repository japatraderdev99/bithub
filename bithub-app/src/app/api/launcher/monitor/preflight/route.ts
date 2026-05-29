import { NextResponse } from "next/server";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findMonitorProcesses, isProcessAlive, readPid } from "@/lib/launcher-state";

export const dynamic = "force-dynamic";

// Hardcoded paths from the operator's env. These must NOT come from the
// request — never allow remote control of which python/file is spawned.
const FREQTRADE_DIR = "/Users/gabrielcasarin/Documents/Project Trading Agora Vai/freqtrade";
const MONITOR_PY = `${FREQTRADE_DIR}/user_data/monitor_all.py`;
const BYBIT_KEYS = `${FREQTRADE_DIR}/user_data/bybit_keys.json`;
const BITHUB_ENV = "/Users/gabrielcasarin/Documents/Bithub Project/.env";
const STATE_DIR = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");
const WORKER_HEALTH =
  process.env.BITHUB_WORKER_URL ??
  "https://bithub-trades-api.guiydantas.workers.dev";

interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
  blocking: boolean;
}

async function workerHealthy(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${WORKER_HEALTH}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, reason: `worker /health returned ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

function bybitKeysValid(): { ok: boolean; reason?: string } {
  if (!existsSync(BYBIT_KEYS)) return { ok: false, reason: "bybit_keys.json missing" };
  try {
    const data = JSON.parse(readFileSync(BYBIT_KEYS, "utf-8"));
    if (!data.apiKey || !data.secret) return { ok: false, reason: "missing apiKey or secret" };
    if (typeof data.apiKey !== "string" || typeof data.secret !== "string") {
      return { ok: false, reason: "apiKey/secret must be strings" };
    }
    if (data.apiKey.length < 10 || data.secret.length < 20) {
      return { ok: false, reason: "apiKey/secret look truncated" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `JSON invalid: ${(e as Error).message}` };
  }
}

function envValid(): { ok: boolean; reason?: string } {
  if (!existsSync(BITHUB_ENV)) return { ok: false, reason: ".env missing" };
  try {
    const raw = readFileSync(BITHUB_ENV, "utf-8");
    const hasIngest = /^BITHUB_INGEST_TOKEN=.+/m.test(raw);
    const hasWorker = /^BITHUB_WORKER_URL=.+/m.test(raw);
    if (!hasIngest) return { ok: false, reason: "BITHUB_INGEST_TOKEN missing in .env" };
    if (!hasWorker) return { ok: false, reason: "BITHUB_WORKER_URL missing in .env" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

function monitorExists(): boolean {
  return existsSync(MONITOR_PY);
}

function noStaleMonitor(): { ok: boolean; reason?: string } {
  const processes = findMonitorProcesses();
  if (processes.length > 0) {
    return {
      ok: false,
      reason: `monitor already running as PID ${processes.map((p) => p.pid).join(", ")}`,
    };
  }
  const rec = readPid();
  if (!rec) return { ok: true };
  if (isProcessAlive(rec.pid)) {
    return { ok: false, reason: `monitor already running as PID ${rec.pid} (started ${rec.started_at})` };
  }
  // stale PID file; not blocking — start will overwrite it
  return { ok: true };
}

function balanceSnapshot(): { ok: boolean; balance_usdt?: number; open_count?: number; as_of?: string } {
  const path = join(STATE_DIR, "system.json");
  if (!existsSync(path)) return { ok: false };
  try {
    const sys = JSON.parse(readFileSync(path, "utf-8"));
    const positions = (() => {
      try {
        const p = JSON.parse(readFileSync(join(STATE_DIR, "positions.json"), "utf-8"));
        return p.open_count ?? 0;
      } catch { return 0; }
    })();
    const ageS = (Date.now() - statSync(path).mtimeMs) / 1000;
    return {
      ok: true,
      balance_usdt: sys.balance_usdt,
      open_count: positions,
      as_of: `${ageS.toFixed(0)}s ago`,
    };
  } catch {
    return { ok: false };
  }
}

export async function GET() {
  const checks: Check[] = [];

  const env = envValid();
  checks.push({ id: "env", label: ".env do Bithub presente + tokens", ok: env.ok, detail: env.reason, blocking: true });

  const keys = bybitKeysValid();
  checks.push({ id: "bybit_keys", label: "bybit_keys.json válido", ok: keys.ok, detail: keys.reason, blocking: true });

  checks.push({ id: "monitor_py", label: "monitor_all.py existe", ok: monitorExists(), blocking: true });

  const worker = await workerHealthy();
  checks.push({ id: "worker", label: "Cloudflare Worker /health", ok: worker.ok, detail: worker.reason, blocking: false });

  const noStale = noStaleMonitor();
  checks.push({ id: "no_running", label: "Nenhum monitor já rodando", ok: noStale.ok, detail: noStale.reason, blocking: true });

  const bal = balanceSnapshot();
  const balanceCheck: Check = bal.ok
    ? { id: "balance", label: `Saldo Bybit conhecido: $${bal.balance_usdt?.toFixed(2)}`, ok: true, detail: `${bal.open_count} posições abertas · last snap ${bal.as_of}`, blocking: false }
    : { id: "balance", label: "Saldo Bybit último snapshot", ok: false, detail: "system.json não disponível — monitor nunca rodou ou state limpo", blocking: false };
  checks.push(balanceCheck);

  const allBlockingPass = checks.filter((c) => c.blocking).every((c) => c.ok);

  return NextResponse.json({
    ok: allBlockingPass,
    checks,
    snapshot: bal.ok ? { balance_usdt: bal.balance_usdt, open_count: bal.open_count } : null,
    presets_available: ["aggressive", "overnight", "conservative"],
  });
}
