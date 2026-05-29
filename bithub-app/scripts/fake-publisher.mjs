#!/usr/bin/env node
// fake-publisher.mjs — simula o bithub_state_publisher.py do projeto
// Freqtrade enquanto o monitor real não está rodando. Útil para iterar
// a UI do Bithub sem precisar de Bybit, monitor, ou tape reader.
//
// Escreve em ~/.bithub-monitor/ (ou $BITHUB_STATE_DIR) a cada N segundos:
//   positions.json, candidates.json, system.json, events.jsonl
//
// Uso:
//   node bithub-app/scripts/fake-publisher.mjs            # 5s tick
//   node bithub-app/scripts/fake-publisher.mjs --tick 2   # 2s tick
//   node bithub-app/scripts/fake-publisher.mjs --once     # 1 ciclo e sai

import { mkdir, writeFile, rename, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const TICK_SEC = parseInt(args[args.indexOf("--tick") + 1] ?? "5", 10) || 5;
const ONCE = args.includes("--once");
const STATE_DIR = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");

const SYMBOLS = ["NEARUSDT", "DOGEUSDT", "SOLUSDT", "WIFUSDT", "AVAXUSDT", "ARBUSDT"];
const MOMENTUM = ["STRONG", "NORMAL", "WANING", "REVERSING"];
const DELTA_TRENDS = ["ACELERANDO", "DESACELERANDO", "ESTAVEL"];

let tick = 0;
const openPositions = [];
const eventBuffer = [];

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function maybeOpenNew() {
  if (openPositions.length >= 4) return;
  if (Math.random() > 0.18) return;
  const symbol = pick(SYMBOLS.filter((s) => !openPositions.find((p) => p.symbol === s)));
  if (!symbol) return;
  const side = Math.random() > 0.5 ? "long" : "short";
  const entry = parseFloat(rand(0.5, 200).toFixed(4));
  const sl_dist = entry * (0.012 + Math.random() * 0.015);
  const tp_dist = sl_dist * (1.2 + Math.random() * 1.5);
  const size_usd = parseFloat(rand(10, 80).toFixed(2));
  const pos = {
    symbol,
    side,
    entry,
    current_price: entry,
    sl: side === "short" ? entry + sl_dist : entry - sl_dist,
    tp: side === "short" ? entry - tp_dist : entry + tp_dist,
    qty: parseFloat((size_usd / entry).toFixed(4)),
    pnl_pct: 0,
    best_pnl_pct: 0,
    size_usd,
    leverage: 10,
    momentum_state: pick(MOMENTUM),
    tape_bias: 0,
    tape_flow_pct: 50 + Math.floor(rand(-10, 10)),
    tape_delta_trend: pick(DELTA_TRENDS),
    be_set: false,
    partial_done: false,
    tp_extended: false,
    opened_at: new Date().toISOString(),
  };
  openPositions.push(pos);
  emitEvent(symbol, "ENTRY", `score ${Math.floor(rand(60, 90))} | tape ${pos.tape_flow_pct}% ${pos.tape_delta_trend.toLowerCase()}`);
}

function stepPositions() {
  for (let i = openPositions.length - 1; i >= 0; i--) {
    const p = openPositions[i];
    // Drift the price
    const drift_pct = rand(-0.4, 0.4);
    p.current_price = parseFloat((p.current_price * (1 + drift_pct / 100)).toFixed(4));
    const move_pct = ((p.current_price - p.entry) / p.entry) * 100;
    p.pnl_pct = parseFloat((p.side === "long" ? move_pct : -move_pct).toFixed(2));
    p.best_pnl_pct = parseFloat(Math.max(p.best_pnl_pct, p.pnl_pct).toFixed(2));

    // Random momentum/tape shifts
    if (Math.random() > 0.6) p.momentum_state = pick(MOMENTUM);
    if (Math.random() > 0.5) {
      p.tape_flow_pct = Math.max(0, Math.min(100, p.tape_flow_pct + Math.floor(rand(-5, 5))));
      p.tape_delta_trend = pick(DELTA_TRENDS);
      p.tape_bias = Math.floor(rand(-2, 3));
    }

    // SL hit?
    if ((p.side === "short" && p.current_price >= p.sl) || (p.side === "long" && p.current_price <= p.sl)) {
      emitEvent(p.symbol, "EXIT_FULL", `SL hit at ${p.current_price.toFixed(4)} | pnl ${p.pnl_pct.toFixed(2)}%`);
      openPositions.splice(i, 1);
      continue;
    }
    // TP hit?
    if ((p.side === "short" && p.current_price <= p.tp) || (p.side === "long" && p.current_price >= p.tp)) {
      emitEvent(p.symbol, "EXIT_FULL", `TP hit at ${p.current_price.toFixed(4)} | pnl ${p.pnl_pct.toFixed(2)}%`);
      openPositions.splice(i, 1);
      continue;
    }
    // Random trail
    if (p.pnl_pct > 0.4 && Math.random() > 0.7) {
      const old_sl = p.sl;
      p.sl = p.side === "short" ? p.sl * 0.998 : p.sl * 1.002;
      emitEvent(p.symbol, "TRAIL", `SL ${old_sl.toFixed(4)} → ${p.sl.toFixed(4)} (anchor=ema9 momentum=${p.momentum_state})`);
    }
    // Random partial exit
    if (p.pnl_pct > 0.8 && !p.partial_done && Math.random() > 0.8) {
      p.partial_done = true;
      emitEvent(p.symbol, "EXIT_PARTIAL", `40% closed at ${p.current_price.toFixed(4)} | pnl ${p.pnl_pct.toFixed(2)}%`);
    }
  }
}

function emitEvent(symbol, event_type, detail, pnl_realized = undefined) {
  const ev = { ts: new Date().toISOString(), symbol, event_type, detail };
  if (pnl_realized !== undefined) ev.pnl_realized = pnl_realized;
  eventBuffer.push(ev);
}

function generateCandidates() {
  const n = Math.floor(rand(3, 9));
  const candidates = [];
  const pool = SYMBOLS.filter((s) => !openPositions.find((p) => p.symbol === s));
  for (let i = 0; i < Math.min(n, pool.length); i++) {
    const symbol = pool[i];
    const direction = Math.random() > 0.5 ? "long" : "short";
    const score = Math.floor(rand(35, 90));
    candidates.push({
      symbol,
      direction,
      score,
      gates: {
        g_atr: score > 50,
        g_bb: score > 45,
        g_vol: score > 55,
        g_ema: score > 50,
        g_rsi: score > 40,
        g_poc: score > 55,
        g_fund: Math.random() > 0.4,
        g_book: Math.random() > 0.4,
        liq_ok: Math.random() > 0.3,
      },
      indicators: {
        atr_pct: parseFloat(rand(0.4, 1.8).toFixed(2)),
        rsi5: Math.floor(rand(35, 70)),
        bb_pct: parseFloat(rand(20, 80).toFixed(1)),
        vol_ratio: parseFloat(rand(0.8, 2.5).toFixed(2)),
        book_imb_pct: Math.floor(rand(30, 70)),
        funding_rate: parseFloat((rand(-0.01, 0.05) / 100).toFixed(6)),
        ema_dist_pct: parseFloat(rand(0.1, 1.4).toFixed(2)),
        price: parseFloat(rand(0.5, 200).toFixed(4)),
      },
      tf_alignment: direction === "long" ? "BULL/BULL/BULL" : "BEAR/BEAR/BEAR",
    });
  }
  return candidates;
}

async function writeAtomic(path, content) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

async function publish() {
  const now = new Date().toISOString();
  tick++;

  maybeOpenNew();
  stepPositions();

  await writeAtomic(
    join(STATE_DIR, "positions.json"),
    JSON.stringify(
      {
        as_of: now,
        open_count: openPositions.length,
        max_slots: 4,
        positions: openPositions,
      },
      null,
      2
    )
  );

  await writeAtomic(
    join(STATE_DIR, "candidates.json"),
    JSON.stringify(
      {
        as_of: now,
        last_t1_scan_ts: new Date(Date.now() - 120000 * Math.random()).toISOString(),
        last_t2_scan_ts: new Date(Date.now() - 30000 * Math.random()).toISOString(),
        candidates: generateCandidates(),
      },
      null,
      2
    )
  );

  await writeAtomic(
    join(STATE_DIR, "system.json"),
    JSON.stringify(
      {
        as_of: now,
        balance_usdt: parseFloat((100 + rand(-2, 5)).toFixed(2)),
        free_usdt: parseFloat((100 - openPositions.reduce((s, p) => s + p.size_usd / 10, 0)).toFixed(2)),
        open_slots: openPositions.length,
        max_slots: 4,
        ws_private_status: "connected",
        last_heartbeat_ts: now,
        alerts: openPositions
          .filter((p) => Math.abs(((p.current_price - p.sl) / p.current_price) * 100) < 0.25)
          .map((p) => ({ severity: "info", msg: `${p.symbol}: SL dist ${(((p.current_price - p.sl) / p.current_price) * 100).toFixed(2)}%` })),
      },
      null,
      2
    )
  );

  if (eventBuffer.length) {
    const lines = eventBuffer.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await appendFile(join(STATE_DIR, "events.jsonl"), lines);
    eventBuffer.length = 0;
  }

  process.stdout.write(`[tick ${tick}] open=${openPositions.length} state_dir=${STATE_DIR}\n`);
}

async function main() {
  if (!existsSync(STATE_DIR)) {
    await mkdir(STATE_DIR, { recursive: true });
    console.log(`Created ${STATE_DIR}`);
  }
  console.log(`fake-publisher up — tick=${TICK_SEC}s state_dir=${STATE_DIR}`);

  // Seed with 1 open position so the UI has something instantly
  maybeOpenNew();
  await publish();
  if (ONCE) return;

  setInterval(publish, TICK_SEC * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
