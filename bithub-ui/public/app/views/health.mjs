// health.mjs — Health View.
//
// Detalha o read-model /v1/health: 3 fontes Phase 0 com status, latency,
// error_code, cache_hit, degraded, last_event_at.

import {
  card,
  h,
  kv,
  statusBadge,
  loadingState,
  errorState,
  chip,
} from "../components.mjs";
import { fmtIso, fmtMs, fmtRelative } from "../format.mjs";
import { fetchHealth } from "../read-client.mjs";

export async function render(container) {
  container.replaceChildren(
    card({
      title: "Health",
      children: [loadingState("Fetching /v1/health…")],
    })
  );
  const result = await fetchHealth();
  if (result.kind !== "ok") {
    container.replaceChildren(
      card({ title: "Health", children: [errorState(result)] })
    );
    return;
  }
  const env = result.envelope;
  const data = env.data;
  container.replaceChildren(
    card({
      title: "Health envelope",
      meta: result.headers && result.headers.readSource
        ? `X-Bithub-Read-Source=${result.headers.readSource}`
        : null,
      children: [
        kv([
          ["schema_version", chip(env.schema_version)],
          ["as_of", h("span", { class: "mono dim" }, fmtIso(env.as_of))],
          ["served_at", h("span", { class: "mono dim" }, fmtIso(env.served_at))],
          ["source", chip(env.source)],
          [
            "overall_status",
            statusBadge(
              data.overall_status,
              (data.overall_status || "—").toUpperCase()
            ),
          ],
          [
            "stale",
            env.stale ? statusBadge("stale", "TRUE") : statusBadge("ok", "FALSE"),
          ],
          [
            "warnings",
            env.warnings.length === 0
              ? h("span", { class: "muted" }, "—")
              : h("span", null, env.warnings.join(", ")),
          ],
        ]),
      ],
    }),
    renderSourcesTable(env, data.sources || {})
  );
}

function renderSourcesTable(env, sources) {
  const rows = Object.entries(sources).map(([name, info]) =>
    h(
      "tr",
      null,
      h("td", null, name),
      h("td", null, statusBadge(info.status, (info.status || "—").toUpperCase())),
      h("td", { class: "num" }, fmtMs(info.latency_ms)),
      h(
        "td",
        null,
        info.error_code || h("span", { class: "muted" }, "—")
      ),
      h(
        "td",
        null,
        info.degraded
          ? statusBadge("degraded", "TRUE")
          : h("span", { class: "muted" }, "false")
      ),
      h(
        "td",
        null,
        info.cache_hit
          ? chip("CACHE", { kind: "cache" })
          : h("span", { class: "muted" }, "false")
      ),
      h(
        "td",
        { class: "muted mono", title: info.last_event_at || "" },
        fmtRelative(info.last_event_at, env.served_at)
      )
    )
  );
  if (rows.length === 0) {
    return card({
      title: "Sources",
      children: [
        h("div", { class: "state", dataState: "empty" }, "No sources reported"),
      ],
    });
  }
  return card({
    title: "Sources",
    children: [
      h(
        "table",
        { class: "dt" },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", null, "source"),
            h("th", null, "status"),
            h("th", null, "latency"),
            h("th", null, "error_code"),
            h("th", null, "degraded"),
            h("th", null, "cache_hit"),
            h("th", null, "last_event")
          )
        ),
        h("tbody", null, ...rows)
      ),
    ],
  });
}
