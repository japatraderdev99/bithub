#!/usr/bin/env node
// kill-switch-status.mjs — CLI utility para inspecionar e controlar o
// kill switch manualmente (sem precisar do daemon ou da UI).
//
// Uso:
//   node kill-switch-status.mjs                # mostra estado atual + último check
//   node kill-switch-status.mjs --pause [reason]
//   node kill-switch-status.mjs --unpause      # libera (seta manual_override=true)
//   node kill-switch-status.mjs --reset        # apaga arquivo (clean state)
//
// Notas:
//   - --unpause NÃO apaga o arquivo. Marca manual_override=true para o daemon
//     parar de re-pausar pela mesma condição. Operator assume responsabilidade.
//   - --reset apaga o arquivo. Daemon vai recriar no próximo tick com active=true.
//     Use quando começar nova sessão / novo baseline.

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");
const STATE_FILE = join(STATE_DIR, "kill_switch.json");
const SCHEMA_VERSION = 1;

function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, "Z"); }

function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); } catch (e) {
    console.error(`ERR: state file inválido: ${e.message}`);
    process.exit(2);
  }
}

function writeState(state) {
  const data = JSON.stringify(state, null, 2);
  const tmp = join(STATE_DIR, `.kill_switch.${process.pid}.${Date.now()}.json`);
  writeFileSync(tmp, data, { mode: 0o644 });
  renameSync(tmp, STATE_FILE);
}

function show(state) {
  if (!state) {
    console.log("(no state file — daemon ainda não rodou ou foi resetado)");
    console.log(`Path: ${STATE_FILE}`);
    return;
  }
  const status = state.active ? "🟢 ACTIVE (entries permitidas)" : "🔴 PAUSED (entries bloqueadas)";
  console.log(status);
  console.log(`  updated_at:       ${state.updated_at}`);
  console.log(`  reason:           ${state.reason ?? "—"}`);
  console.log(`  paused_at:        ${state.paused_at ?? "—"}`);
  console.log(`  manual_override:  ${state.manual_override}`);
  console.log(`  baseline_usd:     ${state.session_baseline_usd}`);
  if (state.triggered_by) {
    console.log(`  triggered_by:     ${JSON.stringify(state.triggered_by)}`);
  }
  if (state.last_check) {
    console.log(`  last_check:`);
    console.log(`    balance:        ${state.last_check.balance}`);
    console.log(`    d1_pnl_sum:     ${state.last_check.d1_pnl_sum}`);
    console.log(`    d1_trades:      ${state.last_check.d1_trades}`);
    console.log(`    streak_losses:  ${state.last_check.streak_losses}`);
    if (state.last_check.triggers) {
      for (const [k, v] of Object.entries(state.last_check.triggers)) {
        console.log(`    ${k}: ${v.trigger ? "🔴 TRIGGER" : "🟢 ok"} ${JSON.stringify(v)}`);
      }
    }
  }
}

function cmdPause(reason) {
  const prev = readState();
  const next = {
    schema_version: SCHEMA_VERSION,
    updated_at: nowIso(),
    active: false,
    paused_at: nowIso(),
    reason: reason ?? "manual",
    triggered_by: { source: "kill-switch-status.mjs --pause", note: reason ?? null },
    session_baseline_usd: prev?.session_baseline_usd ?? null,
    manual_override: false,
    last_check: prev?.last_check ?? null,
  };
  writeState(next);
  console.log("🔴 Pause aplicado manualmente.");
  show(next);
}

function cmdUnpause() {
  const prev = readState();
  if (!prev) {
    console.error("ERR: sem state file — nada pra liberar. Rode --reset ou aguarde daemon iniciar.");
    process.exit(2);
  }
  const next = {
    ...prev,
    updated_at: nowIso(),
    active: true,
    paused_at: null,
    reason: null,
    triggered_by: null,
    manual_override: true,
  };
  writeState(next);
  console.log("🟢 Unpause manual. manual_override=true — daemon NÃO vai re-pausar pela mesma condição.");
  console.log("   Para resetar o override e voltar à vigilância automática, rode: --reset");
  show(next);
}

function cmdReset() {
  if (existsSync(STATE_FILE)) {
    unlinkSync(STATE_FILE);
    console.log(`Apagado: ${STATE_FILE}`);
  } else {
    console.log("(arquivo já não existia)");
  }
  console.log("Daemon vai recriar com active=true no próximo tick (se estiver rodando).");
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0) {
  show(readState());
  process.exit(0);
}

const cmd = args[0];
switch (cmd) {
  case "--pause": cmdPause(args[1]); break;
  case "--unpause": cmdUnpause(); break;
  case "--reset": cmdReset(); break;
  case "--help":
  case "-h":
    console.log("Uso: kill-switch-status.mjs [--pause [reason] | --unpause | --reset]");
    break;
  default:
    console.error(`ERR: comando desconhecido: ${cmd}`);
    console.error("Tente --help");
    process.exit(2);
}
