// read-worker.test.mjs — testes node:test do skeleton (H-20260525-013).
//
// node:test + node:assert/strict apenas. Sem dependencia externa. Roda
// com `node --test bithub-read-worker/tests/read-worker.test.mjs`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { handleRequest, _internals } from "../src/index.mjs";
import workerDefault from "../src/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "..", "fixtures", "generated");

const ORIGIN_APP = "https://app.bit-hub.pro";
const ORIGIN_PAGES = "https://bithub-clo.pages.dev";
const ORIGIN_BAD = "https://evil.example";
const BASE = "https://api.bit-hub.pro";

function makeReq(path, { method = "GET", origin, headers: extraHeaders = {} } = {}) {
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }
  return new Request(BASE + path, { method, headers });
}

function loadFixture(name) {
  const raw = readFileSync(resolve(FIXTURES_DIR, name), "utf-8");
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

function fakeKV(entries) {
  const calls = [];
  return {
    calls,
    async get(key) {
      calls.push(key);
      return Object.prototype.hasOwnProperty.call(entries, key)
        ? entries[key]
        : null;
    },
  };
}

function fakeD1(entries) {
  const calls = [];
  return {
    calls,
    async getReadModel(kind, params) {
      calls.push({ kind, params });
      const key = kind === "latest_bundle"
        ? `latest_bundle:${params.symbol}`
        : kind;
      return Object.prototype.hasOwnProperty.call(entries, key)
        ? entries[key]
        : null;
    },
  };
}

// --------------------------------------------------------------------------
// Module surface
// --------------------------------------------------------------------------

describe("module surface", () => {
  test("exports handleRequest", () => {
    assert.equal(typeof handleRequest, "function");
  });

  test("default export has fetch handler (Cloudflare-shaped)", () => {
    assert.equal(typeof workerDefault.fetch, "function");
  });

  test("internals expose the canonical maps", () => {
    assert.ok(_internals.FIXTURES_DIR);
    assert.ok(_internals.CORS_ALLOWED_ORIGINS instanceof Set);
    assert.ok(_internals.CORS_PREFLIGHT_ALLOWED_REQUEST_METHODS instanceof Set);
    assert.ok(_internals.ROUTE_FIXTURES);
    assert.deepEqual(_internals.KV_BINDING_NAMES, ["KV_BITHUB", "KV"]);
    assert.deepEqual(_internals.D1_BINDING_NAMES, ["D1_BITHUB", "DB_BITHUB"]);
    assert.deepEqual(_internals.EDGE_POLICY_BINDING_NAMES, ["EDGE_POLICY", "READ_EDGE_POLICY"]);
    assert.equal(_internals.KV_KEY_PUBLIC_CONFIG, "public_config");
    assert.equal(_internals.KV_KEY_FEATURE_FLAGS, "feature_flags");
    assert.equal(_internals.KV_KEY_LATEST_HEALTH, "latest_health:data_layer");
    assert.equal(_internals.KV_PREFIX_LATEST_BUNDLE, "latest_bundle:");
    assert.equal(_internals.BLOB_BUNDLE_PREFIX, "/v1/blobs/bundle/");
    assert.equal(_internals.BLOB_MANIFEST_PREFIX, "/v1/blobs/manifest/");
  });
});

// --------------------------------------------------------------------------
// Endpoints minimos /v1/*
// --------------------------------------------------------------------------

const MIN_ROUTES = [
  { path: "/v1/health", schema: "read.health.v1", fixture: "health.json" },
  { path: "/v1/config/public", schema: "read.public_config.v1", fixture: "public-config.json" },
  { path: "/v1/config/feature-flags", schema: "read.feature_flags.v1", fixture: "feature-flags.json" },
  { path: "/v1/symbols", schema: "read.symbols.v1", fixture: "symbols.json" },
  { path: "/v1/source-status", schema: "read.source_status.v1", fixture: "source-status.json" },
];

describe("endpoints minimos GET", () => {
  for (const route of MIN_ROUTES) {
    test(`GET ${route.path} -> 200 com envelope canonico`, async () => {
      const res = await handleRequest(makeReq(route.path));
      assert.equal(res.status, 200);
      assert.equal(
        res.headers.get("Content-Type"),
        "application/json; charset=utf-8"
      );
      assert.equal(
        res.headers.get("X-Bithub-Schema-Version"),
        route.schema
      );
      const cc = res.headers.get("Cache-Control");
      assert.ok(cc && cc.startsWith("private,"), `unexpected cache-control: ${cc}`);
      const body = await res.text();
      // Bytes batem com a fixture canonica em disco.
      assert.equal(body, loadFixture(route.fixture));
      // JSON parseavel + shape canonico.
      const parsed = JSON.parse(body);
      assert.equal(parsed.schema_version, route.schema);
      assert.ok("as_of" in parsed);
      assert.ok("served_at" in parsed);
      assert.ok("source" in parsed);
      assert.equal(typeof parsed.stale, "boolean");
      assert.ok("data" in parsed);
      assert.ok(Array.isArray(parsed.warnings));
    });

    test(`HEAD ${route.path} -> 200 sem body, mesmos headers`, async () => {
      const res = await handleRequest(makeReq(route.path, { method: "HEAD" }));
      assert.equal(res.status, 200);
      assert.equal(
        res.headers.get("X-Bithub-Schema-Version"),
        route.schema
      );
      const body = await res.text();
      assert.equal(body, "");
    });
  }
});

describe("/v1/bundles/latest", () => {
  test("GET com symbol valido (BTC/USDT:USDT) -> 200", async () => {
    const res = await handleRequest(
      makeReq("/v1/bundles/latest?symbol=BTC%2FUSDT%3AUSDT")
    );
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("X-Bithub-Schema-Version"),
      "read.bundle.v1"
    );
    const body = await res.text();
    assert.equal(body, loadFixture("bundles-latest-BTC_USDT_USDT.json"));
    const parsed = JSON.parse(body);
    assert.equal(parsed.schema_version, "read.bundle.v1");
    assert.equal(parsed.data.symbol, "BTC/USDT:USDT");
  });

  test("HEAD com symbol valido -> 200 sem body", async () => {
    const res = await handleRequest(
      makeReq("/v1/bundles/latest?symbol=BTC%2FUSDT%3AUSDT", { method: "HEAD" })
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  test("GET sem symbol -> 400 validation_error", async () => {
    const res = await handleRequest(makeReq("/v1/bundles/latest"));
    assert.equal(res.status, 400);
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.schema_version, "read.error.v1");
    assert.equal(parsed.error.code, "validation_error");
  });

  test("GET com symbol fora do allowlist -> 404 unsupported_symbol", async () => {
    const res = await handleRequest(
      makeReq("/v1/bundles/latest?symbol=DOGE%2FUSDT%3AUSDT")
    );
    assert.equal(res.status, 404);
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.error.code, "unsupported_symbol");
  });

  test("GET com symbol mal-formado -> 400 validation_error", async () => {
    const res = await handleRequest(
      makeReq("/v1/bundles/latest?symbol=not-a-symbol")
    );
    assert.equal(res.status, 400);
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.error.code, "validation_error");
  });
});

