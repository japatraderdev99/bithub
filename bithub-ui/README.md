# bithub-ui — Frontend Shell Read-Only (UI-1 + UI-2A polish)

Frontend institucional **read-only** do Bithub. Consome os envelopes
canonicos `/v1/*` do Read Worker skeleton (H-013) sem inventar mocks no
cliente. Materializa o primeiro shell do dashboard descrito em
[`Frontend-Dashboard-Architecture`](../bithub-vault/01-Architecture/Frontend-Dashboard-Architecture.md)
e implementa o contrato HTTP em
[`Read-Worker-v1-Contract`](../bithub-vault/03-Integration/Read-Worker-v1-Contract.md).

Este modulo entrega:

- **UI-1** ([`H-20260525-UI-1`](../bithub-vault/04-Roadmap/Handoffs/H-20260525-UI-1-Frontend-Shell-Read-Only.md))
  — shell static, dev-server local, 6 views, zero-dep;
- **UI-2A polish** ([`H-20260526-UI-2A`](../bithub-vault/04-Roadmap/Handoffs/H-20260526-UI-2A-Frontend-Polish-Read-Only.md))
  — fecha o ramo `innerHTML` em `components.mjs`, sanitiza query strings
  em logs, adiciona sweep estatico anti-segredo e cria rota `/dev/states`.

## Escopo

| Item | UI-1 (este) | Futuro |
|---|---|---|
| Runtime browser | Static HTML/CSS/JS, ESM nativo | Cloudflare Pages/Workers OpenNext |
| Stack | Zero dependencia | shadcn + Tailwind v4 + React, opcional |
| Build | Nenhum | Vite ou Next.js |
| Dados | Read Worker skeleton (H-013) | Read Worker real (RW-2..RW-8) |
| Auth | Stub (nenhuma) | Cloudflare Access JWT |
| Deploy | **Nenhum** | `app.bit-hub.pro` via H-014 |
| Charts | — (placeholders) | KLineChart / Recharts / ECharts |
| Telemetria | — | Logpush / Web Analytics |

## O que **NAO esta** neste UI-1

- `npm install`, `pnpm install`, `package.json`, `tsconfig.json`,
  `vite.config.*`, `tailwind.config.*`.
- TypeScript, React, Vue, Tailwind, shadcn, Lucide, Recharts, KLineChart,
  ECharts, Glide Data Grid, TanStack Query.
- `npx`, `wrangler`, `next`, `node_modules`.
- Leitura de `.env`, `process.env`, secrets, tokens, chaves Cloudflare.
- Cloudflare real (Pages, Workers, KV, D1, R2, Access).
- Deploy, push Git, commit.
- Auth applicativa (login, sessao, usuario, roles, OIDC, SSO).
- Mutacao (POST/PUT/PATCH/DELETE), trade, sinal, score, direction,
  regime, ordem, posicao, wallet, saldo, paper trading, execucao.
- Inferencia, recommendation, confidence, trade_bias.
- WebSocket, streaming, polling agressivo.
- Charts canvas pesados (KLineChart/ECharts) — entram em UI-8/UI-9.
- Telas de inferencia, news feed, agent brief, multi-symbol comparativo.
- PII (sem email, sem IP, sem geolocation, sem analytics third-party).

## Layout

```
bithub-ui/
├── README.md                      # este arquivo
├── ARCHITECTURE.md                # decisoes e caminho de evolucao
├── public/
│   ├── index.html                 # shell + sidebar + footer
│   ├── styles.css                 # tokens OKLCH + componentes
│   └── app/
│       ├── main.mjs               # entry, router wiring, density toggle
│       ├── router.mjs             # hash router minimo
│       ├── read-client.mjs        # HTTP read-only client + envelope validator
│       ├── state.mjs              # store pub/sub minimo
│       ├── format.mjs             # formatadores deterministicos
│       ├── components.mjs         # h(), card(), kv(), badges, states
│       └── views/
│           ├── dashboard.mjs      # /
│           ├── health.mjs         # /health
│           ├── config.mjs         # /config
│           ├── source-status.mjs  # /source-status
│           ├── bundle.mjs         # /bundle/:symbol
│           └── blobs.mjs          # /blobs (503 esperado)
├── scripts/
│   ├── dev-server.mjs             # Node http + handleRequest delegate
│   └── smoke.mjs                  # end-to-end offline
└── tests/
    ├── read-client.test.mjs       # node:test, 37 casos
    └── dev-server.test.mjs        # node:test, 16 casos
```

