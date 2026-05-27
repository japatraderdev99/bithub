// live-client.mjs — fetch wrappers para /live/* endpoints.
//
// Endpoints sao expostos pelo dev-server local; em producao retornam 503.
// Cada wrapper retorna { kind, data?, error? } no estilo dos outros clients.

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

export function fetchPositions() {
  return fetchJson("/live/positions");
}

export function fetchScanner() {
  return fetchJson("/live/scanner");
}

export function fetchEvents({ since, limit } = {}) {
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return fetchJson(qs ? `/live/events?${qs}` : "/live/events");
}

export function fetchRaw({ n } = {}) {
  const params = new URLSearchParams();
  if (n) params.set("n", String(n));
  const qs = params.toString();
  return fetchJson(qs ? `/live/raw?${qs}` : "/live/raw");
}
