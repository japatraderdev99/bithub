// components.mjs — primitivos UI sem dependencia.
//
// `h(tag, props, ...children)` constroi DOM com seguranca: textContent
// para strings/numbers; aceita HTMLElement filhos.
//
// Status sempre vem com texto + glyph + cor (data-status). Estados
// (loading/empty/stale/degraded/error) sao first-class.

import { fmtIso, fmtRelative, fmtTruncated, statusGlyph } from "./format.mjs";

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class" || k === "className") {
        el.setAttribute("class", v);
      } else if (k === "html") {
        // O ramo `html` foi removido em UI-2A para fechar a porta de XSS
        // que existia em UI-1 (caminho innerHTML nao usado).
        // Reincluir exige handoff Codex-Orchestrator proprio e
        // sanitizacao explicita do payload.
        throw new Error("h(): prop 'html' is forbidden — use textContent children");
      } else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k.startsWith("data") || k.startsWith("aria") || k === "role") {
        el.setAttribute(
          k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()),
          String(v)
        );
      } else if (k === "for") {
        el.setAttribute("for", v);
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(parent, children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

/** Limpa um container e renderiza um filho. */
export function mount(container, child) {
  while (container.firstChild) container.removeChild(container.firstChild);
  if (child) container.appendChild(child);
}

// --------------------------------------------------------------------------
// Status badge
// --------------------------------------------------------------------------

export function statusBadge(status, label) {
  const text = label || (status ? status.toUpperCase() : "—");
  return h(
    "span",
    { class: "badge", dataStatus: status || "empty" },
    h("span", { class: "glyph" }, statusGlyph(status)),
    text
  );
}

// --------------------------------------------------------------------------
// Card
// --------------------------------------------------------------------------

export function card({ title, meta, children = [] } = {}) {
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("h3", null, title || ""),
      meta ? h("span", { class: "meta" }, meta) : null
    ),
    h("div", { class: "card-body" }, ...children)
  );
}

// --------------------------------------------------------------------------
// Key-value block
// --------------------------------------------------------------------------

export function kv(entries) {
  const dl = h("dl", { class: "kv" });
  for (const [k, v] of entries) {
    const dt = h("dt", null, k);
    const dd = v instanceof Node ? h("dd", null, v) : h("dd", null, v ?? "—");
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  return dl;
}

// --------------------------------------------------------------------------
// Stamps and chips
// --------------------------------------------------------------------------

export function asOfStamp(asOf, servedAt) {
  if (!asOf) return h("span", { class: "muted" }, "—");
  const rel = fmtRelative(asOf, servedAt);
  return h(
    "span",
    { class: "row" },
    h("span", { class: "mono dim", title: fmtIso(asOf) }, fmtIso(asOf)),
    h("span", { class: "muted" }, rel)
  );
}

export function chip(text, { kind = "neutral", title } = {}) {
  return h(
    "span",
    { class: `chip ${kind === "run" ? "run" : kind === "cache" ? "cache" : ""}`, title: title || text || "" },
    text || "—"
  );
}

export function runIdChip(runId) {
  if (!runId) return chip("—");
  return chip(fmtTruncated(runId, { head: 8, tail: 4 }), {
    kind: "run",
    title: runId,
  });
}

// --------------------------------------------------------------------------
// State primitives
// --------------------------------------------------------------------------

export function loadingState(label = "Loading…", lines = 3) {
  const wrap = h(
    "div",
    { class: "state", dataState: "loading", role: "status", ariaLive: "polite" },
    h(
      "div",
      { class: "row" },
      statusBadge("loading", "LOADING"),
      h("span", { class: "state-title" }, label)
    )
  );
  for (let i = 0; i < lines; i++) {
    wrap.appendChild(
      h("div", {
        class: `skeleton ${i === 0 ? "w-80" : i === 1 ? "w-60" : "w-40"}`,
      })
    );
  }
  return wrap;
}

export function emptyState(title = "No data", hint) {
  return h(
    "div",
    { class: "state", dataState: "empty" },
    h(
      "div",
      { class: "row" },
      statusBadge("empty", "EMPTY"),
      h("span", { class: "state-title" }, title)
    ),
    hint ? h("span", { class: "state-hint" }, hint) : null
  );
}

export function staleState({ asOf, freshnessSeconds, hint } = {}) {
  return h(
    "div",
    { class: "state", dataState: "stale" },
    h(
      "div",
      { class: "row" },
      statusBadge("stale", "STALE"),
      h("span", { class: "state-title" }, "Data is stale")
    ),
    asOf
      ? h("span", { class: "state-hint" }, "as_of: ", fmtIso(asOf))
      : null,
    typeof freshnessSeconds === "number"
      ? h(
          "span",
          { class: "state-hint" },
          "freshness: ",
          String(freshnessSeconds),
          "s"
        )
      : null,
    hint ? h("span", { class: "state-hint" }, hint) : null
  );
}

export function degradedState({ source, errorCode, hint } = {}) {
  return h(
    "div",
    { class: "state", dataState: "degraded" },
    h(
      "div",
      { class: "row" },
      statusBadge("degraded", "DEGRADED"),
      h(
        "span",
        { class: "state-title" },
        source ? `Source ${source} is degraded` : "Degraded"
      )
    ),
    errorCode
      ? h("span", { class: "state-code" }, "error_code: ", errorCode)
      : null,
    hint ? h("span", { class: "state-hint" }, hint) : null
  );
}

/**
 * fail-loud. Recebe um result do read-client.
 */
export function errorState(result, hint) {
  let code = "unknown_error";
  let message = "Failed to fetch read-model";
  let requestId = null;
  if (result) {
    if (result.kind === "error" && result.errorEnvelope) {
      code = result.errorEnvelope.error.code || code;
      message = result.errorEnvelope.error.message || message;
      requestId = result.errorEnvelope.error.request_id || null;
    } else if (result.kind === "envelope_drift") {
      code = "envelope_drift";
      message = result.reasons ? result.reasons.join("; ") : "envelope drift";
    } else if (result.kind === "transport_error") {
      code = "network_error";
      message = result.message || "transport error";
    }
  }
  return h(
    "div",
    { class: "state", dataState: "error", role: "alert" },
    h(
      "div",
      { class: "row" },
      statusBadge("error", "ERROR"),
      h("span", { class: "state-title" }, code)
    ),
    h("span", { class: "state-hint" }, message),
    requestId
      ? h("span", { class: "state-code mono" }, "request_id: ", requestId)
      : null,
    hint ? h("span", { class: "state-hint" }, hint) : null
  );
}
