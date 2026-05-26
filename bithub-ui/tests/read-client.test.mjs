// read-client.test.mjs — testes node:test do cliente HTTP read-only.
//
// Exerc o read-client contra o dev-server, que delega /v1/* para o Read
// Worker skeleton. Sem rede externa; tudo loopback offline.

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";

import { createDevServer } from "../scripts/dev-server.mjs";
import {
  fetchHealth,
  fetchPublicConfig,
  fetchFeatureFlags,
  fetchSymbols,
  fetchSourceStatus,
  fetchLatestBundle,
  fetchBlobBundle,
  fetchBlobManifest,
  validateEnvelope,
  validateErrorEnvelope,
  ENDPOINTS,
  READ_SOURCES,
  _internals,
} from "../public/app/read-client.mjs";

let server;
let base;

before(async () => {
  server = createDevServer();
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

const opts = () => ({ baseUrl: base });

describe("envelope shape (R-001 5.1)", () => {
  it("accepts a canonical envelope", () => {
    const reasons = validateEnvelope({
      schema_version: "read.health.v1",
      as_of: "2026-05-25T14:00:00Z",
      served_at: "2026-05-25T14:00:15Z",
      source: "kv",
      stale: false,
      data: { overall_status: "ok" },
      warnings: [],
    });
    assert.deepEqual(reasons, []);
  });

  it("rejects missing keys", () => {
    const reasons = validateEnvelope({
      as_of: "2026-05-25T14:00:00Z",
      served_at: "2026-05-25T14:00:15Z",
      source: "kv",
      stale: false,
      data: {},
      warnings: [],
    });
    assert.ok(reasons.length > 0);
    assert.ok(reasons[0].includes("schema_version"));
  });

  it("rejects bad schema_version prefix", () => {
    const reasons = validateEnvelope({
      schema_version: "weird.v1",
      as_of: "2026-05-25T14:00:00Z",
      served_at: "2026-05-25T14:00:15Z",
      source: "kv",
      stale: false,
      data: {},
      warnings: [],
    });
    assert.ok(reasons.some((r) => r.includes("schema_version")));
  });

  it("rejects bad timestamp", () => {
    const reasons = validateEnvelope({
      schema_version: "read.health.v1",
      as_of: "yesterday",
      served_at: "2026-05-25T14:00:15Z",
      source: "kv",
      stale: false,
      data: {},
      warnings: [],
    });
    assert.ok(reasons.some((r) => r.includes("as_of")));
  });

  it("rejects bad source", () => {
    const reasons = validateEnvelope({
      schema_version: "read.health.v1",
      as_of: "2026-05-25T14:00:00Z",
      served_at: "2026-05-25T14:00:15Z",
      source: "memory",
      stale: false,
      data: {},
      warnings: [],
    });
    assert.ok(reasons.some((r) => r.includes("source")));
  });

  it("rejects non-array warnings", () => {
    const reasons = validateEnvelope({
      schema_version: "read.health.v1",
      as_of: "2026-05-25T14:00:00Z",
      served_at: "2026-05-25T14:00:15Z",
      source: "kv",
      stale: false,
      data: {},
      warnings: "none",
    });
    assert.ok(reasons.some((r) => r.includes("warnings")));
  });

  it("rejects non-boolean stale", () => {
    const reasons = validateEnvelope({
      schema_version: "read.health.v1",
      as_of: "2026-05-25T14:00:00Z",
      served_at: "2026-05-25T14:00:15Z",
      source: "kv",
      stale: "yes",
      data: {},
      warnings: [],
    });
    assert.ok(reasons.some((r) => r.includes("stale")));
  });
});

describe("error envelope (read.error.v1)", () => {
  it("accepts a canonical error", () => {
    const reasons = validateErrorEnvelope({
      schema_version: "read.error.v1",
      served_at: "2026-05-25T14:00:15Z",
      error: { code: "not_found", message: "missing", request_id: "01HZX-X" },
    });
    assert.deepEqual(reasons, []);
  });
  it("rejects wrong schema_version", () => {
    const reasons = validateErrorEnvelope({
      schema_version: "read.health.v1",
      served_at: "2026-05-25T14:00:15Z",
      error: { code: "x", message: "x", request_id: "x" },
    });
    assert.ok(reasons.length > 0);
  });
  it("rejects missing error.code", () => {
    const reasons = validateErrorEnvelope({
      schema_version: "read.error.v1",
      served_at: "2026-05-25T14:00:15Z",
      error: { message: "x", request_id: "x" },
    });
    assert.ok(reasons.some((r) => r.includes("error.code")));
  });
});

describe("constants", () => {
  it("ENDPOINTS contains all minimum paths", () => {
    assert.equal(ENDPOINTS.health, "/v1/health");
    assert.equal(ENDPOINTS.publicConfig, "/v1/config/public");
    assert.equal(ENDPOINTS.featureFlags, "/v1/config/feature-flags");
    assert.equal(ENDPOINTS.symbols, "/v1/symbols");
    assert.equal(ENDPOINTS.sourceStatus, "/v1/source-status");
    assert.equal(ENDPOINTS.bundlesLatest, "/v1/bundles/latest");
    assert.equal(ENDPOINTS.blobBundle, "/v1/blobs/bundle/");
    assert.equal(ENDPOINTS.blobManifest, "/v1/blobs/manifest/");
  });
  it("READ_SOURCES are exactly the 4 R-001 sources", () => {
    assert.deepEqual([...READ_SOURCES].sort(), ["d1", "derived", "kv", "r2"]);
  });
});

describe("fetchHealth", () => {
  it("returns ok envelope with health data", async () => {
    const r = await fetchHealth(opts());
    assert.equal(r.kind, "ok");
    assert.equal(r.status, 200);
    assert.equal(r.envelope.schema_version, "read.health.v1");
    assert.ok(r.envelope.data.overall_status);
    assert.ok(typeof r.envelope.data.sources === "object");
    for (const src of ["bybit_public", "defillama_rest", "fred"]) {
      assert.ok(src in r.envelope.data.sources, `expected source: ${src}`);
    }
  });
  it("captures X-Bithub-Read-Source / Schema-Version / Request-Id headers", async () => {
    const r = await fetchHealth(opts());
    assert.equal(r.kind, "ok");
    assert.ok(r.headers.readSource && READ_SOURCES.has(r.headers.readSource));
    assert.equal(r.headers.schemaVersion, "read.health.v1");
    assert.ok(r.headers.requestId && r.headers.requestId.startsWith("01HZX-"));
  });
});

describe("fetchPublicConfig / fetchFeatureFlags", () => {
  it("public config envelope", async () => {
    const r = await fetchPublicConfig(opts());
    assert.equal(r.kind, "ok");
    assert.equal(r.envelope.schema_version, "read.public_config.v1");
  });
  it("feature flags envelope", async () => {
    const r = await fetchFeatureFlags(opts());
    assert.equal(r.kind, "ok");
    assert.equal(r.envelope.schema_version, "read.feature_flags.v1");
  });
});

describe("fetchSymbols", () => {
  it("returns symbol list with BTC/USDT:USDT", async () => {
    const r = await fetchSymbols(opts());
    assert.equal(r.kind, "ok");
    assert.equal(r.envelope.schema_version, "read.symbols.v1");
    const syms = (r.envelope.data.symbols || []).map((s) => s.symbol);
    assert.ok(syms.includes("BTC/USDT:USDT"));
  });
});

describe("fetchSourceStatus", () => {
  it("returns events list with 3 Phase 0 sources", async () => {
    const r = await fetchSourceStatus(opts());
    assert.equal(r.kind, "ok");
    assert.equal(r.envelope.schema_version, "read.source_status.v1");
    const events = r.envelope.data.events || [];
    const sources = new Set(events.map((e) => e.source));
    for (const s of ["bybit_public", "defillama_rest", "fred"]) {
      assert.ok(sources.has(s));
    }
  });
});

describe("fetchLatestBundle", () => {
  it("returns bundle envelope for BTC/USDT:USDT", async () => {
    const r = await fetchLatestBundle("BTC/USDT:USDT", opts());
    assert.equal(r.kind, "ok");
    assert.equal(r.envelope.schema_version, "read.bundle.v1");
    assert.equal(r.envelope.data.symbol, "BTC/USDT:USDT");
    assert.ok(r.envelope.data.section_statuses);
    for (const k of ["market", "derivatives", "fundamentals", "macro"]) {
      assert.ok(k in r.envelope.data.section_statuses);
    }
    assert.ok(
      typeof r.envelope.data.r2_bundle_key === "string"
        && r.envelope.data.r2_bundle_key.startsWith("bundles/")
    );
  });

  it("returns transport_error for empty symbol", async () => {
    const r = await fetchLatestBundle("", opts());
    assert.equal(r.kind, "transport_error");
  });

  it("returns error envelope for unsupported symbol", async () => {
    const r = await fetchLatestBundle("XRP/USDT:USDT", opts());
    assert.equal(r.kind, "error");
    assert.equal(r.status, 404);
    assert.equal(r.errorEnvelope.error.code, "unsupported_symbol");
  });

  it("returns error envelope for malformed symbol", async () => {
    const r = await fetchLatestBundle("lowercase/usdt:usdt", opts());
    assert.equal(r.kind, "error");
    assert.equal(r.status, 400);
    assert.equal(r.errorEnvelope.error.code, "validation_error");
  });
});

describe("blobs (503)", () => {
  it("blob bundle is reported as unavailable", async () => {
    const r = await fetchBlobBundle("01HZX-DUMMY-ID", opts());
    assert.equal(r.kind, "blob_unavailable");
    assert.equal(r.status, 503);
    assert.equal(r.warning, "blobs not available in skeleton");
    assert.equal(r.envelope.schema_version, "read.blob.v1");
    assert.equal(r.envelope.stale, true);
    assert.equal(r.envelope.data, null);
  });
  it("blob manifest is reported as unavailable", async () => {
    const r = await fetchBlobManifest("01HZX-DUMMY-ID", opts());
    assert.equal(r.kind, "blob_unavailable");
    assert.equal(r.status, 503);
    assert.equal(r.warning, "blobs not available in skeleton");
  });
  it("empty id returns transport_error before fetch", async () => {
    const r = await fetchBlobBundle("", opts());
    assert.equal(r.kind, "transport_error");
  });
});

describe("error paths", () => {
  it("404 unknown route returns error envelope", async () => {
    const r = await _internals.request("/v1/no-such-route", {}, opts());
    assert.equal(r.kind, "error");
    assert.equal(r.status, 404);
    assert.equal(r.errorEnvelope.schema_version, "read.error.v1");
    assert.equal(r.errorEnvelope.error.code, "not_found");
  });

  it("405 for POST returns error envelope", async () => {
    const r = await _internals.request("/v1/health", { method: "POST" }, opts());
    assert.equal(r.kind, "error");
    assert.equal(r.status, 405);
    assert.equal(r.errorEnvelope.error.code, "validation_error");
  });

  it("treats static Pages 200 read.error.v1 sentinel as explicit error", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({
        schema_version: "read.error.v1",
        served_at: "2026-05-26T00:00:00Z",
        error: {
          code: "api_unavailable_static_pages",
          message: "Read Worker is not deployed for this static Pages site.",
          request_id: "STATIC-PAGES-V1-GUARD",
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
    try {
      const r = await _internals.request("/v1/health", {}, {});
      assert.equal(r.kind, "error");
      assert.equal(r.status, 200);
      assert.equal(r.errorEnvelope.error.code, "api_unavailable_static_pages");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});

describe("no secret/PII in any response", () => {
  const FORBIDDEN = [
    "api_key=",
    "Bearer ",
    "X-API-Key",
    "X-BAPI-API-KEY",
    "BYBIT_PRIVATE",
    "FRED_API_KEY",
    "WEBHOOK_SIGNING_SECRET",
    "Authorization:",
  ];
  const PATHS = [
    "/v1/health",
    "/v1/config/public",
    "/v1/config/feature-flags",
    "/v1/symbols",
    "/v1/source-status",
    "/v1/bundles/latest?symbol=BTC%2FUSDT%3AUSDT",
    "/v1/blobs/bundle/01HZX-DUMMY",
    "/v1/blobs/manifest/01HZX-DUMMY",
    "/v1/no-such",
  ];
  for (const path of PATHS) {
    it(`scan body for ${path}`, async () => {
      const res = await fetch(`${base}${path}`);
      const text = await res.text();
      for (const tok of FORBIDDEN) {
        assert.ok(!text.includes(tok), `unexpected token ${tok} in ${path}`);
      }
    });
  }
});

describe("dev-server passes envelope bytes unchanged", () => {
  it("X-Bithub-Schema-Version matches body.schema_version", async () => {
    for (const path of [
      "/v1/health",
      "/v1/config/public",
      "/v1/config/feature-flags",
      "/v1/symbols",
      "/v1/source-status",
      "/v1/bundles/latest?symbol=BTC%2FUSDT%3AUSDT",
    ]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(
        res.headers.get("X-Bithub-Schema-Version"),
        body.schema_version,
        `mismatch on ${path}`
      );
    }
  });
});
