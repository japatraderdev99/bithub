// index.mjs — Read Worker skeleton (offline) para H-20260525-013.
//
// ESM puro, sem dependencia externa. Compativel com node:test e com a
// API fetch do Cloudflare Workers (`export default { fetch }`).
//
// Regras estritas (handoff H-013):
// - serve apenas as fixtures determinísticas em
//   `bithub-read-worker/fixtures/generated/*.json`, geradas pelo script
//   Python `bithub-data-layer/scripts/export_read_worker_fixtures.py`;
// - nao inventa payload; nao gera clock; nao gera id aleatorio;
// - nao chama rede; nao le `.env`; nao le `process.env`; nao usa
//   wrangler/npx/Cloudflare real;
// - endpoints minimos /v1/* respondem 200 com envelope canonico;
// - /v1/blobs/bundle/* e /v1/blobs/manifest/* respondem 503 com warning
//   literal "blobs not available in skeleton";
// - metodos diferentes de GET/HEAD respondem 405;
// - rotas desconhecidas respondem envelope read.error.v1 sem stack.
//
// O Worker e local-only. Em runtime real (RW-2/RW-3 futuros) substituira
// `loadFixtures()` por bindings KV/D1/R2.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "..", "fixtures", "generated");

// --------------------------------------------------------------------------
// Allowlist CORS (R-001 secao 8). Strict, sem wildcard.
// --------------------------------------------------------------------------

