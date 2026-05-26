# bithub-read-worker — Skeleton (H-20260525-013)

Worker de leitura **offline-only** que serve os envelopes canônicos
`/v1/*` definidos em
[`Read-Worker-v1-Contract`](../bithub-vault/03-Integration/Read-Worker-v1-Contract.md)
(R-20260525-001) a partir de fixtures determinísticas geradas pelo
`bithub-data-layer`.

Este skeleton **não é o Worker de produção**. É a ponte segura entre o
backend e a UI prevista em
[`Frontend-Dashboard-Architecture`](../bithub-vault/01-Architecture/Frontend-Dashboard-Architecture.md):
a UI-1 (quando Codex emitir o handoff) consome este skeleton como API
HTTP real e estável, em vez de inventar mocks no frontend. Quando RW-2 e
RW-3 plugarem bindings KV/D1 reais, os mesmos clientes da UI continuam
funcionando sem alteração contratual.

## Escopo declarado

| Item | Skeleton | Worker real (futuro) |
|---|---|---|
| Runtime | Node 22+ (node:test) | Cloudflare Workers |
| Dados | Fixtures JSON em disco | KV + D1 + R2 + presigned |
| Auth | _stub_ (nenhuma validação) | Cloudflare Access JWT |
| CORS | Allowlist hard-coded | Cloudflare Access |
| Clock | Constantes determinísticas | `Date.now()` |
| IDs | `01HZX-SKEL-<hash>` por path | ULID/UUIDv7 por request |
| Deploy | **Nenhum** | `wrangler deploy` |

## O que **NÃO está** neste skeleton

- `npm install`, `pnpm install`, `package.json`, `tsconfig.json`,
  `wrangler.toml`.
- `wrangler`, `npx`, deploy, push, commit.
- Leitura de `.env`, `process.env`, secrets, tokens, chaves Cloudflare.
- Bindings KV/D1/R2 reais; consultas a `data_bundle_record`,
  `*_snapshot_record`, `audit_event`, `source_status_event`.
- R2 presigned URLs (R-B3 bloqueante registrado em
  [`Read-Worker-v1-Contract`](../bithub-vault/03-Integration/Read-Worker-v1-Contract.md)
  seção 11.3). `/v1/blobs/*` responde `503` com o warning literal
  `"blobs not available in skeleton"`.
- TypeScript compilado, dependência externa, framework HTTP.
- Validação JWT do Cloudflare Access (a auth real entra em RW-7).
- Rate limit (entra em RW-7 via WAF / Cloudflare).
- Webhook, mutação, escrita, ordem, posição, wallet, sinal, score,
  recommendation, direction, regime.

## Endpoints servidos

| Rota | Métodos | Schema do envelope | Status |
|---|---|---|---|
| `/v1/health` | GET, HEAD | `read.health.v1` | 200 |
| `/v1/config/public` | GET, HEAD | `read.public_config.v1` | 200 |
| `/v1/config/feature-flags` | GET, HEAD | `read.feature_flags.v1` | 200 |
| `/v1/symbols` | GET, HEAD | `read.symbols.v1` | 200 |
| `/v1/source-status` | GET, HEAD | `read.source_status.v1` | 200 |
| `/v1/bundles/latest?symbol=BTC%2FUSDT%3AUSDT` | GET, HEAD | `read.bundle.v1` | 200 |
| `/v1/blobs/bundle/{id}` | GET, HEAD | `read.blob.v1` | 503 (warning literal) |
| `/v1/blobs/manifest/{id}` | GET, HEAD | `read.blob.v1` | 503 (warning literal) |
| Métodos não permitidos | POST/PUT/PATCH/DELETE | `read.error.v1` | 405 (`Allow: GET, HEAD, OPTIONS`) |
| Rotas desconhecidas | qualquer | `read.error.v1` | 404 |
| Preflight | OPTIONS | — | 204 com CORS / 403 sem origem |

Todo response 2xx carrega o envelope canônico
([`Read-Worker-v1-Contract`](../bithub-vault/03-Integration/Read-Worker-v1-Contract.md)
seção 5.1):

```json
{
  "schema_version": "read.<endpoint>.v1",
  "as_of": "2026-05-25T14:00:00Z",
  "served_at": "2026-05-25T14:00:15Z",
  "source": "kv | d1 | r2 | derived",
  "stale": false,
  "data": { ... },
  "warnings": []
}
```

Headers comuns:

- `Content-Type: application/json; charset=utf-8`
- `Cache-Control: private, max-age=<ttl>` (`30` para health/config,
  `60` para bundle)
- `X-Bithub-Read-Source`, `X-Bithub-Schema-Version`,
  `X-Bithub-Request-Id`, `Vary: Origin, Cookie, Cf-Access-Jwt-Assertion`

CORS allowlist hard-coded (R-001 seção 8):

- `https://app.bit-hub.pro` (produção)
- `https://api.bit-hub.pro` (mesmo zone)
- `http://localhost:3000`
- `http://127.0.0.1:3000`

## Como rodar

### 1. Gerar fixtures canônicas (Python stdlib)

```bash
cd "/Users/gabrielcasarin/Documents/Bithub Project/bithub-data-layer"
PYTHONDONTWRITEBYTECODE=1 python3 -W error scripts/export_read_worker_fixtures.py
```

Saída: `bithub-read-worker/fixtures/generated/*.json` (6 arquivos
determinísticos, sort_keys + compact JSON via
`bithub_data.kv_read_model.stable_json_dumps`).

### 2. Testar o exportador Python