// --------------------------------------------------------------------------
// RW-2: KV fake/local read bindings
// --------------------------------------------------------------------------

describe("RW-2 KV fake/local binding", () => {
  test("sem binding KV continua servindo bytes exatos das fixtures", async () => {
    for (const route of MIN_ROUTES) {
      const res = await handleRequest(makeReq(route.path));
      assert.equal(await res.text(), loadFixture(route.fixture));
    }
    const bundle = await handleRequest(
      makeReq("/v1/bundles/latest?symbol=BTC%2FUSDT%3AUSDT")
    );
    assert.equal(await bundle.text(), loadFixture("bundles-latest-BTC_USDT_USDT.json"));
  });

  test("usa env.KV_BITHUB.get(key) para public_config", async () => {
    const kvEnvelope = {
      as_of: "2026-05-26T10:00:00Z",
      data: {
        api_version: "v1",
        build_id: "rw2-kv-fake",
        feature_flags: { read_worker_enabled: true, show_audit_panel: false },
        supported_symbols_url: "/v1/symbols",
      },
      schema_version: "read.public_config.v1",
      served_at: "2026-05-26T10:00:01Z",
      source: "kv",
      stale: false,
      warnings: ["kv-fake"],
    };
    const KV_BITHUB = fakeKV({
      public_config: JSON.stringify(kvEnvelope),
    });
    const res = await handleRequest(makeReq("/v1/config/public"), { KV_BITHUB });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Bithub-Read-Source"), "kv");
    assert.equal(res.headers.get("X-Bithub-Schema-Version"), "read.public_config.v1");
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.data.build_id, "rw2-kv-fake");
    assert.deepEqual(parsed.warnings, ["kv-fake"]);
    assert.deepEqual(KV_BITHUB.calls, ["public_config"]);
  });

  test("usa env.KV_BITHUB.get(key) para feature_flags read-model compacto", async () => {
    const KV_BITHUB = fakeKV({
      feature_flags: JSON.stringify({
        read_worker_enabled: true,
        show_audit_panel: false,
      }),
    });
    const res = await handleRequest(
      makeReq("/v1/config/feature-flags", { method: "HEAD" }),
      { KV_BITHUB }
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Bithub-Schema-Version"), "read.feature_flags.v1");
    assert.equal(await res.text(), "");
    assert.deepEqual(KV_BITHUB.calls, ["feature_flags"]);
  });

  test("usa env.KV_BITHUB.get(key) para latest_health:data_layer", async () => {
    const KV_BITHUB = fakeKV({
      "latest_health:data_layer": JSON.stringify({
        schema_version: "kv.latest_health.v1",
        as_of: "2026-05-26T10:02:00Z",
        generated_at: "2026-05-26T10:02:03Z",
        overall_status: "ok",
        sources: {
          bybit_public: {
            cache_hit: true,
            degraded: false,
            error_code: null,
            last_event_at: "2026-05-26T10:02:00Z",
            latency_ms: 1,
            status: "ok",
          },
        },
      }),
    });
    const res = await handleRequest(makeReq("/v1/health"), { KV_BITHUB });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Bithub-Schema-Version"), "read.health.v1");
    assert.equal(res.headers.get("X-Bithub-Read-Source"), "kv");
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.as_of, "2026-05-26T10:02:00Z");
    assert.equal(parsed.served_at, "2026-05-26T10:02:03Z");
    assert.equal(parsed.data.overall_status, "ok");
    assert.equal(parsed.data.sources.bybit_public.cache_hit, true);
    assert.deepEqual(KV_BITHUB.calls, ["latest_health:data_layer"]);
  });

  test("usa env.KV_BITHUB.get(key) para latest_bundle:{symbol}", async () => {
    const KV_BITHUB = fakeKV({
      "latest_bundle:BTC/USDT:USDT": JSON.stringify({
        schema_version: "kv.latest_bundle.v1",
        as_of: "2026-05-26T10:03:00Z",
        bundle_created_at: "2026-05-26T10:03:05Z",
        overall_status: "ok",
        stale: false,
        symbol: "BTC/USDT:USDT",
        section_statuses: {
          market: {
            error_code: null,
            mandatory: true,
            present: true,
            source: "bybit_public",
            stale: false,
            status: "ok",
          },
        },
        snapshot_refs: { market: "01HZXKVFAKE000000000000001" },
        r2_bundle_key: "bundles/2026-05-26/BTC_USDT_USDT/01HZXKVFAKE000000000000001.json",
      }),
    });
    const res = await handleRequest(
      makeReq("/v1/bundles/latest?symbol=BTC%2FUSDT%3AUSDT"),
      { KV_BITHUB }
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Bithub-Schema-Version"), "read.bundle.v1");
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.data.symbol, "BTC/USDT:USDT");
    assert.equal(parsed.data.overall_status, "ok");
    assert.equal(parsed.served_at, "2026-05-26T10:03:05Z");
    assert.deepEqual(KV_BITHUB.calls, ["latest_bundle:BTC/USDT:USDT"]);
  });

  test("KV miss em health com binding local e sem D1 falha fechado", async () => {
    const KV_BITHUB = fakeKV({});
    const res = await handleRequest(makeReq("/v1/health"), { KV_BITHUB });
    assert.equal(res.status, 503);
    const body = await res.text();
    const parsed = JSON.parse(body);
    assert.equal(parsed.schema_version, "read.error.v1");
    assert.equal(parsed.error.code, "network_error");
    assert.ok(!body.includes("TypeError"));
    assert.deepEqual(KV_BITHUB.calls, ["latest_health:data_layer"]);
  });

  test("KV com JSON invalido falha fechado com read.error.v1 sem stack", async () => {
    const KV_BITHUB = fakeKV({ public_config: "{not-json" });
    const res = await handleRequest(makeReq("/v1/config/public"), { KV_BITHUB });
    assert.equal(res.status, 502);
    assert.equal(res.headers.get("X-Bithub-Schema-Version"), "read.error.v1");
    const body = await res.text();
    const parsed = JSON.parse(body);
    assert.equal(parsed.error.code, "network_error");
    assert.ok(!body.includes("SyntaxError"));
  });

  test("default fetch repassa env para handleRequest", async () => {
    const KV_BITHUB = fakeKV({
      public_config: JSON.stringify({
        as_of: "2026-05-26T10:04:00Z",
        data: {
          api_version: "v1",
          build_id: "default-fetch-kv",
          feature_flags: { read_worker_enabled: true },
          supported_symbols_url: "/v1/symbols",
        },
        schema_version: "read.public_config.v1",
        served_at: "2026-05-26T10:04:01Z",
        source: "kv",
        stale: false,
        warnings: [],
      }),
    });
    const res = await workerDefault.fetch(makeReq("/v1/config/public"), { KV_BITHUB });
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.data.build_id, "default-fetch-kv");
  });
});

