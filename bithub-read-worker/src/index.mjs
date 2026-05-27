// index.mjs — Read Worker offline/local para H-20260525-013 + RW-2/RW-3/RW-7.
//
// ESM puro, sem dependencia externa. Compativel com node:test e com a
// API fetch do Cloudflare Workers (`export default { fetch }`).
//
// Regras estritas (handoffs H-013/RW-2/RW-3/RW-7):
// - serve apenas as fixtures determinísticas embutidas a partir de
//   `bithub-read-worker/fixtures/generated/*.json`, geradas pelo script
//   Python `bithub-data-layer/scripts/export_read_worker_fixtures.py`;
// - quando `env.KV_BITHUB`/`env.KV` existir, tenta ler KV via get(key);
// - quando `env.D1_BITHUB`/`env.DB_BITHUB` existir, tenta fallback D1
//   fake/local via getReadModel(kind, params) para health/latest bundle;
// - sem bindings KV/D1, continua servindo exatamente os bytes das fixtures;
// - nao inventa payload; nao gera clock; nao gera id aleatorio;
// - nao chama rede; nao le `.env`; nao le `process.env`;
// - endpoints minimos /v1/* respondem 200 com envelope canonico;
// - /v1/blobs/bundle/* e /v1/blobs/manifest/* respondem 503 com warning
//   literal "blobs not available in skeleton";
// - metodos diferentes de GET/HEAD respondem 405;
// - RW-7 permite edge policy fake/local injetavel, sem Access/WAF real;
// - rotas desconhecidas respondem envelope read.error.v1 sem stack.
//
// O Worker e local-only. RW-2 prepara o formato do binding KV sem tocar
// Cloudflare real; RW-3 prepara o formato do fallback D1 sem tocar D1 real;
// RW-7 prepara contrato de borda sem tocar Access/WAF/Logpush reais.

import { EMBEDDED_FIXTURE_RAW } from "./fixtures.generated.mjs";

const FIXTURES_DIR = "bithub-read-worker/fixtures/generated";

// --------------------------------------------------------------------------
// Allowlist CORS (R-001 secao 8). Strict, sem wildcard.
// --------------------------------------------------------------------------

