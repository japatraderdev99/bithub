// cockpit.mjs — Live Cockpit (#/cockpit).
//
// Reads the structured monitor exports (state.json + events.jsonl)
// served by /cockpit/* endpoints on the dev-server. Polling every 2s.
// Local-only, read-only, opt-in via BITHUB_COCKPIT_STATE env var.
//
// Differs from #/live (which parses textual monitor logs via regex):
// cockpit consumes the contract from [[Monitor-Export-Contract]] which
// the operator opts into by applying the monitor-export-patch to their
// monitor_all.py.
//
// See [[Bithub-Cockpit-Architecture]] and [[H-COCKPIT-MVP-001]].

import { card, h, kv, statusBadge, emptyState } from "../components.mjs";
import { fmtIso } from "../format.mjs";
import { fetchCockpitState, fetchCockpitEvents } from "../cockpit-client.mjs";

const POLL_MS = 2000;
const EVENT_BUFFER = 200;

let pollTimer = null;
let containerRef = null;
let lastEventTs = null;

let viewState = {
  status: "loading",
  state: null,
  events: [],
  system: null,
  hint: null,
};

export async function render(container) {
  containerRef = container;
  lastEventTs = null;
  viewState = { status: "loading", state: null, events: [], system: null, hint: null };

  paint();
  await tick();
  schedulePoll();

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
  const [stateRes, evRes] = await Promise.all([
    fetchCockpitState(),
    fetchCockpitEvents({ since: lastEventTs, limit: 50 }),
  ]);

  if (stateRes.kind === "disabled") {
    viewState = {
      status: "disabled",
      state: null,
      events: [],
      system: null,
      hint: stateRes.hint || "BITHUB_COCKPIT_STATE not configured",
    };
    paint();
    return;
  }

  if (stateRes.kind !== "ok") {
    viewState = {
      status: "error",
      state: null,
      events: viewState.events,
      system: viewState.system,
      hint: stateRes.error || stateRes.kind || "cockpit endpoint unavailable",
    };
    paint();
    return;
  }

  const stateBody = stateRes.data || {};
  viewState.status = "ok";
  viewState.state = stateBody.state || null;
  viewState.system = stateBody.system || null;
  viewState.hint = null;

  if (evRes.kind === "ok" && Array.isArray(evRes.data?.events)) {
    const newOnes = evRes.data.events;
    if (newOnes.length > 0) {
      viewState.events = [...viewState.events, ...newOnes].slice(-EVENT_BUFFER);
      lastEventTs = newOnes[newOnes.length - 1].ts;
    }
  }

  paint();
}

// --------------------------------------------------------------------------
// Painting
// --------------------------------------------------------------------------

function paint() {
  if (!containerRef) return;

  if (viewState.status === "disabled") {
    containerRef.replaceChildren(
      banner(),
      card({
        title: "Cockpit tail disabled",
        children: [
          emptyState(
            viewState.hint
              ? `Cockpit endpoint disabled: ${viewState.hint}`
              : "BITHUB_COCKPIT_STATE not configured."
          ),
          h(
            "pre",
            { class: "mono", style: "white-space: pre-wrap; padding: 12px;" },
            "Para habilitar:\n\n",
            "1. Aplicar o patch monitor-export ao seu monitor_all.py\n",
            "   (snippet em bithub-vault/03-Design/monitor-export-patch.py)\n\n",
            "2. Subir o dev-server com:\n\n",
            "   BITHUB_COCKPIT_STATE=/tmp/bithub_monitor_state.json \\\n",
            "   BITHUB_COCKPIT_EVENTS=/tmp/bithub_monitor_events.jsonl \\\n",
            "   node bithub-ui/scripts/dev-server.mjs\n"
          ),
        ],
      }),
      disclaimer()
    );
    return;
  }

  if (viewState.status === "error") {
    containerRef.replaceChildren(
      banner(),
      card({
        title: "Cockpit unavailable",
        children: [
          emptyState(viewState.hint ? `error: ${viewState.hint}` : "cockpit endpoint failed"),
        ],
      }),
      disclaimer()
    );
    return;
  }

  containerRef.replaceChildren(
    banner(),
    headerRow(),
    h("div", { class: "card-grid-2" }, renderPositionsCard(), renderScannerCard()),
    renderEventsCard(),
    renderTapeTicker(),
    disclaimer()
  );
}

