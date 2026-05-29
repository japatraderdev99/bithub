#!/usr/bin/env node
// btc-lead-alt-echo-sui-regime-v1.mjs
//
// Regime-gated wrapper over BTC-Lead Alt-Echo, specialized for SUIUSDT,
// with activation gates discovered via the v3 cross-validation + regime
// mining sweep on 2026-05-29.
//
// Tese: o BTC-Lead Alt-Echo base perde dinheiro em media no scalp 1m.
// Quando filtrado por (dia-da-semana NAO em {wed,fri}) AND (sessao UTC em
// {us, overlap}) AND (SUI ATR_pct >= 0.10%), a expectativa muda
// dramaticamente: avg net +0.061%/trade, PF 2.00, 4/5 janelas historicas
// positivas, sobrevive fee stress 0.15%.
//
// Status: shadow. Esta estrategia NAO deve operar real ate que >=30
// signals reais (D1) sejam coletados em shadow_live com avg_net >= 0.04%
// e win_rate >= 55%.
//
// Read-only por design: gera signals e simula trades sobre candles ja
// publicados; nao envia ordens, nao chama Bybit private, nao toca monitor.
//
// Uso:
//   node strategies/btc-lead-alt-echo-sui-regime-v1.mjs --bybit --limit 12000
//   node strategies/btc-lead-alt-echo-sui-regime-v1.mjs --file lead.json --alt-file sui.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runBtcLeadAltEcho } from "../btc-lead-alt-echo.mjs";

// Frozen on the day of discovery. New versions must bump the date suffix
// so per-version stats accumulate in D1 without contaminating history.
export const STRATEGY_VERSION_ID = "btc_lead_alt_echo_sui_regime_v1_20260529";
export const STRATEGY_NAME = "BTC-Lead Alt-Echo SUI Regime-Gated v1";
export const LEAD_SYMBOL = "BTCUSDT";
export const ALT_SYMBOL = "SUIUSDT";

// Inner-motor params (frozen by the v3 grid sweep) and outer regime gates
// (discovered by the 2026-05-29 mining over the 81 trades of the base
// variant `ble_rz0.3_is2.2_vol1.35_t0.34`).
export const STRATEGY_CONFIG = Object.freeze({
  inner: {
    scoreMin: 70,
    residualZMin: 0.3,
    impulseSigmaMin: 2.2,
    volumeRatioMin: 1.35,
    minTargetPct: 0.34,
    maxTargetPct: 0.75,
    maxHoldMin: 8,
    noMoveExitMin: 3,
    noMoveMinPct: 0.08,
    stopPct: 0.35,
    feePctRoundTrip: 0.11,
  },
  gates: {
    exclude_day_of_week_utc: ["wed", "fri"],
    allow_sessions_utc: ["us", "overlap"],
    min_sui_atr_pct: 0.10,
    atr_window: 14,
  },
});

// UTC session buckets used by the gate. Boundaries are aligned with the
// mining analysis that produced the discovery — must not be edited without
// re-running the analysis.
export function sessionOfUtc(date) {
  const h = date.getUTCHours();
  if (h >= 0 && h < 7) return "asia";
  if (h >= 7 && h < 13) return "eu";
  if (h >= 13 && h < 17) return "overlap";
  if (h >= 17 && h < 22) return "us";
  return "dead";
}

export function dayOfWeekUtc(date) {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][date.getUTCDay()];
}

// 14-period ATR on SUI 1m candles, expressed as a percentage of the most
// recent close, computed from the candle that ENDS strictly before `ts`.
// Returns null if there are not enough candles yet.
export function suiAtrPctAt(suiCandles, ts, windowSize = 14) {
  let endIdx = -1;
  for (let i = suiCandles.length - 1; i >= 0; i--) {
    if (suiCandles[i].ts < ts) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < windowSize) return null;
  const window = suiCandles.slice(endIdx - windowSize + 1, endIdx + 1);
  let trSum = 0;
  for (let i = 0; i < window.length; i++) {
    const c = window[i];
    if (i === 0) {
      trSum += c.high - c.low;
    } else {
      const prev = window[i - 1].close;
      trSum += Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    }
  }
  const atr = trSum / window.length;
  return (atr / window[window.length - 1].close) * 100;
}

// Pure regime gate decision. Returns { allowed, reason, features }.
// Caller is expected to attach this to every signal so the D1 record
// preserves WHY a candle was allowed or blocked, which is what makes
// post-hoc regime drift detection possible.
export function evaluateRegimeGate({ ts, suiCandles, config = STRATEGY_CONFIG.gates }) {
  const date = new Date(ts);
  const dow = dayOfWeekUtc(date);
  const session = sessionOfUtc(date);
  const atrPct = suiAtrPctAt(suiCandles, ts, config.atr_window);

  const blocked = [];
  if (config.exclude_day_of_week_utc.includes(dow)) blocked.push(`day=${dow}_excluded`);
  if (!config.allow_sessions_utc.includes(session)) blocked.push(`session=${session}_excluded`);
  if (atrPct == null) blocked.push("atr_unknown_warmup");
  else if (atrPct < config.min_sui_atr_pct) blocked.push(`vol_too_low_${atrPct.toFixed(3)}`);

  return {
    allowed: blocked.length === 0,
    reason: blocked.length === 0 ? "all_gates_passed" : blocked.join("|"),
    features: {
      dow,
      session,
      sui_atr_pct: atrPct == null ? null : Number(atrPct.toFixed(4)),
    },
  };
}