const CORS_ALLOWED_ORIGINS = new Set([
  "https://bithub-clo.pages.dev",
  "https://app.bit-hub.pro",
  "https://api.bit-hub.pro",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

const CORS_ALLOWED_METHODS = "GET, HEAD, OPTIONS";
const CORS_ALLOWED_HEADERS =
  "Content-Type, Cf-Access-Jwt-Assertion, X-Bithub-Request-Id, X-Bithub-Schema-Version";
const CORS_MAX_AGE = "600";
const CORS_PREFLIGHT_ALLOWED_REQUEST_METHODS = new Set(["GET", "HEAD"]);

// --------------------------------------------------------------------------
// Carga das fixtures (sincrono, no module load).
// --------------------------------------------------------------------------

function loadFixtures() {
  const out = Object.create(null);
  for (const [file, raw] of Object.entries(EMBEDDED_FIXTURE_RAW)) {
    const parsed = JSON.parse(raw);
    out[file] = { raw: raw.endsWith("\n") ? raw.slice(0, -1) : raw, parsed };
  }
  return out;
}

const FIXTURES = loadFixtures();

// --------------------------------------------------------------------------
// Chaves KV Phase 0 (H-010). Binding canonico: env.KV_BITHUB.
// --------------------------------------------------------------------------

const KV_KEY_PUBLIC_CONFIG = "public_config";
const KV_KEY_FEATURE_FLAGS = "feature_flags";
const KV_KEY_LATEST_HEALTH = "latest_health:data_layer";
const KV_PREFIX_LATEST_BUNDLE = "latest_bundle:";

const KV_BINDING_NAMES = Object.freeze(["KV_BITHUB", "KV"]);
const D1_BINDING_NAMES = Object.freeze(["D1_BITHUB", "DB_BITHUB"]);
const EDGE_POLICY_BINDING_NAMES = Object.freeze(["EDGE_POLICY", "READ_EDGE_POLICY"]);

const D1_FALLBACK_WARNINGS = Object.freeze({
  kv_absent: "kv-absent-served-from-d1",
  kv_error: "kv-error-served-from-d1",
  kv_miss: "kv-miss-served-from-d1",
  kv_stale: "kv-stale-served-from-d1",
});

const FORBIDDEN_RESPONSE_TOKENS = Object.freeze([
  "api_key",
  "apikey",
  ["Bearer", ""].join(" "),
  "Authorization",
  ["X", "API", "Key"].join("-"),
  ["X", "BAPI", "API", "KEY"].join("-"),
  ["BYBIT", "PRIVATE"].join("_"),
  ["FRED", "API", "KEY"].join("_"),
  ["WEBHOOK", "SIGNING", "SECRET"].join("_"),
  "private_key",
  "signing_secret",
  "access_token",
  "refresh_token",
  "password",
]);

// --------------------------------------------------------------------------
// Mapa rota -> fixture
// --------------------------------------------------------------------------

const ROUTE_FIXTURES = Object.freeze({
  "/v1/health": {
    fixture: "health.json",
    kvKey: KV_KEY_LATEST_HEALTH,
    kind: "latest_health",
  },
  "/v1/symbols": "symbols.json",
  "/v1/source-status": "source-status.json",
  "/v1/config/public": {
    fixture: "public-config.json",
    kvKey: KV_KEY_PUBLIC_CONFIG,
    kind: "public_config",
  },
  "/v1/config/feature-flags": {
    fixture: "feature-flags.json",
    kvKey: KV_KEY_FEATURE_FLAGS,
    kind: "feature_flags",
  },
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

function stableEnvelopeStringify(envelope) {
  const ordered = {
    as_of: envelope.as_of,
    data: envelope.data,
    schema_version: envelope.schema_version,
    served_at: envelope.served_at,
    source: envelope.source,
    stale: envelope.stale,
    warnings: envelope.warnings,
  };
  return JSON.stringify(ordered);
}

function responseBodyHasForbiddenToken(raw) {
  if (typeof raw !== "string") return true;
  const lower = raw.toLowerCase();
  return FORBIDDEN_RESPONSE_TOKENS.some((tok) => {
    const needle = tok.toLowerCase();
    return lower.includes(needle);
  });
}

function isReadEnvelope(value, expectedSchemaVersion) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.schema_version === expectedSchemaVersion
    && typeof value.as_of === "string"
    && typeof value.served_at === "string"
    && typeof value.source === "string"
    && typeof value.stale === "boolean"
    && "data" in value
    && Array.isArray(value.warnings);
}

function getKVBinding(env) {
  if (!env || typeof env !== "object") return null;
  for (const name of KV_BINDING_NAMES) {
    const candidate = env[name];
    if (candidate && typeof candidate.get === "function") return candidate;
  }
  return null;
}

function getD1Binding(env) {
  if (!env || typeof env !== "object") return null;
  for (const name of D1_BINDING_NAMES) {
    const candidate = env[name];
    if (candidate && typeof candidate.getReadModel === "function") {
      return candidate;
    }
  }
  return null;
}

function getEdgePolicyBinding(env) {
  if (!env || typeof env !== "object") return null;
  for (const name of EDGE_POLICY_BINDING_NAMES) {
    const candidate = env[name];
    if (candidate && typeof candidate === "object") return candidate;
  }
  return null;
}

function sanitizeUrlForLog(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_err) {
    return "/";
  }
  const keys = new Set();
  for (const key of parsed.searchParams.keys()) {
    keys.add(key);
  }
  if (keys.size === 0) return parsed.pathname || "/";
  return `${parsed.pathname || "/"}?<${keys.size} key${keys.size === 1 ? "" : "s"}>`;
}

function buildEdgeLogEvent({
  method,
  rawUrl,
  status,
  source,
  schemaVersion,
  requestId,
  durationMs = 0,
}) {
  return Object.freeze({
    at: "2026-05-25T14:00:15Z",
    duration_ms: Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs)) : 0,
    method,
    path: sanitizeUrlForLog(rawUrl),
    request_id: requestId,
    schema_version: schemaVersion || null,
    source: source || null,
    status,
  });
}

