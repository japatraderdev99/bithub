// live.mjs — Live cockpit local (#/live).
//
// Mostra estado de uma instancia de monitor_all.py rodando localmente,
// via endpoints /live/* do dev-server. Local-only, read-only, opt-in.
// Polling 2s nos 3 endpoints (positions, scanner, events). Raw sob demanda.

import { card, h, kv, statusBadge, emptyState } from "../components.mjs";
import { fmtIso } from "../format.mjs";
import {
  fetchPositions,
  fetchScanner,
  fetchEvents,
  fetchRaw,
} from "../live-client.mjs";

const POLL_MS = 2000;

let pollTimer = null;
let mountedAt = 0;
let lastEventTs = null;
let liveState = {
  positions: [],
  scanner: null,
  events: [],
  status: "loading",
  hint: null,
};
let containerRef = null;

export async function render(container) {
  containerRef = container;
  mountedAt = Date.now();
  lastEventTs = null;
  liveState = { positions: [], scanner: null, events: [], status: "loading", hint: null };

  paint();

  // primeiro tick imediato + start polling
  await tick();
  schedulePoll();

  // limpa quando navegar pra fora
  window.addEventListener("hashchange", cleanupOnce, { once: true });
}

function cleanupOnce() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  containerRef = null;
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!containerRef) return;
    await tick();
    schedulePoll();
  }, POLL_MS);
}

async function tick() {
  const [posRes, scanRes, evRes] = await Promise.all([
    fetchPositions(),
    fetchScanner(),
    fetchEvents({ since: lastEventTs, limit: 50 }),
  ]);

  if (posRes.kind === "disabled" || scanRes.kind === "disabled") {
    liveState = {
      positions: [],
      scanner: null,
      events: [],
      status: "disabled",
      hint: (posRes.hint || scanRes.hint) || "BITHUB_LIVE_TAIL_LOG nao configurado",
    };
    paint();
    return;
  }
  const failed = [posRes, scanRes, evRes].find((res) => res.kind !== "ok");
  if (failed) {
    liveState = {
      positions: [],
      scanner: null,
      events: [],
      status: "error",
      hint: failed.error || failed.kind || "live endpoint unavailable",
    };
    paint();
    return;
  }

  if (posRes.kind === "ok") {
    liveState.positions = posRes.data.positions || [];
  }
  if (scanRes.kind === "ok") {
    liveState.scanner = scanRes.data.scanner || null;
  }
  if (evRes.kind === "ok" && Array.isArray(evRes.data.events)) {
    const newOnes = evRes.data.events;
    if (newOnes.length > 0) {
      liveState.events = [...liveState.events, ...newOnes].slice(-100);
      lastEventTs = newOnes[newOnes.length - 1].ts;
    }
  }

  liveState.status = "ok";
  liveState.hint = null;
  paint();
}

function paint() {
  if (!containerRef) return;
  const banner = h(
    "div",
    { class: "freshness-banner", dataStatus: liveState.status === "ok" ? "ok" : (liveState.status === "disabled" ? "stale" : "error") },
    statusBadge(
      liveState.status === "ok" ? "ok" : (liveState.status === "disabled" ? "stale" : "error"),
      "COCKPIT LOCAL"
    ),
    h("span", null, "Cockpit · nao-baseline · privado · 127.0.0.1"),
    h("span", { class: "spacer flex-1" }),
    h("span", { class: "muted mono" }, liveState.status === "ok" ? "polling 2s" : (liveState.status === "disabled" ? "off" : "unavailable"))
  );

  if (liveState.status === "disabled" || liveState.status === "error") {
    containerRef.replaceChildren(
      banner,
      card({
        title: liveState.status === "disabled" ? "Live tail disabled" : "Live tail unavailable",
        children: [
          emptyState(
            liveState.hint
              ? `Live tail indisponivel: ${liveState.hint}`
              : "BITHUB_LIVE_TAIL_LOG nao configurado ou endpoint local indisponivel."
          ),
          h(
            "pre",
            { class: "mono", style: "white-space: pre-wrap; padding: 12px;" },
            "Para habilitar, suba o dev-server com:\n\n",
            "  BITHUB_LIVE_TAIL_LOG=/tmp/monitor_test.log \\\n",
            "  BITHUB_LIVE_STATE_DIR=/path/to/freqtrade/user_data/logs \\\n",
            "  node bithub-ui/scripts/dev-server.mjs\n"
          ),
        ],
      }),
      disclaimer()
    );
    return;
  }

  containerRef.replaceChildren(
    banner,
    h("div", { class: "card-grid-2" }, renderPositionsCard(), renderScannerCard()),
    renderEventsCard(),
    renderRawCard(),
    disclaimer()
  );
}

