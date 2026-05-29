#!/usr/bin/env node
// backfill-fees-from-bybit.mjs — H-PRE-ROUND-3 Gate B
//
// Pega um dump JSON do Bybit `/v5/position/closed-pnl` (que o operador gera
// localmente — ele tem credenciais; Bithub-Claude não) e re-ingere cada
// trade no Worker com fee_usd, funding_usd, pnl_net_usd preenchidos.
//
// Como ON CONFLICT no Worker usa COALESCE, este script só ADICIONA campos
// sem sobrescrever pnl_abs/pnl_pct/etc. que já estão lá.
//
// Schema real do /v5/position/closed-pnl (confirmado contra dump 2026-05-28):
// {
//   "rows": [
//     {
//       "symbol": "XLMUSDT",
//       "side": "Buy" | "Sell",             // side do close (oposto da posição)
//       "qty": "456",
//       "avgEntryPrice": "0.20238053",
//       "avgExitPrice": "0.20146",
//       "createdTime": "1779997539543",     // ms timestamp Bybit (entry order)
//       "updatedTime": "1779997567823",     // ms timestamp Bybit (close)
//       "closedPnl": "-0.52104322",         // NET pnl (já descontado openFee + closeFee)
//       "openFee": "0.05075705",            // fee na abertura
//       "closeFee": "0.05052617",           // fee no fechamento
//       "execType": "Trade",
//       ...
//     },
//   ]
// }
//
// Mapeamento → Worker:
//   fee_usd         = openFee + closeFee
//   pnl_net_usd     = closedPnl (Bybit já calcula net de fees)
//   pnl_abs         = closedPnl + fee_usd (reconstrói gross)
//   funding_usd     = NULL (precisa /v5/account/transaction-log separado)
//
// ⚠️ side em closed-pnl é o lado do FECHAMENTO. Posição original é oposta:
//    Buy (close) → posição original era SHORT
//    Sell (close) → posição original era LONG
//
// Uso:
//   node backfill-fees-from-bybit.mjs \
//     --dump /tmp/bybit-closed-pnl-round2.json \
//     --worker-url https://bithub-trades-api.guiydantas.workers.dev \
//     --token "$BITHUB_INGEST_TOKEN" \
//     [--dry-run]                  # só mostra mapeamento, não chama Worker
//     [--client-trade-id-from db]  # busca client_trade_id por symbol+ts no D1 local

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
const flag = (name) => process.argv.includes(name);

const DUMP_PATH = arg("--dump", process.env.BACKFILL_DUMP);
const WORKER_URL = arg("--worker-url", process.env.BITHUB_WORKER_URL ?? "https://bithub-trades-api.guiydantas.workers.dev");
const TOKEN = arg("--token", process.env.BITHUB_INGEST_TOKEN);
const DRY_RUN = flag("--dry-run");
const LOOKUP_FROM_DB = arg("--client-trade-id-from", "db") === "db";
// Default true: só atualiza trades que existem no local — evita criar fantasmas
// no D1 a partir de trading anterior / manual fora do monitor.
const REQUIRE_DB_MATCH = !flag("--allow-ghost-creates");

if (!DUMP_PATH || !existsSync(DUMP_PATH)) {
  console.error(`ERR: --dump <path> obrigatório e arquivo deve existir. Got: ${DUMP_PATH}`);
  process.exit(2);
}
if (!DRY_RUN && !TOKEN) {
  console.error("ERR: --token (ou env BITHUB_INGEST_TOKEN) obrigatório. Use --dry-run para testar sem chamar Worker.");
  process.exit(2);
}

const STATE_DIR = process.env.BITHUB_STATE_DIR ?? join(homedir(), ".bithub-monitor");
const TRADES_DB = join(STATE_DIR, "trades.db");

function isoFromMs(ms) {
  return new Date(parseInt(ms, 10)).toISOString().replace(/\.\d+Z$/, "Z");
}

function sideFromBybit(s) {
  // No /v5/position/closed-pnl, `side` é o lado do FECHAMENTO. A posição
  // original era a contrária: Buy (close) → posição era SHORT, Sell (close) → LONG.
  // Confirmado contra dump real onde row XLM side=Sell tinha avgEntry > avgExit
  // e closedPnl negativo (long que perdeu).
  if (s === "Buy") return "short";
  if (s === "Sell") return "long";
  throw new Error(`unknown side: ${s}`);
}

function deriveClientTradeId(row) {
  // Fallback heuristic (publisher's actual scheme may differ).
  // Operador pode passar --client-trade-id-from db pra buscar exato.
  const ts = isoFromMs(row.createdTime);
  return `${row.symbol}_${ts}_${sideFromBybit(row.side)}`;
}