// Run the strategy over a (leadCandles, altCandles) pair. Returns the same
// shape as the base motor (signals/trades/outcomes/summary), but with each
// signal tagged with regime_gate_* fields and any entry that the gate would
// have blocked downgraded to a skip carrying `regime_blocked:<reason>`.
//
// Caveat (documented for honesty): the inner motor maintains its own
// activeUntilTs and therefore may skip later candles because an earlier
// would-be-trade is still notionally open. When the gate blocks that earlier
// trade, the inner motor doesn't know — so this post-hoc wrapper produces a
// slightly more conservative trade count than a true regime-aware motor
// would. The discovered edge (avg +0.061%) was measured using the same
// post-hoc method, so the backtest -> shadow comparison stays consistent.
export function runStrategy({ leadCandles, altCandles, config = STRATEGY_CONFIG }) {
  const inner = runBtcLeadAltEcho({
    leadCandles,
    altCandles,
    leadSymbol: LEAD_SYMBOL,
    altSymbol: ALT_SYMBOL,
    config: config.inner,
  });

  const gatedSignals = inner.signals.map((sig) => {
    const ts = new Date(sig.ts).getTime();
    const gate = evaluateRegimeGate({ ts, suiCandles: altCandles, config: config.gates });
    const out = {
      ...sig,
      strategy_version_id: STRATEGY_VERSION_ID,
      regime_gate_passed: gate.allowed,
      regime_gate_reason: gate.reason,
      regime_gate_features: gate.features,
    };
    if (sig.decision === "enter" && !gate.allowed) {
      out.decision = "skip";
      out.entered = false;
      out.reason = `regime_blocked:${gate.reason}`;
    }
    return out;
  });

  const enteredIds = new Set(
    gatedSignals.filter((s) => s.decision === "enter" && s.entered).map((s) => s.client_signal_id),
  );
  const gatedTrades = inner.trades
    .filter((t) => enteredIds.has(t.client_signal_id))
    .map((t) => ({ ...t, strategy_version_id: STRATEGY_VERSION_ID }));
  const gatedOutcomes = inner.outcomes
    .filter((o) => enteredIds.has(o.client_signal_id))
    .map((o) => ({ ...o, strategy_version_id: STRATEGY_VERSION_ID }));

  const wins = gatedTrades.filter((t) => t.pnl_net_pct > 0).length;
  const net = gatedTrades.reduce((s, t) => s + t.pnl_net_pct, 0);
  const blockedByGate = gatedSignals.filter((s) => s.regime_gate_passed === false).length;

  return {
    summary: {
      strategy_version_id: STRATEGY_VERSION_ID,
      lead_symbol: LEAD_SYMBOL,
      alt_symbol: ALT_SYMBOL,
      signals_total: gatedSignals.length,
      signals_blocked_by_gate: blockedByGate,
      entries: gatedTrades.length,
      wins,
      losses: gatedTrades.length - wins,
      win_rate_pct: gatedTrades.length ? Number(((wins / gatedTrades.length) * 100).toFixed(2)) : 0,
      pnl_net_pct: Number(net.toFixed(3)),
      avg_net_pct: gatedTrades.length ? Number((net / gatedTrades.length).toFixed(4)) : 0,
    },
    signals: gatedSignals,
    trades: gatedTrades,
    outcomes: gatedOutcomes,
    config,
  };
}

// ---- CLI plumbing for ad-hoc validation runs ----

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function normalizeBybitKline(row) {
  return { ts: Number(row[0]), open: +row[1], high: +row[2], low: +row[3], close: +row[4], volume: +row[5] };
}

async function fetchBybit(symbol, totalLimit) {
  const byTs = new Map();
  let end = null;
  while (byTs.size < totalLimit) {
    const batch = Math.min(1000, totalLimit - byTs.size);
    const params = new URLSearchParams({ category: "linear", symbol, interval: "1", limit: String(batch) });
    if (end != null) params.set("end", String(end));
    const res = await fetch(`https://api.bybit.com/v5/market/kline?${params}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`bybit ${symbol}: ${json.retMsg ?? json.retCode}`);
    const rows = json.result?.list ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      const c = normalizeBybitKline(row);
      if (Number.isFinite(c.ts)) byTs.set(c.ts, c);
    }
    const oldest = Math.min(...rows.map((r) => +r[0]));
    const ne = oldest - 60_000;
    if (end != null && ne >= end) break;
    end = ne;
    await new Promise((r) => setTimeout(r, 150));
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-totalLimit);
}

async function main() {
  const limit = Number.parseInt(arg("--limit", "12000"), 10);
  let leadCandles;
  let altCandles;
  if (flag("--bybit")) {
    [leadCandles, altCandles] = await Promise.all([fetchBybit(LEAD_SYMBOL, limit), fetchBybit(ALT_SYMBOL, limit)]);
  } else {
    const leadFile = arg("--lead-file");
    const altFile = arg("--alt-file");
    if (!leadFile || !altFile) {
      console.error("Use --bybit, or --lead-file btc.json --alt-file sui.json");
      process.exit(2);
    }
    leadCandles = JSON.parse(readFileSync(leadFile, "utf8"));
    altCandles = JSON.parse(readFileSync(altFile, "utf8"));
  }

  const result = runStrategy({ leadCandles, altCandles });

  const stateDir = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");
  const outDir = arg("--out-dir", join(stateDir, "strategy-runs"));
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${STRATEGY_VERSION_ID}-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: true,
        out: outPath,
        summary: result.summary,
        config: { gates: result.config.gates, inner: { scoreMin: result.config.inner.scoreMin, residualZMin: result.config.inner.residualZMin } },
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
    process.exit(1);
  });
}
