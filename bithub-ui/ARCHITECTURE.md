# bithub-ui — ARCHITECTURE

Decisoes tecnicas do UI-1 (frontend shell read-only). Complementa
[`Frontend-Dashboard-Architecture`](../bithub-vault/01-Architecture/Frontend-Dashboard-Architecture.md)
(docs-only, aprovado) registrando o que **efetivamente foi escolhido**
nesta primeira implementacao e o que ficou deliberadamente para depois.

> A arquitetura completa do dashboard (stack alvo: Next.js 16 + React +
> shadcn + Tailwind v4) continua sendo a referencia *futura*. UI-1
> entrega o **shell** sem material dependente.

## 1. Decisoes desta versao

### 1.1 Static HTML/CSS/JS, zero dependencia

UI-1 foi construido com modulos ESM nativos do browser e Node 22, sem
`package.json`, `node_modules`, framework, bundler ou linter externo.

**Por que.**

1. O handoff UI-1 proibe `npm install`, `pnpm install`, `wrangler`,
   `npx` e qualquer dependencia third-party que exija acesso a rede.
2. Phase 0 nao tem SSR critico, SEO publico ou OG image. O dashboard
   so renderiza dados ja JSON do Read Worker; nao precisa de runtime
   server.
3. ESM nativo, `document.createElement`, `fetch`, `Headers`, `URL` e
   `Response` cobrem 100% do escopo de UI-1 (6 views, 6 endpoints).
4. Trade-off aceito: substituir por React + shadcn quando o handoff
   UI-2 explicitamente liberar. Como cada componente e funcao pura
   `(props) -> HTMLElement`, a migracao por wrapper isolado (regra do
   F-001 secao 3.3) continua valida.

**O que perdemos por agora.**

- Hot reload. (Use refresh manual; o codigo e pequeno.)
- JSX. Substituido por `h(tag, props, ...children)` em
  `components.mjs`.
- shadcn/Lucide/Tailwind. Substituido por `styles.css` com tokens
  OKLCH e classes utilitarias minimas.
- TypeScript. Os contratos sao validados runtime via
  `validateEnvelope()` / `validateErrorEnvelope()` em `read-client.mjs`.

**O que ganhamos.**

- Zero supply chain. Auditoria de dependencia trivial.
- Zero install time. `node scripts/dev-server.mjs` e tudo.
- Mesma surface area de teste em `node:test`, sem `jsdom`.
- O *cliente* da API HTTP (`read-client.mjs`) e o mesmo arquivo
  consumido pelo browser **e** pelos testes Node. Sem duplicacao.

### 1.2 Dev server que importa `handleRequest` direto

O servidor local (`scripts/dev-server.mjs`) **nao** faz proxy HTTP para
o Worker skeleton — ele importa `handleRequest` direto de
`bithub-read-worker/src/index.mjs` e chama com um `Request` construido
a partir do `node:http`.

**Por que.**

1. Mesmo contrato HTTP. Sem proxy, sem duplicacao, sem chance de drift
   entre o que o Cloudflare Worker servira em RW-2 e o que o dev-server
   serve aqui.
2. Os bytes da resposta (`schema_version`, `as_of`, `source`, `data`,
   `warnings`) sao identicos aos que o `node --test
   bithub-read-worker/tests/read-worker.test.mjs` produz.
3. Zero dependencia adicional: o Worker skeleton ja exporta
   `default { fetch }` e `handleRequest`. Reutilizamos.
4. Quando RW-2 plugar bindings KV reais, o dev-server pode continuar
   chamando o mesmo `handleRequest` (com fixtures locais) ou trocar
   para um fetch contra `https://api.bit-hub.pro` sem mudar o cliente
   UI.

**Sequencia de request.**

```
browser  --fetch-->  node:http req
                       |
                       v
                resolvePublicPath()  (static branch)
                       |
                       | se path comeca com /v1/
                       v
                nodeRequestToWebRequest()
                       |
                       v
                handleRequest(webRequest)   <-- Worker skeleton
                       |
                       v
                writeWebResponse(res, webRes)
                       |
                       v
                browser <--res--
```

