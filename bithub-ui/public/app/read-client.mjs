// read-client.mjs — cliente HTTP read-only do dashboard Bithub.
//
// Consome o Read Worker (H-013 skeleton; RW-2/RW-3 reais no futuro)
// pelos envelopes canonicos definidos em
// `bithub-vault/03-Integration/Read-Worker-v1-Contract.md` secao 5.1.
//
// Regras:
// - Frontend NAO inventa payload; apenas le envelopes do Worker.
// - Falha-fechado: se schema_version/as_of/served_at/source/data/warnings
//   faltarem, retorna `{ kind: "envelope_drift" }` e a UI mostra ErrorState.
// - 503 de /v1/blobs/* nao e erro do cliente; e BlobUnavailable.
// - Captura headers X-Bithub-Read-Source / Request-Id / Schema-Version.
// - Sem retry agressivo. UI controla refresh.
// - Sem secret no client. Sem header de auth. Sem cookies aplicativos.

export const ENDPOINTS = Object.freeze({
  health: "/v1/health",
  publicConfig: "/v1/config/public",
  featureFlags: "/v1/config/feature-flags",
  symbols: "/v1/symbols",
  sourceStatus: "/v1/source-status",
  bundlesLatest: "/v1/bundles/latest",
  blobBundle: "/v1/blobs/bundle/",
  blobManifest: "/v1/blobs/manifest/",
});

export const READ_SOURCES = Object.freeze(
  new Set(["kv", "d1", "r2", "derived"])
);

const ENVELOPE_REQUIRED_KEYS = [
  "schema_version",
  "as_of",
  "served_at",
  "source",
  "stale",
  "data",
  "warnings",
];

const ERROR_ENVELOPE_REQUIRED_KEYS = ["schema_version", "served_at", "error"];

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isIsoUtc(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  );
}

function isReadSource(value) {
  return typeof value === "string" && READ_SOURCES.has(value);
}

function isWarningsList(value) {
  return Array.isArray(value) && value.every((w) => typeof w === "string");
}

/**
 * Valida o envelope canonico 2xx (read-worker R-001 secao 5.1).
 * Retorna lista de razoes de drift. Lista vazia => envelope ok.
 */
export function validateEnvelope(envelope) {
  const reasons = [];
  if (!isPlainObject(envelope)) {
    reasons.push("envelope is not an object");
    return reasons;
  }
  for (const key of ENVELOPE_REQUIRED_KEYS) {
    if (!(key in envelope)) {
      reasons.push(`missing key: ${key}`);
    }
  }
  if (reasons.length > 0) return reasons;
  if (
    typeof envelope.schema_version !== "string" ||
    !envelope.schema_version.startsWith("read.")
  ) {
    reasons.push("schema_version must be 'read.*' string");
  }
  if (!isIsoUtc(envelope.as_of)) {
    reasons.push("as_of must be ISO-8601 UTC with Z");
  }
  if (!isIsoUtc(envelope.served_at)) {
    reasons.push("served_at must be ISO-8601 UTC with Z");
  }
  if (!isReadSource(envelope.source)) {
    reasons.push(`source must be one of ${[...READ_SOURCES].join("|")}`);
  }
  if (typeof envelope.stale !== "boolean") {
    reasons.push("stale must be boolean");
  }
  if (!isWarningsList(envelope.warnings)) {
    reasons.push("warnings must be array of strings");
  }
  return reasons;
}

/**
 * Valida o envelope canonico de erro (read.error.v1).
 */
export function validateErrorEnvelope(envelope) {
  const reasons = [];
  if (!isPlainObject(envelope)) {
    reasons.push("error envelope is not an object");
    return reasons;
  }
  for (const key of ERROR_ENVELOPE_REQUIRED_KEYS) {
    if (!(key in envelope)) {
      reasons.push(`missing key: ${key}`);
    }
  }
  if (reasons.length > 0) return reasons;
  if (envelope.schema_version !== "read.error.v1") {
    reasons.push("schema_version must be 'read.error.v1'");
  }
  if (!isIsoUtc(envelope.served_at)) {
    reasons.push("served_at must be ISO-8601 UTC with Z");
  }
  if (!isPlainObject(envelope.error)) {
    reasons.push("error must be an object");
    return reasons;
  }
  for (const k of ["code", "message", "request_id"]) {
    if (typeof envelope.error[k] !== "string") {
      reasons.push(`error.${k} must be string`);
    }
  }
  return reasons;
}