// --------------------------------------------------------------------------
// RW-3: D1 fake/local fallback
// --------------------------------------------------------------------------

describe("RW-3 D1 fake/local fallback", () => {
  test("KV ausente + D1 presente serve /v1/health de D1, nao fixture", async () => {
    const D1_BITHUB = fakeD1({
      latest_health: JSON.stringify({
        schema_version: "kv.latest_health.v1",
        as_of: "2026-05-26T10:59:00Z",
        generated_at: "2026-05-26T10:59:01Z",
        overall_status: "ok",
        sources: {
          bybit_public: {
            cache_hit: false,
            degraded: false,
            error_code: null,
            last_event_at: "2026-05-26T10:59:00Z",
            latency_ms: 4,
            status: "ok",
          },
        },
      }),
    });
    const res = await handleRequest(makeReq("/v1/health"), { D1_BITHUB });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Bithub-Read-Source"), "d1");
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.as_of, "2026-05-26T10:59:00Z");
    assert.deepEqual(parsed.warnings, ["kv-absent-served-from-d1"]);
  });

  test("KV miss -> D1 fallback para /v1/health", async () => {
    const KV_BITHUB = fakeKV({});
    const D1_BITHUB = fakeD1({
      latest_health: JSON.stringify({
        schema_version: "kv.latest_health.v1",
        as_of: "2026-05-26T11:00:00Z",
        generated_at: "2026-05-26T11:00:02Z",
        overall_status: "degraded",
        sources: {
          fred: {
            cache_hit: false,
            degraded: true,
            error_code: "bad_response",
            last_event_at: "2026-05-26T11:00:00Z",
            latency_ms: 25,
            status: "degraded",
          },
        },
      }),
    });
    const res = await handleRequest(makeReq("/v1/health"), { KV_BITHUB, D1_BITHUB });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Bithub-Read-Source"), "d1");
    assert.equal(res.headers.get("X-Bithub-Schema-Version"), "read.health.v1");
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.source, "d1");
    assert.equal(parsed.data.overall_status, "degraded");
    assert.deepEqual(parsed.warnings, ["kv-miss-served-from-d1"]);
    assert.deepEqual(KV_BITHUB.calls, ["latest_health:data_layer"]);
    assert.deepEqual(D1_BITHUB.calls, [
      { kind: "latest_health", params: {} },
    ]);
  });

  test("KV miss -> D1 fallback para /v1/bundles/latest", async () => {
    const KV_BITHUB = fakeKV({});
    const D1_BITHUB = fakeD1({
      "latest_bundle:BTC/USDT:USDT": JSON.stringify({
        schema_version: "kv.latest_bundle.v1",
        as_of: "2026-05-26T11:01:00Z",
        bundle_created_at: "2026-05-26T11:01:05Z",
        overall_status: "ok",
        stale: false,
        symbol: "BTC/USDT:USDT",
        section_statuses: {
          market: {
            error_code: null,
            mandatory: true,
            present: true,
            source: "bybit_public",
            stale: false,
            status: "ok",
          },
        },
        snapshot_refs: { market: "01HZXD1FAKE000000000000001" },
        r2_bundle_key: "bundles/2026-05-26/BTC_USDT_USDT/01HZXD1FAKE000000000000001.json",
      }),
    });
    const res = await handleRequest(
      makeReq("/v1/bundles/latest?symbol=BTC%2FUSDT%3AUSDT"),
      { KV_BITHUB, D1_BITHUB }
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Bithub-Read-Source"), "d1");
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.source, "d1");
    assert.equal(parsed.data.symbol, "BTC/USDT:USDT");
    assert.deepEqual(parsed.warnings, ["kv-miss-served-from-d1"]);
    assert.deepEqual(D1_BITHUB.calls, [
      {
        kind: "latest_bundle",
        params: {
          symbol: "BTC/USDT:USDT",
          kvKey: "latest_bundle:BTC/USDT:USDT",
        },
      },
    ]);
  });

  test("KV stale -> D1 fallback preservando warning canonico", async () => {
    const KV_BITHUB = fakeKV({
      "latest_health:data_layer": JSON.stringify({
        schema_version: "kv.latest_health.v1",
        as_of: "2026-05-26T10:00:00Z",
        generated_at: "2026-05-26T10:00:02Z",
        overall_status: "ok",
        stale: true,
        sources: {
          bybit_public: {
            cache_hit: true,
            degraded: false,
            error_code: null,
            last_event_at: "2026-05-26T10:00:00Z",
            latency_ms: 2,
            status: "ok",
          },
        },
      }),
    });
    const D1_BITHUB = fakeD1({
      latest_health: {
        schema_version: "read.health.v1",
        as_of: "2026-05-26T11:02:00Z",
        served_at: "2026-05-26T11:02:03Z",
        source: "derived",
        stale: false,
        data: {
          overall_status: "ok",
          sources: {
            bybit_public: {
              cache_hit: false,
              degraded: false,
              error_code: null,
              last_event_at: "2026-05-26T11:02:00Z",
              latency_ms: 3,
              status: "ok",
            },
          },
        },
        warnings: ["d1-rederived"],
      },
    });
    const res = await handleRequest(makeReq("/v1/health"), { KV_BITHUB, D1_BITHUB });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.source, "d1");
    assert.deepEqual(parsed.warnings, [
      "d1-rederived",
      "kv-stale-served-from-d1",
    ]);
  });

  test("KV invalido -> D1 fallback controlado sem stack", async () => {
    const KV_BITHUB = fakeKV({ "latest_health:data_layer": "{not-json" });
    const D1_BITHUB = fakeD1({
      latest_health: JSON.stringify({
        schema_version: "kv.latest_health.v1",
        as_of: "2026-05-26T11:03:00Z",
        generated_at: "2026-05-26T11:03:01Z",
        overall_status: "ok",
        sources: {
          bybit_public: {
            cache_hit: false,
            degraded: false,
            error_code: null,
            last_event_at: "2026-05-26T11:03:00Z",
            latency_ms: 1,
            status: "ok",
          },
        },
      }),
    });
    const res = await handleRequest(makeReq("/v1/health"), { KV_BITHUB, D1_BITHUB });
    assert.equal(res.status, 200);
    const body = await res.text();
    const parsed = JSON.parse(body);
    assert.equal(parsed.source, "d1");
    assert.deepEqual(parsed.warnings, ["kv-error-served-from-d1"]);
    assert.ok(!body.includes("SyntaxError"));
  });

  test("D1 indisponivel -> read.error.v1 503 sem stack", async () => {
    const KV_BITHUB = fakeKV({});
    const D1_BITHUB = fakeD1({});
    const res = await handleRequest(makeReq("/v1/health"), { KV_BITHUB, D1_BITHUB });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("X-Bithub-Schema-Version"), "read.error.v1");
    const body = await res.text();
    const parsed = JSON.parse(body);
    assert.equal(parsed.error.code, "network_error");
    assert.equal(parsed.error.message, "D1 fallback unavailable");
    assert.ok(!body.includes("Error:"));
    assert.ok(!body.includes("at getReadModel"));
  });
});

