// dev-server.mjs — Static + /v1/* offline.
//
// Servidor HTTP local, Node 22+, ESM puro, zero dependencia.
//
// - `/v1/*`  -> delega para `handleRequest(request)` importado do
//              Read Worker skeleton (bithub-read-worker/src/index.mjs).
//              Mesmo contrato HTTP, mesmos bytes; sem proxy externo.
// - Outras rotas -> serve arquivos estaticos de bithub-ui/public/.
//
// Regras:
// - Sem `.env`, sem `process.env.*` para secret, sem dependencia.
// - Sem cache agressivo (Cache-Control: no-store em arquivos estaticos
//   durante desenvolvimento; o Worker controla seu proprio Cache-Control).
// - Bind 127.0.0.1 por default (nao 0.0.0.0).
// - Sem traversal: paths sao normalizados e contidos em public/.
//
// CLI:
//   node bithub-ui/scripts/dev-server.mjs [--port 3000] [--host 127.0.0.1]

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { handleRequest } from "../../bithub-read-worker/src/index.mjs";
import { start as startLiveTail, snapshot as snapshotLiveTail } from "./live-tail.mjs";
import { start as startCockpitTail, snapshot as snapshotCockpitTail } from "./cockpit-tail.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = resolve(__dirname, "..", "public");

// --------------------------------------------------------------------------
// Live tail (opt-in via BITHUB_LIVE_TAIL_LOG env var)
// --------------------------------------------------------------------------

let liveTailHandle = null;
let liveTailError = null;

function maybeBootLiveTail() {
  const logPath = process.env.BITHUB_LIVE_TAIL_LOG;
  if (!logPath) return;
  const stateDir = process.env.BITHUB_LIVE_STATE_DIR || null;
  try {
    liveTailHandle = startLiveTail({ logPath, stateDir });
    // eslint-disable-next-line no-console
    console.log(`live-tail enabled: log=${logPath} state=${stateDir || "(none)"}`);
  } catch (err) {
    liveTailError = err && err.message ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`live-tail disabled: ${liveTailError}`);
  }
}

// --------------------------------------------------------------------------
// Cockpit tail (opt-in via BITHUB_COCKPIT_STATE env var)
// --------------------------------------------------------------------------

let cockpitTailHandle = null;
let cockpitTailError = null;

function maybeBootCockpitTail() {
  const statePath = process.env.BITHUB_COCKPIT_STATE;
  if (!statePath) return;
  const eventsPath = process.env.BITHUB_COCKPIT_EVENTS || null;
  try {
    cockpitTailHandle = startCockpitTail({ statePath, eventsPath: eventsPath || undefined });
    // eslint-disable-next-line no-console
    console.log(
      `cockpit-tail enabled: state=${statePath} events=${eventsPath || "(default)"}`
    );
  } catch (err) {
    cockpitTailError = err && err.message ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`cockpit-tail disabled: ${cockpitTailError}`);
  }
}

function jsonRes(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(buf);
}