### 1.3 Hash router (sem history API)

Roteamento em `app/router.mjs` usa apenas `window.location.hash` e
`hashchange`. Nenhuma necessidade de:

- regravacao server-side de URLs (`try_files` / `rewrites`);
- bundle splitting por rota;
- service worker.

Em RW-5/UI-5, quando aparecer SSR/Pages/OpenNext, esse router pode ser
substituido por Next.js App Router sem alterar `read-client.mjs` ou
`components.mjs`.

### 1.4 Validacao runtime em vez de TypeScript

`read-client.mjs` valida cada envelope contra o contrato R-001 secao
5.1:

- chaves obrigatorias presentes;
- `schema_version` comeca com `read.`;
- `as_of` / `served_at` em ISO-8601 UTC com Z;
- `source` ∈ {`kv`, `d1`, `r2`, `derived`};
- `stale` booleano;
- `warnings` lista de strings.

Drift retorna `{ kind: "envelope_drift", reasons: [...] }` e a UI
mostra `<ErrorState/>` com `code="envelope_drift"`. Isso protege contra
mudancas silenciosas no Worker, sem precisar de `zod` ou tipos
gerados.

Em UI-2 (se for liberado), trocamos a validacao manual por `zod` (ou
similar headless) preservando a mesma assinatura publica
(`fetchHealth()`, `fetchLatestBundle(symbol)`, etc.).

### 1.5 Design tokens em CSS vars (OKLCH)

`public/styles.css` define `--bg`, `--bg-panel`, `--border`, `--text`,
`--text-muted`, `--ok`, `--warn`, `--stale`, `--err`, `--info`,
`--accent` (com variants `*-bg` translucidos para overlays). Densidade
e controlada por atributo no `<html>` (`data-density="compact|normal"`).

O design segue o principio 3 de F-001:

- verde (`--ok`) e vermelho (`--err`) sao status operacionais;
- **nunca** indicam "preco subiu" ou "preco caiu";
- amber (`--warn`) e dedicado a degradacao;
- variacao de preco usa setas e `tabular-nums` neutros.

Status sempre vem com **icone + texto + cor** (`statusBadge()` em
`components.mjs`), atendendo ao principio 12 (acessibilidade).

### 1.6 Carga sincrona das fixtures no Worker

O Worker skeleton ja carrega as fixtures sincronamente no `import` via
`readFileSync`. O dev-server reusa esse modulo; nao recarrega no disco
a cada request. Em RW-2, `loadFixtures()` sera substituido por leitura
KV — mas a API publica do `handleRequest` continua identica.

## 2. Comparacao com Frontend-Dashboard-Architecture

| F-001 secao | UI-1 (este) | Mantido para depois |
|---|---|---|
| 3.1 stack (Next.js + Tailwind + shadcn + KLineChart + ECharts) | substituida por static/ESM puro | UI-2 |
| 4 organizacao de repositorio | simplificada para `public/app/`, sem `app/`/`(dashboard)/` Next.js | UI-2 |
| 5 design system (Tailwind v4 + OKLCH) | manual em CSS vars, mesmo paleta zinc + emerald/amber/rose/sky/violet | preservar |
| 6 mapa de paginas | 6 views Phase 0 entregues | `/audit`, `/audit/runs/:id` em UI-7; placeholders `/macro`, `/fundamentals`, `/reports` em UI-11 |
| 7 componentes (badges, kv, state primitives) | implementados em `components.mjs` | enriquecer com Tooltip/Popover via shadcn em UI-2 |
| 8 estados operacionais (loading/empty/stale/degraded/error/partial) | implementados; `blob_unavailable` adicionado | preservar |
| 9 contrato de leitura | consumido como definido (R-001 5.1) | preservar |
| 10 estado cliente, cache, polling | tiny store em `state.mjs`; sem polling agressivo | TanStack Query em UI-2 |
| 11 acessibilidade | foco visivel, ARIA roles em estados, status com texto + cor | aumentar com Storybook em UI-2 |
| 12 performance alvo | bundle JS < 30KB descompactado (sem deps) | preservar |
| 13 lacunas bloqueantes | B5 (runtime), B3 (R2 presigned) ainda em aberto | resolver antes de UI-5 |

