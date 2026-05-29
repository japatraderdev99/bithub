#!/usr/bin/env node
// cooldown-status.mjs — read-only viewer dos cooldowns ativos.
//
// Uso:
//   node cooldown-status.mjs              # tabela de cooldowns ativos
//
// Observação: cooldowns são derivados do live_trades a cada tick do daemon.
// Não há "manual override" por enquanto — quem desligar o daemon
// libera tudo; quem reinicializar volta a calcular do histórico.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");
const STATE_FILE = join(STATE_DIR, "cooldowns.json");

function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); } catch (e) {
    console.error(`ERR: state file inválido: ${e.message}`);
    process.exit(2);
  }
}

function fmtRelative(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "(expirado)";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `em ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `em ${min}min ${sec % 60}s`;
  const h = Math.floor(min / 60);
  return `em ${h}h ${min % 60}min`;
}

function show(state) {
  if (!state) {
    console.log("(no state file — daemon não rodou ou foi resetado)");
    console.log(`Path: ${STATE_FILE}`);
    return;
  }
  console.log(`updated_at: ${state.updated_at}`);
  console.log(`config: light=${state.config.cooldown_any_exit_min}min · loss(${state.config.loss_threshold_pct}%)=${state.config.cooldown_loss_min}min`);
  if (state.degraded) console.log(`⚠️  degraded: ${state.degraded_reason}`);
  console.log("");
  const symbols = Object.keys(state.cooldowns ?? {});
  if (symbols.length === 0) {
    console.log("🟢 Nenhum símbolo em cooldown.");
    return;
  }
  console.log(`🔴 ${symbols.length} símbolo(s) em cooldown:`);
  const sorted = symbols
    .map((s) => ({ symbol: s, ...state.cooldowns[s] }))
    .sort((a, b) => new Date(a.until) - new Date(b.until));
  for (const c of sorted) {
    const expIn = fmtRelative(c.until);
    const pnl = c.pnl_pct != null ? `pnl=${c.pnl_pct.toFixed(2)}%` : "pnl=?";
    console.log(`  ${c.symbol.padEnd(16)} ${c.reason.padEnd(22)} ${pnl.padEnd(14)} libera ${expIn}`);
  }
}

show(readState());