// --------------------------------------------------------------------------
// /v1/blobs/* -> 503 com warning literal
// --------------------------------------------------------------------------

describe("/v1/blobs/* stubado como 503", () => {
  const cases = [
    "/v1/blobs/bundle/01HZX5R7Q3M2K4P8N6B1Y9BUN00",
    "/v1/blobs/bundle/anything",
    "/v1/blobs/manifest/01HZX5R7Q3M2K4P8N6B1Y9MAN00",
    "/v1/blobs/manifest/anything",
  ];
  for (const path of cases) {
    test(`GET ${path} -> 503 com warning literal`, async () => {
      const res = await handleRequest(makeReq(path));
      assert.equal(res.status, 503);
      const parsed = JSON.parse(await res.text());
      assert.ok(Array.isArray(parsed.warnings));
      assert.deepEqual(parsed.warnings, [
        "blobs not available in skeleton",
      ]);
      assert.equal(parsed.stale, true);
    });

    test(`HEAD ${path} -> 503 sem body`, async () => {
      const res = await handleRequest(makeReq(path, { method: "HEAD" }));
      assert.equal(res.status, 503);
      assert.equal(await res.text(), "");
    });
  }
});

// --------------------------------------------------------------------------
// Methods
// --------------------------------------------------------------------------

describe("metodos != GET/HEAD/OPTIONS -> 405", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    test(`${method} /v1/health -> 405`, async () => {
      const res = await handleRequest(makeReq("/v1/health", { method }));
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("Allow"), "GET, HEAD, OPTIONS");
      const parsed = JSON.parse(await res.text());
      assert.equal(parsed.error.code, "validation_error");
    });
  }
});

