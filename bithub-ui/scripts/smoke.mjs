// smoke.mjs — smoke offline para UI-1.
//
// Sobe um servidor local efemero (porta dinamica), faz GET em cada
// endpoint minimo via fetch, valida envelope canonico e imprime o
// resumo.
//
// Uso:
//   node bithub-ui/scripts/smoke.mjs
//
// Sai com codigo 0 se todos os endpoints validam; 1 se algum falha.

import { createDevServer } from "./dev-server.mjs";
import { validateEnvelope, validateErrorEnvelope } from "../public/app/read-client.mjs";

const CASES = [
  { method: "GET", path: "/v1/health", expect: "envelope" },
  { method: "GET", path: "/v1/config/public", expect: "envelope" },
  { method: "GET", path: "/v1/config/feature-flags", expect: "envelope" },
  { method: "GET", path: "/v1/symbols", expect: "envelope" },
  { method: "GET", path: "/v1/source-status", expect: "envelope" },
  { method: "GET", path: "/v1/bundles/latest?symbol=BTC%2FUSDT%3AUSDT", expect: "envelope" },
  { method: "GET", path: "/v1/blobs/bundle/01HZX-DUMMY", expect: "blob503" },
  { method: "GET", path: "/v1/blobs/manifest/01HZX-DUMMY", expect: "blob503" },
  { method: "POST", path: "/v1/health", expect: "error405" },
  { method: "GET", path: "/v1/unknown-route", expect: "error404" },
];

const STATIC_CASES = [
  { method: "GET", path: "/", expectStatus: 200, expectMime: "text/html" },
  { method: "GET", path: "/styles.css", expectStatus: 200, expectMime: "text/css" },
  { method: "GET", path: "/app/main.mjs", expectStatus: 200, expectMime: "text/javascript" },
  { method: "GET", path: "/does-not-exist.png", expectStatus: 404 },
];

async function main() {
  const server = createDevServer();
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  // eslint-disable-next-line no-console
  console.log(`smoke base: ${base}`);

  const results = [];

  for (const tc of CASES) {
    const r = await runCase(base, tc);
    results.push(r);
  }
  for (const tc of STATIC_CASES) {
    const r = await runStaticCase(base, tc);
    results.push(r);
  }

  server.close();

  const failures = results.filter((r) => !r.ok);
  for (const r of results) {
    const tag = r.ok ? "OK" : "FAIL";
    // eslint-disable-next-line no-console
    console.log(`  [${tag}] ${r.method} ${r.path} -> ${r.status} (${r.detail})`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nsmoke summary: ${results.length - failures.length}/${results.length} ok`
  );
  if (failures.length > 0) process.exit(1);
}

async function runCase(base, tc) {
  const url = `${base}${tc.path}`;
  let response;
  try {
    response = await fetch(url, { method: tc.method });
  } catch (err) {
    return mkRes(tc, 0, false, `transport: ${err.message || err}`);
  }
  const status = response.status;
  let body = null;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch (err) {
    return mkRes(tc, status, false, "non-json body");
  }
  if (tc.expect === "envelope") {
    if (status !== 200) return mkRes(tc, status, false, "expected 200");
    const reasons = validateEnvelope(body);
    return mkRes(
      tc,
      status,
      reasons.length === 0,
      reasons.length === 0 ? `schema=${body.schema_version} source=${body.source}` : `drift: ${reasons.join("; ")}`
    );
  }
  if (tc.expect === "blob503") {
    if (status !== 503) return mkRes(tc, status, false, "expected 503");
    const reasons = validateEnvelope(body);
    if (reasons.length !== 0) return mkRes(tc, status, false, `drift: ${reasons.join("; ")}`);
    const warning = Array.isArray(body.warnings) && body.warnings[0];
    if (warning !== "blobs not available in skeleton") {
      return mkRes(tc, status, false, `warning mismatch: ${warning}`);
    }
    return mkRes(tc, status, true, `warning=${warning}`);
  }
  if (tc.expect === "error405" || tc.expect === "error404") {
    const expectedStatus = tc.expect === "error405" ? 405 : 404;
    if (status !== expectedStatus) return mkRes(tc, status, false, `expected ${expectedStatus}`);
    const reasons = validateErrorEnvelope(body);
    return mkRes(
      tc,
      status,
      reasons.length === 0,
      reasons.length === 0 ? `error=${body.error.code}` : `drift: ${reasons.join("; ")}`
    );
  }
  return mkRes(tc, status, false, "unknown expectation");
}

async function runStaticCase(base, tc) {
  const url = `${base}${tc.path}`;
  let response;
  try {
    response = await fetch(url, { method: tc.method });
  } catch (err) {
    return mkRes(tc, 0, false, `transport: ${err.message || err}`);
  }
  const status = response.status;
  const ok = status === tc.expectStatus;
  let detail = `status=${status}`;
  if (ok && tc.expectMime) {
    const ct = response.headers.get("content-type") || "";
    if (!ct.startsWith(tc.expectMime)) {
      return mkRes(tc, status, false, `mime mismatch: ${ct}`);
    }
    detail = `mime=${ct.split(";")[0]}`;
  }
  // Drain body to avoid socket leaks.
  await response.arrayBuffer();
  return mkRes(tc, status, ok, detail);
}

function mkRes(tc, status, ok, detail) {
  return { method: tc.method, path: tc.path, status, ok, detail };
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("smoke crashed:", err);
  process.exit(2);
});
