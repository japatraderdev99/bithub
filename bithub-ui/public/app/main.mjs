// main.mjs — entry point do dashboard Bithub UI-1.
//
// Inicializa: density toggle, router por hash, footer agregado (puxa
// /v1/health), e dispatch para views.

import { registerRoute, onNavigate, start, navigate } from "./router.mjs";
import { setDensity, getState, subscribe } from "./state.mjs";
import { fetchHealth } from "./read-client.mjs";
import { fmtIso, fmtRelative } from "./format.mjs";

import { render as renderDashboard } from "./views/dashboard.mjs";
import { render as renderHealth } from "./views/health.mjs";
import { render as renderConfig } from "./views/config.mjs";
import { render as renderSourceStatus } from "./views/source-status.mjs";
import { render as renderBundle } from "./views/bundle.mjs";
import { render as renderBlobs } from "./views/blobs.mjs";
import { render as renderDevStates } from "./views/dev-states.mjs";
import { render as renderLive } from "./views/live.mjs";

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

registerRoute(/^\/$/, (_p) => ({ view: "dashboard", render: renderDashboard }));
registerRoute(/^\/health$/, (_p) => ({ view: "health", render: renderHealth }));
registerRoute(/^\/config$/, (_p) => ({ view: "config", render: renderConfig }));
registerRoute(/^\/source-status$/, (_p) => ({
  view: "source-status",
  render: renderSourceStatus,
}));
registerRoute(/^\/bundle\/(?<symbol>.+)$/, (_p) => ({
  view: "bundle",
  render: renderBundle,
}));
registerRoute(/^\/blobs$/, (_p) => ({ view: "blobs", render: renderBlobs }));
registerRoute(/^\/dev\/states$/, (_p) => ({
  view: "dev-states",
  render: renderDevStates,
}));
registerRoute(/^\/live$/, (_p) => ({ view: "live", render: renderLive }));

// --------------------------------------------------------------------------
// Density toggle
// --------------------------------------------------------------------------

function wireDensityToggle() {
  const btn = document.getElementById("density-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const next = getState().density === "compact" ? "normal" : "compact";
    setDensity(next);
    btn.textContent = `density: ${next}`;
    btn.setAttribute("aria-pressed", next === "normal" ? "true" : "false");
  });
}

// --------------------------------------------------------------------------
// Sidebar active state
// --------------------------------------------------------------------------

function wireSidebar() {
  const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  document.querySelectorAll("[data-local-only='true']").forEach((el) => {
    el.hidden = !isLocalHost;
    if (!isLocalHost) el.setAttribute("aria-hidden", "true");
  });
  const items = document.querySelectorAll("[data-nav]");
  function paint(path) {
    items.forEach((el) => {
      const target = el.getAttribute("data-nav");
      if (!target) return;
      const active =
        (target === "/" && path === "/") ||
        (target !== "/" && path.startsWith(target));
      el.classList.toggle("active", active);
    });
  }
  return paint;
}

// --------------------------------------------------------------------------
// Footer (agregado de /v1/health, refresh manual via hash change)
// --------------------------------------------------------------------------

let lastFooterFetch = 0;
const FOOTER_REFRESH_MIN_MS = 5_000; // throttle por navegacao

async function refreshFooter() {
  const now = Date.now();
  if (now - lastFooterFetch < FOOTER_REFRESH_MIN_MS) return;
  lastFooterFetch = now;
  try {
    const result = await fetchHealth();
    paintFooter(result);
  } catch (_err) {
    paintFooter(null);
  }
}

function paintFooter(result) {
  const dot = document.getElementById("footer-dot");
  const status = document.getElementById("footer-status");
  const asOfEl = document.getElementById("footer-as-of");
  const servedEl = document.getElementById("footer-served-at");
  const sourceEl = document.getElementById("footer-source");
  const mirror = document.getElementById("footer-freshness-mirror");
  if (!dot || !status || !asOfEl || !servedEl || !sourceEl) return;

  if (!result || result.kind !== "ok") {
    dot.setAttribute("data-status", "error");
    status.textContent = "error";
    asOfEl.textContent = "as_of —";
    servedEl.textContent = "served_at —";
    sourceEl.textContent = "source —";
    if (mirror) mirror.textContent = "";
    return;
  }
  const env = result.envelope;
  const data = env.data || {};
  const overall = data.overall_status || "unknown";
  const visual = env.stale ? "stale" : overall;
  dot.setAttribute("data-status", visual);
  status.textContent = overall + (env.stale ? " · stale" : "");
  asOfEl.textContent = `as_of ${fmtIso(env.as_of)}`;
  servedEl.textContent = `served_at ${fmtIso(env.served_at)}`;
  sourceEl.textContent = `source ${env.source}`;
  if (mirror) {
    mirror.textContent = `${overall} · ${fmtRelative(env.as_of, env.served_at)}`;
  }
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

function boot() {
  const content = document.getElementById("content");
  const paintSidebar = wireSidebar();
  wireDensityToggle();

  onNavigate(async ({ path, matched }) => {
    paintSidebar(path);
    if (!matched) {
      content.replaceChildren(
        unknownRouteView(path)
      );
      refreshFooter();
      return;
    }
    const { handler } = matched;
    const result = handler(path);
    const params = matched.params || {};
    try {
      await result.render(content, params);
    } catch (err) {
      content.replaceChildren(crashView(err));
    }
    refreshFooter();
  });

  start();
}

function unknownRouteView(path) {
  const div = document.createElement("div");
  div.className = "state";
  div.setAttribute("data-state", "empty");
  const title = document.createElement("div");
  title.className = "state-title";
  title.textContent = "Unknown route";
  const hint = document.createElement("div");
  hint.className = "state-hint";
  hint.textContent = `No handler for path: ${path}`;
  const link = document.createElement("a");
  link.href = "#/";
  link.textContent = "Go to dashboard";
  div.append(title, hint, link);
  return div;
}

function crashView(err) {
  const div = document.createElement("div");
  div.className = "state";
  div.setAttribute("data-state", "error");
  const title = document.createElement("div");
  title.className = "state-title";
  title.textContent = "View crashed";
  const hint = document.createElement("div");
  hint.className = "state-hint";
  hint.textContent = err && err.message ? err.message : String(err);
  div.append(title, hint);
  return div;
}

// --------------------------------------------------------------------------
// Keyboard shortcuts (g h / g c / etc.) — leve, sem captura agressiva.
// --------------------------------------------------------------------------

let lastKey = null;
let lastKeyTs = 0;
window.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLInputElement) return;
  if (ev.target instanceof HTMLTextAreaElement) return;
  const now = Date.now();
  const within = now - lastKeyTs < 800;
  if (ev.key === "g") {
    lastKey = "g";
    lastKeyTs = now;
    return;
  }
  if (within && lastKey === "g") {
    const map = {
      d: "/",
      h: "/health",
      c: "/config",
      s: "/source-status",
      b: "/bundle/BTC%2FUSDT%3AUSDT",
      x: "/blobs",
      v: "/dev/states",
    };
    const target = map[ev.key];
    if (target) {
      navigate(target);
      ev.preventDefault();
    }
    lastKey = null;
  }
});

// Subscribe to state changes (density mirror in body)
subscribe((s) => {
  document.documentElement.setAttribute("data-density", s.density);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