// --------------------------------------------------------------------------
// Rotas desconhecidas -> envelope read.error.v1 sem stack/segredo
// --------------------------------------------------------------------------

describe("rotas desconhecidas", () => {
  test("GET /v1/nada -> 404 sem stack/segredo", async () => {
    const res = await handleRequest(makeReq("/v1/nada"));
    assert.equal(res.status, 404);
    const body = await res.text();
    const parsed = JSON.parse(body);
    assert.equal(parsed.schema_version, "read.error.v1");
    assert.equal(parsed.error.code, "not_found");
    // Sem stack, sem segredo (defesa em profundidade).
    for (const tok of [
      "Traceback",
      "at handleRequest",
      "api_key",
      "Bearer ",
      "Authorization",
      "X-API-Key",
      "BYBIT_PRIVATE",
      "FRED_API_KEY",
    ]) {
      assert.ok(!body.includes(tok), `unexpected token ${tok} in body`);
    }
  });

  test("GET / -> 404 (raiz nao mapeada)", async () => {
    const res = await handleRequest(makeReq("/"));
    assert.equal(res.status, 404);
  });
});

// --------------------------------------------------------------------------
// CORS stub
// --------------------------------------------------------------------------

describe("CORS stub allowlist", () => {
  test("OPTIONS com Origin permitido -> 204 com headers CORS", async () => {
    const res = await handleRequest(
      makeReq("/v1/health", {
        method: "OPTIONS",
        origin: ORIGIN_APP,
        headers: { "Access-Control-Request-Method": "GET" },
      })
    );
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("Access-Control-Allow-Origin"),
      ORIGIN_APP
    );
    assert.equal(res.headers.get("Access-Control-Allow-Methods"), "GET, HEAD, OPTIONS");
    assert.equal(
      res.headers.get("Access-Control-Allow-Credentials"),
      "true"
    );
  });

  test("OPTIONS com Origin nao permitido -> 403", async () => {
    const res = await handleRequest(
      makeReq("/v1/health", {
        method: "OPTIONS",
        origin: ORIGIN_BAD,
        headers: { "Access-Control-Request-Method": "GET" },
      })
    );
    assert.equal(res.status, 403);
  });

  test("OPTIONS com metodo solicitado nao permitido -> 403", async () => {
    const res = await handleRequest(
      makeReq("/v1/health", {
        method: "OPTIONS",
        origin: ORIGIN_APP,
        headers: { "Access-Control-Request-Method": "POST" },
      })
    );
    assert.equal(res.status, 403);
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.schema_version, "read.error.v1");
    assert.equal(parsed.error.code, "validation_error");
    assert.equal(parsed.error.message, "preflight not allowed");
  });

  test("OPTIONS sem Access-Control-Request-Method -> 403", async () => {
    const res = await handleRequest(
      makeReq("/v1/health", { method: "OPTIONS", origin: ORIGIN_APP })
    );
    assert.equal(res.status, 403);
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.error.message, "preflight not allowed");
  });

  test("OPTIONS sem Origin -> 403", async () => {
    const res = await handleRequest(
      makeReq("/v1/health", { method: "OPTIONS" })
    );
    assert.equal(res.status, 403);
  });

  test("GET com Origin permitido -> ACAO no header", async () => {
    const res = await handleRequest(
      makeReq("/v1/health", { origin: ORIGIN_APP })
    );
    assert.equal(
      res.headers.get("Access-Control-Allow-Origin"),
      ORIGIN_APP
    );
  });

  test("GET com Pages production atual -> ACAO no header", async () => {
    const res = await handleRequest(
      makeReq("/v1/health", { origin: ORIGIN_PAGES })
    );
    assert.equal(
      res.headers.get("Access-Control-Allow-Origin"),
      ORIGIN_PAGES
    );
  });

  test("GET com Origin proibido -> sem header CORS", async () => {
    const res = await handleRequest(
      makeReq("/v1/health", { origin: ORIGIN_BAD })
    );
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  });
});

