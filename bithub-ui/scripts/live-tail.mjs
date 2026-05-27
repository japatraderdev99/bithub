// live-tail.mjs — sidecar local que tail /tmp/monitor_test.log + le JSON state.
//
// Local-only, read-only, opt-in via env var BITHUB_LIVE_TAIL_LOG.
//
// API publica:
//   start({ logPath, stateDir, capacity? }) -> handle
//   stop(handle)
//   snapshot(handle) -> { positions, scanner, events, rawLines, startedAt }
//
// Sem deps. Node 22+. Defesa em profundidade: linhas com padroes
// sensiveis (api_key, Authorization, Bearer, secret=, password=, BYBIT_,
// cfat_) sao descartadas e nao entram no estado.
//
// Veja [[H-LIVE-CONSOLE-LOCAL-001]].

import { watch, statSync, readFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const EVENT_CAPACITY = 500;
const RAW_CAPACITY = 200;
const STATE_POLL_MS = 2000;

const SENSITIVE_PATTERNS = [
  /api[_-]?key\s*[=:]/i,
  /authorization\s*:/i,
  /bearer\s+/i,
  /\bsecret\s*[=:]/i,
  /\bpassword\s*[=:]/i,
  /\bBYBIT_[A-Z_]+\s*[=:]/,
  /\bcfat_[A-Za-z0-9]/,
  /\bjwt_secret/i,
];

export function isSensitive(line) {
  for (const re of SENSITIVE_PATTERNS) {
    if (re.test(line)) return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Parsers (cada um retorna evento ou null)
// --------------------------------------------------------------------------

const RX_BANNER = /^Monitor v\d+ \| T1: (.+?) \| T2: (.+?) \| (.+)$/;
const RX_STARTUP_POS = /^\[startup\]\s+📋\s+(\S+)\s+(LONG|SHORT)\s+carregada\s*\|\s*entry=([\d.]+)\s+SL=([\d.]+)\s+TP=([\d.]+)/;
const RX_WS_UP = /^\[ws-priv\]\s+✅\s+streams position\+order ativos/;
const RX_WS_AUTH = /^\[ws-priv\]\s+✅\s+auth OK/;
const RX_WS_DOWN = /^\[ws-priv\]\s+(keys ausentes|falha ao iniciar|❌)/;
const RX_WS_CLOSE = /^\[ws-priv\]\s+🏁\s+(\S+)\s+fechada/;
const RX_WS_STOP = /^\[ws-priv\]\s+⚡\s+(\S+)\s+(StopLoss|TakeProfit|Limit|Market)\s+filled/i;
const RX_POSITION_TICK = /^\[(\d{2}:\d{2}:\d{2})\]\s+📊\s+(\S+)\s+(LONG|SHORT)\s+\|\s+price=([\d.]+)\s+PnL=([+-][\d.]+)%\s+best=([+-][\d.]+)%\s+\|\s+SL=([\d.]+)\s+TP=([\d.]+)\s+EMA9=([\d.]+)\s+mom=(\S+)/;
const RX_SCANNER_T1 = /^\[(\d{2}:\d{2}:\d{2})\]\s+🔍\s+T1 scan top-(\d+)/;
const RX_SCANNER_T1_RESULT = /^T1\s+→\s+(\d+)\s+candidatos/;
const RX_ENTRY = /^🚀\s+ENTRADA\s+\|\s+(\S+)\s+(LONG|SHORT)\s+SCORE=(\d+)/;
const RX_SCORE_LOW = /^📉\s+SCORE BAIXO/;
const RX_NEAR_MISS = /^⏳\s+near-miss T2:\s+(\S+)\s+\[falta:([^\]]+)\]/;
const RX_TAPE_OK = /^\[(\S+)\]\s+✅\s+tape confirmou:\s+favor=(\d+)%/;
const RX_TAPE_REJECT = /^\[(\S+)\]\s+❌\s+tape rejeitou/;
const RX_EXECUTE = /^🔴\s+EXECUTANDO\s+(\S+)\s+(LONG|SHORT)\s+\|\s+margin=\$?([\d.]+)\s+lev=(\d+)x\s+notional=\$?([\d.]+).*?slots=(\d+)\/(\d+)/;
const RX_SLTP_ATTACHED = /^\[SL\/TP\]\s+anexados via trading-stop/;
const RX_TRAIL_UPDATE = /^📉\s+(\S+)\s+TRAIL\s+→/;

const TIME_RX = /^\[(\d{2}:\d{2}:\d{2})\]/;

function toIsoFromHHMMSS(hhmmss, refDate) {
  const d = refDate || new Date();
  const [h, m, s] = hhmmss.split(":").map(Number);
  const out = new Date(d);
  out.setHours(h, m, s, 0);
  // Heuristica: se HH:MM:SS no futuro >2h, assume dia anterior.
  if (out.getTime() - d.getTime() > 2 * 60 * 60 * 1000) {
    out.setDate(out.getDate() - 1);
  }
  return out.toISOString();
}

export function parseLine(line, nowFactory) {
  const now = (nowFactory || (() => new Date()))();
  const stripped = line.replace(/\s+$/, "");
  if (stripped.length === 0) return null;

  if (isSensitive(stripped)) {
    return { ts: now.toISOString(), kind: "redacted", data: {} };
  }

  let m;

  m = stripped.match(RX_POSITION_TICK);
  if (m) {
    return {
      ts: toIsoFromHHMMSS(m[1], now),
      kind: "position_tick",
      data: {
        symbol: m[2],
        dir: m[3],
        price: Number(m[4]),
        pnl_pct: Number(m[5]),
        best_pct: Number(m[6]),
        sl: Number(m[7]),
        tp: Number(m[8]),
        ema9: Number(m[9]),
        mom: m[10],
      },
    };
  }

  m = stripped.match(RX_SCANNER_T1);
  if (m) {
    return {
      ts: toIsoFromHHMMSS(m[1], now),
      kind: "scanner_t1",
      data: { top_n: Number(m[2]) },
    };
  }

  m = stripped.match(RX_SCANNER_T1_RESULT);
  if (m) {
    return { ts: now.toISOString(), kind: "scanner_t1_result", data: { candidates: Number(m[1]) } };
  }

  m = stripped.match(RX_ENTRY);
  if (m) {
    return {
      ts: now.toISOString(),
      kind: "entry",
      data: { tag: m[1], dir: m[2], score: Number(m[3]) },
    };
  }

  if (RX_SCORE_LOW.test(stripped)) {
    return { ts: now.toISOString(), kind: "score_low", data: {} };
  }

  m = stripped.match(RX_NEAR_MISS);
  if (m) {
    return {
      ts: now.toISOString(),
      kind: "near_miss",
      data: { symbol: m[1], missing: m[2] },
    };
  }

  m = stripped.match(RX_TAPE_OK);
  if (m) {
    return {
      ts: now.toISOString(),
      kind: "tape_ok",
      data: { tag: m[1], favor_pct: Number(m[2]) },
    };
  }

  m = stripped.match(RX_TAPE_REJECT);
  if (m) {
    return { ts: now.toISOString(), kind: "tape_reject", data: { tag: m[1] } };
  }

  m = stripped.match(RX_EXECUTE);
  if (m) {
    return {
      ts: now.toISOString(),
      kind: "execute",
      data: {
        tag: m[1],
        dir: m[2],
        margin: Number(m[3]),
        lev: Number(m[4]),
        notional: Number(m[5]),
        slots_used: Number(m[6]),
        slots_max: Number(m[7]),
      },
    };
  }

  if (RX_SLTP_ATTACHED.test(stripped)) {
    return { ts: now.toISOString(), kind: "sltp_attached", data: {} };
  }

  m = stripped.match(RX_TRAIL_UPDATE);
  if (m) {
    return { ts: now.toISOString(), kind: "trail_update", data: { symbol: m[1] } };
  }

  m = stripped.match(RX_STARTUP_POS);
  if (m) {
    return {
      ts: now.toISOString(),
      kind: "position_load",
      data: {
        symbol: m[1],
        dir: m[2],
        entry: Number(m[3]),
        sl: Number(m[4]),
        tp: Number(m[5]),
      },
    };
  }

  if (RX_WS_UP.test(stripped) || RX_WS_AUTH.test(stripped)) {
    return { ts: now.toISOString(), kind: "ws_status", data: { up: true } };
  }

  if (RX_WS_DOWN.test(stripped)) {
    return { ts: now.toISOString(), kind: "ws_status", data: { up: false } };
  }

  m = stripped.match(RX_WS_CLOSE);
  if (m) {
    return {
      ts: now.toISOString(),
      kind: "position_close",
      data: { symbol: m[1] },
    };
  }

  m = stripped.match(RX_WS_STOP);
  if (m) {
    return {
      ts: now.toISOString(),
      kind: "stop_fill",
      data: { symbol: m[1], fill_type: m[2] },
    };
  }

  if (RX_BANNER.test(stripped)) {
    return { ts: now.toISOString(), kind: "banner", data: { line: stripped } };
  }

  return { ts: now.toISOString(), kind: "raw", data: { line: stripped } };
}

// --------------------------------------------------------------------------
// Estado em memoria
// --------------------------------------------------------------------------

export function createState({ capacity } = {}) {
  return {
    positions: new Map(),    // symbol -> {symbol, dir, entry?, sl, tp, price, pnl_pct, best_pct, ema9, mom, updated_at}
    scanner: {
      t1_last_ts: null,
      t1_top_n: null,
      t2_last_ts: null,
      ws_status: "unknown",  // "up" | "down" | "unknown"
      last_candidates_count: null,
      slots_used: null,
      slots_max: null,
    },
    events: [],
    rawLines: [],
    eventCapacity: (capacity && capacity.events) || EVENT_CAPACITY,
    rawCapacity: (capacity && capacity.raw) || RAW_CAPACITY,
    startedAt: null,
  };
}

export function applyEvent(state, ev, rawLine) {
  if (state.startedAt === null) state.startedAt = ev.ts;

  if (ev.kind === "redacted") {
    // nunca expor: nem em events nem em raw.
    return;
  }

  // raw buffer (todas linhas nao-sensiveis vao parar aqui)
  if (typeof rawLine === "string" && rawLine.length > 0) {
    state.rawLines.push({ ts: ev.ts, line: rawLine });
    if (state.rawLines.length > state.rawCapacity) {
      state.rawLines.splice(0, state.rawLines.length - state.rawCapacity);
    }
  }

  switch (ev.kind) {
    case "position_load": {
      const p = ev.data;
      state.positions.set(p.symbol, {
        symbol: p.symbol,
        dir: p.dir,
        entry: p.entry,
        sl: p.sl,
        tp: p.tp,
        price: null,
        pnl_pct: null,
        best_pct: null,
        ema9: null,
        mom: null,
        updated_at: ev.ts,
      });
      break;
    }
    case "position_tick": {
      const p = ev.data;
      const prev = state.positions.get(p.symbol) || {};
      state.positions.set(p.symbol, {
        symbol: p.symbol,
        dir: p.dir,
        entry: prev.entry ?? null,
        sl: p.sl,
        tp: p.tp,
        price: p.price,
        pnl_pct: p.pnl_pct,
        best_pct: p.best_pct,
        ema9: p.ema9,
        mom: p.mom,
        updated_at: ev.ts,
      });
      break;
    }
    case "position_close": {
      state.positions.delete(ev.data.symbol);
      break;
    }
    case "stop_fill": {
      // tambem trata como fechamento defensivo
      state.positions.delete(ev.data.symbol);
      break;
    }
    case "ws_status": {
      state.scanner.ws_status = ev.data.up ? "up" : "down";
      break;
    }
    case "scanner_t1": {
      state.scanner.t1_last_ts = ev.ts;
      state.scanner.t1_top_n = ev.data.top_n;
      break;
    }
    case "scanner_t1_result": {
      state.scanner.last_candidates_count = ev.data.candidates;
      break;
    }
    case "execute": {
      state.scanner.slots_used = ev.data.slots_used;
      state.scanner.slots_max = ev.data.slots_max;
      break;
    }
    default:
      break;
  }

  // adicionar a feed de eventos (excluindo banner e raw puros pra nao poluir)
  const FEED_KINDS = new Set([
    "position_load",
    "position_close",
    "stop_fill",
    "ws_status",
    "scanner_t1_result",
    "entry",
    "score_low",
    "near_miss",
    "tape_ok",
    "tape_reject",
    "execute",
    "sltp_attached",
    "trail_update",
  ]);
  if (FEED_KINDS.has(ev.kind)) {
    state.events.push(ev);
    if (state.events.length > state.eventCapacity) {
      state.events.splice(0, state.events.length - state.eventCapacity);
    }
  }
}

// --------------------------------------------------------------------------
// JSON state files (scalper_positions.json, scanner_state.json)
// --------------------------------------------------------------------------

export function readJsonStateSafe(path) {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    if (raw.trim().length === 0) return null;
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

export function mergeScalperPositions(state, scalperPositions) {
  if (!scalperPositions || typeof scalperPositions !== "object") return;
  for (const [symbol, info] of Object.entries(scalperPositions)) {
    if (!info || typeof info !== "object") continue;
    const dir = info.dir || (typeof info === "string" ? info : null);
    if (!dir) continue;
    const existing = state.positions.get(symbol) || {};
    state.positions.set(symbol, {
      symbol,
      dir,
      entry: existing.entry ?? info.entry ?? null,
      sl: existing.sl ?? info.stop ?? null,
      tp: existing.tp ?? null,
      price: existing.price ?? null,
      pnl_pct: existing.pnl_pct ?? null,
      best_pct: existing.best_pct ?? null,
      ema9: existing.ema9 ?? null,
      mom: existing.mom ?? null,
      updated_at: existing.updated_at ?? new Date().toISOString(),
    });
  }
}

// --------------------------------------------------------------------------
// Watcher de log (tail incremental)
// --------------------------------------------------------------------------

function readFromOffset(path, offset) {
  // Le do offset ate o final. Retorna { newOffset, content }.
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (_err) {
    return { newOffset: offset, content: "" };
  }
  try {
    const stat = statSync(path);
    const size = stat.size;
    if (size < offset) {
      // arquivo truncado/rotacionado, reseta
      offset = 0;
    }
    if (size === offset) {
      return { newOffset: offset, content: "" };
    }
    const len = size - offset;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    return { newOffset: size, content: buf.toString("utf8") };
  } finally {
    try { closeSync(fd); } catch (_e) { /* ignore */ }
  }
}

// --------------------------------------------------------------------------
// Path safety
// --------------------------------------------------------------------------

const FORBIDDEN_FRAGMENTS = ["bithub-vault", "/etc/", "/private/etc/", "/.ssh/", "/Library/Keychains/"];

export function isPathSafe(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  const abs = resolve(path);
  for (const frag of FORBIDDEN_FRAGMENTS) {
    if (abs.includes(frag)) return false;
  }
  try {
    const s = statSync(abs);
    if (!s.isFile()) return false;
  } catch (_err) {
    // arquivo pode nao existir ainda — aceita (caller checa de novo no read)
    return true;
  }
  return true;
}

// --------------------------------------------------------------------------
// start / stop / snapshot
// --------------------------------------------------------------------------

export function start({ logPath, stateDir, capacity, nowFactory } = {}) {
  if (!logPath) {
    throw new Error("logPath required");
  }
  if (!isPathSafe(logPath)) {
    throw new Error(`logPath rejected by safety policy: ${logPath}`);
  }
  const state = createState({ capacity });
  let offset = 0;
  let leftover = "";
  let stopped = false;

  function ingest() {
    if (stopped) return;
    const { newOffset, content } = readFromOffset(logPath, offset);
    offset = newOffset;
    if (content.length === 0) return;
    const combined = leftover + content;
    const lines = combined.split("\n");
    leftover = lines.pop() || "";
    for (const line of lines) {
      if (line.length === 0) continue;
      const ev = parseLine(line, nowFactory);
      if (ev) {
        // ev.kind === "redacted" eh aplicado pra ja nao expor; mas nao loga raw.
        applyEvent(state, ev, ev.kind === "redacted" ? null : line);
      }
    }
  }

  function pollState() {
    if (stopped || !stateDir) return;
    const posPath = join(stateDir, "scalper_positions.json");
    const scalperPositions = readJsonStateSafe(posPath);
    if (scalperPositions) {
      mergeScalperPositions(state, scalperPositions);
    }
  }

  // ingest inicial (no caso de log ja existir com conteudo)
  ingest();
  pollState();

  let watcher = null;
  try {
    if (existsSync(logPath)) {
      watcher = watch(logPath, () => ingest());
    }
  } catch (_err) {
    watcher = null;
  }

  // fallback periodico caso watch nao dispare (NFS, etc.) + poll state files
  const interval = setInterval(() => {
    ingest();
    pollState();
  }, STATE_POLL_MS);

  return {
    state,
    stop() {
      stopped = true;
      if (watcher) { try { watcher.close(); } catch (_e) { /* ignore */ } }
      clearInterval(interval);
    },
  };
}

export function snapshot(handle) {
  if (!handle || !handle.state) return null;
  const s = handle.state;
  return {
    positions: Array.from(s.positions.values()),
    scanner: { ...s.scanner },
    events: s.events.slice(),
    rawLines: s.rawLines.slice(),
    startedAt: s.startedAt,
  };
}
