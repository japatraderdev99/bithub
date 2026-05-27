// live-tail.test.mjs — testes do sidecar de tail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseLine,
  applyEvent,
  createState,
  isSensitive,
  isPathSafe,
  readJsonStateSafe,
  mergeScalperPositions,
  start,
  snapshot,
} from "../scripts/live-tail.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_LOG = resolvePath(__dirname, "fixtures", "monitor-v4-sample.log");

const FIXED_NOW = () => new Date("2026-05-27T01:00:00Z");

// --------------------------------------------------------------------------
// parser
// --------------------------------------------------------------------------

test("parseLine: banner", () => {
  const line = "Monitor v4 | T1: top-100 cada 180s | T2: candidatos cada 45s | tape reading ativo";
  const ev = parseLine(line, FIXED_NOW);
  assert.equal(ev.kind, "banner");
});

test("parseLine: startup position load", () => {
  const ev = parseLine("[startup] 📋 GRASS LONG carregada | entry=0.503052 SL=0.50093 TP=0.506444", FIXED_NOW);
  assert.equal(ev.kind, "position_load");
  assert.equal(ev.data.symbol, "GRASS");
  assert.equal(ev.data.dir, "LONG");
  assert.equal(ev.data.entry, 0.503052);
  assert.equal(ev.data.sl, 0.50093);
  assert.equal(ev.data.tp, 0.506444);
});

test("parseLine: ws_status up", () => {
  const ev = parseLine("[ws-priv] ✅ streams position+order ativos", FIXED_NOW);
  assert.equal(ev.kind, "ws_status");
  assert.equal(ev.data.up, true);
});

test("parseLine: ws_status auth ok", () => {
  const ev = parseLine("[ws-priv] ✅ auth OK — subscrevendo position+order", FIXED_NOW);
  assert.equal(ev.kind, "ws_status");
  assert.equal(ev.data.up, true);
});

test("parseLine: ws_status down (keys ausentes)", () => {
  const ev = parseLine("[ws-priv] keys ausentes — abortando", FIXED_NOW);
  assert.equal(ev.kind, "ws_status");
  assert.equal(ev.data.up, false);
});

test("parseLine: position_tick LONG", () => {
  const line = "[01:05:23] 📊 GRASS LONG | price=0.50341 PnL=+0.07% best=+0.00% | SL=0.50093 TP=0.50644 EMA9=0.50274 mom=WANING";
  const ev = parseLine(line, FIXED_NOW);
  assert.equal(ev.kind, "position_tick");
  assert.equal(ev.data.symbol, "GRASS");
  assert.equal(ev.data.dir, "LONG");
  assert.equal(ev.data.price, 0.50341);
  assert.equal(ev.data.pnl_pct, 0.07);
  assert.equal(ev.data.best_pct, 0.00);
  assert.equal(ev.data.sl, 0.50093);
  assert.equal(ev.data.tp, 0.50644);
  assert.equal(ev.data.ema9, 0.50274);
  assert.equal(ev.data.mom, "WANING");
});

test("parseLine: position_tick SHORT com PnL negativo", () => {
  const line = "[01:05:23] 📊 BTC SHORT | price=68000.0 PnL=-0.15% best=+0.10% | SL=68100 TP=67500 EMA9=67990 mom=NORMAL";
  const ev = parseLine(line, FIXED_NOW);
  assert.equal(ev.kind, "position_tick");
  assert.equal(ev.data.pnl_pct, -0.15);
  assert.equal(ev.data.best_pct, 0.1);
});

test("parseLine: scanner_t1", () => {
  const ev = parseLine("[01:05:23] 🔍 T1 scan top-100...", FIXED_NOW);
  assert.equal(ev.kind, "scanner_t1");
  assert.equal(ev.data.top_n, 100);
});

test("parseLine: scanner_t1_result", () => {
  const ev = parseLine("T1 → 7 candidatos: BTC ETH SOL XRP BNB AAVE DOGE", FIXED_NOW);
  assert.equal(ev.kind, "scanner_t1_result");
  assert.equal(ev.data.candidates, 7);
});

