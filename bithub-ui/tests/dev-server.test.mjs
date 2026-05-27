// dev-server.test.mjs — testes do servidor local offline.
//
// Garantias:
// - Static fallback serve index.html para `/` com MIME correto.
// - MIME types corretos para `.css`, `.mjs`, `.html`.
// - 404 para paths que nao existem.
// - Tentativa de traversal e barrada (400/404).
// - /v1/* rotas atendidas pelo handleRequest (status 200/503/405/404 conforme contrato).
// - Sem cabecalho de auth, sem cookie, sem Set-Cookie.
// - Sem stack trace em paths /v1/* desconhecidos.

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createDevServer, PUBLIC_DIR, sanitizeUrlForLog } from "../scripts/dev-server.mjs";
import { validateErrorEnvelope } from "../public/app/read-client.mjs";

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

describe("static fallback", () => {
  it("/ -> 200 text/html index", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.ok((res.headers.get("content-type") || "").startsWith("text/html"));
    const body = await res.text();
    assert.ok(body.includes("Bithub"));
    assert.ok(body.includes("/app/main.mjs"));
  });

  it("/styles.css -> 200 text/css", async () => {
    const res = await fetch(`${base}/styles.css`);
    assert.equal(res.status, 200);
    assert.ok((res.headers.get("content-type") || "").startsWith("text/css"));
  });

  it("/app/main.mjs -> 200 text/javascript", async () => {
    const res = await fetch(`${base}/app/main.mjs`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") || "";
    assert.ok(
      ct.startsWith("text/javascript") || ct.startsWith("application/javascript"),
      `got ${ct}`
    );
  });

  it("/missing.png -> 404", async () => {
    const res = await fetch(`${base}/missing.png`);
    assert.equal(res.status, 404);
  });

  it("traversal attempt is blocked", async () => {
    const res = await fetch(`${base}/../README.md`);
    assert.ok([400, 404].includes(res.status), `got ${res.status}`);
  });

  it("static responses have nosniff + no-referrer", async () => {
    const res = await fetch(`${base}/styles.css`);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  });
});