function emitEdgeLog(env, event) {
  const edgePolicy = getEdgePolicyBinding(env);
  if (!edgePolicy || typeof edgePolicy.log !== "function") return;
  try {
    edgePolicy.log(event);
  } catch (_err) {
    // Local logging is best-effort; it must never change read behavior.
  }
}

function normalizeEdgeDecision(value) {
  if (value === undefined || value === null || value === true) return { action: "allow" };
  if (value === false) return { action: "deny" };
  if (typeof value === "string") return { action: value };
  if (typeof value === "object" && !Array.isArray(value)) {
    return {
      action: value.action || value.status || "allow",
      retryAfterSeconds: value.retry_after_seconds || value.retryAfterSeconds,
    };
  }
  return { action: "deny" };
}

function retryAfterHeader(value) {
  if (value === undefined || value === null) return "60";
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 3600) return "60";
  return String(Math.floor(numeric));
}

async function edgePolicyRejection({ env, request, url, origin, method, requestId }) {
  const edgePolicy = getEdgePolicyBinding(env);
  if (!edgePolicy) return null;

  const context = Object.freeze({
    method,
    origin,
    path: url.pathname,
    request_id: requestId,
    url: sanitizeUrlForLog(request.url),
  });

  if (typeof edgePolicy.checkAccess === "function") {
    let decision;
    try {
      decision = normalizeEdgeDecision(await edgePolicy.checkAccess(context));
    } catch (_err) {
      decision = { action: "deny" };
    }
    if (decision.action === "missing") {
      return errorResponse({
        status: 401,
        code: "auth_error",
        message: "access credential missing",
        origin,
        requestId,
        method,
      });
    }
    if (decision.action !== "allow") {
      return errorResponse({
        status: 403,
        code: "auth_error",
        message: "access denied",
        origin,
        requestId,
        method,
      });
    }
  }

  if (typeof edgePolicy.checkRateLimit === "function") {
    let decision;
    try {
      decision = normalizeEdgeDecision(await edgePolicy.checkRateLimit(context));
    } catch (_err) {
      decision = { action: "limited" };
    }
    if (decision.action === "limited" || decision.action === "rate_limited") {
      return errorResponse({
        status: 429,
        code: "rate_limited",
        message: "rate limit exceeded",
        origin,
        requestId,
        method,
        extraHeaders: { "Retry-After": retryAfterHeader(decision.retryAfterSeconds) },
      });
    }
    if (decision.action !== "allow") {
      return errorResponse({
        status: 429,
        code: "rate_limited",
        message: "rate limit exceeded",
        origin,
        requestId,
        method,
        extraHeaders: { "Retry-After": "60" },
      });
    }
  }

  return null;
}

async function readKVRaw(env, key) {
  const kv = getKVBinding(env);
  if (!kv) return { status: "no_binding" };
  let value;
  try {
    value = await kv.get(key);
  } catch (_err) {
    return { status: "error" };
  }
  return bindingValueToRaw(value);
}

function bindingValueToRaw(value) {
  if (value === null || value === undefined) return { status: "miss" };
  if (typeof value === "string") return { status: "hit", raw: value };
  try {
    return { status: "hit", raw: JSON.stringify(value) };
  } catch (_err) {
    return { status: "error" };
  }
}

async function readModelFromKV({ env, key, kind, expectedSchemaVersion }) {
  const kvResult = await readKVRaw(env, key);
  if (kvResult.status !== "hit") return kvResult;
  if (responseBodyHasForbiddenToken(kvResult.raw)) {
    return { status: "invalid" };
  }
  let parsed;
  try {
    parsed = JSON.parse(kvResult.raw);
  } catch (_err) {
    return { status: "invalid" };
  }

  if (isReadEnvelope(parsed, expectedSchemaVersion)) {
    if (parsed.stale) return { status: "stale", raw: kvResult.raw, parsed };
    return { status: "hit", raw: kvResult.raw, parsed };
  }

  const envelope = wrapKVReadModel({
    model: parsed,
    kind,
    expectedSchemaVersion,
  });
  if (!envelope) return { status: "invalid" };
  const raw = stableEnvelopeStringify(envelope);
  if (responseBodyHasForbiddenToken(raw)) return { status: "invalid" };
  if (envelope.stale) return { status: "stale", raw, parsed: envelope };
  return { status: "hit", raw, parsed: envelope };
}