function handleLiveRequest(req, res, path) {
  if (req.method !== "GET") {
    res.writeHead(405, {
      "Content-Type": "text/plain; charset=utf-8",
      "Allow": "GET",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end("method not allowed");
    return;
  }
  if (!liveTailHandle) {
    jsonRes(res, 503, {
      error: "live tail not enabled",
      hint: "set BITHUB_LIVE_TAIL_LOG and (optionally) BITHUB_LIVE_STATE_DIR before starting the dev-server",
      detail: liveTailError || null,
    });
    return;
  }
  const snap = snapshotLiveTail(liveTailHandle);

  if (path === "/live/positions") {
    jsonRes(res, 200, { positions: snap.positions, started_at: snap.startedAt });
    return;
  }
  if (path === "/live/scanner") {
    jsonRes(res, 200, { scanner: snap.scanner, started_at: snap.startedAt });
    return;
  }
  if (path === "/live/events") {
    const url = new URL(req.url, "http://localhost");
    const since = url.searchParams.get("since");
    const limit = Math.max(0, Math.min(500, Number(url.searchParams.get("limit") || 50)));
    let events = snap.events;
    if (since) {
      events = events.filter((e) => e.ts > since);
    }
    if (limit && events.length > limit) {
      events = events.slice(events.length - limit);
    }
    jsonRes(res, 200, { events });
    return;
  }
  if (path === "/live/raw") {
    const url = new URL(req.url, "http://localhost");
    const n = Math.max(0, Math.min(500, Number(url.searchParams.get("n") || 50)));
    const lines = n ? snap.rawLines.slice(-n) : snap.rawLines;
    jsonRes(res, 200, { lines });
    return;
  }
  jsonRes(res, 404, { error: "unknown live route" });
}

function isLivePath(path) {
  return path === "/live/positions"
    || path === "/live/scanner"
    || path === "/live/events"
    || path === "/live/raw";
}

function handleCockpitRequest(req, res, path) {
  if (req.method !== "GET") {
    res.writeHead(405, {
      "Content-Type": "text/plain; charset=utf-8",
      "Allow": "GET",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end("method not allowed");
    return;
  }
  if (!cockpitTailHandle) {
    jsonRes(res, 503, {
      error: "cockpit tail not enabled",
      hint:
        "set BITHUB_COCKPIT_STATE (and optionally BITHUB_COCKPIT_EVENTS) before starting dev-server; apply the monitor-export patch from bithub-vault/03-Design/monitor-export-patch.py to your monitor_all.py",
      detail: cockpitTailError || null,
    });
    return;
  }
  const snap = snapshotCockpitTail(cockpitTailHandle);

  if (path === "/cockpit/state") {
    jsonRes(res, 200, {
      state: snap.state,
      started_at: snap.startedAt,
      system: snap.system,
    });
    return;
  }
  if (path === "/cockpit/events") {
    const url = new URL(req.url, "http://localhost");
    const sinceRaw = url.searchParams.get("since");
    const since = sinceRaw == null ? null : Number(sinceRaw);
    const symbol = url.searchParams.get("symbol");
    const type = url.searchParams.get("type");
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 100)));
    let events = snap.recentEvents;
    if (since != null && Number.isFinite(since)) {
      events = events.filter((e) => typeof e.ts === "number" && e.ts > since);
    }
    if (symbol) {
      events = events.filter((e) => e.symbol === symbol);
    }
    if (type) {
      events = events.filter((e) => e.type === type);
    }
    if (events.length > limit) {
      events = events.slice(events.length - limit);
    }
    jsonRes(res, 200, { events });
    return;
  }
  if (path === "/cockpit/system") {
    jsonRes(res, 200, { system: snap.system, started_at: snap.startedAt });
    return;
  }
  jsonRes(res, 404, { error: "unknown cockpit route" });
}

function isCockpitPath(path) {
  return path.startsWith("/cockpit/");
}

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt":  "text/plain; charset=utf-8",
});

function mimeFor(path) {
  return MIME_TYPES[extname(path).toLowerCase()] || "application/octet-stream";
}

function resolvePublicPath(urlPath) {
  // Normalize and resolve, then ensure containment in PUBLIC_DIR.
  const trimmed = urlPath.split("?")[0].split("#")[0];
  let target = trimmed === "/" ? "/index.html" : trimmed;
  // Decode safely; if decode fails, treat as not-found later.
  try {
    target = decodeURIComponent(target);
  } catch (_err) {
    return null;
  }
  const cleaned = normalize(target).replace(/^[/\\]+/, "");
  const full = resolve(PUBLIC_DIR, cleaned);
  if (!full.startsWith(PUBLIC_DIR + sep) && full !== PUBLIC_DIR) {
    return null; // traversal attempt
  }
  return full;
}