const CORS_ALLOWED_ORIGINS = new Set([
  "https://app.bit-hub.pro",
  "https://api.bit-hub.pro",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

const CORS_ALLOWED_METHODS = "GET, HEAD, OPTIONS";
const CORS_ALLOWED_HEADERS =
  "Content-Type, Cf-Access-Jwt-Assertion, X-Bithub-Request-Id, X-Bithub-Schema-Version";
const CORS_MAX_AGE = "600";

// --------------------------------------------------------------------------
// Carga das fixtures (sincrono, no module load).
// --------------------------------------------------------------------------

/**
 * Le todas as fixtures JSON do diretorio canonico.
 * Retorna {filename -> {raw: string, parsed: object}}.
 */
function loadFixtures() {
  if (!existsSync(FIXTURES_DIR)) {
    throw new Error(
      `read-worker skeleton: fixtures dir not found at ${FIXTURES_DIR}. ` +
        `Run scripts/export_read_worker_fixtures.py first.`
    );
  }
  const out = Object.create(null);
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const path = resolve(FIXTURES_DIR, file);
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    out[file] = { raw: raw.endsWith("\n") ? raw.slice(0, -1) : raw, parsed };
  }
  return out;
}

const FIXTURES = loadFixtures();

// --------------------------------------------------------------------------
// Mapa rota -> fixture
// --------------------------------------------------------------------------

const ROUTE_FIXTURES = Object.freeze({
  "/v1/health": "health.json",
  "/v1/symbols": "symbols.json",
  "/v1/source-status": "source-status.json",
  "/v1/config/public": "public-config.json",
  "/v1/config/feature-flags": "feature-flags.json",
});

const BUNDLES_LATEST_PATH = "/v1/bundles/latest";
const BLOB_BUNDLE_PREFIX = "/v1/blobs/bundle/";
const BLOB_MANIFEST_PREFIX = "/v1/blobs/manifest/";

// Allowlist de simbolos suportados pelo skeleton. Em RW-2 vira lookup KV.
const SUPPORTED_BUNDLE_SYMBOLS = Object.freeze({
  "BTC/USDT:USDT": "bundles-latest-BTC_USDT_USDT.json",
});

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Gera um request id determinístico, derivado do path. Sem clock, sem
 * random. Em runtime real, sera substituido por ULID/UUIDv7 do edge.
 */
function deterministicRequestId(path) {
  // djb2 hash compactado em 8 chars hex maiusculos
  let h = 5381;
  for (let i = 0; i < path.length; i++) {
    h = ((h << 5) + h + path.charCodeAt(i)) >>> 0;
  }
  const hex = h.toString(16).padStart(8, "0").toUpperCase();
  return `01HZX-SKEL-${hex}`;
}

function buildHeaders({
  schemaVersion,
  source,
  origin,
  requestId,
  cacheControl,
}) {
  const headers = new Headers();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", cacheControl);
  headers.set("X-Bithub-Read-Source", source);
  headers.set("X-Bithub-Schema-Version", schemaVersion);
  headers.set("X-Bithub-Request-Id", requestId);
  headers.set("Vary", "Origin, Cookie, Cf-Access-Jwt-Assertion");
  if (origin && CORS_ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  return headers;
}

function isMethodAllowed(method) {
  return method === "GET" || method === "HEAD";
}

function jsonResponse({
  body,
  status,
  schemaVersion,
  source,
  origin,
  requestId,
  cacheControl,
  method,
}) {
  const headers = buildHeaders({
    schemaVersion,
    source,
    origin,
    requestId,
    cacheControl,
  });
  if (method === "HEAD") {
    return new Response(null, { status, headers });
  }
  return new Response(body, { status, headers });
}

function buildErrorEnvelope({ code, message, requestId }) {
  return JSON.stringify({
    error: {
      code,
      message,
      request_id: requestId,
    },
    schema_version: "read.error.v1",
    served_at: "2026-05-25T14:00:15Z",
  });
}

function errorResponse({
  status,
  code,
  message,
  origin,
  requestId,
  method,
  source = "derived",
  cacheControl = "no-store",
  extraHeaders = {},
}) {
  const headers = buildHeaders({
    schemaVersion: "read.error.v1",
    source,
    origin,
    requestId,
    cacheControl,
  });
  for (const [k, v] of Object.entries(extraHeaders)) {
    headers.set(k, v);
  }
  if (method === "HEAD") {
    return new Response(null, { status, headers });
  }
  return new Response(
    buildErrorEnvelope({ code, message, requestId }),
    { status, headers }
  );
}

// --------------------------------------------------------------------------
// /v1/blobs/* — stub 503 com warning literal
// --------------------------------------------------------------------------

function blobNotAvailableResponse({ origin, requestId, method }) {
  const body = JSON.stringify({
    as_of: "2026-05-25T14:00:00Z",
    data: null,
    schema_version: "read.blob.v1",
    served_at: "2026-05-25T14:00:15Z",
    source: "derived",
    stale: true,
    warnings: ["blobs not available in skeleton"],
  });
  return jsonResponse({
    body,
    status: 503,
    schemaVersion: "read.blob.v1",
    source: "derived",
    origin,
    requestId,
    cacheControl: "no-store",
    method,
  });
}

// --------------------------------------------------------------------------
// /v1/bundles/latest?symbol=...
// --------------------------------------------------------------------------

function bundlesLatestResponse({ url, origin, requestId, method }) {
  const rawSymbol = url.searchParams.get("symbol");
  if (!rawSymbol) {
    return errorResponse({
      status: 400,
      code: "validation_error",
      message: "symbol parameter is required",
      origin,
      requestId,
      method,
    });
  }
  // Symbol comes URL-decoded by URLSearchParams; validate format.
  if (!/^[A-Z0-9]+\/[A-Z0-9]+(?::[A-Z0-9]+)?$/.test(rawSymbol)) {
    return errorResponse({
      status: 400,
      code: "validation_error",
      message: "symbol parameter is not a Bithub-canonical format",
      origin,
      requestId,
      method,
    });
  }
  const fixtureName = SUPPORTED_BUNDLE_SYMBOLS[rawSymbol];
  if (!fixtureName) {
    return errorResponse({
      status: 404,
      code: "unsupported_symbol",
      message: "symbol not in skeleton allowlist",
      origin,
      requestId,
      method,
    });
  }
  const fixture = FIXTURES[fixtureName];
  if (!fixture) {
    return errorResponse({
      status: 500,
      code: "unknown_error",
      message: "skeleton fixture missing for symbol",
      origin,
      requestId,
      method,
    });
  }
  return jsonResponse({
    body: fixture.raw,
    status: 200,
    schemaVersion: fixture.parsed.schema_version,
    source: fixture.parsed.source,
    origin,
    requestId,
    cacheControl: "private, max-age=60",
    method,
  });
}

// --------------------------------------------------------------------------
// Roteador principal
// --------------------------------------------------------------------------

/**
 * Handler principal. Independente do runtime (Node node:test ou Cloudflare
 * Workers fetch handler).
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleRequest(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch (_err) {
    // Defesa em profundidade: URL invalida nunca deveria chegar ao
    // handler, mas se chegar, responde envelope de erro sem stack.
    return errorResponse({
      status: 400,
      code: "validation_error",
      message: "invalid request URL",
      origin: null,
      requestId: deterministicRequestId("invalid"),
      method: request.method,
    });
  }

  const origin = request.headers.get("Origin");
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const requestId = deterministicRequestId(path);

  // OPTIONS preflight
  if (method === "OPTIONS") {
    const headers = new Headers();
    if (origin && CORS_ALLOWED_ORIGINS.has(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS);
      headers.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
      headers.set("Access-Control-Allow-Credentials", "true");
      headers.set("Access-Control-Max-Age", CORS_MAX_AGE);
      headers.set("Vary", "Origin, Cookie, Cf-Access-Jwt-Assertion");
      return new Response(null, { status: 204, headers });
    }
    return new Response(null, { status: 403 });
  }

  if (!isMethodAllowed(method)) {
    return errorResponse({
      status: 405,
      code: "validation_error",
      message: "method not allowed; this read-worker accepts GET/HEAD only",
      origin,
      requestId,
      method,
      extraHeaders: { Allow: "GET, HEAD, OPTIONS" },
    });
  }

  // /v1/blobs/* (stub 503)
  if (
    path.startsWith(BLOB_BUNDLE_PREFIX) ||
    path.startsWith(BLOB_MANIFEST_PREFIX)
  ) {
    return blobNotAvailableResponse({ origin, requestId, method });
  }

  // /v1/bundles/latest
  if (path === BUNDLES_LATEST_PATH) {
    return bundlesLatestResponse({ url, origin, requestId, method });
  }

  // Endpoints simples por mapa
  const fixtureName = ROUTE_FIXTURES[path];
  if (fixtureName) {
    const fixture = FIXTURES[fixtureName];
    if (!fixture) {
      return errorResponse({
        status: 500,
        code: "unknown_error",
        message: "skeleton fixture missing for route",
        origin,
        requestId,
        method,
      });
    }
    return jsonResponse({
      body: fixture.raw,
      status: 200,
      schemaVersion: fixture.parsed.schema_version,
      source: fixture.parsed.source,
      origin,
      requestId,
      cacheControl: "private, max-age=30",
      method,
    });
  }

  // Unknown route -> envelope de erro 404 sem stack/segredo.
  return errorResponse({
    status: 404,
    code: "not_found",
    message: "route not found in read-worker skeleton",
    origin,
    requestId,
    method,
  });
}

// Compat com Cloudflare Workers (apesar de o skeleton nao rodar la).
// Importadores Node usam `handleRequest` diretamente.
export default {
  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  fetch(request /*, env, ctx */) {
    return handleRequest(request);
  },
};

// Exportados auxiliares apenas para os testes node:test.
export const _internals = Object.freeze({
  FIXTURES_DIR,
  CORS_ALLOWED_ORIGINS,
  ROUTE_FIXTURES,
  BUNDLES_LATEST_PATH,
  BLOB_BUNDLE_PREFIX,
  BLOB_MANIFEST_PREFIX,
  SUPPORTED_BUNDLE_SYMBOLS,
  deterministicRequestId,
});
