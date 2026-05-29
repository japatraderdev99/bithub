// cockpit-tail.mjs — sidecar that reads structured monitor exports.
//
// Local-only, read-only, opt-in via env var BITHUB_COCKPIT_STATE.
//
// Differs from live-tail.mjs: live-tail parses textual monitor logs via
// regex. cockpit-tail reads the structured contract files produced by
// the monitor-export patch (Monitor-Export-Contract).
//
// Public API:
//   start({ statePath, eventsPath, pollMs? }) -> handle
//   stop(handle)
//   snapshot(handle) -> { state, recentEvents, system, startedAt }
//
// Zero deps. Node 22+. Sanitization is defensive — the Python publisher
// already sanitizes, the monitor patch already avoids forbidden keys,
// but the dev-server also strips credential-shaped keys before serving.
//
// See:
//   - [[Bithub-Cockpit-Architecture]]
//   - [[Monitor-Export-Contract]]
//   - [[H-COCKPIT-MVP-001]]

import { readFileSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_STATE_PATH = "/tmp/bithub_monitor_state.json";
const DEFAULT_EVENTS_PATH = "/tmp/bithub_monitor_events.jsonl";
const DEFAULT_POLL_MS = 2000;

const MAX_STATE_BYTES = 1_048_576;
const MAX_EVENT_LINE_BYTES = 16_384;
const MAX_RECENT_EVENTS = 500;
const MAX_INGEST_BYTES_PER_POLL = 4_194_304; // cap one poll at ~4 MB

const FORBIDDEN_KEY = /(?:^|_)(?:api_?key|secret|password|passphrase|token|signature|private_key|priv_key|bearer|auth|cookie|session_id)(?:_|$)/i;

// Mirrors live-tail.mjs path policy. We accept files under /tmp, /private/tmp
// (macOS-resolved /tmp), or under the operator's home dir, but never inside
// the Bithub vault, system dirs, or anywhere that would let the tail expose
// secrets/configs. Operators who need a non-default path own the override.
const FORBIDDEN_PATH_FRAGMENTS = [
  "bithub-vault",
  "/etc/",
  "/private/etc/",
  "/.ssh/",
  "/Library/Keychains/",
  "/.aws/",
  "/.gnupg/",
];

export function isPathSafe(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  let abs;
  try {
    abs = resolvePath(path);
  } catch (_err) {
    return false;
  }
  for (const frag of FORBIDDEN_PATH_FRAGMENTS) {
    if (abs.includes(frag)) return false;
  }
  try {
    const s = statSync(abs);
    if (!s.isFile()) return false;
  } catch (_err) {
    // File may not exist yet — monitor writes it on first cycle. We accept
    // the path now; the read paths re-check existence per poll.
    return true;
  }
  return true;
}

const MIN_VALID_TS = 1_735_689_600; // 2025-01-01T00:00:00Z
const FUTURE_SLACK_SECS = 3600;

export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      if (typeof k !== "string") continue;
      if (FORBIDDEN_KEY.test(k)) continue;
      out[k] = sanitize(value[k]);
    }
    return out;
  }
  return value;
}

function tsValid(ts, now = Date.now() / 1000) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
  return ts >= MIN_VALID_TS && ts <= now + FUTURE_SLACK_SECS;
}

function validateState(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "not a dict";
  if (data.schema_version !== 1) return `unknown schema_version ${data.schema_version}`;
  if (!tsValid(data.ts)) return `invalid ts ${data.ts}`;
  if (data.positions != null && (typeof data.positions !== "object" || Array.isArray(data.positions))) {
    return "positions not a dict";
  }
  if (data.candidates != null && !Array.isArray(data.candidates)) {
    return "candidates not a list";
  }
  return null;
}

function validateEvent(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "not a dict";
  if (data.schema_version !== 1) return `unknown schema_version ${data.schema_version}`;
  if (!tsValid(data.ts)) return `invalid ts ${data.ts}`;
  if (typeof data.type !== "string" || data.type.length === 0) return "missing type";
  if (typeof data.symbol !== "string" || data.symbol.length === 0) return "missing symbol";
  if (data.detail != null && (typeof data.detail !== "object" || Array.isArray(data.detail))) {
    return "detail not a dict";
  }
  return null;
}

// --------------------------------------------------------------------------
// Reading
// --------------------------------------------------------------------------