async function serveStatic(req, res) {
  const target = resolvePublicPath(req.url);
  if (!target) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("bad request");
    return;
  }
  let info;
  try {
    info = await stat(target);
  } catch (_err) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  let path = target;
  if (info.isDirectory()) {
    path = join(target, "index.html");
    try {
      await stat(path);
    } catch (_err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
  }
  try {
    const buf = await readFile(path);
    res.writeHead(200, {
      "Content-Type": mimeFor(path),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(buf);
  } catch (_err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("read error");
  }
}

function isReadWorkerPath(path) {
  return path === "/v1/health"
    || path === "/v1/config/public"
    || path === "/v1/config/feature-flags"
    || path === "/v1/symbols"
    || path === "/v1/source-status"
    || path === "/v1/bundles/latest"
    || path.startsWith("/v1/blobs/bundle/")
    || path.startsWith("/v1/blobs/manifest/")
    || path.startsWith("/v1/"); // catch-all v1 -> let worker return read.error.v1
}

function nodeRequestToWebRequest(req) {
  const host = req.headers.host || "localhost";
  const proto = req.socket && req.socket.encrypted ? "https" : "http";
  const url = `${proto}://${host}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers.set(k, v.join(", "));
    else if (v !== undefined) headers.set(k, String(v));
  }
  return new Request(url, {
    method: req.method,
    headers,
    // GET/HEAD have no body; OPTIONS doesn't either in our preflight.
  });
}

async function writeWebResponse(res, webRes) {
  const headers = {};
  for (const [k, v] of webRes.headers.entries()) {
    headers[k] = v;
  }
  res.writeHead(webRes.status, headers);
  if (webRes.body === null || webRes.body === undefined) {
    res.end();
    return;
  }
  const buf = Buffer.from(await webRes.arrayBuffer());
  res.end(buf);
}

export async function handle(req, res) {
  const start = Date.now();
  const url = req.url || "/";
  const path = url.split("?")[0].split("#")[0];
  try {
    if (isLivePath(path)) {
      handleLiveRequest(req, res, path);
      logLine(req, res.statusCode || 200, "live", Date.now() - start);
      return;
    }
    if (isCockpitPath(path)) {
      handleCockpitRequest(req, res, path);
      logLine(req, res.statusCode || 200, "cockpit", Date.now() - start);
      return;
    }
    if (isReadWorkerPath(path)) {
      const webReq = nodeRequestToWebRequest(req);
      const webRes = await handleRequest(webReq);
      const source = webRes.headers.get("X-Bithub-Read-Source") || "—";
      await writeWebResponse(res, webRes);
      logLine(req, webRes.status, source, Date.now() - start);
      return;
    }
    await serveStatic(req, res);
    logLine(req, res.statusCode || 200, "static", Date.now() - start);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end("internal error");
    logLine(req, 500, "error", Date.now() - start, err && err.message);
  }
}

// Returns the request path without query string or fragment, plus a compact
// summary of how many query keys were present. We never log raw query values:
// even Phase 0 takes `?symbol=BTC/USDT:USDT`, but the same shape will carry
// caller-controllable values in RW-2+ and we want defense in depth. Keeping
// the key count helps debugging cardinality without leaking values.
export function sanitizeUrlForLog(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return "/";
  const hashIdx = rawUrl.indexOf("#");
  const noHash = hashIdx === -1 ? rawUrl : rawUrl.slice(0, hashIdx);
  const qIdx = noHash.indexOf("?");
  if (qIdx === -1) return noHash || "/";
  const path = noHash.slice(0, qIdx) || "/";
  const query = noHash.slice(qIdx + 1);
  if (query.length === 0) return path;
  // Count unique keys without inspecting their values.
  const keys = new Set();
  for (const pair of query.split("&")) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    keys.add(key);
  }
  return `${path}?<${keys.size} key${keys.size === 1 ? "" : "s"}>`;
}

function logLine(req, status, source, ms, extra) {
  const time = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  const safeUrl = sanitizeUrlForLog(req.url);
  const line =
    `[${time}] ${req.method} ${safeUrl} -> ${status} ` +
    `(${source}) ${ms}ms` +
    (extra ? ` :: ${extra}` : "");
  // eslint-disable-next-line no-console
  console.log(line);
}

export function createDevServer() {
  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end("crashed");
      } catch (_e) { /* ignore */ }
      // eslint-disable-next-line no-console
      console.error("dev-server crashed:", err);
    });
  });
}

// CLI entrypoint guard: only auto-listen when this file is run directly.
const argv = process.argv.slice(2);
function parseArg(name, def) {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= argv.length) return def;
  return argv[idx + 1];
}

const HOST = parseArg("host", "127.0.0.1");
const PORT = Number(parseArg("port", "3000"));

const invokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`
        || fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch (_err) {
    return false;
  }
})();

if (invokedDirectly) {
  maybeBootLiveTail();
  maybeBootCockpitTail();
  const server = createDevServer();
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(
      `bithub-ui dev-server listening at http://${HOST}:${PORT} ` +
        `(public=${PUBLIC_DIR})`
    );
    console.log(
      "  routes: /v1/* -> read-worker skeleton; /live/* -> live tail (if enabled); /cockpit/* -> cockpit tail (if enabled); * -> static (public/)"
    );
  });
}
