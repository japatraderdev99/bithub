// bundle.mjs — Bundle drill-down por simbolo (Phase 0: BTC/USDT:USDT).

import {
  card,
  h,
  kv,
  statusBadge,
  loadingState,
  errorState,
  emptyState,
  chip,
  runIdChip,
} from "../components.mjs";
import { fmtIso, fmtRelative } from "../format.mjs";
import { fetchLatestBundle, fetchSymbols } from "../read-client.mjs";

export async function render(container, { symbol }) {
  const decoded = symbol ? decodeURIComponent(symbol) : "BTC/USDT:USDT";
  container.replaceChildren(
    renderHeader(decoded, null),
    card({
      title: "Bundle envelope",
      children: [loadingState(`Loading /v1/bundles/latest?symbol=${decoded}…`)],
    })
  );
  const [bundleRes, symbolsRes] = await Promise.all([
    fetchLatestBundle(decoded),
    fetchSymbols(),
  ]);

  if (bundleRes.kind !== "ok") {
    container.replaceChildren(
      renderHeader(decoded, symbolsRes),
      card({
        title: "Bundle envelope",
        children: [errorState(bundleRes)],
      })
    );
    return;
  }
  const env = bundleRes.envelope;
  const data = env.data || {};

  container.replaceChildren(
    renderHeader(decoded, symbolsRes),
    card({
      title: "Bundle envelope",
      meta: bundleRes.headers && bundleRes.headers.readSource
        ? `source=${bundleRes.headers.readSource}`
        : null,
      children: [
        kv([
          ["schema_version", chip(env.schema_version)],
          ["symbol", chip(data.symbol || decoded)],
          [
            "overall_status",
            statusBadge(
              data.overall_status,
              (data.overall_status || "—").toUpperCase()
            ),
          ],
          [
            "stale",
            (env.stale || data.stale)
              ? statusBadge("stale", "TRUE")
              : statusBadge("ok", "FALSE"),
          ],
          ["as_of", h("span", { class: "mono dim" }, fmtIso(env.as_of))],
          ["served_at", h("span", { class: "mono dim" }, fmtIso(env.served_at))],
          ["bundle_created_at", h("span", { class: "mono dim" }, fmtIso(data.bundle_created_at))],
          ["r2_bundle_key", h("span", { class: "chip r2-key mono", title: data.r2_bundle_key }, data.r2_bundle_key || "—")],
          [
            "warnings",
            env.warnings.length === 0
              ? h("span", { class: "muted" }, "—")
              : h("span", null, env.warnings.join(", ")),
          ],
        ]),
      ],
    }),
    renderSectionGrid(env)
  );
}

function renderHeader(decoded, symbolsRes) {
  const known = collectSymbols(symbolsRes);
  const buttons = known.length === 0
    ? null
    : known.map((s) =>
        h(
          "a",
          {
            class: "chip",
            href: `#/bundle/${encodeURIComponent(s)}`,
            style: s === decoded ? "color: var(--text); border-color: var(--accent);" : "",
          },
          s
        )
      );
  return h(
    "div",
    { class: "row mb-12", style: "flex-wrap: wrap;" },
    h("span", { class: "muted" }, "symbol:"),
    h("span", { class: "mono", style: "font-weight:600;" }, decoded),
    h("span", { class: "spacer flex-1" }),
    ...(buttons || [])
  );
}

function collectSymbols(symbolsRes) {
  if (!symbolsRes || symbolsRes.kind !== "ok") return [];
  const env = symbolsRes.envelope;
  const list = env.data && Array.isArray(env.data.symbols) ? env.data.symbols : [];
  return list.map((s) => s.symbol).filter((s) => typeof s === "string");
}

function renderSectionGrid(env) {
  const data = env.data || {};
  const sections = data.section_statuses;
  if (!sections || Object.keys(sections).length === 0) {
    return card({
      title: "Section statuses",
      children: [emptyState("No sections in this bundle")],
    });
  }
  const snapshotRefs = data.snapshot_refs || {};
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
        info.present
          ? runIdChip(snapshotRefs[name])
          : h("span", { class: "muted" }, "absent")
      )
    );
  }
  return card({
    title: "Section statuses",
    meta: `overall=${data.overall_status}`,
    children: [grid],
  });
}