// --------------------------------------------------------------------------
// RW-7: edge policy fake/local
// --------------------------------------------------------------------------

describe("RW-7 edge policy fake/local", () => {
  test("EDGE_POLICY.checkAccess missing -> 401 read.error.v1 sem ecoar header", async () => {
    const EDGE_POLICY = {
      checkAccess() {
        return { action: "missing" };
      },
    };
    const res = await handleRequest(
      makeReq("/v1/health", {
        headers: {
          "Cf-Access-Jwt-Assertion": "Bearer SECRET.JWT.VALUE",
        },
      }),
      { EDGE_POLICY }
    );
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("X-Bithub-Schema-Version"), "read.error.v1");
    const body = await res.text();
    const parsed = JSON.parse(body);
    assert.equal(parsed.error.code, "auth_error");
    assert.equal(parsed.error.message, "access credential missing");
    assert.ok(!body.includes("SECRET.JWT.VALUE"));
    assert.ok(!body.includes("Cf-Access-Jwt-Assertion"));
  });

  test("READ_EDGE_POLICY.checkAccess denied -> 403 read.error.v1", async () => {
    const READ_EDGE_POLICY = {
      checkAccess() {
        return { action: "denied" };
      },
    };
    const res = await handleRequest(makeReq("/v1/health"), { READ_EDGE_POLICY });
    assert.equal(res.status, 403);
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.error.code, "auth_error");
    assert.equal(parsed.error.message, "access denied");
  });

  test("EDGE_POLICY.checkRateLimit limited -> 429 com Retry-After", async () => {
    const EDGE_POLICY = {
      checkAccess() {
        return { action: "allow" };
      },
      checkRateLimit() {
        return { action: "limited", retryAfterSeconds: 17 };
      },
    };
    const res = await handleRequest(makeReq("/v1/health"), { EDGE_POLICY });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "17");
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.error.code, "rate_limited");
    assert.equal(parsed.error.message, "rate limit exceeded");
  });

  test("EDGE_POLICY allow -> request segue comportamento normal", async () => {
    const EDGE_POLICY = {
      checkAccess(context) {
        assert.equal(context.path, "/v1/health");
        assert.equal(context.url, "/v1/health");
        return { action: "allow" };
      },
      checkRateLimit() {
        return { action: "allow" };
      },
    };
    const res = await handleRequest(makeReq("/v1/health"), { EDGE_POLICY });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), loadFixture("health.json"));
  });

  test("EDGE_POLICY.log recebe evento sanitizado e deterministico", async () => {
    const events = [];
    const EDGE_POLICY = {
      log(event) {
        events.push(event);
      },
    };
    const res = await handleRequest(
      makeReq("/v1/bundles/latest?symbol=BTC%2FUSDT%3AUSDT&token=BearerSecret", {
        headers: {
          Authorization: "Bearer SHOULD_NOT_LOG",
          Cookie: "session=SHOULD_NOT_LOG",
        },
      }),
      { EDGE_POLICY }
    );
    assert.equal(res.status, 200);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      at: "2026-05-25T14:00:15Z",
      duration_ms: 0,
      method: "GET",
      path: "/v1/bundles/latest?<2 keys>",
      request_id: "01HZX-SKEL-1B58DD73",
      schema_version: "read.bundle.v1",
      source: "kv",
      status: 200,
    });
    const raw = JSON.stringify(events[0]);
    for (const forbidden of [
      "BTC%2FUSDT",
      "BearerSecret",
      "SHOULD_NOT_LOG",
      "Authorization",
      "Cookie",
    ]) {
      assert.ok(!raw.includes(forbidden), `log leaked ${forbidden}`);
    }
  });

  test("sanitizeUrlForLog conta chaves sem valores", () => {
    assert.equal(
      _internals.sanitizeUrlForLog("https://api.bit-hub.pro/v1/health"),
      "/v1/health"
    );
    assert.equal(
      _internals.sanitizeUrlForLog("https://api.bit-hub.pro/v1/x?a=secret&a=other&b=2#frag"),
      "/v1/x?<2 keys>"
    );
    assert.equal(_internals.sanitizeUrlForLog("not a url"), "/");
  });
});

