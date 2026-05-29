// launcher-state.ts — H-LAUNCHER-MONITOR-CONTROL-001
//
// Filesystem-backed state for the local launcher API:
//   - PID file: ~/.bithub-monitor/launcher-monitor.pid (atomic write)
//   - Audit log: ~/.bithub-monitor/launcher.jsonl (append-only)
//   - WebAuthn creds: ~/.bithub-monitor/launcher-credentials.json
//
// Bound to localhost only (Next.js dev) — no remote exposure. Audit log
// is append-only and never returns PII or credentials in API responses.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, renameSync, mkdirSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const STATE_DIR = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");
const PID_FILE = join(STATE_DIR, "launcher-monitor.pid");
const AUDIT_LOG = join(STATE_DIR, "launcher.jsonl");
const CREDS_FILE = join(STATE_DIR, "launcher-credentials.json");
const LOCK_FILE = join(STATE_DIR, "launcher.lock");
const MONITOR_PROCESS_PATTERN = "monitor_all.py";
const WATCHDOG_PROCESS_PATTERN = "monitor-watchdog.mjs";

function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

export type LauncherEventType =
  | "preflight_ok"
  | "preflight_fail"
  | "start_initiated"
  | "start_success"
  | "start_failed"
  | "stop_initiated"
  | "stop_success"
  | "stop_failed"
  | "auth_register"
  | "auth_challenge"
  | "auth_verify_ok"
  | "auth_verify_fail";

export interface LauncherEvent {
  ts: string;
  event: LauncherEventType;
  actor?: string;
  pid?: number;
  preset?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export function writeAudit(event: LauncherEvent): void {
  try {
    ensureStateDir();
    const line = JSON.stringify({ ...event, ts: event.ts ?? new Date().toISOString() });
    appendFileSync(AUDIT_LOG, line + "\n", { encoding: "utf-8" });
  } catch (e) {
    // never throw from audit; log fallback to stderr
    console.error("[launcher-state] audit write failed:", (e as Error).message);
  }
}

export function readRecentAudit(limit = 100): LauncherEvent[] {
  if (!existsSync(AUDIT_LOG)) return [];
  try {
    const raw = readFileSync(AUDIT_LOG, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try { return JSON.parse(l) as LauncherEvent; } catch { return null; }
      })
      .filter((x): x is LauncherEvent => x !== null);
  } catch {
    return [];
  }
}

// --- PID file -------------------------------------------------------------

export interface PidRecord {
  pid: number;
  started_at: string;
  preset: string;
  config_snapshot: Record<string, unknown>;
  watchdog_pid?: number | null;
}

export function writePid(record: PidRecord): void {
  ensureStateDir();
  const tmp = join(tmpdir(), `launcher-pid-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(record), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, PID_FILE);
}

export function readPid(): PidRecord | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf-8")) as PidRecord;
  } catch {
    return null;
  }
}

export function clearPid(): void {
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch { /* noop */ }
}

/** Returns true if a process with the given PID currently exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 = check without actually sending
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // EPERM means process exists but we don't have permission
    return err.code === "EPERM";
  }
}

export async function withLauncherLock<T>(fn: () => Promise<T>): Promise<T> {
  ensureStateDir();
  let fd: number | null = null;
  try {
    fd = openSync(LOCK_FILE, "wx", 0o600);
  } catch {
    throw new Error("launcher_busy");
  }
  try {
    return await fn();
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* noop */ }
    }
    try { unlinkSync(LOCK_FILE); } catch { /* noop */ }
  }
}

export interface MonitorProcess {
  pid: number;
  command: string;
}

export function findMonitorProcesses(): MonitorProcess[] {
  const result = spawnSync("pgrep", ["-fl", MONITOR_PROCESS_PATTERN], { encoding: "utf-8" });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pidRaw, ...rest] = line.split(/\s+/);
      return { pid: Number(pidRaw), command: rest.join(" ") };
    })
    .filter((p) => Number.isInteger(p.pid) && p.pid > 0);
}

export function findWatchdogProcesses(): MonitorProcess[] {
  const result = spawnSync("pgrep", ["-fl", WATCHDOG_PROCESS_PATTERN], { encoding: "utf-8" });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pidRaw, ...rest] = line.split(/\s+/);
      return { pid: Number(pidRaw), command: rest.join(" ") };
    })
    .filter((p) => Number.isInteger(p.pid) && p.pid > 0);
}

// --- WebAuthn credentials store ------------------------------------------

export interface StoredCredential {
  credentialID: string;       // base64url
  publicKey: string;           // base64url
  counter: number;
  transports?: string[];
  created_at: string;
  label: string;               // operator-friendly label
}

interface CredStoreFile {
  rpId: string;                // expected origin host
  credentials: StoredCredential[];
  registrationChallenge?: { value: string; expires_at: number };
  authChallenge?: { value: string; expires_at: number };
  intentToken?: { value: string; expires_at: number };
}

export function readCredStore(): CredStoreFile {
  if (!existsSync(CREDS_FILE)) {
    return { rpId: "localhost", credentials: [] };
  }
  try {
    return JSON.parse(readFileSync(CREDS_FILE, "utf-8")) as CredStoreFile;
  } catch {
    return { rpId: "localhost", credentials: [] };
  }
}

export function writeCredStore(store: CredStoreFile): void {
  ensureStateDir();
  const tmp = join(tmpdir(), `launcher-creds-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, CREDS_FILE);
}