```bash
cd "/Users/gabrielcasarin/Documents/Bithub Project/bithub-data-layer"
PYTHONDONTWRITEBYTECODE=1 python3 -W error -m unittest tests.test_read_worker_fixtures
```

### 3. Testar o Worker (node:test)

```bash
cd "/Users/gabrielcasarin/Documents/Bithub Project"
node --test bithub-read-worker/tests/read-worker.test.mjs
```

Requer Node 22+ (globais `Request`/`Response`/`URL`, `node:test`,
`node:assert/strict`). Sem dependência externa.

### 4. Smoke manual (opcional)

```javascript
import { handleRequest } from "./src/index.mjs";

const res = await handleRequest(
  new Request("https://api.bit-hub.pro/v1/health")
);
console.log(res.status, await res.text());
```

## Layout

```
bithub-read-worker/
├── README.md                          # este arquivo
├── src/
│   └── index.mjs                      # Worker skeleton ESM
├── fixtures/
│   └── generated/                     # gerado por export_read_worker_fixtures.py
│       ├── bundles-latest-BTC_USDT_USDT.json
│       ├── feature-flags.json
│       ├── health.json
│       ├── public-config.json
│       ├── source-status.json
│       └── symbols.json
└── tests/
    └── read-worker.test.mjs           # node:test + assert/strict
```

## Regra invariante: fixtures vêm de `bithub_data`

O Worker **nunca inventa payload**. Toda fixture é gerada por
`bithub-data-layer/scripts/export_read_worker_fixtures.py`, que usa:

- `bithub_data.kv_read_model.latest_bundle_read_model(...)` para o
  envelope de `/v1/bundles/latest` (mesmas invariantes do H-010:
  `overall_status` consistente com seções, `snapshot_refs` apenas para
  seções presentes, `r2_bundle_key` re-validado contra o símbolo, walk
  recursivo contra inferência/segredo/PII);
- `bithub_data.kv_read_model.latest_health_read_model(...)` para o
  envelope de `/v1/health`;
- `bithub_data.source_status.ERROR_CODES` + `VALID_STATUSES` para os
  enums de `/v1/source-status`;
- `bithub_data.kv_read_model.stable_json_dumps(...)` para a serialização
  determinística (sort_keys, separators compactos, allow_nan=False, walk
  recursivo contra `_BUNDLE_FORBIDDEN_INFERENCE_FIELDS`, `_FORBIDDEN_SECRET_FIELDS`,
  `_FORBIDDEN_PII_FIELDS`).

Isso garante que quando RW-2/RW-3 trocarem fixtures por KV/D1 reais, o
cliente UI **não percebe**: os bytes são idênticos aos que a pipeline
real produz. O Worker fake não vira segunda fonte de verdade.

## Caminho de evolução

Sub-handoffs propostos em
[`Read-Worker-v1-Contract`](../bithub-vault/03-Integration/Read-Worker-v1-Contract.md)
seção 15:

1. **H-013/RW-1 (este)** — skeleton local com fixtures.
2. **UI-1** (Codex precisa emitir) — frontend shell consumindo este
   skeleton.
3. **RW-2** — TS Worker real + bindings KV; `/v1/health`, `/v1/config/*`
   passam a ler KV.
4. **RW-3** — D1 fallback + `/v1/bundles/latest` lendo D1 quando KV
   miss/stale.
5. **RW-4** — `/v1/symbols`, `/v1/source-status`, `/v1/snapshots/{id}`
   contra D1.
6. **RW-5** — `/v1/audit?run_id=...`, `/v1/bundles/{bundle_id}`.
7. **RW-6** — `/v1/blobs/*` com R2 presigned (depende de R-B3).
8. **RW-7** — Cloudflare Access JWT validation + CORS final + rate limit
   + Logpush.
9. **RW-8** — Kill-switch via `feature_flags.read_worker_enabled`.

Nenhuma dessas etapas está autorizada por H-013. Cada uma precisa de
handoff Codex próprio.

## Referências do vault

- [`Read-Worker-v1-Contract`](../bithub-vault/03-Integration/Read-Worker-v1-Contract.md) — contrato HTTP completo, envelopes, status codes, CORS, Access, R2.
- [`Frontend-Dashboard-Architecture`](../bithub-vault/01-Architecture/Frontend-Dashboard-Architecture.md) — arquitetura docs-only do dashboard que consumirá este skeleton.
- [`H-20260525-010-KV-Cache-Policy-and-Read-Model`](../bithub-vault/04-Roadmap/Handoffs/H-20260525-010-KV-Cache-Policy-and-Read-Model.md) — política KV e read-models reutilizados.
- [`H-20260525-011-Persistence-Adapter-BundlePersistence`](../bithub-vault/04-Roadmap/Handoffs/H-20260525-011-Persistence-Adapter-BundlePersistence.md) — adapter Python que produz os registros que o Worker (real) lerá.
- [`H-20260525-012-Queue-Contracts-and-Envelope-Helpers`](../bithub-vault/04-Roadmap/Handoffs/H-20260525-012-Queue-Contracts-and-Envelope-Helpers.md) — contratos de queues que alimentam o pipeline upstream.
- [`H-20260525-013-Read-Worker-Skeleton-Canonical-Fixtures`](../bithub-vault/04-Roadmap/Handoffs/H-20260525-013-Read-Worker-Skeleton-Canonical-Fixtures.md) — este handoff.
- [`Implementation-Acceleration-Workflow`](../bithub-vault/04-Roadmap/Implementation-Acceleration-Workflow.md) — esteira Lane A/B/C.
- [`GitHub-Commit-Policy`](../bithub-vault/04-Roadmap/GitHub-Commit-Policy.md) — política de commit; este skeleton **não é commitado** por Claude.
