// blobs.mjs — demonstra estado 503 esperado.
//
// /v1/blobs/* responde 503 com warning literal "blobs not available in
// skeleton". A UI deve mostrar isso como estado planejado, nao bug.
// Quando R-B3 for resolvido (R2 presigned), este estado vira o caminho
// de erro real.

import {
  card,
  h,
  kv,
  statusBadge,
  loadingState,
  errorState,
  chip,
} from "../components.mjs";
import { fmtIso } from "../format.mjs";
import { fetchBlobBundle, fetchBlobManifest } from "../read-client.mjs";

const SAMPLE_BUNDLE_ID = "01HZX3K2M7Q9W5R4T8N1B6Y2RQ";
const SAMPLE_MANIFEST_ID = "01HZX3K2M7Q9W5R4T8N1B6Y2RM";

export async function render(container) {
  container.replaceChildren(
    explainer(),
    h(
      "div",
      { class: "card-grid-2" },
      card({
        title: `GET /v1/blobs/bundle/${SAMPLE_BUNDLE_ID}`,
        children: [loadingState("Loading…")],
      }),
      card({
        title: `GET /v1/blobs/manifest/${SAMPLE_MANIFEST_ID}`,
        children: [loadingState("Loading…")],
      })
    )
  );
  const [bundleRes, manifestRes] = await Promise.all([
    fetchBlobBundle(SAMPLE_BUNDLE_ID),
    fetchBlobManifest(SAMPLE_MANIFEST_ID),
  ]);
  container.replaceChildren(
    explainer(),
    h(
      "div",
      { class: "card-grid-2" },
      renderBlob(`bundle/${SAMPLE_BUNDLE_ID}`, bundleRes),
      renderBlob(`manifest/${SAMPLE_MANIFEST_ID}`, manifestRes)
    )
  );
}

function explainer() {
  return h(
    "div",
    { class: "bithub-disclaimer mb-12" },
    h("strong", null, "Estado planejado, nao bug. "),
    "Em H-013 (skeleton), `/v1/blobs/*` responde HTTP 503 com warning literal ",
    h("span", { class: "mono" }, "\"blobs not available in skeleton\""),
    " porque R2 presigned (R-B3) ainda nao foi liberado. Esta view existe ",
    "para garantir que a UI ja trata o caminho de blob indisponivel desde o dia 1. ",
    "Quando R-B3 for resolvido, o mesmo componente passa a renderizar a URL presigned curta."
  );
}

function renderBlob(label, result) {
  if (result.kind === "blob_unavailable") {
    const env = result.envelope;
    return card({
      title: label,
      meta: result.headers && result.headers.readSource ? `source=${result.headers.readSource}` : null,
      children: [
        h(
          "div",
          { class: "state", dataState: "degraded" },
          h(
            "div",
            { class: "row" },
            statusBadge("stale", "STALE"),
            h("span", { class: "state-title" }, "HTTP 503"),
            chip(`status=${result.status}`)
          ),
          h(
            "span",
            { class: "state-hint" },
            "warning: ",
            h("span", { class: "mono" }, result.warning || "—")
          ),
          h(
            "span",
            { class: "state-code mono" },
            "schema_version: ",
            env.schema_version
          )
        ),
        kv([
          ["as_of", h("span", { class: "mono dim" }, fmtIso(env.as_of))],
          ["served_at", h("span", { class: "mono dim" }, fmtIso(env.served_at))],
          ["source", chip(env.source)],
          ["stale", env.stale ? statusBadge("stale", "TRUE") : statusBadge("ok", "FALSE")],
          [
            "data",
            env.data === null
              ? h("span", { class: "muted" }, "null (expected)")
              : h("span", { class: "muted mono" }, JSON.stringify(env.data)),
          ],
        ]),
      ],
    });
  }
  if (result.kind === "ok") {
    return card({
      title: label,
      children: [
        h(
          "div",
          { class: "state", dataState: "ok" },
          h(
            "div",
            { class: "row" },
            statusBadge("ok", "OK"),
            h("span", { class: "state-title" }, "Blob available")
          ),
          h("span", { class: "state-hint" }, "schema_version: ", result.envelope.schema_version),
          h("span", { class: "state-hint" }, "(R2 presigned would render here)")
        ),
      ],
    });
  }
  return card({ title: label, children: [errorState(result)] });
}