async function readD1Raw(env, kind, params) {
  const d1 = getD1Binding(env);
  if (!d1) return { status: "no_binding" };
  let value;
  try {
    value = await d1.getReadModel(kind, Object.freeze({ ...params }));
  } catch (_err) {
    return { status: "error" };
  }
  return bindingValueToRaw(value);
}

async function readModelFromD1({
  env,
  kind,
  params,
  expectedSchemaVersion,
  fallbackReason,
}) {
  const d1Result = await readD1Raw(env, kind, params);
  if (d1Result.status !== "hit") return d1Result;
  if (responseBodyHasForbiddenToken(d1Result.raw)) {
    return { status: "invalid" };
  }
  let parsed;
  try {
    parsed = JSON.parse(d1Result.raw);
  } catch (_err) {
    return { status: "invalid" };
  }

  const warning = D1_FALLBACK_WARNINGS[fallbackReason];
  if (!warning) return { status: "invalid" };

  let envelope;
  if (isReadEnvelope(parsed, expectedSchemaVersion)) {
    envelope = forceD1FallbackEnvelope(parsed, warning);
  } else {
    const wrapped = wrapKVReadModel({
      model: parsed,
      kind,
      expectedSchemaVersion,
    });
    if (!wrapped) return { status: "invalid" };
    envelope = forceD1FallbackEnvelope(wrapped, warning);
  }

  const raw = stableEnvelopeStringify(envelope);
  if (responseBodyHasForbiddenToken(raw)) return { status: "invalid" };
  return { status: "hit", raw, parsed: envelope };
}

function forceD1FallbackEnvelope(envelope, warning) {
  const warnings = Array.isArray(envelope.warnings)
    ? [...envelope.warnings]
    : [];
  if (!warnings.includes(warning)) warnings.push(warning);
  return {
    ...envelope,
    source: "d1",
    warnings,
  };
}

function wrapKVReadModel({ model, kind, expectedSchemaVersion }) {
  if (!model || typeof model !== "object" || Array.isArray(model)) return null;
  if (kind === "public_config" || kind === "feature_flags") {
    return {
      schema_version: expectedSchemaVersion,
      as_of: model.as_of || "2026-05-25T14:00:00Z",
      served_at: model.served_at || model.generated_at || model.as_of || "2026-05-25T14:00:15Z",
      source: "kv",
      stale: Boolean(model.stale || false),
      data: model.data && typeof model.data === "object" ? model.data : model,
      warnings: Array.isArray(model.warnings) ? model.warnings : [],
    };
  }
  if (kind === "latest_health") {
    if (model.schema_version !== "kv.latest_health.v1") return null;
    if (!model.as_of || !model.sources || !model.overall_status) return null;
    return {
      schema_version: expectedSchemaVersion,
      as_of: model.as_of,
      served_at: model.served_at || model.generated_at || model.as_of,
      source: "kv",
      stale: Boolean(model.stale || false),
      data: {
        overall_status: model.overall_status,
        sources: model.sources,
      },
      warnings: Array.isArray(model.warnings) ? model.warnings : [],
    };
  }
  if (kind === "latest_bundle") {
    if (model.schema_version !== "kv.latest_bundle.v1") return null;
    if (!model.as_of || !model.symbol || !model.section_statuses) return null;
    const data = { ...model };
    delete data.schema_version;
    delete data.served_at;
    delete data.generated_at;
    return {
      schema_version: expectedSchemaVersion,
      as_of: model.as_of,
      served_at: model.served_at || model.generated_at || model.bundle_created_at || model.as_of,
      source: "kv",
      stale: Boolean(model.stale || false),
      data,
      warnings: Array.isArray(model.warnings) ? model.warnings : [],
    };
  }
  return null;
}

function fixtureResult(fixtureName) {
  const fixture = FIXTURES[fixtureName];
  if (!fixture) return null;
  return { raw: fixture.raw, parsed: fixture.parsed };
}