test("parseLine: entry", () => {
  const ev = parseLine("🚀 ENTRADA | BASE SHORT SCORE=72 | TF:1m+5m | BookImb:32%✅", FIXED_NOW);
  assert.equal(ev.kind, "entry");
  assert.equal(ev.data.tag, "BASE");
  assert.equal(ev.data.dir, "SHORT");
  assert.equal(ev.data.score, 72);
});

test("parseLine: score_low", () => {
  const ev = parseLine("📉 SCORE BAIXO", FIXED_NOW);
  assert.equal(ev.kind, "score_low");
});

test("parseLine: near_miss", () => {
  const ev = parseLine("⏳ near-miss T2: AAVE [falta:VP]", FIXED_NOW);
  assert.equal(ev.kind, "near_miss");
  assert.equal(ev.data.symbol, "AAVE");
  assert.equal(ev.data.missing, "VP");
});

test("parseLine: tape_ok", () => {
  const ev = parseLine("[BASE] ✅ tape confirmou: favor=63% | delta_trend=ACELERANDO", FIXED_NOW);
  assert.equal(ev.kind, "tape_ok");
  assert.equal(ev.data.tag, "BASE");
  assert.equal(ev.data.favor_pct, 63);
});

test("parseLine: tape_reject", () => {
  const ev = parseLine("[XRPL] ❌ tape rejeitou", FIXED_NOW);
  assert.equal(ev.kind, "tape_reject");
  assert.equal(ev.data.tag, "XRPL");
});

test("parseLine: execute", () => {
  const ev = parseLine("🔴 EXECUTANDO BASE SHORT | margin=$0.43 lev=10x notional=$4.30 qty=0.026 | risk=$0.43(0.50%) slots=1/4 | SL=0.50644(0.50%) TP=0.50093 R:R=1.82", FIXED_NOW);
  assert.equal(ev.kind, "execute");
  assert.equal(ev.data.tag, "BASE");
  assert.equal(ev.data.dir, "SHORT");
  assert.equal(ev.data.lev, 10);
  assert.equal(ev.data.slots_used, 1);
  assert.equal(ev.data.slots_max, 4);
});

test("parseLine: sltp_attached", () => {
  const ev = parseLine("[SL/TP] anexados via trading-stop | SL=0.50644 TP=0.50093", FIXED_NOW);
  assert.equal(ev.kind, "sltp_attached");
});

test("parseLine: trail_update", () => {
  const ev = parseLine("📉 BASE TRAIL → 0.50412 | mom:NORMAL anchor=EMA9 SL→0.50412", FIXED_NOW);
  assert.equal(ev.kind, "trail_update");
});

test("parseLine: position_close (ws-priv)", () => {
  const ev = parseLine("[ws-priv] 🏁 GRASS fechada", FIXED_NOW);
  assert.equal(ev.kind, "position_close");
  assert.equal(ev.data.symbol, "GRASS");
});

test("parseLine: stop_fill", () => {
  const ev = parseLine("[ws-priv] ⚡ GRASS TakeProfit filled", FIXED_NOW);
  assert.equal(ev.kind, "stop_fill");
  assert.equal(ev.data.symbol, "GRASS");
  assert.equal(ev.data.fill_type, "TakeProfit");
});

test("parseLine: unknown returns raw", () => {
  const ev = parseLine("✅ Posição registrada: BASE @ 0.50352", FIXED_NOW);
  assert.equal(ev.kind, "raw");
});

test("parseLine: empty returns null", () => {
  assert.equal(parseLine("", FIXED_NOW), null);
  assert.equal(parseLine("   ", FIXED_NOW), null);
});

// --------------------------------------------------------------------------
// sensitive
// --------------------------------------------------------------------------

test("isSensitive: detecta api_key=", () => {
  assert.equal(isSensitive("api_key=XtCDFmQJvWTUVNriqP"), true);
});

test("isSensitive: detecta Authorization:", () => {
  assert.equal(isSensitive("Authorization: Bearer eyJhbGciOi"), true);
});

test("isSensitive: detecta cfat_ token", () => {
  assert.equal(isSensitive("cloudflare token: cfat_k61E5rzw"), true);
});

test("isSensitive: detecta BYBIT_API_SECRET", () => {
  assert.equal(isSensitive("BYBIT_API_SECRET=3LM12u9Sfqmvxvs0M5bo1IcQbpWQF94SpgkI"), true);
});