// --------------------------------------------------------------------------
// Headers basicos / Vary / X-Bithub-Request-Id determinista
// --------------------------------------------------------------------------

describe("headers basicos", () => {
  test("Vary inclui Origin e Cf-Access-Jwt-Assertion", async () => {
    const res = await handleRequest(makeReq("/v1/health"));
    const vary = res.headers.get("Vary");
    assert.ok(vary && vary.includes("Origin"), `Vary: ${vary}`);
    assert.ok(
      vary && vary.includes("Cf-Access-Jwt-Assertion"),
      `Vary: ${vary}`
    );
  });

  test("X-Bithub-Request-Id determinista por path", async () => {
    const a = await handleRequest(makeReq("/v1/health"));
    const b = await handleRequest(makeReq("/v1/health"));
    assert.equal(
      a.headers.get("X-Bithub-Request-Id"),
      b.headers.get("X-Bithub-Request-Id")
    );
    assert.ok(
      a.headers.get("X-Bithub-Request-Id").startsWith("01HZX-SKEL-")
    );
  });

  test("X-Bithub-Read-Source bate com a fixture (kv/d1/derived)", async () => {
    const health = await handleRequest(makeReq("/v1/health"));
    assert.equal(health.headers.get("X-Bithub-Read-Source"), "kv");
    const sourceStatus = await handleRequest(makeReq("/v1/source-status"));
    assert.equal(sourceStatus.headers.get("X-Bithub-Read-Source"), "d1");
  });

  test("nao emite headers aplicativos sensiveis", async () => {
    for (const path of [
      "/v1/health",
      "/v1/no-such",
      "/v1/blobs/bundle/whatever",
    ]) {
      const res = await handleRequest(makeReq(path));
      for (const header of [
        "Authorization",
        "Set-Cookie",
        "X-Powered-By",
        "X-Forwarded-For",
        "X-Real-IP",
      ]) {
        assert.equal(res.headers.get(header), null, `${path} emitted ${header}`);
      }
    }
  });
});

