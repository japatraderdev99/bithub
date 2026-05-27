# bithub-read-worker — Read Worker fixture-backed (H-013/RW-2/RW-3/RW-7)

Worker de leitura **read-only** que serve os envelopes canônicos
`/v1/*` definidos em
[`Read-Worker-v1-Contract`](../bithub-vault/03-Integration/Read-Worker-v1-Contract.md)
(R-20260525-001) a partir de fixtures determinísticas geradas pelo
`bithub-data-layer` e embutidas no bundle do Worker. Em dev/test, também
aceita bindings KV/D1 fake/local injetados em teste e, no escopo RW-7,
uma edge policy fake/local injetada em teste.

Este Worker é a ponte segura entre o backend e a UI prevista em
[`Frontend-Dashboard-Architecture`](../bithub-vault/01-Architecture/Frontend-Dashboard-Architecture.md):
a UI-1 consome uma API HTTP real e estável, em vez de inventar mocks no
frontend. O deploy inicial continua fixture-backed: não cria KV, D1, R2,
Access, Queue, Cron, segredo, Bybit private ou qualquer integração de
ordem/trade.

## Escopo declarado

| Item | Worker atual | Worker futuro |
|---|---|---|
| Runtime | Node 22+ em teste; Cloudflare Workers em deploy | Cloudflare Workers |
| Dados | Fixtures embutidas + KV/D1 fake injetável em teste | KV + D1 + R2 + presigned |
| Auth | Edge policy fake/local opcional em teste | Cloudflare Access JWT |
| CORS | Allowlist hard-coded testada | Cloudflare Access / Worker |
| Clock | Constantes determinísticas | `Date.now()` |
| IDs | `01HZX-SKEL-<hash>` por path | ULID/UUIDv7 por request |
| Deploy | `wrangler deploy` via `wrangler.toml` | Pipeline operacional versionado |

## O que **NÃO está** neste skeleton

- `npm install`, `pnpm install`, `package.json`, `tsconfig.json`,
  bundle step externo ou framework HTTP.
- Leitura de `.env`, `process.env`, secrets, tokens, chaves Cloudflare em runtime.
- Bindings KV/D1/R2 reais; SQL real contra `data_bundle_record`,
  `*_snapshot_record`, `audit_event`, `source_status_event`.
- R2 presigned URLs (R-B3 bloqueante registrado em
  [`Read-Worker-v1-Contract`](../bithub-vault/03-Integration/Read-Worker-v1-Contract.md)
  seção 11.3). `/v1/blobs/*` responde `503` com o warning literal
  `"blobs not available in skeleton"`.
- Validação JWT real do Cloudflare Access.
- Rate limit real via WAF/Cloudflare.
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
| Access fake negado/ausente | GET, HEAD | `read.error.v1` | 401 / 403 |
| Rate-limit fake | GET, HEAD | `read.error.v1` | 429 (`Retry-After`) |
| Métodos não permitidos | POST/PUT/PATCH/DELETE | `read.error.v1` | 405 (`Allow: GET, HEAD, OPTIONS`) |
| Rotas desconhecidas | qualquer | `read.error.v1` | 404 |
| Preflight | OPTIONS | — / `read.error.v1` | 204 com CORS para origem permitida + `Access-Control-Request-Method` GET/HEAD; 403 caso contrario |

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

- `https://bithub-clo.pages.dev` (Pages production atual)
- `https://app.bit-hub.pro` (produção)
- `https://api.bit-hub.pro` (mesmo zone)
- `http://localhost:3000`
- `http://127.0.0.1:3000`

## RW-2: KV fake/local

RW-2 adiciona uma interface mínima de leitura KV: um objeto injetável
com método `get(key)`. O binding canônico é `env.KV_BITHUB`; `env.KV`
também é aceito apenas para ergonomia local. Sem binding, o Worker cai
para as fixtures e preserva exatamente os bytes do skeleton H-013.

Chaves lidas em RW-2:

| Rota | Chave KV | Fallback |
|---|---|---|
| `/v1/config/public` | `public_config` | `fixtures/generated/public-config.json` |
| `/v1/config/feature-flags` | `feature_flags` | `fixtures/generated/feature-flags.json` |
| `/v1/health` | `latest_health:data_layer` | `fixtures/generated/health.json` |
| `/v1/bundles/latest?symbol=...` | `latest_bundle:{symbol}` | fixture do símbolo allowlisted |

Valores KV podem ser envelopes `read.*.v1` completos ou read-models
compactos H-010:

- `kv.latest_health.v1` vira envelope `read.health.v1`;
- `kv.latest_bundle.v1` vira envelope `read.bundle.v1`;
- `public_config` e `feature_flags` podem ser dicts públicos compactos.

O Worker continua sem namespace KV real, sem `.env`, sem rede de
provider e sem escrita em KV. Sem bindings locais, os bytes das fixtures
H-013 continuam intactos; em `/v1/health` e `/v1/bundles/latest`, KV
miss/stale passa por D1 fake quando houver binding D1. JSON inválido,
erro de `get()` ou token proibido no payload falha fechado ou cai para
D1 fake conforme o contrato RW-3, sempre sem stack.

## RW-3: D1 fake/local fallback

RW-3 adiciona uma interface mínima de fallback D1 fake/local para
`/v1/health` e `/v1/bundles/latest`. O binding canônico é
`env.D1_BITHUB`; `env.DB_BITHUB` também é aceito apenas para ergonomia
local.

Interface do stub:

```javascript
const D1_BITHUB = {
  async getReadModel(kind, params) {
    // kind: "latest_health" | "latest_bundle"
    // params: {} para latest_health
    // params: { symbol, kvKey } para latest_bundle
    return null;
  }
};
```

