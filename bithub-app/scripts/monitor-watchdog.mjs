#!/usr/bin/env node
// monitor-watchdog.mjs — H-OVERNIGHT-READINESS-001 Gate 4
//
// Roda continuamente em background. A cada `TICK_SECONDS` (default 30s):
//
//   1. Checa monitor_all.py process (pgrep). Down → alerta.
//   2. Checa freshness de ~/.bithub-monitor/system.json (mtime < STALE_SECONDS).
//   3. Checa pending queue ~/.bithub-monitor/pending_ingest.jsonl.
//      Se > PENDING_THRESHOLD entries há > PENDING_MAX_AGE_SEC → alerta.
//   4. Checa Worker /health (timeout 5s). 3 falhas seguidas → alerta.
//
// Cada tipo de alerta é "debounced" — não spamma se condição persiste; envia
// um quando entra em estado bad e outro quando recupera ("recovered" alert).
//
// Canais de alerta (escolhidos automaticamente):
//   - macOS notification (osascript), sempre presente
//   - Telegram bot, se TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID setados em env
//   - stdout log estruturado (audit trail)
//
// Auto-restart do monitor é OPT-IN via env WATCHDOG_AUTORESTART=1. Default
// é só alerta (operador decide reiniciar). Sleep-safe = auto-restart on.
//
// Uso:
//   node bithub-app/scripts/monitor-watchdog.mjs
//   # ou em background:
//   nohup node bithub-app/scripts/monitor-watchdog.mjs > /tmp/watchdog.log 2>&1 &

import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config (env-tunable)
// ---------------------------------------------------------------------------

const TICK_SECONDS = parseInt(process.env.WATCHDOG_TICK ?? "30", 10);
const STALE_SECONDS = parseInt(process.env.WATCHDOG_STALE ?? "60", 10);
const PENDING_THRESHOLD = parseInt(process.env.WATCHDOG_PENDING_MAX ?? "100", 10);
const PENDING_MAX_AGE_SEC = parseInt(process.env.WATCHDOG_PENDING_MAX_AGE ?? "300", 10);
const HEALTH_URL =
  process.env.WATCHDOG_HEALTH_URL ??
  "https://bithub-trades-api.guiydantas.workers.dev/health";
const STATE_DIR = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");
const MONITOR_PATTERN = process.env.WATCHDOG_MONITOR_PATTERN ?? "monitor_all.py";
const AUTORESTART = process.env.WATCHDOG_AUTORESTART === "1";
const RESTART_GRACE_SECONDS = parseInt(process.env.WATCHDOG_RESTART_GRACE ?? "90", 10);
const MONITOR_RESTART_CMD =
  process.env.WATCHDOG_RESTART_CMD ??
  `cd "/Users/gabrielcasarin/Documents/Project Trading Agora Vai/freqtrade" && set -a && source "/Users/gabrielcasarin/Documents/Bithub Project/.env" && set +a && export BITHUB_STATE_DIR="${STATE_DIR}" && nohup python3 user_data/monitor_all.py > /tmp/monitor.log 2>&1 &`;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// ---------------------------------------------------------------------------
// State (in-process)
// ---------------------------------------------------------------------------

const state = {
  monitor: { down: false, downSince: null },
  stateFile: { stale: false, lastFresh: Date.now() },
  pending: { high: false, highSince: null },
  health: { down: false, failedTicks: 0 },
  consecutiveErrors: 0,
};

// ---------------------------------------------------------------------------
// Alert channels
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function logEvent(level, kind, msg) {
  // structured stdout for audit trail / log forwarders
  console.log(JSON.stringify({ ts: nowIso(), level, kind, msg }));
}

function notifyMac(title, msg) {
  // osascript is built-in on macOS; no install needed
  try {
    spawnSync("osascript", [
      "-e",
      `display notification "${msg.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`,
    ]);
  } catch {
    // best-effort; never throw
  }
}

async function notifyTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text,
        parse_mode: "Markdown",
        disable_notification: false,
      }),
    });
  } catch (e) {
    logEvent("error", "telegram", `failed: ${e.message}`);
  }
}