## Telas

| Rota | View | Endpoints consumidos | Descricao |
|---|---|---|---|
| `#/` | Dashboard | `/v1/health`, `/v1/bundles/latest?symbol=BTC/USDT:USDT` | Cards lado a lado + Section Status Grid |
| `#/health` | Health | `/v1/health` | Detalhe de 3 fontes Phase 0 |
| `#/config` | Config | `/v1/config/public`, `/v1/config/feature-flags` | Cards lado a lado |
| `#/source-status` | Source Status | `/v1/source-status` | Tabela de eventos canonicos |
| `#/bundle/{symbol}` | Bundle | `/v1/bundles/latest`, `/v1/symbols` | Drill por simbolo + symbol switcher |
| `#/blobs` | Blobs | `/v1/blobs/bundle/...`, `/v1/blobs/manifest/...` | Demonstra estado 503 esperado |
| `#/dev/states` | Dev states (UI-2A) | nenhum | Catalogo dos 8+ estados operacionais com props sinteticos |

Atalhos de teclado: `g d` (dashboard), `g h` (health), `g c` (config),
`g s` (source status), `g b` (bundle), `g x` (blobs), `g v` (dev states).

## Estados operacionais

Cada view trata as seguintes situacoes:

- **loading** — skeleton sutil + chip `LOADING`.
- **ok** — render normal, status com texto + cor.
- **degraded** — overlay amber + badge `DEGRADED` (alinhamento com R-001 5.1).
- **stale** — chip `STALE` + tooltip com `as_of`.
- **error** — fail-loud com `error_code` real do envelope `read.error.v1`.
- **empty** — texto explicito.
- **blob_unavailable** (`/v1/blobs/*`) — HTTP 503 + warning literal
  `blobs not available in skeleton` como caminho esperado, nao bug.

Cor obedece principio 2/3 do
[`Frontend-Dashboard-Architecture`](../bithub-vault/01-Architecture/Frontend-Dashboard-Architecture.md):
verde/vermelho indicam status operacional, **nunca** direcao de preco.
Status sempre vem com texto + glyph + cor (nunca so cor) para garantir
acessibilidade (WCAG 2.1 AA / daltonismo).

## Como rodar

### 1. Pre-requisitos

- Node 22+ (`node --version` deve mostrar `v22.x` ou superior).
- Python 3.12+ apenas para regenerar fixtures (opcional; ja existem).
- Sem `npm`, `pnpm`, `yarn`, `bun`. Sem `wrangler`, `npx`.

### 2. Garantir fixtures geradas (uma vez)

As fixtures vivem em `bithub-read-worker/fixtures/generated/`. Se nao
existirem, regenere via:

```bash
cd "/Users/gabrielcasarin/Documents/Bithub Project/bithub-data-layer"
PYTHONDONTWRITEBYTECODE=1 python3 -W error scripts/export_read_worker_fixtures.py
```

### 3. Subir o dev server

```bash
cd "/Users/gabrielcasarin/Documents/Bithub Project"
node bithub-ui/scripts/dev-server.mjs
# bithub-ui dev-server listening at http://127.0.0.1:3000
```

Bind default e `127.0.0.1:3000`. Para mudar:

```bash
node bithub-ui/scripts/dev-server.mjs --host 127.0.0.1 --port 4000
```

Abra `http://127.0.0.1:3000/` no navegador (Chrome/Safari/Firefox).
Navegacao por hash: `#/`, `#/health`, `#/config`, `#/source-status`,
`#/bundle/BTC%2FUSDT%3AUSDT`, `#/blobs`.

### 4. Testar

```bash
cd "/Users/gabrielcasarin/Documents/Bithub Project"
node --test bithub-ui/tests/*.test.mjs
node bithub-ui/scripts/smoke.mjs
```

Esperado (UI-1 + UI-2A polish):

- `read-client.test.mjs`: 37 testes / 12 suites OK.
- `dev-server.test.mjs`: 25 testes / 5 suites OK (16 originais + 7 do
  `sanitizeUrlForLog` + 2 do `/dev/states`).
- `components.test.mjs`: 6 testes / 1 suite OK (regressao do ramo `html`).
- `anti-secret.test.mjs`: 3 testes / 1 suite OK (sweep estatico do source).
- `smoke.mjs`: 14/14 OK (10 contra `/v1/*` + 4 estaticos).

Total: **71 testes UI Node** + **14 smoke**.

## Cloudflare Pages static settings