function readStateFile(path) {
  try {
    const info = statSync(path);
    if (info.size > MAX_STATE_BYTES) {
      return { state: null, error: `state file too large (${info.size} bytes)` };
    }
  } catch (_err) {
    return { state: null, error: null }; // file missing, not an error
  }
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { state: null, error: `state read failed: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { state: null, error: `state parse failed: ${err.message}` };
  }
  const reason = validateState(parsed);
  if (reason) return { state: null, error: `state invalid: ${reason}` };
  return { state: sanitize(parsed), error: null };
}

const FIRST_LINE_FP_MAX_BYTES = 16_384;

function readFirstLineFingerprint(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (_err) {
    return null;
  }
  let buf;
  let read = 0;
  try {
    buf = Buffer.alloc(FIRST_LINE_FP_MAX_BYTES);
    read = readSync(fd, buf, 0, FIRST_LINE_FP_MAX_BYTES, 0);
  } catch (_err) {
    return null;
  } finally {
    try { closeSync(fd); } catch (_e) { /* ignore */ }
  }
  if (read === 0) return null;
  const slice = buf.slice(0, read);
  const nl = slice.indexOf(0x0a);
  if (nl < 0) return null; // no complete first line yet
  const firstLine = slice.slice(0, nl + 1);
  return createHash("sha256").update(firstLine).digest("hex");
}

function readNewEventLines(path, lastOffset, lastInode, lastFingerprint) {
  let info;
  try {
    info = statSync(path);
  } catch (_err) {
    return {
      events: [], newOffset: lastOffset, truncated: false, errors: [],
      inode: null, fingerprint: null,
    };
  }
  const size = info.size;
  const currentInode = info.ino;
  const currentFp = readFirstLineFingerprint(path);

  const shrunk = size < lastOffset;
  const inodeChanged = lastInode != null && currentInode != null && currentInode !== lastInode;
  const fpChanged =
    lastFingerprint != null && currentFp != null && currentFp !== lastFingerprint;
  const truncated = shrunk || inodeChanged || fpChanged;
  const start = truncated ? 0 : lastOffset;

  if (size === start) {
    return {
      events: [], newOffset: start, truncated, errors: [],
      inode: currentInode, fingerprint: currentFp,
    };
  }
  const toRead = Math.min(MAX_INGEST_BYTES_PER_POLL, size - start);

  // Positional read via fd: avoids re-reading the whole file each poll.
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    return {
      events: [], newOffset: lastOffset, truncated,
      errors: [`events open failed: ${err.message}`],
      inode: currentInode, fingerprint: currentFp,
    };
  }
  let buf;
  let read = 0;
  try {
    buf = Buffer.alloc(toRead);
    read = readSync(fd, buf, 0, toRead, start);
  } catch (err) {
    return {
      events: [], newOffset: lastOffset, truncated,
      errors: [`events read failed: ${err.message}`],
      inode: currentInode, fingerprint: currentFp,
    };
  } finally {
    try { closeSync(fd); } catch (_e) { /* ignore */ }
  }
  const slice = buf.slice(0, read).toString("utf-8");
  const parsed = parseLines(slice, start, truncated);
  parsed.inode = currentInode;
  parsed.fingerprint = currentFp;
  return parsed;
}

function parseLines(slice, absoluteStart, truncated) {
  const events = [];
  const errors = [];
  let consumedTo = absoluteStart;
  let cursor = 0;
  while (cursor < slice.length) {
    const nl = slice.indexOf("\n", cursor);
    if (nl < 0) {
      // partial trailing line — not consumed yet
      break;
    }
    const line = slice.slice(cursor, nl);
    const lineStart = absoluteStart + cursor;
    cursor = nl + 1;
    consumedTo = absoluteStart + cursor;
    if (line.length === 0) continue;
    if (line.length > MAX_EVENT_LINE_BYTES) {
      errors.push(`events line ${lineStart} too large`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      errors.push(`events line ${lineStart} parse: ${err.message}`);
      continue;
    }
    const reason = validateEvent(parsed);
    if (reason) {
      errors.push(`events line ${lineStart} ${reason}`);
      continue;
    }
    events.push({ offset: lineStart, event: sanitize(parsed) });
  }
  return { events, newOffset: consumedTo, truncated, errors };
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export function start({ statePath, eventsPath, pollMs } = {}) {
  const sp = statePath || DEFAULT_STATE_PATH;
  const ep = eventsPath || DEFAULT_EVENTS_PATH;
  if (!isPathSafe(sp)) {
    throw new Error(`statePath rejected by safety policy: ${sp}`);
  }
  if (!isPathSafe(ep)) {
    throw new Error(`eventsPath rejected by safety policy: ${ep}`);
  }
  const handle = {
    statePath: sp,
    eventsPath: ep,
    pollMs: Math.max(250, Math.min(60_000, pollMs || DEFAULT_POLL_MS)),
    startedAt: new Date().toISOString(),
    state: null,
    stateError: null,
    stateUpdatedAt: null,
    recentEvents: [], // newest last
    eventsOffset: 0,
    eventsInode: null,
    eventsFingerprint: null,
    eventsErrors: [],
    pollErrors: 0,
    lastPollAt: null,
    timer: null,
    stopped: false,
  };
  poll(handle); // immediate first poll
  handle.timer = setInterval(() => poll(handle), handle.pollMs);
  // Don't keep Node alive solely because of this timer if the server shuts down.
  if (handle.timer && typeof handle.timer.unref === "function") handle.timer.unref();
  return handle;
}

export function stop(handle) {
  if (!handle) return;
  handle.stopped = true;
  if (handle.timer) {
    clearInterval(handle.timer);
    handle.timer = null;
  }
}

export function snapshot(handle) {
  if (!handle) {
    return { state: null, recentEvents: [], system: null, startedAt: null };
  }
  // System block carries booleans, ages, counts and errors. Absolute
  // filesystem paths are deliberately omitted: they would expose
  // operator-local structure to any browser/devtools/extension and add
  // nothing the operator cannot read off their own shell.
  return {
    state: handle.state,
    recentEvents: handle.recentEvents.slice(),
    system: {
      started_at: handle.startedAt,
      last_poll_at: handle.lastPollAt,
      state_error: handle.stateError,
      events_offset: handle.eventsOffset,
      events_errors_recent: handle.eventsErrors.slice(-10),
      poll_errors: handle.pollErrors,
      state_path_exists: existsSync(handle.statePath),
      events_path_exists: existsSync(handle.eventsPath),
      state_age_s:
        handle.state && typeof handle.state.ts === "number"
          ? Math.max(0, Date.now() / 1000 - handle.state.ts)
          : null,
    },
    startedAt: handle.startedAt,
  };
}

export function poll(handle) {
  if (!handle || handle.stopped) return;
  handle.lastPollAt = new Date().toISOString();
  try {
    const { state, error } = readStateFile(handle.statePath);
    if (state) {
      handle.state = state;
      handle.stateError = null;
      handle.stateUpdatedAt = new Date().toISOString();
    } else if (error) {
      handle.stateError = error;
    }
  } catch (err) {
    handle.pollErrors += 1;
    handle.stateError = `state pipeline crashed: ${err.message}`;
  }
  try {
    const result = readNewEventLines(
      handle.eventsPath,
      handle.eventsOffset,
      handle.eventsInode,
      handle.eventsFingerprint,
    );
    if (result.truncated) {
      handle.recentEvents = [];
      handle.eventsOffset = 0;
      const r2 = readNewEventLines(
        handle.eventsPath,
        0,
        result.inode,
        result.fingerprint,
      );
      ingestEvents(handle, r2);
    } else {
      ingestEvents(handle, result);
    }
  } catch (err) {
    handle.pollErrors += 1;
    handle.eventsErrors.push(`events crashed: ${err.message}`);
    if (handle.eventsErrors.length > 50) {
      handle.eventsErrors = handle.eventsErrors.slice(-50);
    }
  }
}

function ingestEvents(handle, result) {
  if (result.events && result.events.length > 0) {
    for (const item of result.events) {
      handle.recentEvents.push(item.event);
    }
    if (handle.recentEvents.length > MAX_RECENT_EVENTS) {
      handle.recentEvents = handle.recentEvents.slice(-MAX_RECENT_EVENTS);
    }
  }
  if (typeof result.newOffset === "number" && result.newOffset > handle.eventsOffset) {
    handle.eventsOffset = result.newOffset;
  }
  if (result.inode != null) {
    handle.eventsInode = result.inode;
  }
  if (result.fingerprint != null) {
    handle.eventsFingerprint = result.fingerprint;
  }
  if (result.errors && result.errors.length > 0) {
    for (const e of result.errors) handle.eventsErrors.push(e);
    if (handle.eventsErrors.length > 50) {
      handle.eventsErrors = handle.eventsErrors.slice(-50);
    }
  }
}