async function alert(level, kind, title, msg) {
  logEvent(level, kind, msg);
  notifyMac(title, msg);
  await notifyTelegram(`*[${level.toUpperCase()}] ${title}*\n${msg}\n_${nowIso()}_`);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkMonitorAlive() {
  const result = spawnSync("pgrep", ["-f", MONITOR_PATTERN]);
  return result.status === 0;
}

function checkStateFileFresh() {
  const path = join(STATE_DIR, "system.json");
  if (!existsSync(path)) return false;
  const st = statSync(path);
  const ageMs = Date.now() - st.mtimeMs;
  return ageMs < STALE_SECONDS * 1000;
}

function checkPendingQueue() {
  const path = join(STATE_DIR, "pending_ingest.jsonl");
  if (!existsSync(path)) return { count: 0, age_seconds: 0 };
  const st = statSync(path);
  if (st.size === 0) return { count: 0, age_seconds: 0 };
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const ageSec = (Date.now() - st.mtimeMs) / 1000;
  return { count: lines.length, age_seconds: ageSec };
}

async function checkWorkerHealth() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(HEALTH_URL, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

function attemptRestartMonitor() {
  if (!AUTORESTART) {
    logEvent("warn", "restart", "auto-restart disabled (set WATCHDOG_AUTORESTART=1 to enable)");
    return;
  }
  logEvent("info", "restart", "attempting to restart monitor");
  try {
    const child = spawn("zsh", ["-c", MONITOR_RESTART_CMD], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    logEvent("info", "restart", "restart command spawned");
  } catch (e) {
    logEvent("error", "restart", `restart failed: ${e.message}`);
  }
}

function monitorDownAgeSeconds() {
  if (!state.monitor.downSince) return 0;
  return Math.round((Date.now() - Date.parse(state.monitor.downSince)) / 1000);
}

// ---------------------------------------------------------------------------
// Tick (main loop)
// ---------------------------------------------------------------------------

async function tick() {
  // 1) Monitor process
  const monAlive = checkMonitorAlive();
  if (!monAlive && !state.monitor.down) {
    state.monitor.down = true;
    state.monitor.downSince = nowIso();
    await alert("error", "monitor.down",
      "🛑 Monitor v4 OFFLINE",
      `Process matching "${MONITOR_PATTERN}" not running. Posições com SL/TP nativo seguem protegidas, mas trail/partial pararam.`);
    logEvent("warn", "restart.waiting",
      `auto-restart waiting for ${RESTART_GRACE_SECONDS}s grace before restart attempt`);
  } else if (!monAlive && state.monitor.down && monitorDownAgeSeconds() >= RESTART_GRACE_SECONDS) {
    attemptRestartMonitor();
    state.monitor.downSince = nowIso();
  } else if (monAlive && state.monitor.down) {
    state.monitor.down = false;
    const since = state.monitor.downSince;
    state.monitor.downSince = null;
    await alert("info", "monitor.recovered",
      "✅ Monitor v4 RECUPERADO",
      `Process voltou. Estava down desde ${since}.`);
  }

  // 2) State file freshness (only meaningful if monitor alive)
  if (monAlive) {
    const fresh = checkStateFileFresh();
    if (!fresh && !state.stateFile.stale) {
      state.stateFile.stale = true;
      await alert("warn", "state.stale",
        "⚠️ system.json STALE",
        `Publisher pode estar travado. Última atualização > ${STALE_SECONDS}s.`);
    } else if (fresh && state.stateFile.stale) {
      state.stateFile.stale = false;
      await alert("info", "state.recovered",
        "✅ Publisher voltou",
        `system.json fresh novamente.`);
    }
  }

  // 3) Pending queue
  const pq = checkPendingQueue();
  const pqBad = pq.count > PENDING_THRESHOLD && pq.age_seconds > PENDING_MAX_AGE_SEC;
  if (pqBad && !state.pending.high) {
    state.pending.high = true;
    state.pending.highSince = nowIso();
    await alert("warn", "pending.high",
      "⚠️ Pending queue cresceu",
      `${pq.count} payloads em pending_ingest.jsonl há ${Math.round(pq.age_seconds)}s. Cloud sync com problema.`);
  } else if (!pqBad && state.pending.high) {
    state.pending.high = false;
    await alert("info", "pending.recovered",
      "✅ Pending queue drenou",
      `Queue agora com ${pq.count} entries.`);
  }

  // 4) Worker health (3 strikes)
  const healthOk = await checkWorkerHealth();
  if (!healthOk) {
    state.health.failedTicks++;
    if (state.health.failedTicks >= 3 && !state.health.down) {
      state.health.down = true;
      await alert("error", "worker.down",
        "🛑 Worker D1 OFFLINE",
        `Worker ${HEALTH_URL} não responde há ${state.health.failedTicks} ticks. Histórico cloud parado.`);
    }
  } else {
    if (state.health.down) {
      state.health.down = false;
      await alert("info", "worker.recovered",
        "✅ Worker D1 OK",
        `${HEALTH_URL} respondendo normalmente.`);
    }
    state.health.failedTicks = 0;
  }

  // heartbeat to stdout (silent for monitoring infrastructure)
  logEvent("debug", "tick", JSON.stringify({
    monitor_alive: monAlive,
    state_fresh: monAlive ? checkStateFileFresh() : null,
    pending_count: pq.count,
    pending_age_s: Math.round(pq.age_seconds),
    worker_ok: healthOk,
  }));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  console.log(JSON.stringify({
    ts: nowIso(),
    level: "info",
    kind: "boot",
    msg: "watchdog up",
    config: {
      TICK_SECONDS,
      STALE_SECONDS,
      PENDING_THRESHOLD,
      PENDING_MAX_AGE_SEC,
      HEALTH_URL,
      STATE_DIR,
      MONITOR_PATTERN,
      AUTORESTART,
      RESTART_GRACE_SECONDS,
      telegram_enabled: !!(TG_TOKEN && TG_CHAT),
    },
  }));

  // Initial tick immediately, then schedule
  await tick().catch((e) => logEvent("error", "tick", e.message));
  setInterval(() => {
    tick().catch((e) => {
      state.consecutiveErrors++;
      logEvent("error", "tick", e.message);
      if (state.consecutiveErrors > 5) {
        logEvent("fatal", "watchdog", "too many consecutive errors, exiting");
        process.exit(1);
      }
    });
  }, TICK_SECONDS * 1000);

  // Graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      logEvent("info", "shutdown", `received ${sig}, exiting`);
      process.exit(0);
    });
  }
}

main().catch((e) => {
  console.error("watchdog crashed:", e);
  process.exit(1);
});