Contrato local:

| Situação | Resultado |
|---|---|
| Sem KV/D1 local | fixture H-013 byte-a-byte |
| KV hit fresco | envelope KV |
| KV miss + D1 hit | envelope `source: "d1"` com warning `kv-miss-served-from-d1` |
| KV stale + D1 hit | envelope `source: "d1"` com warning `kv-stale-served-from-d1` |
| KV inválido/erro + D1 hit | envelope `source: "d1"` com warning `kv-error-served-from-d1` |
| KV miss/stale + D1 indisponível | `read.error.v1` status `503`, sem stack |
| D1 inválido/erro | `read.error.v1` status `502`, sem stack |

O stub pode retornar um envelope `read.health.v1`/`read.bundle.v1`
completo ou um read-model compacto `kv.latest_health.v1`/
`kv.latest_bundle.v1`. Em ambos os casos, quando servido como fallback,
o Worker força `source: "d1"` e adiciona o warning canônico de fallback.

Query contract futuro, ainda sem SQL no runtime local:

- `latest_health`: D1 agrega os últimos `source_status_event` por fonte;
- `latest_bundle`: D1 lê o último `data_bundle_record` do símbolo e seus
  `bundle_section_status_record` associados.

RW-3 continua sem D1 real, sem `.env`, sem rede de provider e sem
escrita em D1.

## RW-7: edge policy fake/local

RW-7 adiciona uma interface mínima de política de borda fake/local. O
binding canônico é `env.EDGE_POLICY`; `env.READ_EDGE_POLICY` também é
aceito para ergonomia local.

Interface do stub:

```javascript
const EDGE_POLICY = {
  async checkAccess(context) {
    // context: { method, origin, path, request_id, url }
    return { action: "allow" }; // "missing" -> 401, outros deny -> 403
  },
  async checkRateLimit(context) {
    return { action: "allow" }; // "limited" -> 429
  },
  log(event) {
    // event nao contem query raw, headers, cookies, IP, UA ou payload.
  }
};
```

Contrato local:

| Situação | Resultado |
|---|---|
| Sem `EDGE_POLICY` | comportamento H-013/RW-2/RW-3 intacto |
| `checkAccess()` -> `missing` | `read.error.v1` status `401`, `auth_error` |
| `checkAccess()` -> deny | `read.error.v1` status `403`, `auth_error` |
| `checkRateLimit()` -> `limited` | `read.error.v1` status `429`, `rate_limited`, `Retry-After` |
| `log(event)` | recebe evento determinístico e sanitizado |

Campos permitidos no log local:

- `at`, `duration_ms`, `method`, `path`, `request_id`,
  `schema_version`, `source`, `status`.

Campos proibidos no log local:

- query string crua, valores de query, `Authorization`, `Bearer`,
  `Cookie`, `Cf-Access-Jwt-Assertion`, payload raw, IP, user-agent,
  token, segredo ou PII.

RW-7 continua sem validar JWT real, sem Cloudflare Access real, sem WAF,
sem Logpush, sem `.env` e sem rede de provider.

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

### 4. Dry-run de deploy (opcional, Cloudflare autorizado)

```bash
cd "/Users/gabrielcasarin/Documents/Bithub Project/bithub-read-worker"
npx wrangler deploy --dry-run
```

O dry-run deve reportar `No bindings found`. O bundle usa fixtures
embutidas e não requer KV, D1, R2, Access, Queue, Cron ou secrets.

### 5. Smoke manual (opcional)

```javascript
import { handleRequest } from "./src/index.mjs";

const res = await handleRequest(
  new Request("https://api.bit-hub.pro/v1/health")
);
console.log(res.status, await res.text());
```

Exemplo com KV fake:

```javascript
import { handleRequest } from "./src/index.mjs";

const KV_BITHUB = {
  async get(key) {
    if (key !== "feature_flags") return null;
    return JSON.stringify({
      read_worker_enabled: true,
      show_audit_panel: false
    });
  }
};

const res = await handleRequest(
  new Request("https://api.bit-hub.pro/v1/config/feature-flags"),
  { KV_BITHUB }
);
console.log(res.status, await res.text());
```

Exemplo com D1 fake:

```javascript
import { handleRequest } from "./src/index.mjs";

const KV_BITHUB = { async get() { return null; } };
const D1_BITHUB = {
  async getReadModel(kind) {
    if (kind !== "latest_health") return null;
    return {
      schema_version: "kv.latest_health.v1",
      as_of: "2026-05-26T11:00:00Z",
      generated_at: "2026-05-26T11:00:02Z",
      overall_status: "ok",
      sources: {}
    };
  }
};

const res = await handleRequest(
  new Request("https://api.bit-hub.pro/v1/health"),
  { KV_BITHUB, D1_BITHUB }
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

1. **H-013/RW-1** — skeleton local com fixtures.
2. **UI-1** — frontend shell consumindo este
   skeleton.
3. **RW-2** — bindings KV fake/local injetáveis; `/v1/health`,
   `/v1/config/*` e `/v1/bundles/latest` tentam KV antes das fixtures.
4. **RW-3** — D1 fake/local para `/v1/health` e
   `/v1/bundles/latest` quando KV estiver ausente, miss, stale ou
   inválido.
5. **RW-4** — `/v1/symbols`, `/v1/source-status`, `/v1/snapshots/{id}`
   contra D1.
6. **RW-5** — `/v1/audit?run_id=...`, `/v1/bundles/{bundle_id}`.
7. **RW-6** — `/v1/blobs/*` com R2 presigned (depende de R-B3).
8. **RW-7 (este)** — edge policy fake/local para CORS, Access semantics,
   rate-limit semantics e logs sanitizados.
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