function pickHeaders(headers) {
  return {
    readSource: headers.get("X-Bithub-Read-Source") || null,
    schemaVersion: headers.get("X-Bithub-Schema-Version") || null,
    requestId: headers.get("X-Bithub-Request-Id") || null,
    cacheControl: headers.get("Cache-Control") || null,
  };
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (text.length === 0) return { parsed: null, raw: text };
  try {
    return { parsed: JSON.parse(text), raw: text };
  } catch (_err) {
    return { parsed: null, raw: text };
  }
}

/**
 * Resultado tipado-na-doc:
 *   { kind: "ok",            envelope, headers, status }
 *   { kind: "error",         status, errorEnvelope, headers }
 *   { kind: "blob_unavailable", envelope, headers, status, warning }
 *   { kind: "envelope_drift",   reasons, raw, headers, status }
 *   { kind: "transport_error",  message }
 */
async function request(path, init = {}, opts = {}) {
  const { baseUrl = "" } = opts;
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: init.method || "GET",
      headers: { Accept: "application/json", ...(init.headers || {}) },
      signal: init.signal,
    });
  } catch (err) {
    return {
      kind: "transport_error",
      message: err && err.message ? err.message : "fetch failed",
    };
  }
  const headers = pickHeaders(response.headers);
  const { parsed, raw } = await readJsonSafe(response);

  if (response.status === 503 && path.startsWith(ENDPOINTS.blobBundle)) {
    return blobResult(parsed, raw, headers, response.status);
  }
  if (response.status === 503 && path.startsWith(ENDPOINTS.blobManifest)) {
    return blobResult(parsed, raw, headers, response.status);
  }

  const errReasons = validateErrorEnvelope(parsed);
  if (errReasons.length === 0) {
    return {
      kind: "error",
      status: response.status,
      errorEnvelope: parsed,
      headers,
    };
  }

  if (response.status >= 400) {
    return {
      kind: "envelope_drift",
      reasons: errReasons,
      raw,
      headers,
      status: response.status,
    };
  }

  const reasons = validateEnvelope(parsed);
  if (reasons.length > 0) {
    return {
      kind: "envelope_drift",
      reasons,
      raw,
      headers,
      status: response.status,
    };
  }
  return {
    kind: "ok",
    envelope: parsed,
    headers,
    status: response.status,
  };
}

function blobResult(parsed, raw, headers, status) {
  if (!isPlainObject(parsed)) {
    return {
      kind: "envelope_drift",
      reasons: ["blob envelope is not an object"],
      raw,
      headers,
      status,
    };
  }
  const warning =
    Array.isArray(parsed.warnings) && parsed.warnings.length > 0
      ? parsed.warnings[0]
      : null;
  return {
    kind: "blob_unavailable",
    envelope: parsed,
    headers,
    status,
    warning,
  };
}

// --------------------------------------------------------------------------
// API publica
// --------------------------------------------------------------------------

export function fetchHealth(opts) {
  return request(ENDPOINTS.health, {}, opts);
}

export function fetchPublicConfig(opts) {
  return request(ENDPOINTS.publicConfig, {}, opts);
}

export function fetchFeatureFlags(opts) {
  return request(ENDPOINTS.featureFlags, {}, opts);
}

export function fetchSymbols(opts) {
  return request(ENDPOINTS.symbols, {}, opts);
}

export function fetchSourceStatus(opts) {
  return request(ENDPOINTS.sourceStatus, {}, opts);
}

export function fetchLatestBundle(symbol, opts = {}) {
  if (typeof symbol !== "string" || symbol.length === 0) {
    return Promise.resolve({
      kind: "transport_error",
      message: "symbol is required",
    });
  }
  const path = `${ENDPOINTS.bundlesLatest}?symbol=${encodeURIComponent(symbol)}`;
  return request(path, {}, opts);
}

export function fetchBlobBundle(id, opts = {}) {
  if (typeof id !== "string" || id.length === 0) {
    return Promise.resolve({
      kind: "transport_error",
      message: "blob id is required",
    });
  }
  return request(`${ENDPOINTS.blobBundle}${encodeURIComponent(id)}`, {}, opts);
}

export function fetchBlobManifest(id, opts = {}) {
  if (typeof id !== "string" || id.length === 0) {
    return Promise.resolve({
      kind: "transport_error",
      message: "blob id is required",
    });
  }
  return request(`${ENDPOINTS.blobManifest}${encodeURIComponent(id)}`, {}, opts);
}

export const _internals = Object.freeze({
  request,
  validateEnvelope,
  validateErrorEnvelope,
  isIsoUtc,
  isReadSource,
});
