// anti-secret.test.mjs — defesa em profundidade no source tree.
//
// O sweep anti-segredo em `read-client.test.mjs` valida *respostas* do dev
// server. Este sweep e estatico: varre `bithub-ui/` e `bithub-read-worker/src/`
// procurando os mesmos tokens canonicos. Catch para o caso em que alguem
// (humano ou agente) escreve um segredo direto no source — antes de chegar
// a virar response. Sem dependencia externa; usa apenas `node:fs`/
// `node:test`/`node:assert/strict`.
//
// Politica:
// - Tokens proibidos sao definidos uma vez aqui, sao os mesmos do
//   `read-client.test.mjs` e os mesmos referenciados em
//   `~/.claude/skills/bithub-ui-conventions/SKILL.md` secao 14.
// - Diretorios proibidos para varredura: `node_modules`, `.git`,
//   `__pycache__`, `dist`, `build`, `.wrangler`, `.next`, `coverage`.
// - Este proprio arquivo (`anti-secret.test.mjs`) e isento — caso
//   contrario os literais da lista quebrariam o teste recursivamente.

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const FORBIDDEN_TOKENS = Object.freeze([
  "api_key=",
  "Bearer ",
  "X-API-Key",
  "X-BAPI-API-KEY",
  "BYBIT_PRIVATE",
  "FRED_API_KEY",
  "WEBHOOK_SIGNING_SECRET",
  "Authorization:",
]);

const SCAN_ROOTS = Object.freeze([
  resolve(REPO_ROOT, "bithub-ui"),
  resolve(REPO_ROOT, "bithub-read-worker", "src"),
]);

const SKIP_DIRS = Object.freeze(
  new Set([
    "node_modules",
    ".git",
    "__pycache__",
    "dist",
    "build",
    ".wrangler",
    ".next",
    "coverage",
  ])
);

// Files exempt: test files whose explicit job is to exercise anti-secret
// behavior. They MUST contain the tokens as literals to assert the system
// scrubs them. Adding new files here requires Codex review.
const EXEMPT_FILES = Object.freeze(
  new Set([
    resolve(__dirname, "anti-secret.test.mjs"),
    resolve(__dirname, "read-client.test.mjs"),
    resolve(__dirname, "dev-server.test.mjs"),
    // live-tail.test.mjs exercita isSensitive() do live-tail.mjs sidecar.
    // Inclui literais "api_key=", "Authorization:", "Bearer " como input
    // de teste para garantir que o parser descarta linhas sensiveis vindas
    // do log. Sem essa isencao o sweep estatico bate em si proprio.
    resolve(__dirname, "live-tail.test.mjs"),
  ])
);

// Only scan text-like files. Binary or fixture-heavy types are skipped to keep
// the sweep fast and avoid false positives in JSON fixtures (which the
// runtime sweep in read-client.test.mjs already covers from the wire side).
const SCANNABLE_EXTENSIONS = Object.freeze(
  new Set([".mjs", ".js", ".ts", ".css", ".html", ".md", ".txt"])
);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXEMPT_FILES.has(full)) continue;
    const dot = entry.name.lastIndexOf(".");
    const ext = dot === -1 ? "" : entry.name.slice(dot).toLowerCase();
    if (!SCANNABLE_EXTENSIONS.has(ext)) continue;
    yield full;
  }
}

function collectFiles() {
  const out = [];
  for (const root of SCAN_ROOTS) {
    let info;
    try {
      info = statSync(root);
    } catch (_err) {
      continue;
    }
    if (!info.isDirectory()) continue;
    for (const file of walk(root)) out.push(file);
  }
  return out;
}

describe("anti-secret static sweep", () => {
  it("source tree under bithub-ui/ and bithub-read-worker/src/ has no forbidden tokens", () => {
    const files = collectFiles();
    assert.ok(files.length > 0, "expected at least one scannable file");
    const hits = [];
    for (const file of files) {
      let body;
      try {
        body = readFileSync(file, "utf8");
      } catch (_err) {
        continue;
      }
      for (const token of FORBIDDEN_TOKENS) {
        if (body.includes(token)) {
          hits.push({ file: file.replace(REPO_ROOT + sep, ""), token });
        }
      }
    }
    assert.deepEqual(
      hits,
      [],
      "forbidden tokens found in source:\n" +
        hits.map((h) => `  ${h.file} :: ${h.token}`).join("\n")
    );
  });

  it("anti-secret token list matches read-client.test.mjs sweep", () => {
    // Defesa contra drift entre o sweep estatico e o sweep de wire.
    const wireTest = readFileSync(
      resolve(__dirname, "read-client.test.mjs"),
      "utf8"
    );
    for (const tok of FORBIDDEN_TOKENS) {
      // O wire sweep declara `const FORBIDDEN = [...]` listando cada token
      // como string literal. Procuramos `"<tok>"` ou `'<tok>'`.
      const double = `"${tok}"`;
      const single = `'${tok}'`;
      assert.ok(
        wireTest.includes(double) || wireTest.includes(single),
        `token missing from read-client wire sweep: ${tok}`
      );
    }
  });

  it("source tree is non-trivial (sanity check on the walker)", () => {
    const files = collectFiles();
    // UI-1 ja tem mais de 10 arquivos escannaveis; este teste protege contra
    // um SKIP_DIRS muito agressivo no futuro.
    assert.ok(
      files.length >= 10,
      `expected >= 10 scannable files, got ${files.length}`
    );
  });
});