function banner() {
  const s = viewState.status;
  const status = s === "ok" ? "ok" : s === "loading" ? "stale" : "error";
  const ageS =
    viewState.system && typeof viewState.system.state_age_s === "number"
      ? viewState.system.state_age_s
      : null;
  return h(
    "div",
    { class: "freshness-banner", dataStatus: status },
    statusBadge(status, "COCKPIT"),
    h("span", null, "Cockpit · nao-baseline · privado · 127.0.0.1"),
    h("span", { class: "spacer flex-1" }),
    h(
      "span",
      { class: "muted mono" },
      ageS != null ? `state age ${ageS.toFixed(1)}s` : (s === "ok" ? "polling 2s" : s)
    )
  );
}

function headerRow() {
  const st = viewState.state || {};
  const sys = viewState.system || {};
  const wsKind = st.ws_status === "connected" ? "ok" :
    st.ws_status === "disconnected" ? "error" :
    st.ws_status === "reconnecting" ? "stale" : "empty";
  const wsBadge = statusBadge(wsKind, `WS ${st.ws_status || "?"}`);

  const balance = st.balance || {};
  const total = typeof balance.total_usdt === "number"
    ? `$${balance.total_usdt.toFixed(2)}` : "—";
  const free = typeof balance.free_usdt === "number"
    ? `$${balance.free_usdt.toFixed(2)}` : "—";

  const slotsTxt = (typeof st.slots_used === "number" && typeof st.slots_max === "number")
    ? `${st.slots_used} / ${st.slots_max}` : "—";

  return card({
    title: "System",
    children: [
      kv([
        ["WS private", wsBadge],
        ["slots", h("span", { class: "mono dim" }, slotsTxt)],
        ["balance total", h("span", { class: "mono dim" }, total)],
        ["balance free", h("span", { class: "mono dim" }, free)],
        ["t1 last", st.t1_last ? h("span", { class: "mono dim" }, fmtIso(new Date(st.t1_last * 1000).toISOString())) : muted("—")],
        ["state ts", st.ts ? h("span", { class: "mono dim" }, fmtIso(new Date(st.ts * 1000).toISOString())) : muted("—")],
        ["monitor version", h("span", { class: "mono dim" }, st.monitor_version || "—")],
        ["events offset", h("span", { class: "muted mono" }, String(sys.events_offset ?? "—"))],
      ]),
    ],
  });
}

function renderPositionsCard() {
  const positions = viewState.state ? (viewState.state.positions || {}) : {};
  const keys = Object.keys(positions);
  if (keys.length === 0) {
    return card({
      title: "Posicoes abertas",
      children: [emptyState("Nenhuma posicao aberta")],
    });
  }
  const rows = keys.sort().map((sym) => renderPositionRow(positions[sym]));
  return card({
    title: `Posicoes abertas (${keys.length})`,
    children: rows,
  });
}

function renderPositionRow(p) {
  if (!p) return null;
  const sideUpper = String(p.side || "").toUpperCase();
  const isLong = sideUpper === "LONG";
  const pnl = typeof p.pnl_pct === "number" ? p.pnl_pct : null;
  const best = typeof p.best_pnl === "number" ? p.best_pnl : null;
  const pnlClass = (pnl ?? 0) >= 0 ? "ok" : "error";

  const tape = p.tape_state || null;
  const tapeBadge = tape ? renderTapeBadge(tape) : null;

  return h(
    "div",
    { class: "position-row" },
    h(
      "div",
      { class: "position-head" },
      h("span", { class: "mono", style: "font-weight: 600;" }, p.symbol || "?"),
      h("span", { class: "badge", dataStatus: isLong ? "ok" : "stale" }, sideUpper || "?"),
      h("span", { class: "spacer flex-1" }),
      h(
        "span",
        {
          class: "mono",
          dataStatus: pnlClass,
          style: `color: ${pnlClass === "ok" ? "var(--ok, #5ed498)" : "var(--err, #ef6c6c)"};`,
        },
        `PnL ${formatPct(pnl)}`
      ),
      h("span", { class: "muted mono" }, `best ${formatPct(best)}`)
    ),
    kv([
      ["entry", p.entry != null ? mono(p.entry) : muted("—")],
      ["SL", p.sl != null ? mono(p.sl) : muted("—")],
      ["TP", p.tp != null ? mono(p.tp) : muted("—")],
      ["qty", p.qty != null ? mono(p.qty) : muted("—")],
      ["momentum", p.momentum ? chipText(p.momentum) : muted("—")],
      ["flags", renderFlags(p)],
      ...(tapeBadge ? [["tape", tapeBadge]] : []),
    ])
  );
}

function renderFlags(p) {
  const flags = [];
  if (p.be_set) flags.push(["BE", "ok"]);
  if (p.partial_done) flags.push(["PARTIAL", "stale"]);
  if (p.tp_extended) flags.push(["TP_EXT", "ok"]);
  if (p.tp_tightened) flags.push(["TP_TIGHT", "stale"]);
  if (flags.length === 0) return muted("—");
  return h(
    "span",
    null,
    ...flags.map(([label, status]) =>
      h("span", { class: "badge", dataStatus: status, style: "margin-right: 4px;" }, label)
    )
  );
}