// Greedy match: cada client_trade_id local pode ser usado uma vez só. Caller
// passa o Set de já-usados; função retorna o melhor candidato disponível.
//
// Match por (symbol, side, ts_exit ±15min). ts_exit do local é mais próximo
// do `updatedTime` do Bybit que ts_entry de createdTime — monitor pode
// demorar pra registrar entrada após o fill, mas o close ts é capturado
// quando o evento WS chega.
function findClientTradeIdInDb(row, usedIds) {
  if (!existsSync(TRADES_DB)) return null;
  try {
    const db = new DatabaseSync(TRADES_DB, { readOnly: true });
    const tsExit = isoFromMs(row.updatedTime);
    const side = sideFromBybit(row.side);
    const tsMs = parseInt(row.updatedTime, 10);
    const before = new Date(tsMs - 900_000).toISOString().replace(/\.\d+Z$/, "Z");
    const after = new Date(tsMs + 900_000).toISOString().replace(/\.\d+Z$/, "Z");
    const rows = db.prepare(
      `SELECT client_trade_id FROM live_trades
       WHERE symbol = ? AND side = ? AND ts_exit IS NOT NULL
         AND ts_exit BETWEEN ? AND ?
       ORDER BY ABS(strftime('%s', ts_exit) - strftime('%s', ?)) ASC`
    ).all(row.symbol, side, before, after, tsExit);
    db.close();
    for (const r of rows) {
      if (!usedIds.has(r.client_trade_id)) return r.client_trade_id;
    }
    return null;
  } catch (e) {
    console.error(`WARN: db lookup failed for ${row.symbol}: ${e.message}`);
    return null;
  }
}

function mapRow(row, usedIds) {
  const closedPnl = parseFloat(row.closedPnl);
  const openFee = parseFloat(row.openFee ?? "0");
  const closeFee = parseFloat(row.closeFee ?? "0");
  const fee = openFee + closeFee;
  if (!Number.isFinite(closedPnl) || !Number.isFinite(fee)) return null;
  const side = sideFromBybit(row.side);

  let clientTradeId = null;
  let matchedInDb = false;
  if (LOOKUP_FROM_DB) {
    clientTradeId = findClientTradeIdInDb(row, usedIds);
    matchedInDb = !!clientTradeId;
    if (matchedInDb) usedIds.add(clientTradeId);
  }
  if (!clientTradeId) {
    clientTradeId = deriveClientTradeId(row);
  }

  return {
    matched_in_db: matchedInDb,
    payload: {
      client_trade_id: clientTradeId,
      ts_entry: isoFromMs(row.createdTime),
      ts_exit: isoFromMs(row.updatedTime),
      symbol: row.symbol,
      side,
      entry: parseFloat(row.avgEntryPrice ?? row.entryPrice ?? "0"),
      exit: parseFloat(row.avgExitPrice ?? row.exitPrice ?? "0"),
      qty: parseFloat(row.qty ?? row.closedSize ?? "0"),
      fee_usd: fee,
      funding_usd: null,
      pnl_net_usd: closedPnl,
      pnl_abs: closedPnl + fee,
    },
  };
}

async function postTrade(payload) {
  const r = await fetch(`${WORKER_URL}/ingest/trade`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  return { status: r.status, body: j };
}

async function main() {
  const dump = JSON.parse(readFileSync(DUMP_PATH, "utf-8"));
  const rows = dump.rows ?? dump.list ?? dump;
  if (!Array.isArray(rows)) {
    console.error("ERR: dump.rows (ou .list, ou array root) não encontrado");
    process.exit(2);
  }

  console.log(`Carregadas ${rows.length} linhas de ${DUMP_PATH}`);
  console.log(`Mode: ${REQUIRE_DB_MATCH ? "REQUIRE DB MATCH (default — só atualiza locais)" : "ALLOW GHOST CREATES (--allow-ghost-creates)"}`);
  const stats = { mapped: 0, skipped_no_match: 0, posted: 0, failed: 0, skipped_invalid: 0, total_fee: 0, total_net: 0 };

  // Greedy match: ordena por ts_exit (updatedTime) DESC pra que matches mais
  // recentes ganhem prioridade — assume que monitor é mais consistente nos
  // closes recentes que nos antigos.
  const sortedRows = [...rows].sort((a, b) => parseInt(b.updatedTime, 10) - parseInt(a.updatedTime, 10));
  const usedIds = new Set();

  for (const raw of sortedRows) {
    const result = mapRow(raw, usedIds);
    if (!result) { stats.skipped_invalid++; continue; }
    const { matched_in_db, payload } = result;

    if (REQUIRE_DB_MATCH && !matched_in_db) {
      stats.skipped_no_match++;
      continue;
    }
    stats.mapped++;
    stats.total_fee += payload.fee_usd;
    stats.total_net += payload.pnl_net_usd;

    if (DRY_RUN) {
      console.log(`DRY  ${payload.symbol.padEnd(16)} ${payload.side.padEnd(6)} ${payload.ts_entry} → fee=${payload.fee_usd.toFixed(4)} net=${payload.pnl_net_usd.toFixed(4)} cid=${payload.client_trade_id}`);
      continue;
    }

    const res = await postTrade(payload);
    if (res.status === 200 && res.body.ok) {
      stats.posted++;
      console.log(`OK   ${payload.symbol.padEnd(16)} ${payload.side.padEnd(6)} ${payload.ts_entry} fee=${payload.fee_usd.toFixed(4)} net=${payload.pnl_net_usd.toFixed(4)}`);
    } else {
      stats.failed++;
      console.error(`FAIL ${payload.symbol} ${payload.ts_entry} → status=${res.status} body=${JSON.stringify(res.body)}`);
    }
  }

  console.log("---");
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...stats }, null, 2));
  if (!DRY_RUN) {
    console.log(`Total fees acumulados: $${stats.total_fee.toFixed(4)}`);
    console.log(`Total net acumulado:   $${stats.total_net.toFixed(4)}`);
  }
}

main().catch((e) => {
  console.error("ERR:", e);
  process.exit(1);
});
