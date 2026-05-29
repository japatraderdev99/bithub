// cockpit-tail.test.mjs — H-COCKPIT-MVP-001.
//
// Sidecar that reads structured monitor exports (state.json +
// events.jsonl). Tests cover sanitization, schema validation, partial
// line handling, truncation detection, and the public start/snapshot/poll API.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sanitize,
  start,
  stop,
  snapshot,
  poll,
  isPathSafe,
} from "../scripts/cockpit-tail.mjs";

function now() {
  return Date.now() / 1000;
}

function goodSnap(overrides = {}) {
  return {
    schema_version: 1,
    ts: now(),
    monitor_version: "v4",
    ws_status: "connected",
    t1_last: now() - 30,
    slots_used: 1,
    slots_max: 4,
    balance: { total_usdt: 100, free_usdt: 60 },
    positions: { NEAR: { symbol: "NEAR", side: "short", entry: 1.52, pnl_pct: 1.2 } },
    candidates: [{ symbol: "BTCUSDT", direction: "short", ts: now() - 30 }],
    t2_analysis: {},
    alerts: [],
    ...overrides,
  };
}

function makeFiles() {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-tail-"));
  return {
    dir,
    statePath: join(dir, "state.json"),
    eventsPath: join(dir, "events.jsonl"),
  };
}

function atomicWrite(path, obj) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, path);
}

function appendEvent(path, ev) {
  appendFileSync(path, JSON.stringify(ev) + "\n");
}

// --------------------------------------------------------------------------
// sanitize
// --------------------------------------------------------------------------

test("sanitize strips top-level credential keys", () => {
  const out = sanitize({ api_key: "x", symbol: "BTC", ts: 1.0 });
  assert.equal("api_key" in out, false);
  assert.equal(out.symbol, "BTC");
});

test("sanitize strips nested credential keys", () => {
  const out = sanitize({ positions: { NEAR: { symbol: "NEAR", secret_token: "leak", side: "short" } } });
  assert.equal("secret_token" in out.positions.NEAR, false);
  assert.equal(out.positions.NEAR.side, "short");
});

test("sanitize strips credentials inside lists", () => {
  const out = sanitize({ events: [{ api_key: "x", type: "ENTRY" }, { token: "y", type: "EXIT" }] });
  assert.equal(out.events.length, 2);
  assert.equal("api_key" in out.events[0], false);
  assert.equal("token" in out.events[1], false);
});

test("sanitize preserves keys that only resemble credentials (secretary)", () => {
  const out = sanitize({ secretary: "Alice", secret_word: "redacted" });
  assert.equal(out.secretary, "Alice");
  assert.equal("secret_word" in out, false);
});

test("sanitize passes through primitives", () => {
  assert.equal(sanitize(42), 42);
  assert.equal(sanitize("foo"), "foo");
  assert.equal(sanitize(null), null);
  assert.equal(sanitize(true), true);
});

// --------------------------------------------------------------------------
// start/snapshot — happy path
// --------------------------------------------------------------------------

test("start+snapshot reads a valid state file", () => {
  const { statePath, eventsPath } = makeFiles();
  atomicWrite(statePath, goodSnap());
  const handle = start({ statePath, eventsPath, pollMs: 60000 });
  try {
    const snap = snapshot(handle);
    assert.equal(snap.state.positions.NEAR.symbol, "NEAR");
    assert.equal(snap.system.state_path_exists, true);
    assert.equal(snap.system.state_error, null);
  } finally {
    stop(handle);
  }
});

