// config.mjs — Config View.
//
// Mostra public_config e feature_flags lado a lado.

import {
  card,
  h,
  kv,
  loadingState,
  errorState,
  chip,
  statusBadge,
} from "../components.mjs";
import { fmtIso } from "../format.mjs";
import {
  fetchPublicConfig,
  fetchFeatureFlags,
} from "../read-client.mjs";

export async function render(container) {
  container.replaceChildren(
    h(
      "div",
      { class: "card-grid-2" },
      card({ title: "Public config", children: [loadingState("Loading /v1/config/public…")] }),
      card({ title: "Feature flags", children: [loadingState("Loading /v1/config/feature-flags…")] })
    )
  );
  const [cfg, flags] = await Promise.all([
    fetchPublicConfig(),
    fetchFeatureFlags(),
  ]);
  container.replaceChildren(
    h(
      "div",
      { class: "card-grid-2" },
      renderCfg(cfg),
      renderFlags(flags)
    )
  );
}

function renderCfg(result) {
  if (result.kind !== "ok") {
    return card({ title: "Public config", children: [errorState(result)] });
  }
  const env = result.envelope;
  const data = env.data || {};
  return card({
    title: "Public config",
    meta: result.headers && result.headers.readSource ? `source=${result.headers.readSource}` : null,
    children: [
      kv([
        ["schema_version", chip(env.schema_version)],
        ["as_of", h("span", { class: "mono dim" }, fmtIso(env.as_of))],
        ["served_at", h("span", { class: "mono dim" }, fmtIso(env.served_at))],
        ["api_version", chip(data.api_version || "—")],
        ["build_id", chip(data.build_id || "—", { kind: "neutral" })],
        ["supported_symbols_url", h("span", { class: "mono dim" }, data.supported_symbols_url || "—")],
        ["stale", env.stale ? statusBadge("stale", "TRUE") : statusBadge("ok", "FALSE")],
      ]),
      data.feature_flags
        ? h(
            "div",
            { class: "mt-12" },
            h("div", { class: "muted mb-8", style: "font-size:11px; text-transform:uppercase; letter-spacing:0.02em;" }, "feature_flags (preview)"),
            renderFlagsList(data.feature_flags)
          )
        : null,
    ],
  });
}

function renderFlags(result) {
  if (result.kind !== "ok") {
    return card({ title: "Feature flags", children: [errorState(result)] });
  }
  const env = result.envelope;
  const data = env.data || {};
  return card({
    title: "Feature flags",
    meta: result.headers && result.headers.readSource ? `source=${result.headers.readSource}` : null,
    children: [
      kv([
        ["schema_version", chip(env.schema_version)],
        ["as_of", h("span", { class: "mono dim" }, fmtIso(env.as_of))],
        ["served_at", h("span", { class: "mono dim" }, fmtIso(env.served_at))],
        ["stale", env.stale ? statusBadge("stale", "TRUE") : statusBadge("ok", "FALSE")],
      ]),
      renderFlagsList(data.flags || data),
    ],
  });
}

function renderFlagsList(flags) {
  const entries = Object.entries(flags || {}).filter(([k]) => !k.startsWith("_"));
  if (entries.length === 0) {
    return h("div", { class: "state", dataState: "empty" }, "No flags defined");
  }
  return h(
    "table",
    { class: "dt mt-8" },
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        h("th", null, "flag"),
        h("th", null, "value")
      )
    ),
    h(
      "tbody",
      null,
      ...entries.map(([k, v]) =>
        h(
          "tr",
          null,
          h("td", null, k),
          h(
            "td",
            null,
            typeof v === "boolean"
              ? statusBadge(v ? "ok" : "empty", v ? "TRUE" : "FALSE")
              : h("span", { class: "mono" }, JSON.stringify(v))
          )
        )
      )
    )
  );
}
