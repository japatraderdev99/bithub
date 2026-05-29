-- Pre-Round-3 Gate B — net PnL accounting (fees + funding)
--
-- Round 2 overnight provou que pnl_abs (gross) sub-reporta PnL real porque
-- não desconta fees nem funding. Saldo Bybit caiu $5.75 enquanto D1 reportou
-- só -$0.29 — diferença de $5.45 é quase 100% explicada por fees ($3.38)
-- + funding + slippage de alguns stops grandes.
--
-- Solução: 3 colunas adicionais, nullable (backward-compatible — ingests
-- antigos seguem funcionando, novos enriquecem). Backfill da Round 2 vem
-- por script separado consumindo Bybit /v5/position/closed-pnl.

ALTER TABLE live_trades ADD COLUMN fee_usd REAL;
ALTER TABLE live_trades ADD COLUMN funding_usd REAL;
ALTER TABLE live_trades ADD COLUMN pnl_net_usd REAL;

-- Índice no net é útil pra ordenar/filtrar relatórios "real PnL".
CREATE INDEX IF NOT EXISTS idx_trades_pnl_net ON live_trades(pnl_net_usd);
