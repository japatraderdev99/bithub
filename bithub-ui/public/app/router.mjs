// router.mjs — hash router minimo.
//
// Sem history API (que exigiria server rewrite). URLs estilo
// `#/health`, `#/bundle/BTC%2FUSDT%3AUSDT`, etc.

const routes = [];

export function registerRoute(pattern, handler) {
  routes.push({ pattern, handler });
}

function matchRoute(path) {
  for (const { pattern, handler } of routes) {
    const m = path.match(pattern);
    if (m) return { handler, params: m.groups || {} };
  }
  return null;
}

export function currentPath() {
  const hash = window.location.hash.replace(/^#/, "");
  return hash === "" ? "/" : hash;
}

export function navigate(path) {
  const next = path.startsWith("#") ? path : `#${path}`;
  if (window.location.hash === next) {
    handleHashChange();
  } else {
    window.location.hash = next;
  }
}

let onNavigateCb = null;

export function onNavigate(cb) {
  onNavigateCb = cb;
}

export function start() {
  window.addEventListener("hashchange", handleHashChange);
  handleHashChange();
}

function handleHashChange() {
  const path = currentPath();
  const matched = matchRoute(path);
  if (onNavigateCb) {
    onNavigateCb({ path, matched });
  }
}
