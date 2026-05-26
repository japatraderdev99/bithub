// source-status.mjs — Source Status View.
//
// Tabela canonica de eventos /v1/source-status.

import {
  card,
  h,
  kv,
  statusBadge,
  loadingState,
  errorState,
  emptyState,
  chip,
} from "../components.mjs";
import { fmtIso, fmtMs, fmtRelative } from "../format.mjs";
import { fetchSourceStatus } from "../read-client.mjs";

export async function render(container) {
  container.replaceChildren(
    card({ title: "Source status", children: [loadingState("Loading /v1/source-status…")] })
  );
  const result = await fetchSourceStatus();
  if (result.kind !== "ok") {
    container.replaceChildren(
      card({ title: "Source status", children: [errorState(result)] })
    );
    return;
  }
  const env = result.envelope;
  const data = env.data || {};
  const events = Array.isArray(data.events) ? data.events : [];
  container.replaceChildren(
    card({
      title: "Source status envelope",
      meta: result.headers && result.headers.readSource ? `source=${result.headers.readSource}` : null,
      children: [
        kv([
          ["schema_version", chip(env.schema_version)],
          ["as_of", h("span", { class: "mono dim" }, fmtIso(env.as_of))],
          ["served_at", h("span", { class: "mono dim" }, fmtIso(env.served_at))],
          ["source", chip(env.source)],
          [
            "stale",
            env.stale ? statusBadge("stale", "TRUE") : statusBadge("ok", "FALSE"),
          ],
          [
            "filter",
            data.source
              ? h("span", null, "source=", chip(data.source), data.since ? h("span", null, " since=", h("span", { class: "mono dim" }, data.since)) : null)
              : h("span", { class: "muted" }, "—"),
          ],
        ]),
      ],
    }),
    events.length === 0
      ? card({ title: "Events", children: [emptyState("No events in window")] })
      : renderEvents(env, events)
  );
}

function renderEvents(env, events) {
  const rows = events.map((ev) =>
    h(
      "tr",
      null,
      h("td", null, ev.source || "—"),
      h("td", null, ev.endpoint || "—"),
      h("td", null, statusBadge(ev.status, (ev.status || "—").toUpperCase())),
      h(
        "td",
        null,
        ev.error_code || h("span", { class: "muted" }, "—")
      ),
      h("td", { class: "num" }, ev.http_status ?? "—"),
      h("td", { class: "num" }, fmtMs(ev.latency_ms)),
      h("td", { class: "num" }, ev.retry_count ?? 0),
      h(
        "td",
        null,
        ev.degraded
          ? statusBadge("degraded", "TRUE")
          : h("span", { class: "muted" }, "false")
      ),
      h(
        "td",
        null,
        ev.cache_hit
          ? chip("CACHE", { kind: "cache" })
          : h("span", { class: "muted" }, "false")
      ),
      h(
        "td",
        { class: "muted mono", title: ev.created_at || "" },
        fmtRelative(ev.created_at, env.served_at)
      )
    )
  );
  return card({
    title: `Events (${events.length})`,
    children: [
      h(
        "div",
        { style: "overflow-x:auto;" },
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
              h("th", null, "endpoint"),
              h("th", null, "status"),
              h("th", null, "error_code"),
              h("th", null, "http_status"),
              h("th", null, "latency"),
              h("th", null, "retry"),
              h("th", null, "degraded"),
              h("th", null, "cache_hit"),
              h("th", null, "created_at")
            )
          ),
          h("tbody", null, ...rows)
        )
      ),
    ],
  });
}
