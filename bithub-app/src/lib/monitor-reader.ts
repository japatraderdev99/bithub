// monitor-reader — reads JSON snapshots written by the Freqtrade-side
// bithub_state_publisher into ~/.bithub-monitor/.
//
// Defense-in-depth: every payload is run through a credential sweep
// (same regex family as Phase 1 cockpit-tail) before being returned to
// the client. The publisher is supposed to never write credentials,
// but if a regression slips through, the API route refuses to serve.

import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR =
  process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");

export const SNAPSHOTS = {
  positions: "positions.json",
  candidates: "candidates.json",
  system: "system.json",
  events: "events.jsonl",
} as const;

// Mirror of Phase 1 cockpit sanitizer regex.
const SENSITIVE_KEY = /(?:^|_)(?:api_?key|secret|password|passphrase|token|signature|private_key|priv_key|bearer|auth|cookie|session_id)(?:_|$)/i;

const SENSITIVE_VALUE_PATTERNS = [
  /\bcfat_[A-Za-z0-9_-]{20,}\b/,
  /\b(?:sk|pk)_(?:live|test|prod)_[A-Za-z0-9]{20,}\b/,
  /(?:^|[^A-Za-z0-9])api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]{16,}['"]/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

export interface CredentialFinding {
  path: string;
  kind: "key" | "value";
}

export function sweepCredentials(payload: unknown, basePath = "$"): CredentialFinding[] {
  const findings: CredentialFinding[] = [];
  walk(payload, basePath, findings);
  return findings;
}

function walk(value: unknown, path: string, out: CredentialFinding[]) {
  if (out.length >= 25) return;
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, out));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = `${path}.${k}`;
      if (typeof k === "string" && SENSITIVE_KEY.test(k)) {
        out.push({ path: child, kind: "key" });
      }
      walk(v, child, out);
    }
    return;
  }
  if (typeof value === "string" && value.length >= 12) {
    for (const rx of SENSITIVE_VALUE_PATTERNS) {
      if (rx.test(value)) {
        out.push({ path, kind: "value" });
        return;
      }
    }
  }
}

export class PublisherOfflineError extends Error {
  constructor(public state_dir: string, public reason: string) {
    super(reason);
    this.name = "PublisherOfflineError";
  }
}

export class CredentialLeakError extends Error {
  constructor(public findings: CredentialFinding[]) {
    super(`refuse to serve — ${findings.length} credential-shaped fields detected`);
    this.name = "CredentialLeakError";
  }
}

export async function readSnapshot<T>(filename: string): Promise<{ data: T; age_ms: number }> {
  if (!existsSync(STATE_DIR)) {
    throw new PublisherOfflineError(STATE_DIR, "state directory does not exist yet");
  }
  const path = join(STATE_DIR, filename);
  if (!existsSync(path)) {
    throw new PublisherOfflineError(STATE_DIR, `snapshot ${filename} not yet written`);
  }
  const st = await stat(path);
  const age_ms = Date.now() - st.mtimeMs;
  const raw = await readFile(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new PublisherOfflineError(STATE_DIR, `snapshot ${filename} is not valid JSON: ${(e as Error).message}`);
  }
  const findings = sweepCredentials(parsed);
  if (findings.length > 0) {
    throw new CredentialLeakError(findings);
  }
  return { data: parsed as T, age_ms };
}

export async function readEvents(limit = 100): Promise<{ events: unknown[]; age_ms: number }> {
  const path = join(STATE_DIR, SNAPSHOTS.events);
  if (!existsSync(STATE_DIR) || !existsSync(path)) {
    throw new PublisherOfflineError(STATE_DIR, "events.jsonl not yet written");
  }
  const st = await stat(path);
  const age_ms = Date.now() - st.mtimeMs;
  const raw = await readFile(path, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  const tail = lines.slice(-limit);
  const events: unknown[] = [];
  for (const line of tail) {
    try {
      const obj = JSON.parse(line);
      const findings = sweepCredentials(obj);
      if (findings.length > 0) {
        throw new CredentialLeakError(findings);
      }
      events.push(obj);
    } catch (e) {
      if (e instanceof CredentialLeakError) throw e;
      // skip malformed lines silently — append-only files can have a partial last line
    }
  }
  return { events, age_ms };
}

export function publisherStateDir(): string {
  return STATE_DIR;
}