test("snapshot does NOT expose absolute filesystem paths", () => {
  const { statePath, eventsPath } = makeFiles();
  atomicWrite(statePath, goodSnap());
  const handle = start({ statePath, eventsPath, pollMs: 60000 });
  try {
    const snap = snapshot(handle);
    // Codex review finding #1: paths must not leak through the API.
    assert.equal("state_path" in snap.system, false);
    assert.equal("events_path" in snap.system, false);
    // The system block still carries booleans, ages, errors, offsets.
    assert.equal(typeof snap.system.state_path_exists, "boolean");
    assert.equal(typeof snap.system.events_path_exists, "boolean");
    // Belt and braces: serialize the whole snapshot and confirm no
    // absolute-looking strings leak through nested fields either.
    const serialized = JSON.stringify(snap);
    assert.ok(!serialized.includes(statePath));
    assert.ok(!serialized.includes(eventsPath));
    // Also defend against any "/Users/" or "/tmp/" string fragments
    // ending up in the response (the test dirs live under /var/folders/
    // on macOS, so we check the realpath fragment too).
    assert.ok(!/\/Users\/[^"]+\.(json|jsonl)/.test(serialized));
  } finally {
    stop(handle);
  }
});

test("snapshot strips credential keys from state", () => {
  const { statePath, eventsPath } = makeFiles();
  const bad = goodSnap();
  bad.api_key = "leak";
  bad.positions.NEAR.secret = "x";
  atomicWrite(statePath, bad);
  const handle = start({ statePath, eventsPath, pollMs: 60000 });
  try {
    const snap = snapshot(handle);
    assert.equal("api_key" in snap.state, false);
    assert.equal("secret" in snap.state.positions.NEAR, false);
  } finally {
    stop(handle);
  }
});

test("start+snapshot reads events incrementally", () => {
  const { statePath, eventsPath } = makeFiles();
  atomicWrite(statePath, goodSnap());
  appendEvent(eventsPath, { schema_version: 1, ts: now(), type: "ENTRY", symbol: "NEAR", detail: {} });
  const handle = start({ statePath, eventsPath, pollMs: 60000 });
  try {
    let snap = snapshot(handle);
    assert.equal(snap.recentEvents.length, 1);
    appendEvent(eventsPath, { schema_version: 1, ts: now(), type: "TRAIL", symbol: "NEAR", detail: {} });
    poll(handle);
    snap = snapshot(handle);
    assert.equal(snap.recentEvents.length, 2);
    assert.equal(snap.recentEvents[1].type, "TRAIL");
  } finally {
    stop(handle);
  }
});

// --------------------------------------------------------------------------
// snapshot — degraded paths
// --------------------------------------------------------------------------

test("snapshot returns null state when files are missing", () => {
  const { statePath, eventsPath } = makeFiles();
  const handle = start({ statePath, eventsPath, pollMs: 60000 });
  try {
    const snap = snapshot(handle);
    assert.equal(snap.state, null);
    assert.equal(snap.recentEvents.length, 0);
    assert.equal(snap.system.state_path_exists, false);
  } finally {
    stop(handle);
  }
});

test("snapshot exposes state_error when JSON is malformed", () => {
  const { statePath, eventsPath } = makeFiles();
  writeFileSync(statePath, "{not json");
  const handle = start({ statePath, eventsPath, pollMs: 60000 });
  try {
    const snap = snapshot(handle);
    assert.equal(snap.state, null);
    assert.ok(typeof snap.system.state_error === "string");
    assert.ok(snap.system.state_error.toLowerCase().includes("parse"));
  } finally {
    stop(handle);
  }
});

test("snapshot rejects unknown schema_version", () => {
  const { statePath, eventsPath } = makeFiles();
  const bad = goodSnap();
  bad.schema_version = 99;
  atomicWrite(statePath, bad);
  const handle = start({ statePath, eventsPath, pollMs: 60000 });
  try {
    const snap = snapshot(handle);
    assert.equal(snap.state, null);
    assert.ok(snap.system.state_error.toLowerCase().includes("schema_version"));
  } finally {
    stop(handle);
  }
});

test("malformed event lines are skipped, good lines are kept", () => {
  const { statePath, eventsPath } = makeFiles();
  atomicWrite(statePath, goodSnap());
  appendFileSync(eventsPath, "not-json\n");
  appendEvent(eventsPath, { schema_version: 1, ts: now(), type: "ENTRY", symbol: "NEAR", detail: {} });
  appendFileSync(eventsPath, "{broken\n");
  const handle = start({ statePath, eventsPath, pollMs: 60000 });
  try {
    const snap = snapshot(handle);
    assert.equal(snap.recentEvents.length, 1);
    assert.equal(snap.recentEvents[0].type, "ENTRY");
    assert.ok(snap.system.events_errors_recent.length >= 2);
  } finally {
    stop(handle);
  }
});

test("schema-mismatch events are skipped", () => {
  const { statePath, eventsPath } = makeFiles();
  atomicWrite(statePath, goodSnap());
  appendEvent(eventsPath, { schema_version: 99, ts: now(), type: "ENTRY", symbol: "NEAR", detail: {} });
  appendEvent(eventsPath, { schema_version: 1, ts: now(), type: "TRAIL", symbol: "NEAR", detail: {} });
  const handle = start({ statePath, eventsPath, pollMs: 60000 });
  try {
    const snap = snapshot(handle);
    assert.equal(snap.recentEvents.length, 1);
    assert.equal(snap.recentEvents[0].type, "TRAIL");
  } finally {
    stop(handle);
  }
});

test("partial trailing line is left unconsumed and read next poll", () => {
  const { statePath, eventsPath } = makeFiles();
  appendEvent(eventsPath, { schema_version: 1, ts: now(), type: "ENTRY", symbol: "NEAR", detail: {} });
  // Now append a partial line (no \n)
  appendFileSync(eventsPath, '{"schema_version":1,"ts":');
  const handle = start({ statePath, eventsPath, pollMs: 60000 });
  try {
    let snap = snapshot(handle);
    assert.equal(snap.recentEvents.length, 1);
    // Finish the partial line
    appendFileSync(
      eventsPath,
      `${now()},"type":"TRAIL","symbol":"NEAR","detail":{}}\n`
    );
    poll(handle);
    snap = snapshot(handle);
    assert.equal(snap.recentEvents.length, 2);
    assert.equal(snap.recentEvents[1].type, "TRAIL");
  } finally {
    stop(handle);
  }
});

// --------------------------------------------------------------------------
// truncation
// --------------------------------------------------------------------------

test("truncation by unlink+recreate resets recent buffer", () => {
  const { statePath, eventsPath } = makeFiles();
  appendEvent(eventsPath, { schema_version: 1, ts: now(), type: "ENTRY", symbol: "NEAR", detail: {} });
  const handle = start({ statePath, eventsPath, pollMs: 60000 });
  try {
    let snap = snapshot(handle);
    assert.equal(snap.recentEvents.length, 1);
    unlinkSync(eventsPath);
    appendEvent(eventsPath, { schema_version: 1, ts: now(), type: "TRAIL", symbol: "NEAR", detail: {} });
    poll(handle);
    snap = snapshot(handle);
    assert.equal(snap.recentEvents.length, 1);
    assert.equal(snap.recentEvents[0].type, "TRAIL");
  } finally {
    stop(handle);
  }
});

// --------------------------------------------------------------------------
// public API hygiene
// --------------------------------------------------------------------------

test("stop is idempotent and survives multiple calls", () => {
  const { statePath, eventsPath } = makeFiles();
  const handle = start({ statePath, eventsPath, pollMs: 60000 });
  stop(handle);
  stop(handle);
  assert.equal(handle.stopped, true);
});

test("stop on null handle does not throw", () => {
  stop(null);
  stop(undefined);
});

test("snapshot on null handle returns safe defaults", () => {
  const snap = snapshot(null);
  assert.equal(snap.state, null);
  assert.deepEqual(snap.recentEvents, []);
  assert.equal(snap.system, null);
});

test("poll never throws on missing files", () => {
  const { statePath, eventsPath } = makeFiles();
  const handle = start({ statePath, eventsPath, pollMs: 60000 });
  try {
    // First poll already ran; trigger another with no files written
    poll(handle);
    const snap = snapshot(handle);
    assert.equal(snap.state, null);
  } finally {
    stop(handle);
  }
});

// --------------------------------------------------------------------------
// path safety (Codex review finding #3)
// --------------------------------------------------------------------------

test("isPathSafe rejects vault, /etc, ssh, keychains, aws, gnupg", () => {
  assert.equal(isPathSafe("/Users/x/bithub-vault/secrets.json"), false);
  assert.equal(isPathSafe("/etc/passwd"), false);
  assert.equal(isPathSafe("/private/etc/hosts"), false);
  assert.equal(isPathSafe("/Users/x/.ssh/id_rsa"), false);
  assert.equal(isPathSafe("/Library/Keychains/login.keychain-db"), false);
  assert.equal(isPathSafe("/Users/x/.aws/credentials"), false);
  assert.equal(isPathSafe("/Users/x/.gnupg/pubring.kbx"), false);
});

test("isPathSafe accepts non-existent /tmp paths (monitor will create)", () => {
  assert.equal(isPathSafe("/tmp/bithub_monitor_state.json"), true);
  assert.equal(isPathSafe("/tmp/does_not_exist_yet.jsonl"), true);
});

test("isPathSafe rejects empty/non-string inputs", () => {
  assert.equal(isPathSafe(""), false);
  assert.equal(isPathSafe(null), false);
  assert.equal(isPathSafe(undefined), false);
  assert.equal(isPathSafe(42), false);
});

test("isPathSafe rejects existing directory paths", () => {
  assert.equal(isPathSafe("/tmp"), false);
});

test("start throws when statePath is under bithub-vault", () => {
  assert.throws(
    () => start({
      statePath: "/Users/x/bithub-vault/state.json",
      eventsPath: "/tmp/ok.jsonl",
      pollMs: 60000,
    }),
    /statePath rejected by safety policy/
  );
});

test("start throws when eventsPath is under /etc", () => {
  assert.throws(
    () => start({
      statePath: "/tmp/ok.json",
      eventsPath: "/etc/passwd",
      pollMs: 60000,
    }),
    /eventsPath rejected by safety policy/
  );
});

test("recentEvents buffer is bounded", () => {
  // Spam events past the cap; we should keep only the tail.
  const { statePath, eventsPath } = makeFiles();
  for (let i = 0; i < 600; i++) {
    appendEvent(eventsPath, {
      schema_version: 1, ts: now() + i * 0.001, type: "T1_SCAN", symbol: "SYSTEM", detail: { i },
    });
  }
  const handle = start({ statePath, eventsPath, pollMs: 60000 });
  try {
    const snap = snapshot(handle);
    assert.equal(snap.recentEvents.length, 500); // MAX_RECENT_EVENTS
    // Should be the LAST 500 (oldest 100 dropped)
    assert.equal(snap.recentEvents[snap.recentEvents.length - 1].detail.i, 599);
  } finally {
    stop(handle);
  }
});
