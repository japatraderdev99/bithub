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
const ORIGIN_BAD = "https://evil.example";
const BASE = "https://api.bit-hub.pro";

function makeReq(path, { method = "GET", origin } = {}) {
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  return new Request(BASE + path, { method, headers });
}

function loadFixture(name) {
  const raw = readFileSync(resolve(FIXTURES_DIR, name), "utf-8");
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
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
    assert.ok(_internals.ROUTE_FIXTURES);
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
      makeReq("/v1/health", { method: "OPTIONS", origin: ORIGIN_APP })
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
      makeReq("/v1/health", { method: "OPTIONS", origin: ORIGIN_BAD })
    );
    assert.equal(res.status, 403);
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

  test("GET com Origin proibido -> sem header CORS", async () => {
    const res = await handleRequest(
      makeReq("/v1/health", { origin: ORIGIN_BAD })
    );
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
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
