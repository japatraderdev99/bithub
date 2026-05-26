// dashboard.mjs — Dashboard Home.
//
// Mostra:
// - FreshnessBanner global derivado de overall health.
// - 2 cards lado a lado: HealthSummary + BundleSummary BTC/USDT:USDT.
// - SectionStatusGrid 4 secoes (market, derivatives, fundamentals, macro).
// - Aviso de read-only.

import {
  card,
  h,
  kv,
  loadingState,
  errorState,
  emptyState,
  statusBadge,
  asOfStamp,
  chip,
  runIdChip,
} from "../components.mjs";
import {
  fmtIso,
  fmtMs,
  fmtRelative,
} from "../format.mjs";
import {
  fetchHealth,
  fetchLatestBundle,
} from "../read-client.mjs";

const PRIMARY_SYMBOL = "BTC/USDT:USDT";

export async function render(container) {
  // estado loading imediato
  container.replaceChildren(
    freshnessBanner({ status: "loading", asOf: null, servedAt: null }),
    h(
      "div",
      { class: "card-grid-2" },
      card({
        title: "Health summary",
        children: [loadingState("Loading /v1/health…")],
      }),
      card({
        title: "Bundle summary — BTC/USDT:USDT",
        children: [loadingState("Loading /v1/bundles/latest…")],
      })
    ),
    card({
      title: "Section statuses",
      children: [loadingState("Loading sections…", 2)],
    }),
    disclaimer()
  );

  const [healthRes, bundleRes] = await Promise.all([
    fetchHealth(),
    fetchLatestBundle(PRIMARY_SYMBOL),
  ]);

  // banner agregado: se um dos dois falhou, ou degradou, banner reflete pior
  const banner = aggregateBanner(healthRes, bundleRes);

  container.replaceChildren(
    freshnessBanner(banner),
    h(
      "div",
      { class: "card-grid-2" },
      renderHealthCard(healthRes),
      renderBundleCard(bundleRes)
    ),
    renderSectionGrid(bundleRes),
    disclaimer()
  );
}

function aggregateBanner(healthRes, bundleRes) {
  let status = "ok";
  let asOf = null;
  let servedAt = null;
  let source = null;

  if (healthRes.kind === "ok") {
    asOf = healthRes.envelope.as_of;
    servedAt = healthRes.envelope.served_at;
    source = healthRes.envelope.source;
    const overall = healthRes.envelope.data && healthRes.envelope.data.overall_status;
    if (overall === "degraded") status = "degraded";
    else if (overall === "error") status = "error";
    if (healthRes.envelope.stale) status = status === "ok" ? "stale" : status;
  } else {
    status = "error";
  }

  if (bundleRes.kind === "ok") {
    const overall =
      bundleRes.envelope.data && bundleRes.envelope.data.overall_status;
    if (overall === "error") status = "error";
    else if (overall === "degraded" && status === "ok") status = "degraded";
    if (bundleRes.envelope.stale && status === "ok") status = "stale";
  } else if (bundleRes.kind !== "ok" && status === "ok") {
    status = "error";
  }

  return { status, asOf, servedAt, source };
}

function freshnessBanner({ status, asOf, servedAt, source }) {
  return h(
    "div",
    { class: "freshness-banner", dataStatus: status },
    statusBadge(status, status ? status.toUpperCase() : "—"),
    h("span", null, "data-layer"),
    asOf
      ? h(
          "span",
          { class: "muted mono" },
          "as_of ",
          fmtIso(asOf),
          " · ",
          fmtRelative(asOf, servedAt)
        )
      : h("span", { class: "muted" }, "—"),
    source
      ? h("span", { class: "muted mono" }, "source: ", source)
      : null,
    h("span", { class: "spacer flex-1" })
  );
}

