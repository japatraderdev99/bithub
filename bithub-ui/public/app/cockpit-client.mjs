// cockpit-client.mjs — fetch wrappers for /cockpit/* endpoints.
//
// Endpoints are exposed by the local dev-server when BITHUB_COCKPIT_STATE
// is set. In production they return 503 — the cockpit view is local-only.
//
// Same return shape as live-client.mjs: { kind, data?, error?, hint? }.

const HEADERS = { Accept: "application/json" };

async function fetchJson(path) {
  let res;
  try {
    res = await fetch(path, { headers: HEADERS, cache: "no-store" });
  } catch (err) {
    return { kind: "network-error", error: err && err.message ? err.message : String(err) };
  }
  if (res.status === 503) {
    let body = null;
    try { body = await res.json(); } catch (_e) { /* ignore */ }
    return { kind: "disabled", hint: body && body.hint, detail: body && body.detail };
  }
  if (!res.ok) {
    return { kind: "http-error", status: res.status };
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { kind: "parse-error", error: err && err.message ? err.message : String(err) };
  }
  return { kind: "ok", data: body };
}

export function fetchCockpitState() {
  return fetchJson("/cockpit/state");
}

export function fetchCockpitEvents({ since, symbol, type, limit } = {}) {
  const params = new URLSearchParams();
  if (since != null) params.set("since", String(since));
  if (symbol) params.set("symbol", symbol);
  if (type) params.set("type", type);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return fetchJson(qs ? `/cockpit/events?${qs}` : "/cockpit/events");
}

export function fetchCockpitSystem() {
  return fetchJson("/cockpit/system");
}
