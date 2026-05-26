// dev-states.mjs — Catalogo de estados operacionais (UI dev gallery).
//
// Renderiza, com props sinteticos, os 8 estados first-class do dashboard
// para garantir cobertura visual antes de plugar dados reais:
//
//   loading | empty | ok | degraded | stale | partial | error | blob_unavailable
//
// Esta view e DEV-ONLY. Nao consome `/v1/*`. Nao inventa payload operacional
// (overall_status, symbol, OHLCV, etc.) — apenas demonstra os componentes de
// estado que `components.mjs` exporta. Conforme F-001 secao 15.3 / UI-3:
//
//   "Todos os estados secao 8 renderizam corretamente em rota /dev/states."
//
// Vocabulario proibido (signal/score/direction/regime/trade_bias/...) nao
// aparece aqui. Cores seguem principio 2/3: verde/vermelho sao status
// operacionais, nunca direcao.

import {
  card,
  h,
  loadingState,
  emptyState,
  staleState,
  degradedState,
  errorState,
  statusBadge,
} from "../components.mjs";

const STATES = [
  {
    id: "loading",
    title: "Loading",
    hint: "Request em voo, sem cache. Skeleton sutil + chip LOADING.",
    render: () => loadingState("Loading /v1/health…", 3),
  },
  {
    id: "empty",
    title: "Empty",
    hint: "Endpoint OK, zero registros. Texto explicito, sem placeholder operacional.",
    render: () => emptyState("No events in window", "Try widening the time range."),
  },
  {
    id: "ok",
    title: "OK",
    hint: "Render normal. Status com texto + cor (nunca so cor).",
    render: () =>
      h(
        "div",
        { class: "row" },
        statusBadge("ok", "OK"),
        h(
          "span",
          { class: "muted" },
          "All sources fresh; render normal."
        )
      ),
  },
  {
    id: "degraded",
    title: "Degraded",
    hint: "Alguma secao com problema. Overlay amber + badge DEGRADED + error_code real.",
    render: () =>
      degradedState({
        source: "fred",
        errorCode: "bad_response",
        hint:
          "Macro section degraded; mandatory sections still ok. Banner global vira amber.",
      }),
  },
  {
    id: "stale",
    title: "Stale",
    hint: "Secao presente com stale=true (R-001 5.1 auto-degrade quando served_at - as_of > 2*TTL).",
    render: () =>
      staleState({
        asOf: "2026-05-26T13:55:00Z",
        freshnessSeconds: 720,
        hint: "Cache hit mas idade > 2*TTL — banner global vira amber.",
      }),
  },
  {
    id: "partial",
    title: "Partial",
    hint:
      "Mandatory sections ok, opcional ausente. Secao opcional renderiza emptyState — mandatory continua normal.",
    render: () =>
      emptyState(
        "No fundamentals this run",
        "Mandatory sections (market, derivatives) renderizam normalmente."
      ),
  },
  {
    id: "error",
    title: "Error",
    hint:
      "Fail-loud. Mostra error_code real do envelope `read.error.v1`. Sem fallback silencioso.",
    render: () =>
      errorState(
        {
          kind: "error",
          status: 502,
          errorEnvelope: {
            schema_version: "read.error.v1",
            served_at: "2026-05-26T14:00:00Z",
            error: {
              code: "network_error",
              message: "Upstream KV unavailable; D1 fallback also failed.",
              request_id: "01HZX-DEV-STATES",
            },
          },
        },
        "Botao retry so re-invalida query — nunca escreve."
      ),
  },
  {
    id: "envelope_drift",
    title: "Envelope drift",
    hint:
      "Resposta com schema_version invalido. read-client falha-fechado, UI renderiza errorState com code=envelope_drift.",
    render: () =>
      errorState(
        {
          kind: "envelope_drift",
          reasons: [
            "missing key: schema_version",
            "source not in {kv,d1,r2,derived}",
          ],
        },
        "Protege contra drift silencioso entre Worker e UI."
      ),
  },
  {
    id: "transport_error",
    title: "Transport error",
    hint: "Falha de rede/socket antes do envelope. Trate como ErrorState com message generico.",
    render: () =>
      errorState({
        kind: "transport_error",
        message: "fetch failed: ECONNREFUSED 127.0.0.1:3000",
      }),
  },
  {
    id: "blob_unavailable",
    title: "Blob unavailable",
    hint:
      "503 + warning literal `blobs not available in skeleton`. Estado PLANEJADO ate R-B3 resolvido, nao bug.",
    render: () => blobUnavailableDemo(),
  },
];

function blobUnavailableDemo() {
  return h(
    "div",
    { class: "state", dataState: "stale" },
    h(
      "div",
      { class: "row" },
      statusBadge("stale", "BLOB UNAVAILABLE"),
      h("span", { class: "state-title" }, "blobs not available in skeleton")
    ),
    h(
      "span",
      { class: "state-hint" },
      "Read Worker skeleton responde 503 em /v1/blobs/* ate R-B3 (R2 presigned strategy) ser resolvido."
    ),
    h(
      "span",
      { class: "state-hint mono" },
      "schema_version: read.blob.v1 · stale: true · data: null"
    )
  );
}

export async function render(container) {
  const intro = card({
    title: "Operational states (dev gallery)",
    meta: "synthetic props · no /v1/* call",
    children: [
      h(
        "p",
        { class: "muted" },
        "Catalogo dos estados first-class do dashboard. Render usa props sinteticos, sem chamar o Read Worker. ",
        "Coberto pelo F-001 secao 15.3 (gate de promocao MVP → beta) e pela skill bithub-ui-conventions secao 7. ",
        "Nenhum vocabulario operacional (signal/score/direction/regime) aparece aqui."
      ),
    ],
  });

  const cards = STATES.map((s) =>
    card({
      title: s.title,
      meta: s.id,
      children: [
        h(
          "p",
          { class: "muted state-hint" },
          s.hint
        ),
        s.render(),
      ],
    })
  );

  container.replaceChildren(
    intro,
    h("div", { class: "card-grid-2" }, ...cards)
  );
}

// Exportado para os testes verificarem que o catalogo cobre os 8 estados
// minimos sem palavras proibidas.
export const _internals = Object.freeze({ STATES });
