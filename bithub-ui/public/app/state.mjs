// state.mjs — store pub/sub minimo.
//
// Phase 0 nao precisa de Redux/Zustand. Read-only com 6 endpoints.
// Mantemos um dicionario por chave de endpoint + dispatch por subscribe.

const subscribers = new Set();
const data = {
  density: "compact",
  view: "",
  fetched: Object.create(null), // endpointKey -> { result, fetchedAt }
};

export function getState() {
  return data;
}

export function setDensity(value) {
  if (value !== "compact" && value !== "normal") return;
  data.density = value;
  document.documentElement.setAttribute("data-density", value);
  notify();
}

export function setView(view) {
  data.view = view;
  notify();
}

export function setFetched(key, result) {
  data.fetched[key] = { result, fetchedAt: Date.now() };
  notify();
}

export function getFetched(key) {
  return data.fetched[key] || null;
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function notify() {
  for (const fn of subscribers) {
    try { fn(data); } catch (_err) { /* swallow */ }
  }
}