function renderPositionsCard() {
  const positions = liveState.positions || [];
  if (positions.length === 0) {
    return card({
      title: "Posicoes abertas",
      children: [emptyState("Nenhuma posicao aberta")],
    });
  }
  const cards = positions.map(renderPositionRow);
  return card({
    title: `Posicoes abertas (${positions.length})`,
    children: cards,
  });
}

function renderPositionRow(p) {
  const isLong = p.dir === "LONG";
  const pnlClass = (p.pnl_pct ?? 0) >= 0 ? "ok" : "error";
  const bestClass = (p.best_pct ?? 0) >= 0 ? "ok" : "error";
  const slDistPct = p.price && p.sl ? ((p.sl - p.price) / p.price) * 100 : null;
  const tpDistPct = p.price && p.tp ? ((p.tp - p.price) / p.price) * 100 : null;

  const meterBar = (() => {
    if (p.price == null || p.sl == null || p.tp == null) return null;
    const lo = Math.min(p.sl, p.tp);
    const hi = Math.max(p.sl, p.tp);
    const span = hi - lo;
    if (span <= 0) return null;
    const pos = Math.max(0, Math.min(1, (p.price - lo) / span));
    const pct = (isLong ? pos : (1 - pos)) * 100;
    const fill = h("div", {
      style: `width: ${pct.toFixed(1)}%; height: 100%; background: var(--accent, #69b7ff);`,
    });
    return h("div", {
      style: "position: relative; height: 6px; background: var(--bg-2, #1c2230); border-radius: 3px; margin: 8px 0;",
    }, fill);
  })();

  return h(
    "div",
    { class: "position-row" },
    h(
      "div",
      { class: "position-head" },
      h("span", { class: "mono", style: "font-weight: 600;" }, p.symbol),
      h("span", { class: `badge`, dataStatus: isLong ? "ok" : "stale" }, p.dir),
      h("span", { class: "spacer flex-1" }),
      h(
        "span",
        { class: `mono`, dataStatus: pnlClass, style: `color: ${pnlClass === "ok" ? "var(--ok, #5ed498)" : "var(--err, #ef6c6c)"};` },
        `PnL ${formatPct(p.pnl_pct)}`
      ),
      h(
        "span",
        { class: "muted mono" },
        `best ${formatPct(p.best_pct)}`
      )
    ),
    meterBar,
    kv([
      ["entry", p.entry != null ? mono(p.entry) : muted("—")],
      ["price", p.price != null ? mono(p.price) : muted("—")],
      ["SL", p.sl != null ? mono(`${p.sl} (${formatPct(slDistPct)})`) : muted("—")],
      ["TP", p.tp != null ? mono(`${p.tp} (${formatPct(tpDistPct)})`) : muted("—")],
      ["EMA9", p.ema9 != null ? mono(p.ema9) : muted("—")],
      ["mom", p.mom ? chipText(p.mom) : muted("—")],
      ["updated_at", muted(p.updated_at ? fmtIso(p.updated_at) : "—")],
    ])
  );
}

function renderScannerCard() {
  const s = liveState.scanner;
  if (!s) {
    return card({
      title: "Scanner heartbeat",
      children: [emptyState("Sem dados de scanner ainda")],
    });
  }
  const wsBadge = s.ws_status === "up"
    ? statusBadge("ok", "WS up")
    : (s.ws_status === "down" ? statusBadge("error", "WS down") : statusBadge("empty", "WS ?"));
  return card({
    title: "Scanner heartbeat",
    children: [
      kv([
        ["WS private", wsBadge],
        ["T1 last", s.t1_last_ts ? mono(fmtIso(s.t1_last_ts)) : muted("—")],
        ["T1 top-N", s.t1_top_n != null ? mono(String(s.t1_top_n)) : muted("—")],
        ["last candidatos", s.last_candidates_count != null ? mono(String(s.last_candidates_count)) : muted("—")],
        ["slots", (s.slots_used != null && s.slots_max != null) ? mono(`${s.slots_used} / ${s.slots_max}`) : muted("—")],
      ]),
    ],
  });
}