function renderHealthCard(result) {
  if (result.kind !== "ok") {
    return card({
      title: "Health summary",
      meta: result.headers && result.headers.requestId,
      children: [errorState(result)],
    });
  }
  const data = result.envelope.data;
  const sources = data && data.sources ? data.sources : {};
  const sourceRows = Object.entries(sources).map(([name, info]) =>
    h(
      "tr",
      null,
      h("td", null, name),
      h("td", null, statusBadge(info.status, info.status.toUpperCase())),
      h("td", { class: "num" }, fmtMs(info.latency_ms)),
      h("td", null, info.error_code || h("span", { class: "muted" }, "—")),
      h(
        "td",
        { class: "muted mono", title: info.last_event_at || "" },
        fmtRelative(info.last_event_at, result.envelope.served_at)
      )
    )
  );

  return card({
    title: "Health summary",
    meta: result.headers && result.headers.readSource
      ? `source=${result.headers.readSource}`
      : null,
    children: [
      kv([
        ["overall_status", statusBadge(data.overall_status, data.overall_status.toUpperCase())],
        ["as_of", h("span", { class: "mono dim" }, fmtIso(result.envelope.as_of))],
        ["served_at", h("span", { class: "mono dim" }, fmtIso(result.envelope.served_at))],
        ["source", chip(result.envelope.source)],
        ["stale", result.envelope.stale ? statusBadge("stale", "TRUE") : statusBadge("ok", "FALSE")],
      ]),
      h(
        "table",
        { class: "dt mt-12" },
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
            h("th", null, "last_event")
          )
        ),
        h("tbody", null, ...sourceRows)
      ),
    ],
  });
}

function renderBundleCard(result) {
  if (result.kind !== "ok") {
    return card({
      title: `Bundle summary — ${PRIMARY_SYMBOL}`,
      meta: result.headers && result.headers.requestId,
      children: [errorState(result)],
    });
  }
  const data = result.envelope.data;
  return card({
    title: `Bundle summary — ${data.symbol || PRIMARY_SYMBOL}`,
    meta: result.headers && result.headers.readSource
      ? `source=${result.headers.readSource}`
      : null,
    children: [
      kv([
        [
          "overall_status",
          statusBadge(
            data.overall_status,
            data.overall_status ? data.overall_status.toUpperCase() : "—"
          ),
        ],
        ["bundle_created_at", h("span", { class: "mono dim" }, fmtIso(data.bundle_created_at))],
        ["as_of", h("span", { class: "mono dim" }, fmtIso(result.envelope.as_of))],
        ["served_at", h("span", { class: "mono dim" }, fmtIso(result.envelope.served_at))],
        [
          "stale",
          (result.envelope.stale || data.stale)
            ? statusBadge("stale", "TRUE")
            : statusBadge("ok", "FALSE"),
        ],
        ["r2_bundle_key", h("span", { class: "chip r2-key mono", title: data.r2_bundle_key }, data.r2_bundle_key || "—")],
      ]),
    ],
  });
}

function renderSectionGrid(result) {
  if (result.kind !== "ok") {
    return card({
      title: "Section statuses",
      children: [errorState(result, "Sem bundle, sem sections")],
    });
  }
  const sections = result.envelope.data && result.envelope.data.section_statuses;
  if (!sections || Object.keys(sections).length === 0) {
    return card({
      title: "Section statuses",
      children: [emptyState("No sections in this bundle")],
    });
  }
  const snapshotRefs = result.envelope.data.snapshot_refs || {};
  const grid = h(
    "div",
    { class: "section-grid" },
    h("div", { class: "head" }, "section"),
    h("div", { class: "head" }, "status"),
    h("div", { class: "head" }, "source"),
    h("div", { class: "head" }, "mandatory"),
    h("div", { class: "head" }, "error_code"),
    h("div", { class: "head" }, "snapshot")
  );
  for (const [name, info] of Object.entries(sections)) {
    grid.appendChild(h("div", { class: "cell" }, name));
    grid.appendChild(
      h(
        "div",
        { class: "cell" },
        statusBadge(info.status, (info.status || "—").toUpperCase())
      )
    );
    grid.appendChild(h("div", { class: "cell" }, info.source || "—"));
    grid.appendChild(
      h(
        "div",
        { class: "cell" },
        info.mandatory ? "yes" : h("span", { class: "muted" }, "no")
      )
    );
    grid.appendChild(
      h(
        "div",
        { class: "cell" },
        info.error_code || h("span", { class: "muted" }, "—")
      )
    );
    grid.appendChild(
      h(
        "div",
        { class: "cell" },
        info.present ? runIdChip(snapshotRefs[name]) : h("span", { class: "muted" }, "absent")
      )
    );
  }
  return card({
    title: "Section statuses",
    meta: `overall=${result.envelope.data.overall_status}`,
    children: [grid],
  });
}

function disclaimer() {
  return h(
    "div",
    { class: "bithub-disclaimer mt-12" },
    "Read-only dashboard. Fixtures provem de bithub_data via Read Worker skeleton (H-013). ",
    "Sem trade, sinal, score, direction, regime, ordem, posicao, wallet, saldo, paper trading ou execucao. ",
    "Sem KV/D1/R2 real, sem Cloudflare real, sem deploy."
  );
}