test("isSensitive: linha normal nao gatilha", () => {
  assert.equal(isSensitive("[01:05:23] 📊 GRASS LONG | price=0.50341"), false);
});

test("parseLine: linha sensivel vira redacted", () => {
  const ev = parseLine("api_key=XtCDFmQJvWTUVNriqP", FIXED_NOW);
  assert.equal(ev.kind, "redacted");
  assert.deepEqual(ev.data, {});
});

// --------------------------------------------------------------------------
// state machine
// --------------------------------------------------------------------------

test("applyEvent: position_load -> position_tick -> position_close", () => {
  const state = createState();
  applyEvent(state, parseLine("[startup] 📋 GRASS LONG carregada | entry=0.503052 SL=0.50093 TP=0.506444", FIXED_NOW), "line1");
  assert.equal(state.positions.size, 1);
  assert.equal(state.positions.get("GRASS").entry, 0.503052);

  applyEvent(state, parseLine("[01:05:23] 📊 GRASS LONG | price=0.50341 PnL=+0.07% best=+0.00% | SL=0.50093 TP=0.50644 EMA9=0.50274 mom=WANING", FIXED_NOW), "line2");
  const p = state.positions.get("GRASS");
  assert.equal(p.price, 0.50341);
  assert.equal(p.entry, 0.503052); // preservado do load

  applyEvent(state, parseLine("[ws-priv] 🏁 GRASS fechada", FIXED_NOW), "line3");
  assert.equal(state.positions.size, 0);
});

test("applyEvent: ws_status atualiza scanner.ws_status", () => {
  const state = createState();
  applyEvent(state, parseLine("[ws-priv] ✅ streams position+order ativos", FIXED_NOW), "l");
  assert.equal(state.scanner.ws_status, "up");
  applyEvent(state, parseLine("[ws-priv] keys ausentes", FIXED_NOW), "l");
  assert.equal(state.scanner.ws_status, "down");
});

test("applyEvent: scanner_t1 + scanner_t1_result + execute populam scanner", () => {
  const state = createState();
  applyEvent(state, parseLine("[01:05:23] 🔍 T1 scan top-100...", FIXED_NOW), "l");
  applyEvent(state, parseLine("T1 → 7 candidatos: BTC ETH", FIXED_NOW), "l");
  applyEvent(state, parseLine("🔴 EXECUTANDO BASE SHORT | margin=$0.43 lev=10x notional=$4.30 qty=0.026 | risk=$0.43(0.50%) slots=2/4 | SL=0.50644 TP=0.50093 R:R=1.82", FIXED_NOW), "l");
  assert.equal(state.scanner.t1_top_n, 100);
  assert.equal(state.scanner.last_candidates_count, 7);
  assert.equal(state.scanner.slots_used, 2);
  assert.equal(state.scanner.slots_max, 4);
});

test("applyEvent: buffer de events respeita capacity", () => {
  const state = createState({ capacity: { events: 5, raw: 5 } });
  for (let i = 0; i < 10; i++) {
    applyEvent(state, parseLine("📉 SCORE BAIXO", FIXED_NOW), `line${i}`);
  }
  assert.equal(state.events.length, 5);
  assert.ok(state.rawLines.length <= 5);
});

test("applyEvent: redacted nao adiciona em events nem raw", () => {
  const state = createState();
  applyEvent(state, parseLine("api_key=secret123", FIXED_NOW), null);
  assert.equal(state.events.length, 0);
  assert.equal(state.rawLines.length, 0);
});

// --------------------------------------------------------------------------
// fixture full file
// --------------------------------------------------------------------------