function renderEventsCard() {
  const events = liveState.events || [];
  if (events.length === 0) {
    return card({
      title: "Feed de avaliacoes",
      children: [emptyState("Sem eventos ainda")],
    });
  }
  // mais recente primeiro
  const recent = events.slice(-20).reverse();
  const rows = recent.map((e) => {
    const t = (e.ts || "").slice(11, 19);
    let label, dataStatus;
    switch (e.kind) {
      case "entry":
        label = `🚀 ENTRADA ${e.data.tag || ""} ${e.data.dir || ""} SCORE=${e.data.score}`;
        dataStatus = "ok";
        break;
      case "score_low":
        label = "📉 SCORE BAIXO";
        dataStatus = "empty";
        break;
      case "near_miss":
        label = `⏳ near-miss ${e.data.symbol || ""} [${e.data.missing || ""}]`;
        dataStatus = "stale";
        break;
      case "tape_ok":
        label = `✅ tape OK ${e.data.tag || ""} favor=${e.data.favor_pct}%`;
        dataStatus = "ok";
        break;
      case "tape_reject":
        label = `❌ tape rejeitou ${e.data.tag || ""}`;
        dataStatus = "error";
        break;
      case "execute":
        label = `🔴 EXEC ${e.data.tag || ""} ${e.data.dir || ""} lev=${e.data.lev}x notional=${e.data.notional}`;
        dataStatus = "ok";
        break;
      case "sltp_attached":
        label = "[SL/TP] anexados";
        dataStatus = "ok";
        break;
      case "trail_update":
        label = `📉 ${e.data.symbol} TRAIL`;
        dataStatus = "stale";
        break;
      case "position_close":
        label = `🏁 ${e.data.symbol} fechada`;
        dataStatus = "empty";
        break;
      case "stop_fill":
        label = `⚡ ${e.data.symbol} ${e.data.fill_type} filled`;
        dataStatus = "stale";
        break;
      case "position_load":
        label = `📋 ${e.data.symbol} ${e.data.dir} carregada`;
        dataStatus = "ok";
        break;
      case "ws_status":
        label = e.data.up ? "WS up" : "WS down";
        dataStatus = e.data.up ? "ok" : "error";
        break;
      case "scanner_t1_result":
        label = `T1 → ${e.data.candidates} candidatos`;
        dataStatus = "empty";
        break;
      default:
        label = e.kind;
        dataStatus = "empty";
    }
    return h(
      "tr",
      null,
      h("td", { class: "mono muted" }, t),
      h("td", null, h("span", { class: "badge", dataStatus }, label))
    );
  });
  return card({
    title: `Feed de avaliacoes (${events.length})`,
    children: [
      h(
        "table",
        { class: "dt" },
        h("tbody", null, ...rows)
      ),
    ],
  });
}

function renderRawCard() {
  return card({
    title: "Log raw (clique pra carregar)",
    children: [
      h(
        "button",
        {
          type: "button",
          onClick: async () => {
            const res = await fetchRaw({ n: 50 });
            const pre = document.getElementById("live-raw-pre");
            if (!pre) return;
            if (res.kind === "ok") {
              pre.textContent = (res.data.lines || []).map((l) => `[${l.ts.slice(11, 19)}] ${l.line}`).join("\n");
            } else {
              pre.textContent = `erro: ${JSON.stringify(res)}`;
            }
          },
        },
        "Carregar ultimas 50 linhas"
      ),
      h(
        "pre",
        {
          id: "live-raw-pre",
          class: "mono",
          style: "max-height: 240px; overflow: auto; white-space: pre-wrap; margin-top: 8px; padding: 8px; background: var(--bg-2, #1c2230); border-radius: 4px;",
        },
        "(clique pra carregar)"
      ),
    ],
  });
}

function disclaimer() {
  return h(
    "div",
    { class: "bithub-disclaimer mt-12" },
    "Cockpit local. Le /tmp/monitor_test.log + JSON state de uma instancia ",
    "monitor_all.py rodando em outro projeto. Read-only puro, sem comandos, ",
    "sem auth, sem Cloudflare, 127.0.0.1 apenas. Esta view fura o baseline ",
    "read-only do Bithub deliberadamente para acompanhar trading do operador; ",
    "nao e visivel em producao."
  );
}

// helpers
function mono(v) {
  return h("span", { class: "mono dim" }, String(v));
}
function muted(s) {
  return h("span", { class: "muted" }, s);
}
function chipText(s) {
  return h("span", { class: "chip mono" }, s);
}
function formatPct(v) {
  if (v == null || Number.isNaN(v)) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}