Quando o repo for conectado a Cloudflare Pages como site static (handoff
`H-20260526-PAGES-STATIC-PREP`), as configuracoes sao:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Preview branches | `preview/*` |
| Build command | *(vazio)* |
| Build output directory | `bithub-ui/public` |
| Root directory | *(vazio / project root)* |
| Environment variables | *(nenhuma — frontend e zero-secret)* |

Cloudflare Pages serve `bithub-ui/public/` verbatim. Sem build. Sem
`wrangler`, sem `npx`, sem `npm install`. Headers HTTP estaticos vem do
arquivo `bithub-ui/public/_headers` (X-Content-Type-Options, Referrer-
Policy, Permissions-Policy restritiva, X-Frame-Options, COOP). CSP fica
para H-014/RW-7 quando o origin do Worker real estiver definido.

Enquanto o Read Worker real nao existir, `bithub-ui/public/_redirects`
reescreve `/v1/*` para `v1-api-unavailable.json`. Isso impede que Pages
static devolva `index.html` para URLs de API. O sentinela e um
`read.error.v1`; `read-client.mjs` o trata como erro explicito mesmo que
o host static responda `200` por causa da rewrite de Pages.

`bithub-read-worker/` continua sendo skeleton **local** para dev/test;
nao e deploy de Worker Cloudflare. Worker real entra em handoff proprio
RW-2/RW-3/RW-7, sem ser liberado por Pages static.

## Headers e contrato

Em respostas 2xx do `/v1/*`, o dev-server propaga os headers que o
Worker skeleton emite (mesmo bytes que o Cloudflare Worker real emitira):

- `Content-Type: application/json; charset=utf-8`
- `Cache-Control: private, max-age=<ttl>`
- `X-Bithub-Read-Source: kv | d1 | r2 | derived`
- `X-Bithub-Schema-Version: read.<endpoint>.v1`
- `X-Bithub-Request-Id: 01HZX-SKEL-<8 hex>` (determinista por path no skeleton)
- `Vary: Origin, Cookie, Cf-Access-Jwt-Assertion`

O dev server estatico adiciona `X-Content-Type-Options: nosniff` e
`Referrer-Policy: no-referrer` em arquivos servidos do `public/`.

## Regra invariante

O frontend **nao inventa payload**. Toda exibicao numerica e textual
vem dos envelopes do Read Worker, que por sua vez gera bytes via
`bithub-data-layer/scripts/export_read_worker_fixtures.py` (H-013).

Quando RW-2/RW-3 plugarem KV/D1 reais, o cliente UI **nao percebe** —
os bytes sao identicos aos que a pipeline real produz. O Worker fake
nao vira segunda fonte de verdade.

## Caminho de evolucao

| Etapa | Saida | Dependencia |
|---|---|---|
| UI-1 (este) | static, sem dep, dev-server local | H-013 aprovado |
| UI-2 | (opcional) Vite + React + shadcn + Tailwind se Codex aprovar | handoff proprio |
| UI-3 | Charts wrappers (KLineChart/Recharts/ECharts) | UI-2 + handoff |
| UI-4 | Conectar ao Read Worker real (RW-2/RW-3) | RW-2/RW-3 + handoff |
| UI-5 | Cloudflare Pages/Workers OpenNext deploy | H-014 + Access + CORS finais |
| UI-6+ | Audit Explorer, blob viewer com R2 presigned | R-B3 resolvido |

Nenhuma dessas etapas esta autorizada por UI-1.

## Referencias do vault

- [`Frontend-Dashboard-Architecture`](../bithub-vault/01-Architecture/Frontend-Dashboard-Architecture.md)
- [`Read-Worker-v1-Contract`](../bithub-vault/03-Integration/Read-Worker-v1-Contract.md)
- [`H-20260525-013-Read-Worker-Skeleton-Canonical-Fixtures`](../bithub-vault/04-Roadmap/Handoffs/H-20260525-013-Read-Worker-Skeleton-Canonical-Fixtures.md)
- [`H-20260525-UI-1-Frontend-Shell-Read-Only`](../bithub-vault/04-Roadmap/Handoffs/H-20260525-UI-1-Frontend-Shell-Read-Only.md)
- [`Implementation-Acceleration-Workflow`](../bithub-vault/04-Roadmap/Implementation-Acceleration-Workflow.md)
- [`GitHub-Commit-Policy`](../bithub-vault/04-Roadmap/GitHub-Commit-Policy.md) — UI-1 **nao** e commitado por Claude.
