#!/usr/bin/env node
// btc-lead-alt-echo.mjs — Strategy Library shadow/backtest runner
//
// Tese: BTC/ETH como gatilho, nao apenas filtro. Quando BTC faz impulso
// forte e uma alt beta-correlacionada ainda nao acompanhou, testamos o
// catch-up nos proximos 2-8 minutos. Shadow/read-only: nao envia ordens.
//
// Uso:
//   node scripts/btc-lead-alt-echo.mjs --synthetic
//   node scripts/btc-lead-alt-echo.mjs --bybit --alt SOLUSDT --limit 1000
//   node scripts/btc-lead-alt-echo.mjs --lead-file btc.json --alt-file sol.json

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const STRATEGY_VERSION_ID = "btc_lead_alt_echo_v1_20260528";

const DEFAULT_CONFIG = {
  scoreMin: 70,
  minImpulsePct: 0.4,
  minRelativeImpulsePct: 0.25,
  impulseSigmaMin: 1.7,
  volumeRatioMin: 1.35,
  betaMin: 0.65,
  corrMin: 0.45,
  residualZMin: 0.3,
  betaWindow5m: 48,
  impulseStdWindow5m: 20,
  maxHoldMin: 8,
  noMoveExitMin: 2,
  noMoveMinPct: 0.05,
  stopPct: 0.35,
  minTargetPct: 0.18,
  maxTargetPct: 0.65,
  targetResidualCapture: 0.65,
  feePctRoundTrip: 0.11,
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function toIso(ts) {
  return new Date(ts).toISOString().replace(/\.\d+Z$/, "Z");
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCandle(c) {
  const ts = c.ts ?? c.timestamp ?? c.time ?? c.start;
  return {
    ts: typeof ts === "number" ? ts : new Date(ts).getTime(),
    open: asNumber(c.open),
    high: asNumber(c.high),
    low: asNumber(c.low),
    close: asNumber(c.close),
    volume: asNumber(c.volume ?? c.vol),
  };
}

function normalizeBybitKline(row) {
  return {
    ts: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

export function resampleCandles(candles, minutes) {
  const bucketMs = minutes * 60_000;
  const sorted = [...candles].sort((a, b) => a.ts - b.ts);
  const buckets = new Map();
  for (const c of sorted) {
    const key = Math.floor(c.ts / bucketMs) * bucketMs;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { ts: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume += c.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

function pct(from, to) {
  return ((to - from) / from) * 100;
}

function sidePct(entry, price, side) {
  const raw = pct(entry, price);
  return side === "short" ? -raw : raw;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function std(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function covariance(a, b) {
  if (a.length !== b.length || a.length < 2) return 0;
  const ma = mean(a);
  const mb = mean(b);
  return a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / (a.length - 1);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function returns(candles) {
  return candles.map((c, i) => (i === 0 ? 0 : pct(candles[i - 1].close, c.close)));
}

function rollingAvg(values, period, i) {
  if (i < period) return null;
  return mean(values.slice(i - period, i));
}

function alignCandles(lead, alt) {
  const altByTs = new Map(alt.map((c) => [c.ts, c]));
  const rows = [];
  for (const leadCandle of lead) {
    const altCandle = altByTs.get(leadCandle.ts);
    if (altCandle) rows.push({ ts: leadCandle.ts, lead: leadCandle, alt: altCandle });
  }
  return rows;
}

function latestIndexAtOrAfter(candles, ts) {
  return candles.findIndex((c) => c.ts >= ts);
}

function betaStats(leadReturns, altReturns, start, end) {
  const x = leadReturns.slice(start, end);
  const y = altReturns.slice(start, end);
  const varX = covariance(x, x);
  const cov = covariance(y, x);
  const beta = varX ? cov / varX : 0;
  const corr = std(x) && std(y) ? cov / (std(x) * std(y)) : 0;
  return { beta, corr };
}

function scoreEcho({ impulsePct, impulseSigma, volumeRatio, beta, corr, residualZ, lagPct }, config) {
  const impulseOk =
    Math.abs(impulsePct) >= config.minImpulsePct ||
    (Math.abs(impulsePct) >= config.minRelativeImpulsePct && impulseSigma >= config.impulseSigmaMin);
  const volumeOk = volumeRatio >= config.volumeRatioMin;
  const betaOk = Math.abs(beta) >= config.betaMin && Math.abs(corr) >= config.corrMin;
  const lagOk = residualZ >= config.residualZMin && lagPct > 0;

  let score = 0;
  score += clamp((impulseSigma / 2.4) * 30, 0, 30);
  score += clamp(((Math.abs(beta) - 0.45) / 0.75) * 25, 0, 25);
  score += clamp((residualZ / 1.4) * 20, 0, 20);
  score += clamp(((volumeRatio - 1) / 1.2) * 15, 0, 15);
  score += Math.abs(corr) >= 0.75 ? 10 : Math.abs(corr) >= 0.55 ? 6 : 0;

  const decision = score >= config.scoreMin && impulseOk && volumeOk && betaOk && lagOk ? "enter" : "skip";
  return {
    decision,
    score: Math.round(score),
    confidence: Number(clamp(score / 100, 0.2, 0.95).toFixed(2)),
    expectedEdge: Number(((score - 50) / 100).toFixed(3)),
    gates: { impulseOk, volumeOk, betaOk, lagOk },
  };
}

function makeSignal(strategyVersionId, leadSymbol, altSymbol, row, side, score, features) {
  const ts = toIso(row.ts);
  const body = `${strategyVersionId}:${ts}:${leadSymbol}:${altSymbol}:${side}:${score.score}`;
  const hash = createHash("sha1").update(body).digest("hex").slice(0, 10);
  return {
    client_signal_id: `${strategyVersionId}:${ts}:${altSymbol}:${hash}`,
    strategy_version_id: strategyVersionId,
    ts,
    symbol: altSymbol,
    side,
    decision: score.decision,
    confidence: score.confidence,
    expected_edge: score.expectedEdge,
    setup_score: score.score,
    regime_snapshot_json: {
      lead_symbol: leadSymbol,
      lead_impulse_pct: features.lead_impulse_pct,
      beta_4h: features.beta_4h,
      corr_4h: features.corr_4h,
    },
    features_json: features,
    reason:
      score.decision === "enter"
        ? `${leadSymbol} impulse; ${altSymbol} lagging regression by ${features.lag_pct}%`
        : `score=${score.score} gates=${JSON.stringify(score.gates)}`,
    entered: score.decision === "enter",
  };
}

function simulateTrade({ signal, entryIndex, lead1m, alt1m, leadImpulseStart, leadImpulseEnd, lagPct, config }) {
  const entry = alt1m[entryIndex];
  if (!entry) return null;
  const leadByTs = new Map(lead1m.map((c) => [c.ts, c]));
  const side = signal.side;
  const targetPct = clamp(lagPct * config.targetResidualCapture, config.minTargetPct, config.maxTargetPct);
  const tp = side === "long" ? entry.close * (1 + targetPct / 100) : entry.close * (1 - targetPct / 100);
  const sl = side === "long" ? entry.close * (1 - config.stopPct / 100) : entry.close * (1 + config.stopPct / 100);
  const leadMove = leadImpulseEnd.close - leadImpulseStart.close;
  const leadReversalPrice = leadImpulseStart.close + leadMove * 0.5;

  let mfe = 0;
  let mae = 0;
  for (let offset = 1; offset <= config.maxHoldMin; offset++) {
    const alt = alt1m[entryIndex + offset];
    const lead = leadByTs.get(alt.ts);
    if (!alt || !lead) break;
    const highPnl = side === "long" ? sidePct(entry.close, alt.high, side) : sidePct(entry.close, alt.low, side);
    const lowPnl = side === "long" ? sidePct(entry.close, alt.low, side) : sidePct(entry.close, alt.high, side);
    mfe = Math.max(mfe, highPnl);
    mae = Math.min(mae, lowPnl);

    const hitTp = side === "long" ? alt.high >= tp : alt.low <= tp;
    const hitSl = side === "long" ? alt.low <= sl : alt.high >= sl;
    const leadReversed = side === "long" ? lead.close <= leadReversalPrice : lead.close >= leadReversalPrice;
    const noMove = offset >= config.noMoveExitMin && sidePct(entry.close, alt.close, side) < config.noMoveMinPct;

    if (hitTp) return finishTrade("residual_converged", tp, alt, offset);
    if (hitSl) return finishTrade("sl_lag_failed", sl, alt, offset);
    if (leadReversed) return finishTrade("lead_reversed_half_impulse", alt.close, alt, offset);
    if (noMove) return finishTrade("no_echo_90s", alt.close, alt, offset);
  }

  const last = alt1m[Math.min(entryIndex + config.maxHoldMin, alt1m.length - 1)];
  return finishTrade("time_exit", last.close, last, config.maxHoldMin);

  function finishTrade(reason, exitPrice, candle, minutesHeld) {
    const gross = sidePct(entry.close, exitPrice, side);
    const net = gross - config.feePctRoundTrip;
    return {
      client_signal_id: signal.client_signal_id,
      symbol: signal.symbol,
      side,
      entry_ts: toIso(entry.ts),
      entry: Number(entry.close.toFixed(8)),
      exit_ts: toIso(candle.ts),
      exit_price: Number(exitPrice.toFixed(8)),
      exit_reason: reason,
      minutes_held: minutesHeld,
      target_pct: Number(targetPct.toFixed(3)),
      pnl_gross_pct: Number(gross.toFixed(3)),
      pnl_net_pct: Number(net.toFixed(3)),
      mfe_pct: Number(mfe.toFixed(3)),
      mae_pct: Number(mae.toFixed(3)),
      setup_score: signal.setup_score,
      confidence: signal.confidence,
    };
  }
}

export function runBtcLeadAltEcho({ leadCandles, altCandles, leadSymbol = "BTCUSDT", altSymbol = "ALTUSDT", config = {} }) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const lead1m = leadCandles.map(normalizeCandle).sort((a, b) => a.ts - b.ts);
  const alt1m = altCandles.map(normalizeCandle).sort((a, b) => a.ts - b.ts);
  const lead5m = resampleCandles(lead1m, 5);
  const alt5m = resampleCandles(alt1m, 5);
  const rows = alignCandles(lead5m, alt5m);
  const leadReturns = returns(rows.map((r) => r.lead));
  const altReturns = returns(rows.map((r) => r.alt));
  const leadVolumes = rows.map((r) => r.lead.volume);
  const residualHistory = [];
  const signals = [];
  const outcomes = [];
  const trades = [];
  let activeUntilTs = 0;

  for (let i = cfg.betaWindow5m; i < rows.length - 2; i++) {
    const row = rows[i];
    if (row.ts <= activeUntilTs) continue;

    const impulsePct = leadReturns[i];
    const impulseStd = std(leadReturns.slice(Math.max(1, i - cfg.impulseStdWindow5m), i).map(Math.abs)) || 0.01;
    const impulseSigma = Math.abs(impulsePct) / impulseStd;
    const volumeAvg = rollingAvg(leadVolumes, 12, i) ?? row.lead.volume;
    const volumeRatio = volumeAvg ? row.lead.volume / volumeAvg : 1;
    const { beta, corr } = betaStats(leadReturns, altReturns, i - cfg.betaWindow5m, i);
    const expectedAltMove = beta * impulsePct;
    const altMove = altReturns[i];
    const side = expectedAltMove >= 0 ? "long" : "short";
    const lagPct = side === "long" ? expectedAltMove - altMove : altMove - expectedAltMove;
    const residualStd = std(residualHistory.slice(-cfg.betaWindow5m).map((v) => Math.abs(v))) || std(altReturns.slice(i - cfg.betaWindow5m, i)) || 0.01;
    const residualZ = lagPct / residualStd;
    residualHistory.push(expectedAltMove - altMove);

    const features = {
      lead_symbol: leadSymbol,
      alt_symbol: altSymbol,
      lead_impulse_pct: Number(impulsePct.toFixed(3)),
      impulse_sigma: Number(impulseSigma.toFixed(3)),
      lead_volume_ratio: Number(volumeRatio.toFixed(3)),
      beta_4h: Number(beta.toFixed(3)),
      corr_4h: Number(corr.toFixed(3)),
      expected_alt_move_pct: Number(expectedAltMove.toFixed(3)),
      alt_move_pct: Number(altMove.toFixed(3)),
      lag_pct: Number(lagPct.toFixed(3)),
      residual_z: Number(residualZ.toFixed(3)),
    };
    const scored = scoreEcho({ impulsePct, impulseSigma, volumeRatio, beta, corr, residualZ, lagPct }, cfg);
    const signal = makeSignal(STRATEGY_VERSION_ID, leadSymbol, altSymbol, row, side, scored, features);
    signals.push(signal);
    if (signal.decision !== "enter") continue;

    const entryIndex = latestIndexAtOrAfter(alt1m, row.ts + 60_000);
    const leadImpulseStart = lead5m.find((c) => c.ts === row.ts)?.open ? { close: row.lead.open } : row.lead;
    const trade = simulateTrade({
      signal,
      entryIndex,
      lead1m,
      alt1m,
      leadImpulseStart,
      leadImpulseEnd: row.lead,
      lagPct,
      config: cfg,
    });
    if (!trade) continue;
    trades.push(trade);
    activeUntilTs = new Date(trade.exit_ts).getTime();
    outcomes.push({
      client_signal_id: trade.client_signal_id,
      ts: trade.exit_ts,
      horizon_sec: trade.minutes_held * 60,
      mfe_pct: trade.mfe_pct,
      mae_pct: trade.mae_pct,
      exit_reason: trade.exit_reason,
      pnl_gross_usd: null,
      fee_usd: null,
      pnl_net_usd: null,
      label: trade.pnl_net_pct > 0 ? "win" : "loss",
    });
  }

  const wins = trades.filter((t) => t.pnl_net_pct > 0).length;
  const gross = trades.reduce((s, t) => s + t.pnl_gross_pct, 0);
  const net = trades.reduce((s, t) => s + t.pnl_net_pct, 0);
  return {
    summary: {
      strategy_version_id: STRATEGY_VERSION_ID,
      lead_symbol: leadSymbol,
      alt_symbol: altSymbol,
      aligned_5m: rows.length,
      signals: signals.length,
      entries: trades.length,
      wins,
      losses: trades.length - wins,
      win_rate_pct: trades.length ? Number(((wins / trades.length) * 100).toFixed(2)) : 0,
      pnl_gross_pct: Number(gross.toFixed(3)),
      pnl_net_pct: Number(net.toFixed(3)),
      avg_net_pct: trades.length ? Number((net / trades.length).toFixed(3)) : 0,
    },
    signals,
    outcomes,
    trades,
    config: cfg,
  };
}

export function syntheticLeadAlt({ start = "2026-05-28T00:00:00Z", minutes = 900 } = {}) {
  const lead = [];
  const alt = [];
  let leadPrice = 100;
  let altPrice = 25;
  let seed = 7;
  function rand() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }
  const startMs = new Date(start).getTime();
  const impulses = new Map([
    [260, 0.18],
    [261, 0.16],
    [262, 0.14],
    [263, 0.12],
    [520, -0.17],
    [521, -0.15],
    [522, -0.13],
    [523, -0.11],
    [700, 0.2],
    [701, 0.17],
    [702, 0.15],
    [703, 0.12],
  ]);
  for (let i = 0; i < minutes; i++) {
    const impulse = impulses.get(i) ?? 0;
    const leadMove = impulse || Math.sin(i / 30) * 0.018 + (rand() - 0.5) * 0.045;
    const laggedImpulse = (impulses.get(i - 3) ?? 0) + (impulses.get(i - 4) ?? 0) * 0.45;
    const altLagMove = leadMove * 0.28 + laggedImpulse * 0.82 + Math.sin(i / 28) * 0.015 + (rand() - 0.5) * 0.04;
    lead.push(makeCandle(startMs + i * 60_000, leadPrice, leadMove, 1800 + Math.abs(impulse) * 9000 + rand() * 500));
    alt.push(makeCandle(startMs + i * 60_000, altPrice, altLagMove, 900 + Math.abs(impulses.get(i - 3) ?? 0) * 7000 + rand() * 400));
    leadPrice = lead[lead.length - 1].close;
    altPrice = alt[alt.length - 1].close;
  }
  return { lead, alt };
}

function makeCandle(ts, open, movePct, volume) {
  const close = open * (1 + movePct / 100);
  const high = Math.max(open, close) * 1.0004;
  const low = Math.min(open, close) * 0.9996;
  return { ts, open, high, low, close, volume };
}

async function loadBybitKline(symbol, limit) {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=1&limit=${limit}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.retCode !== 0) throw new Error(`Bybit kline failed for ${symbol}: ${json.retMsg ?? json.retCode}`);
  return json.result.list.map(normalizeBybitKline).sort((a, b) => a.ts - b.ts);
}

async function main() {
  const leadSymbol = arg("--lead", "BTCUSDT");
  const altSymbol = arg("--alt", "SOLUSDT");
  const limit = parseInt(arg("--limit", "1000"), 10);
  let leadCandles;
  let altCandles;

  if (flag("--synthetic")) {
    const pair = syntheticLeadAlt({ minutes: limit });
    leadCandles = pair.lead;
    altCandles = pair.alt;
  } else if (flag("--bybit")) {
    [leadCandles, altCandles] = await Promise.all([loadBybitKline(leadSymbol, limit), loadBybitKline(altSymbol, limit)]);
  } else {
    const leadFile = arg("--lead-file");
    const altFile = arg("--alt-file");
    if (!leadFile || !altFile) {
      console.error("Use --synthetic, --bybit, or --lead-file btc.json --alt-file alt.json");
      process.exit(2);
    }
    const leadParsed = JSON.parse(readFileSync(leadFile, "utf8"));
    const altParsed = JSON.parse(readFileSync(altFile, "utf8"));
    leadCandles = Array.isArray(leadParsed) ? leadParsed : leadParsed.candles;
    altCandles = Array.isArray(altParsed) ? altParsed : altParsed.candles;
  }

  const result = runBtcLeadAltEcho({ leadCandles, altCandles, leadSymbol, altSymbol });
  const stateDir = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");
  const outDir = arg("--out-dir", join(stateDir, "strategy-runs"));
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${STRATEGY_VERSION_ID}-${leadSymbol}-${altSymbol}-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: true, out: outPath, summary: result.summary }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  });
}