async function readRoutePayload({
  env,
  fixtureName,
  kvKey,
  kind,
  expectedSchemaVersion,
  d1Params = {},
}) {
  let kvStatus = "no_binding";
  if (kvKey) {
    const kvResult = await readModelFromKV({
      env,
      key: kvKey,
      kind,
      expectedSchemaVersion,
    });
    if (kvResult.status === "hit") return kvResult;
    kvStatus = kvResult.status;

    if (kind === "latest_health" || kind === "latest_bundle") {
      const fallbackReason =
        kvResult.status === "miss"
          ? "kv_miss"
          : kvResult.status === "stale"
            ? "kv_stale"
            : kvResult.status === "no_binding"
              ? "kv_absent"
              : "kv_error";
      const d1Result = await readModelFromD1({
        env,
        kind,
        params: d1Params,
        expectedSchemaVersion,
        fallbackReason,
      });
      if (d1Result.status === "hit") return d1Result;
      if (kvResult.status === "invalid" || kvResult.status === "error") {
        return { status: "error" };
      }
      if (d1Result.status === "invalid" || d1Result.status === "error") {
        return { status: "d1_error" };
      }
      if (d1Result.status === "miss" || d1Result.status === "no_binding") {
        if (kvResult.status !== "no_binding" || getD1Binding(env)) {
          return { status: "d1_unavailable" };
        }
      }
    }

    if (kvResult.status === "invalid" || kvResult.status === "error") {
      return kvResult;
    }
  }
  if (kvStatus === "stale" && getD1Binding(env)) {
    return { status: "d1_unavailable" };
  }
  const fallback = fixtureResult(fixtureName);
  if (!fallback) return { status: "fixture_missing" };
  return { status: "hit", ...fallback };
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

async function bundlesLatestResponse({ url, origin, requestId, method, env }) {
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
  const result = await readRoutePayload({
    env,
    fixtureName,
    kvKey: `${KV_PREFIX_LATEST_BUNDLE}${rawSymbol}`,
    kind: "latest_bundle",
    expectedSchemaVersion: "read.bundle.v1",
    d1Params: {
      symbol: rawSymbol,
      kvKey: `${KV_PREFIX_LATEST_BUNDLE}${rawSymbol}`,
    },
  });
  if (result.status === "error" || result.status === "invalid" || result.status === "d1_error") {
    return errorResponse({
      status: 502,
      code: "network_error",
      message: "KV/D1 read model unavailable",
      origin,
      requestId,
      method,
    });
  }
  if (result.status === "d1_unavailable") {
    return errorResponse({
      status: 503,
      code: "network_error",
      message: "D1 fallback unavailable",
      origin,
      requestId,
      method,
    });
  }
  if (result.status === "fixture_missing") {
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
    body: result.raw,
    status: 200,
    schemaVersion: result.parsed.schema_version,
    source: result.parsed.source,
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
 * @param {object=} env
 * @returns {Promise<Response>}
 */
export async function handleRequest(request, env = undefined) {
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
  const respond = (response) => {
    emitEdgeLog(env, buildEdgeLogEvent({
      method,
      rawUrl: request.url,
      requestId,
      schemaVersion: response.headers.get("X-Bithub-Schema-Version"),
      source: response.headers.get("X-Bithub-Read-Source"),
      status: response.status,
    }));
    return response;
  };

  // OPTIONS preflight
  if (method === "OPTIONS") {
    const headers = new Headers();
    const requestedMethod = request.headers
      .get("Access-Control-Request-Method")
      ?.toUpperCase();
    if (
      origin
      && CORS_ALLOWED_ORIGINS.has(origin)
      && CORS_PREFLIGHT_ALLOWED_REQUEST_METHODS.has(requestedMethod)
    ) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS);
      headers.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
      headers.set("Access-Control-Allow-Credentials", "true");
      headers.set("Access-Control-Max-Age", CORS_MAX_AGE);
      headers.set("Vary", "Origin, Cookie, Cf-Access-Jwt-Assertion");
      return respond(new Response(null, { status: 204, headers }));
    }
    return respond(errorResponse({
      status: 403,
      code: "validation_error",
      message: "preflight not allowed",
      origin,
      requestId,
      method,
    }));
  }

  if (!isMethodAllowed(method)) {
    return respond(errorResponse({
      status: 405,
      code: "validation_error",
      message: "method not allowed; this read-worker accepts GET/HEAD only",
      origin,
      requestId,
      method,
      extraHeaders: { Allow: "GET, HEAD, OPTIONS" },
    }));
  }

  const edgeRejection = await edgePolicyRejection({
    env,
    request,
    url,
    origin,
    method,
    requestId,
  });
  if (edgeRejection) {
    return respond(edgeRejection);
  }

  // /v1/blobs/* (stub 503)
  if (
    path.startsWith(BLOB_BUNDLE_PREFIX) ||
    path.startsWith(BLOB_MANIFEST_PREFIX)
  ) {
    return respond(blobNotAvailableResponse({ origin, requestId, method }));
  }

  // /v1/bundles/latest
  if (path === BUNDLES_LATEST_PATH) {
    return respond(await bundlesLatestResponse({ url, origin, requestId, method, env }));
  }

  // Endpoints simples por mapa
  const route = ROUTE_FIXTURES[path];
  if (route) {
    const fixtureName = typeof route === "string" ? route : route.fixture;
    const expectedSchemaVersion = fixtureResult(fixtureName)?.parsed.schema_version;
    const result = await readRoutePayload({
      env,
      fixtureName,
      kvKey: typeof route === "string" ? null : route.kvKey,
      kind: typeof route === "string" ? null : route.kind,
      expectedSchemaVersion,
    });
    if (result.status === "error" || result.status === "invalid" || result.status === "d1_error") {
      return respond(errorResponse({
        status: 502,
        code: "network_error",
        message: "KV/D1 read model unavailable",
        origin,
        requestId,
        method,
      }));
    }
    if (result.status === "d1_unavailable") {
      return respond(errorResponse({
        status: 503,
        code: "network_error",
        message: "D1 fallback unavailable",
        origin,
        requestId,
        method,
      }));
    }
    if (result.status === "fixture_missing") {
      return respond(errorResponse({
        status: 500,
        code: "unknown_error",
        message: "skeleton fixture missing for route",
        origin,
        requestId,
        method,
      }));
    }
    return respond(jsonResponse({
      body: result.raw,
      status: 200,
      schemaVersion: result.parsed.schema_version,
      source: result.parsed.source,
      origin,
      requestId,
      cacheControl: "private, max-age=30",
      method,
    }));
  }

  // Unknown route -> envelope de erro 404 sem stack/segredo.
  return respond(errorResponse({
    status: 404,
    code: "not_found",
    message: "route not found in read-worker skeleton",
    origin,
    requestId,
    method,
  }));
}

// Compat com Cloudflare Workers (apesar de o skeleton nao rodar la).
// Importadores Node usam `handleRequest` diretamente.
export default {
  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  fetch(request, env /*, ctx */) {
    return handleRequest(request, env);
  },
};

// Exportados auxiliares apenas para os testes node:test.
export const _internals = Object.freeze({
  FIXTURES_DIR,
  CORS_ALLOWED_ORIGINS,
  CORS_PREFLIGHT_ALLOWED_REQUEST_METHODS,
  ROUTE_FIXTURES,
  KV_BINDING_NAMES,
  D1_BINDING_NAMES,
  EDGE_POLICY_BINDING_NAMES,
  KV_KEY_PUBLIC_CONFIG,
  KV_KEY_FEATURE_FLAGS,
  KV_KEY_LATEST_HEALTH,
  KV_PREFIX_LATEST_BUNDLE,
  BUNDLES_LATEST_PATH,
  BLOB_BUNDLE_PREFIX,
  BLOB_MANIFEST_PREFIX,
  SUPPORTED_BUNDLE_SYMBOLS,
  deterministicRequestId,
  getKVBinding,
  getD1Binding,
  getEdgePolicyBinding,
  readModelFromKV,
  readModelFromD1,
  sanitizeUrlForLog,
  buildEdgeLogEvent,
  edgePolicyRejection,
});