/** Mint and persist a base64url challenge with TTL (default 60s). */
export function mintChallenge(purpose: "register" | "verify", ttlMs = 60_000): string {
  const value = randomBytes(32).toString("base64url");
  const store = readCredStore();
  const challenge = { value, expires_at: Date.now() + ttlMs };
  if (purpose === "register") store.registrationChallenge = challenge;
  else store.authChallenge = challenge;
  writeCredStore(store);
  return value;
}

export function consumeChallenge(expectedPurpose: "register" | "verify"): string | null {
  const store = readCredStore();
  const ch = expectedPurpose === "register" ? store.registrationChallenge : store.authChallenge;
  if (!ch) return null;
  if (ch.expires_at < Date.now()) {
    if (expectedPurpose === "register") delete store.registrationChallenge;
    else delete store.authChallenge;
    writeCredStore(store);
    return null;
  }
  const value = ch.value;
  if (expectedPurpose === "register") delete store.registrationChallenge;
  else delete store.authChallenge;
  writeCredStore(store);
  return value;
}

// --- Preset configs -------------------------------------------------------

export interface PresetConfig {
  name: string;
  risk_pct: number;
  max_leverage: number;
  max_slots: number;
  description: string;
}

export const PRESETS: Record<string, PresetConfig> = {
  aggressive: {
    name: "Aggressive",
    risk_pct: 0.40,
    max_leverage: 50,
    max_slots: 3,
    description: "Configuração atual do exec_bybit. Risco máximo, capital pequeno.",
  },
  overnight: {
    name: "Overnight (sleep-safe)",
    risk_pct: 0.20,
    max_leverage: 20,
    max_slots: 2,
    description: "Recomendado para operação não-supervisionada. Menos volatilidade.",
  },
  conservative: {
    name: "Conservative",
    risk_pct: 0.10,
    max_leverage: 10,
    max_slots: 1,
    description: "Teste mínimo. Aprendizado sem risco material.",
  },
};

/**
 * NOTE: presets are *informative* in the UI. Actually applying them requires
 * editing `exec_bybit.py` which is owned by another Claude / operator. For
 * the launcher MVP we only RECORD which preset the operator selected at
 * start time so audit log captures intent; actual params come from whatever
 * is in disk when monitor starts.
 */

// --- Intent token (single-use, short-lived, gates start/stop) -------------
// Minted by WebAuthn verify, consumed by start/stop endpoints. Single-slot
// scratchpad in the cred store keeps everything in one file under 0o600.

export function mintIntentToken(): { token: string; expires_at: number } {
  const token = randomBytes(24).toString("base64url");
  const expires_at = Date.now() + 30_000;
  const store = readCredStore();
  store.intentToken = { value: token, expires_at };
  writeCredStore(store);
  return { token, expires_at };
}

export function consumeIntentToken(token: string): boolean {
  const store = readCredStore();
  if (!store.intentToken) return false;
  if (store.intentToken.expires_at < Date.now()) {
    delete store.intentToken;
    writeCredStore(store);
    return false;
  }
  if (store.intentToken.value !== token) return false;
  delete store.intentToken;
  writeCredStore(store);
  return true;
}