## 3. Limitacoes conhecidas

1. **Sem charts.** UI-1 nao desenha OHLCV, sparkline, heatmap. Esses
   wrappers entram em UI-8/UI-9 sob handoff proprio.
2. **Sem audit explorer.** A view `/audit` de F-001 secao 6.5 nao foi
   implementada — o skeleton nao expoe `/v1/audit?run_id=...`. Entra em
   RW-5.
3. **Sem multi-symbol real.** Phase 0 so tem `BTC/USDT:USDT` no
   allowlist do Worker. A view bundle ja navega por outros simbolos
   declarados em `/v1/symbols`, mas eles ainda nao tem fixture.
4. **Sem theme light.** Dark-first apenas, conforme F-001 N3.
5. **Sem mobile.** Phase 0 e tool desktop (F-001 N4); abaixo de 900px
   a sidebar some mas o layout nao foi otimizado.
6. **Sem CSP em runtime.** O dev-server emite `X-Content-Type-Options`
   e `Referrer-Policy`, mas nao adiciona CSP. CSP estrita entra em
   UI-14.
7. **Sem auth, sem rate limit.** Cloudflare Access + WAF rate limit
   entram em RW-7 + handoff operacional separado.
8. **Sem ETag/304.** Phase 0 v1 adia (R-001 13.2).

## 4. Por que confiamos no Worker skeleton como fonte

O Worker skeleton (`bithub-read-worker/src/index.mjs`) tem **50
testes node:test** validando:

- envelope canonico R-001 5.1;
- determinismo bit-a-bit (mesma path -> mesma resposta);
- ausencia de PII/segredo em qualquer rota;
- 503 + warning literal em `/v1/blobs/*`;
- 405 + `Allow: GET, HEAD, OPTIONS` em metodos mutantes;
- 404 com envelope `read.error.v1` em rotas desconhecidas.

As fixtures que o Worker serve sao geradas por
`bithub-data-layer/scripts/export_read_worker_fixtures.py` (45 testes
Python), que reutiliza diretamente os builders aprovados em H-010
(`latest_bundle_read_model`, `latest_health_read_model`,
`stable_json_dumps`) e os enums de `source_status.VALID_STATUSES` /
`ERROR_CODES`.

Logo: o pipeline `bithub_data -> fixture JSON -> Worker -> UI` esta
todo coberto por testes na cadeia inteira, sem que o frontend invente
um unico campo.

## 5. Caminho de evolucao (resumo)

```
UI-1 (este)
   |
   v
UI-2: opcional — Vite + React + Tailwind v4 + shadcn (handoff proprio)
   |
   v
UI-3: charts wrappers (KLineChart/Recharts/ECharts) por handoff
   |
   v
UI-4: conectar contra Read Worker real (RW-2/RW-3)
   |
   v
UI-5: Cloudflare Pages/Workers OpenNext deploy (H-014)
   |
   v
UI-6+: audit explorer, blob viewer (RW-5/RW-6 + R-B3)
   |
   v
UI-13/14: a11y/perf/security pass (CSP, regex anti-segredo)
```

Cada etapa requer handoff Codex proprio. Nenhuma esta autorizada por
UI-1.

## 6. Tabela de comandos