// --------------------------------------------------------------------------
// Envelope canonico shape (bytes em todas as rotas /v1/*)
// --------------------------------------------------------------------------

describe("envelope canonico em todas as rotas", () => {
  test("todos os endpoints minimos retornam envelope canonico R-001 5.1", async () => {
    for (const route of MIN_ROUTES) {
      const res = await handleRequest(makeReq(route.path));
      const parsed = JSON.parse(await res.text());
      assert.equal(
        Object.keys(parsed).sort().join(","),
        ["as_of", "data", "schema_version", "served_at", "source", "stale", "warnings"].join(","),
        `envelope shape mismatch for ${route.path}`
      );
    }
  });
});

// --------------------------------------------------------------------------
// Defesa em profundidade: sem segredo/PII em nenhuma resposta
// --------------------------------------------------------------------------

const FORBIDDEN_TOKENS = [
  "api_key=",
  "Bearer ",
  "X-API-Key",
  "X-BAPI-API-KEY",
  "BYBIT_PRIVATE",
  "FRED_API_KEY",
  "WEBHOOK_SIGNING_SECRET",
];

describe("defesa em profundidade: sem segredo/PII", () => {
  const paths = [
    "/v1/health",
    "/v1/config/public",
    "/v1/config/feature-flags",
    "/v1/symbols",
    "/v1/source-status",
    "/v1/bundles/latest?symbol=BTC%2FUSDT%3AUSDT",
    "/v1/blobs/bundle/whatever",
    "/v1/blobs/manifest/whatever",
    "/v1/nada",
  ];
  for (const path of paths) {
    test(`${path} nao expoe segredo/PII`, async () => {
      const res = await handleRequest(makeReq(path));
      const body = await res.text();
      for (const tok of FORBIDDEN_TOKENS) {
        assert.ok(
          !body.includes(tok),
          `${path} expoe ${tok} no body`
        );
      }
    });
  }
});