function renderTapeBadge(tape) {
  const bias = tape.tape_bias;
  const trend = tape.delta_trend || "—";
  const status =
    bias >= 2 ? "ok" : bias === 1 ? "ok" : bias === 0 ? "empty" : "error";
  const label =
    typeof bias === "number"
      ? `bias=${bias >= 0 ? "+" : ""}${bias} · ${trend}`
      : trend;
  const conf = tape.tape_confirm === true ? "✓" : tape.tape_confirm === false ? "✗" : "?";
  return h(
    "span",
    null,
    h("span", { class: "badge", dataStatus: status }, label),
    h("span", { class: "muted mono", style: "margin-left: 6px;" }, `confirm ${conf}`)
  );
}

function renderScannerCard() {
  const st = viewState.state || {};
  const candidates = st.candidates || [];
  const t2 = st.t2_analysis || {};
  const t2Keys = Object.keys(t2);

  const children = [];
  if (candidates.length === 0 && t2Keys.length === 0) {
    children.push(emptyState("Sem candidatos T1 nem analise T2"));
  } else {
    if (candidates.length > 0) {
      children.push(h(
        "div",
        { class: "muted mono", style: "margin-bottom: 8px;" },
        `T1 candidatos: ${candidates.map((c) => `${c.symbol}(${c.direction})`).join(", ") || "—"}`
      ));
    }
    if (t2Keys.length > 0) {
      const sortedT2 = t2Keys
        .map((s) => ({ symbol: s, ...t2[s] }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const headerRow = h(
        "tr",
        null,
        h("th", null, "symbol"),
        h("th", null, "dir"),
        h("th", null, "score"),
        h("th", null, "gates"),
        h("th", null, "ATR%"),
        h("th", null, "RSI5"),
        h("th", null, "vol×"),
        h("th", null, "book"),
        h("th", null, "fund")
      );
      const bodyRows = sortedT2.map((row) => {
        const gates = row.gates || {};
        const ind = row.indicators || {};
        const gateBadges = gateOrder.map((g) =>
          h("span", {
            class: "badge",
            dataStatus: gates[g] ? "ok" : "error",
            title: g,
            style: "margin-right: 2px; padding: 0 4px; font-size: 10px;",
          }, gates[g] ? "✓" : "✗")
        );
        const scoreClass = (row.score ?? 0) >= 60 ? "ok" : (row.score ?? 0) >= 45 ? "stale" : "empty";
        return h(
          "tr",
          null,
          h("td", { class: "mono" }, row.symbol),
          h("td", null, h("span", { class: "badge", dataStatus: row.direction === "long" ? "ok" : "stale" }, (row.direction || "?").toUpperCase())),
          h("td", null, h("span", { class: "badge", dataStatus: scoreClass }, String(row.score ?? "—"))),
          h("td", null, ...gateBadges),
          h("td", { class: "mono" }, fmtNum(ind.atr_pct, 2, "%")),
          h("td", { class: "mono" }, fmtNum(ind.rsi5, 0)),
          h("td", { class: "mono" }, fmtNum(ind.vol_x, 2, "×")),
          h("td", { class: "mono" }, fmtNum(ind.book_imb, 0, "%")),
          h("td", { class: "mono" }, fmtNum(ind.funding != null ? ind.funding * 100 : null, 3, "%"))
        );
      });
      children.push(
        h(
          "table",
          { class: "dt" },
          h("thead", null, headerRow),
          h("tbody", null, ...bodyRows)
        )
      );
    }
  }
  return card({ title: "Scanner", children });
}

const gateOrder = ["g_atr", "g_bb", "g_vol", "g_ema", "g_rsi", "g_poc", "g_fund", "g_book", "liq_ok"];

function renderEventsCard() {
  const events = viewState.events || [];
  if (events.length === 0) {
    return card({
      title: "Eventos recentes",
      children: [emptyState("Sem eventos ainda")],
    });
  }
  const recent = events.slice(-30).reverse();
  const rows = recent.map((e) => {
    const t = e.ts ? new Date(e.ts * 1000).toISOString().slice(11, 19) : "—";
    const { label, status } = labelEvent(e);
    return h(
      "tr",
      null,
      h("td", { class: "mono muted" }, t),
      h("td", { class: "mono" }, e.symbol || "—"),
      h("td", null, h("span", { class: "badge", dataStatus: status }, label))
    );
  });
  return card({
    title: `Eventos recentes (${events.length})`,
    children: [
      h(
        "table",
        { class: "dt" },
        h("thead", null,
          h("tr", null,
            h("th", null, "time"),
            h("th", null, "symbol"),
            h("th", null, "event")
          )
        ),
        h("tbody", null, ...rows)
      ),
    ],
  });
}

function labelEvent(e) {
  const d = e.detail || {};
  switch (e.type) {
    case "ENTRY":
      return {
        label: `🚀 ENTRY ${(d.side || "").toUpperCase()} score=${d.score ?? "?"} entry=${d.entry ?? "?"}`,
        status: "ok",
      };
    case "EXIT_FULL":
      return {
        label: `🏁 EXIT ${d.exit_reason || ""} pnl=${formatPct(d.pnl_pct)}`,
        status: (d.pnl_pct ?? 0) >= 0 ? "ok" : "error",
      };
    case "PARTIAL_EXIT":
      return {
        label: `📤 PARTIAL closed=${d.qty_closed ?? "?"} remaining=${d.qty_remaining ?? "?"}`,
        status: "stale",
      };
    case "TRAIL":
      return {
        label: `📉 TRAIL sl ${d.old_sl ?? "?"} → ${d.new_sl ?? "?"}`,
        status: "stale",
      };
    case "EXTEND_TP":
      return {
        label: `📈 EXTEND_TP tp ${d.old_tp ?? "?"} → ${d.new_tp ?? "?"}`,
        status: "ok",
      };
    case "TIGHT_TP":
      return {
        label: `↘ TIGHT_TP tp ${d.old_tp ?? "?"} → ${d.new_tp ?? "?"}`,
        status: "stale",
      };
    case "BE_SET":
      return { label: `BE @ ${d.be_price ?? "?"}`, status: "ok" };
    case "TAPE_SIGNAL":
      return {
        label: `TAPE bias=${d.bias ?? "?"} ${d.delta_trend || ""}`,
        status: (d.bias ?? 0) >= 1 ? "ok" : "stale",
      };
    case "T1_SCAN":
      return {
        label: `T1 → ${d.candidates_count ?? "?"} candidatos (${(d.duration_s ?? 0).toFixed?.(1) || "?"}s)`,
        status: "empty",
      };
    case "T2_SIGNAL":
      return {
        label: `T2 ${(d.direction || "").toUpperCase()} score=${d.score ?? "?"}` +
          (d.gates_failed?.length ? ` failed=${d.gates_failed.join(",")}` : ""),
        status: (d.score ?? 0) >= 60 ? "ok" : "empty",
      };
    case "ALERT":
      return { label: `⚠ ${d.alert_type || ""} ${d.msg || ""}`, status: "error" };
    default:
      return { label: e.type, status: "empty" };
  }
}

function renderTapeTicker() {
  const positions = viewState.state ? (viewState.state.positions || {}) : {};
  const entries = Object.values(positions)
    .filter((p) => p && p.tape_state)
    .map((p) => {
      const t = p.tape_state || {};
      const flow = (t.sell_ratio != null && t.buy_ratio != null)
        ? (p.side === "short"
          ? `sell ${(t.sell_ratio * 100).toFixed(0)}%`
          : `buy ${(t.buy_ratio * 100).toFixed(0)}%`)
        : "—";
      const trend = t.delta_trend || "—";
      const status = t.tape_confirm === true ? "ok" :
        t.tape_confirm === false ? "error" : "empty";
      return h(
        "span",
        { class: "badge", dataStatus: status, style: "margin-right: 8px;" },
        `${p.symbol}: ${flow} · ${trend}`
      );
    });
  if (entries.length === 0) return h("div", null);
  return card({
    title: "Tape ticker",
    children: [
      h(
        "div",
        { style: "padding: 8px; white-space: nowrap; overflow-x: auto;" },
        ...entries
      ),
    ],
  });
}

function disclaimer() {
  return h(
    "div",
    { class: "bithub-disclaimer mt-12" },
    "Cockpit local lendo o contrato monitor-export (state.json + ",
    "events.jsonl). Read-only puro, sem comandos, sem auth, sem ",
    "Cloudflare, 127.0.0.1 apenas. Esta view fura o baseline read-only ",
    "do Bithub deliberadamente para acompanhar trading do operador; nao ",
    "e visivel em producao. Quando o cockpit cloud (H-COCKPIT-CLOUD-001) ",
    "estiver pronto, este mesmo conjunto de telas serve a versao remota ",
    "via Cloudflare Access."
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
  if (v == null || typeof v !== "number" || Number.isNaN(v)) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}
function fmtNum(v, decimals = 2, suffix = "") {
  if (v == null || typeof v !== "number" || !Number.isFinite(v)) return "—";
  return `${v.toFixed(decimals)}${suffix}`;
}