| Acao | Comando |
|---|---|
| Subir dev server | `node bithub-ui/scripts/dev-server.mjs` |
| Subir em porta custom | `node bithub-ui/scripts/dev-server.mjs --port 4000` |
| Smoke offline (sobe servidor, testa 14 casos, encerra) | `node bithub-ui/scripts/smoke.mjs` |
| Testes UI completos (71 OK) | `node --test bithub-ui/tests/*.test.mjs` |
| Testar read client | `node --test bithub-ui/tests/read-client.test.mjs` |
| Testar dev server + sanitizer + dev-states | `node --test bithub-ui/tests/dev-server.test.mjs` |
| Testar primitivos `h()` (UI-2A) | `node --test bithub-ui/tests/components.test.mjs` |
| Sweep estatico anti-segredo (UI-2A) | `node --test bithub-ui/tests/anti-secret.test.mjs` |
| Regenerar fixtures (one-shot) | `cd bithub-data-layer && PYTHONDONTWRITEBYTECODE=1 python3 -W error scripts/export_read_worker_fixtures.py` |
| Testar Worker skeleton (H-013) | `node --test bithub-read-worker/tests/read-worker.test.mjs` |
| Suite Python completa | `cd bithub-data-layer && PYTHONDONTWRITEBYTECODE=1 python3 -W error -m unittest discover -s tests` |

## 6.1 UI-2A polish (2026-05-26)

Mudancas conservadoras em cima do UI-1 aprovado:

1. **Ramo `html` em `h()` removido.** `components.mjs` agora lanca
   `Error("h(): prop 'html' is forbidden — use textContent children")` se
   alguem tentar usar a chave `html`. Fecha a porta para XSS via
   `innerHTML`; o caminho nunca foi usado em UI-1, mas estava disponivel
   como debito.
2. **Sanitizacao de query strings nos logs do dev-server.**
   `scripts/dev-server.mjs` exporta `sanitizeUrlForLog(rawUrl)` que extrai
   apenas o path + uma contagem de chaves de query (ex.:
   `/v1/bundles/latest?<1 key>`). Valores nunca aparecem no log. Mesmo
   em UI-1 isso era ja seguro (so `symbol=BTC%2FUSDT%3AUSDT` passava),
   mas a politica vale tambem para qualquer query controlavel pelo
   caller em RW-2+.
3. **Sweep estatico anti-segredo.** `tests/anti-secret.test.mjs`
   varre `bithub-ui/` e `bithub-read-worker/src/` procurando os 8 tokens
   canonicos da skill `bithub-ui-conventions` secao 14 (lista exata
   vive no proprio teste, em `FORBIDDEN_TOKENS`, e e auditada contra o
   sweep de wire em `read-client.test.mjs` para evitar drift).
   Complementa o sweep de wire (que valida bodies de resposta)
   prevenindo que segredos cheguem ao codigo antes do runtime.
4. **Rota `/dev/states` (gallery).** `views/dev-states.mjs` renderiza
   com props sinteticos os 10 estados first-class (loading, empty, ok,
   degraded, stale, partial, error, envelope_drift, transport_error,
   blob_unavailable). Cumpre o gate F-001 secao 15.3 "todos os estados
   secao 8 renderizam corretamente em rota /dev/states". Atalho `g v`.
   Nao consome `/v1/*`; nao inventa payload operacional.
5. **Testes novos.** `components.test.mjs` (6) cobre regressao do
   ramo `html` + comportamento base de `h()`. `dev-server.test.mjs`
   ganhou 7 testes do `sanitizeUrlForLog` e 2 do `/dev/states`.
6. **O que NAO mudou.** Stack continua static HTML/CSS/JS, zero
   dependencia. Read client, router, state, format, views existentes,
   styles.css, index.html — todos intocados. Sem `package.json`, sem
   `node_modules`, sem Cloudflare real, sem commit, sem push.

## 7. Decisoes nao tomadas (responsabilidade Codex)

- Adotar (ou nao) Vite + React em UI-2.
- Setar Cloudflare Access policy em `app.bit-hub.pro`.
- Definir custom domain `app.bit-hub.pro` (gate B6).
- Aprovar deploy real (H-014).
- Definir Logpush destino R2.
- Definir rate limit WAF.
- Definir TTL presigned URL R2 (R-B3).

Cada uma vira handoff proprio quando chegar a hora.