describe("/v1/* routing via handleRequest", () => {
  it("GET /v1/health -> 200 envelope", async () => {
    const res = await fetch(`${base}/v1/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.schema_version, "read.health.v1");
  });

  it("HEAD /v1/health -> 200, empty body", async () => {
    const res = await fetch(`${base}/v1/health`, { method: "HEAD" });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, "");
  });

  it("GET /v1/blobs/bundle/x -> 503 with literal warning", async () => {
    const res = await fetch(`${base}/v1/blobs/bundle/01HZX-X`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.schema_version, "read.blob.v1");
    assert.deepEqual(body.warnings, ["blobs not available in skeleton"]);
  });

  it("POST /v1/health -> 405 with Allow header", async () => {
    const res = await fetch(`${base}/v1/health`, { method: "POST" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("Allow"), "GET, HEAD, OPTIONS");
  });

  it("GET /v1/unknown -> 404 with read.error.v1 envelope", async () => {
    const res = await fetch(`${base}/v1/unknown`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.schema_version, "read.error.v1");
    assert.equal(body.error.code, "not_found");
  });

  it("OPTIONS preflight with allowed origin -> 204 with CORS", async () => {
    const res = await fetch(`${base}/v1/health`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("Access-Control-Allow-Origin"),
      "http://localhost:3000"
    );
    assert.equal(res.headers.get("Access-Control-Allow-Credentials"), "true");
  });

  it("OPTIONS without origin -> 403", async () => {
    const res = await fetch(`${base}/v1/health`, { method: "OPTIONS" });
    assert.equal(res.status, 403);
  });

  it("does not emit Set-Cookie", async () => {
    const res = await fetch(`${base}/v1/health`);
    assert.equal(res.headers.get("Set-Cookie"), null);
  });
});

describe("/live/* local-only sidecar guard", () => {
  it("GET /live/positions is disabled unless explicitly enabled", async () => {
    const res = await fetch(`${base}/live/positions`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, "live tail not enabled");
    assert.equal(body.detail, null);
  });

  it("POST /live/positions is rejected read-only with Allow header", async () => {
    const res = await fetch(`${base}/live/positions`, { method: "POST" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("Allow"), "GET");
    assert.equal(await res.text(), "method not allowed");
  });

  it("static nav marks Live cockpit as local-only", async () => {
    const body = await readFile(join(PUBLIC_DIR, "index.html"), "utf8");
    assert.ok(body.includes('data-nav="/live" data-local-only="true"'));
    assert.ok(!body.toLowerCase().includes("/users/"));
  });

  it("Live cockpit view does not embed operator-local paths", async () => {
    const body = await readFile(join(PUBLIC_DIR, "app", "views", "live.mjs"), "utf8");
    assert.ok(!body.toLowerCase().includes("/users/"));
    assert.ok(!body.includes("Project Trading Agora Vai"));
  });
});

describe("hygiene", () => {
  it("PUBLIC_DIR resolves under bithub-ui/public", () => {
    assert.ok(PUBLIC_DIR.endsWith("/bithub-ui/public"));
  });

  it("response bodies never contain stack trace markers", async () => {
    const paths = [
      "/v1/health",
      "/v1/no-such",
      "/v1/blobs/bundle/x",
    ];
    for (const p of paths) {
      const res = await fetch(`${base}${p}`);
      const text = await res.text();
      assert.ok(!text.includes("at handle"), `stack leak in ${p}`);
      assert.ok(!text.includes("Traceback"), `traceback leak in ${p}`);
      assert.ok(!text.toLowerCase().includes("/users/"), `home path leak in ${p}: ${text.slice(0,80)}`);
    }
  });
});

describe("Cloudflare Pages static /v1 guard", () => {
  it("_redirects rewrites /v1/* before SPA fallback", async () => {
    const body = await readFile(join(PUBLIC_DIR, "_redirects"), "utf8");
    const rules = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    assert.ok(
      rules.includes("/v1/* /v1-api-unavailable.json 200"),
      "expected static /v1/* rewrite guard"
    );
  });

  it("static guard target is a valid read.error.v1 sentinel", async () => {
    const body = await readFile(join(PUBLIC_DIR, "v1-api-unavailable.json"), "utf8");
    const parsed = JSON.parse(body);
    assert.deepEqual(validateErrorEnvelope(parsed), []);
    assert.equal(parsed.error.code, "api_unavailable_static_pages");
    assert.ok(!("data" in parsed));
  });
});

describe("/dev/states module shape (no DOM)", () => {
  it("exports _internals with the 8+ minimum operational states", async () => {
    // Carrega o modulo dev-states sem invocar `render()` (que precisaria de
    // document). Verifica que o catalogo expoe os estados minimos.
    const mod = await import("../public/app/views/dev-states.mjs");
    assert.ok(mod._internals && Array.isArray(mod._internals.STATES));
    const ids = new Set(mod._internals.STATES.map((s) => s.id));
    const required = [
      "loading",
      "empty",
      "ok",
      "degraded",
      "stale",
      "partial",
      "error",
      "blob_unavailable",
    ];
    for (const id of required) {
      assert.ok(ids.has(id), `missing required state in dev gallery: ${id}`);
    }
  });

  it("dev-states module contains no forbidden operational vocabulary", async () => {
    // Defesa contra drift: se algum dev tentar exemplificar um sinal/score/
    // direction numa state card, o sweep aqui pega antes de virar runtime.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const body = readFileSync(
      resolve(__dirname, "..", "public", "app", "views", "dev-states.mjs"),
      "utf8"
    );
    // Comentarios podem citar a palavra para explicar a proibicao; checamos
    // ocorrencias *fora* de comentario via heuristica simples: palavras
    // proibidas nao podem aparecer dentro de string literais (`"..."`).
    const FORBIDDEN_AS_LITERAL = [
      '"signal"',
      "'signal'",
      '"score"',
      "'score'",
      '"direction"',
      "'direction'",
      '"regime"',
      "'regime'",
      '"trade_bias"',
      "'trade_bias'",
      '"recommendation"',
      "'recommendation'",
      '"confidence"',
      "'confidence'",
    ];
    for (const tok of FORBIDDEN_AS_LITERAL) {
      assert.ok(
        !body.includes(tok),
        `dev-states.mjs contains forbidden literal: ${tok}`
      );
    }
  });
});

describe("sanitizeUrlForLog", () => {
  it("returns path unchanged when there is no query string", () => {
    assert.equal(sanitizeUrlForLog("/v1/health"), "/v1/health");
    assert.equal(sanitizeUrlForLog("/styles.css"), "/styles.css");
    assert.equal(sanitizeUrlForLog("/"), "/");
  });

  it("strips query values and reports only key count (single key)", () => {
    assert.equal(
      sanitizeUrlForLog("/v1/bundles/latest?symbol=BTC%2FUSDT%3AUSDT"),
      "/v1/bundles/latest?<1 key>"
    );
  });

  it("strips query values and reports key count (multiple keys)", () => {
    assert.equal(
      sanitizeUrlForLog("/v1/source-status?source=fred&since=2026-05-26T00:00:00Z&limit=10"),
      "/v1/source-status?<3 keys>"
    );
  });

  it("collapses duplicate keys to unique count", () => {
    assert.equal(
      sanitizeUrlForLog("/v1/source-status?source=fred&source=bybit_public"),
      "/v1/source-status?<1 key>"
    );
  });

  it("never echoes value substrings (defense in depth)", () => {
    const secret = "api_key=sk-LEAKED-VALUE-must-not-appear";
    const out = sanitizeUrlForLog(`/v1/health?${secret}`);
    assert.equal(out, "/v1/health?<1 key>");
    assert.ok(!out.includes("sk-LEAKED-VALUE"));
    assert.ok(!out.includes("LEAKED"));
  });

  it("strips fragments before processing query", () => {
    assert.equal(
      sanitizeUrlForLog("/v1/bundles/latest?symbol=x#frag"),
      "/v1/bundles/latest?<1 key>"
    );
    assert.equal(sanitizeUrlForLog("/v1/health#frag"), "/v1/health");
  });

  it("handles empty / malformed inputs without crashing", () => {
    assert.equal(sanitizeUrlForLog(""), "/");
    assert.equal(sanitizeUrlForLog(undefined), "/");
    assert.equal(sanitizeUrlForLog(null), "/");
    assert.equal(sanitizeUrlForLog("/v1/health?"), "/v1/health");
  });
});