test("fixture: 21+ linhas parsed, posicoes corretas no final", () => {
  const content = readFileSync(FIXTURE_LOG, "utf8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  const state = createState();
  let parsedCount = 0;
  for (const line of lines) {
    const ev = parseLine(line, FIXED_NOW);
    if (ev) {
      parsedCount++;
      applyEvent(state, ev, line);
    }
  }
  assert.ok(parsedCount >= 20, `expected >=20 events, got ${parsedCount}`);
  // No final do fixture: GRASS foi fechada via TakeProfit, BASE SHORT abriu
  assert.equal(state.positions.has("GRASS"), false, "GRASS deve ter sido fechada");
  // BASE foi executada mas nao tem position_load nem position_tick com symbol BASE
  // (no fixture BASE eh executada e depois recebe position_tick como "BASE SHORT")
  assert.equal(state.positions.has("BASE"), true, "BASE deve estar aberta");
  const base = state.positions.get("BASE");
  assert.equal(base.dir, "SHORT");
  assert.equal(state.scanner.ws_status, "up");
});

// --------------------------------------------------------------------------
// JSON state files
// --------------------------------------------------------------------------

test("readJsonStateSafe: arquivo inexistente -> null", () => {
  assert.equal(readJsonStateSafe("/tmp/__nope__/positions.json"), null);
});

test("readJsonStateSafe: JSON valido", () => {
  const dir = mkdtempSync(join(tmpdir(), "bithub-livetail-"));
  const path = join(dir, "p.json");
  writeFileSync(path, JSON.stringify({ "BTC/USDT:USDT": { dir: "LONG", entry: 68000 } }));
  const r = readJsonStateSafe(path);
  assert.deepEqual(r, { "BTC/USDT:USDT": { dir: "LONG", entry: 68000 } });
});

test("readJsonStateSafe: JSON invalido -> null", () => {
  const dir = mkdtempSync(join(tmpdir(), "bithub-livetail-"));
  const path = join(dir, "p.json");
  writeFileSync(path, "{ not valid json");
  assert.equal(readJsonStateSafe(path), null);
});

test("mergeScalperPositions: complementa positions sem sobrescrever ticks", () => {
  const state = createState();
  // primeiro vem position_tick (com price)
  applyEvent(state, parseLine("[01:05:23] 📊 GRASS LONG | price=0.50341 PnL=+0.07% best=+0.00% | SL=0.50093 TP=0.50644 EMA9=0.50274 mom=WANING", FIXED_NOW), "l");
  // depois json reporta a mesma
  mergeScalperPositions(state, { "GRASS": { dir: "LONG", entry: 0.502, stop: 0.50093 } });
  const p = state.positions.get("GRASS");
  // price do tick preservado
  assert.equal(p.price, 0.50341);
});

// --------------------------------------------------------------------------
// path safety
// --------------------------------------------------------------------------

test("isPathSafe: rejeita path com bithub-vault", () => {
  assert.equal(isPathSafe("/Users/foo/bithub-vault/some.md"), false);
});

test("isPathSafe: rejeita /etc/", () => {
  assert.equal(isPathSafe("/etc/passwd"), false);
});

test("isPathSafe: aceita /tmp/something.log", () => {
  const dir = mkdtempSync(join(tmpdir(), "bithub-livetail-"));
  const path = join(dir, "x.log");
  writeFileSync(path, "");
  assert.equal(isPathSafe(path), true);
});

// --------------------------------------------------------------------------
// start/snapshot (smoke integracao)
// --------------------------------------------------------------------------

test("start+snapshot: ingere log dinamicamente e snapshot reflete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bithub-livetail-"));
  const logPath = join(dir, "monitor.log");
  writeFileSync(logPath, "Monitor v4 | T1: top-100 | T2: candidatos cada 45s | tape ativo\n");
  const h = start({ logPath });
  try {
    await new Promise((r) => setTimeout(r, 50));
    appendFileSync(logPath, "[ws-priv] ✅ streams position+order ativos\n");
    appendFileSync(logPath, "[01:05:23] 📊 BTC LONG | price=68000 PnL=+0.10% best=+0.10% | SL=67900 TP=68500 EMA9=67995 mom=NORMAL\n");
    // dar tempo do watcher/poller pegar
    await new Promise((r) => setTimeout(r, 100));
    // forcar poll manual chamando snapshot direto nao reflete; precisamos que o interval rode.
    // Aguarda 2.2s (1 ciclo de poll) — esse teste eh lento mas confiavel.
    await new Promise((r) => setTimeout(r, 2200));
    const s = snapshot(h);
    assert.equal(s.scanner.ws_status, "up");
    assert.equal(s.positions.length, 1);
    assert.equal(s.positions[0].symbol, "BTC");
    assert.equal(s.positions[0].price, 68000);
  } finally {
    h.stop();
  }
});
