"use client";
import { AlertTriangle, Activity, ShieldOff, TrendingDown, TrendingUp, Zap, Flame, Snowflake } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PublisherStatus } from "@/components/publisher-status";
import { useContext, useSystem } from "@/hooks/use-monitor";
import { useDailyStats } from "@/hooks/use-trades";
import { DailyEquitySpark } from "./daily-equity-spark";
import { formatPct, formatPrice, pnlClass, timeAgo } from "@/lib/utils";
import type { ContextAsset } from "@/types/monitor";

export function MacroBar() {
  const ctxResp = useContext(5000);
  const sysResp = useSystem(3000);
  const { stats: daily } = useDailyStats(30000);

  const ctxResponse = ctxResp.response;
  const sysResponse = sysResp.response;
  const ctx = ctxResponse && ctxResponse.ok ? ctxResponse.data : null;
  const sysOk = sysResponse?.ok === true;
  const sys = sysResponse && sysResponse.ok ? sysResponse.data : null;
  const sysAge = sysResponse && sysResponse.ok ? sysResponse.age_ms : undefined;

  const dailyPnL = daily?.overall?.total_pnl_abs ?? 0;
  const dailyTrades = daily?.overall?.total_trades ?? 0;
  const dailyWins = daily?.overall?.winners ?? 0;
  const dailyLosses = daily?.overall?.losers ?? 0;
  const winRate = dailyTrades > 0 ? (dailyWins / dailyTrades) * 100 : null;

  return (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      {/* Line 1: BTC */}
      <AssetRow label="BTC" asset={ctx?.btc} />
      {/* Line 2: ETH */}
      <AssetRow label="ETH" asset={ctx?.eth} />
      {/* Line 3: System + daily PnL */}
      <div className="grid grid-cols-[1fr_auto] gap-3 px-3 py-1.5 text-[11px] border-t border-border/40 items-center">
        <div className="flex items-center gap-3 flex-wrap">
          {sys && (
            <>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Saldo</span>
              <span className="mono tabular font-semibold text-foreground text-sm">${sys.balance_usdt.toFixed(2)}</span>
              <span className="text-[10px] text-muted-foreground">free <span className="mono tabular text-foreground">${sys.free_usdt.toFixed(2)}</span></span>
              <span className="text-[10px] text-muted-foreground">slots <span className="mono tabular text-foreground">{sys.open_slots}/{sys.max_slots}</span></span>
              <Separator />
            </>
          )}
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">24h</span>
          <span className={`mono tabular font-semibold text-sm ${pnlClass(dailyPnL)}`}>
            {dailyPnL >= 0 ? "+" : ""}${dailyPnL.toFixed(2)}
          </span>
          <DailyEquitySpark />
          <span className="text-muted-foreground tabular">
            {dailyTrades} trade{dailyTrades !== 1 ? "s" : ""}
          </span>
          {winRate != null && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className={`tabular ${winRate >= 50 ? "text-emerald" : "text-rose"}`}>
                {winRate.toFixed(0)}% wr ({dailyWins}W/{dailyLosses}L)
              </span>
            </>
          )}
          <Separator />
          {ctx?.last_t1_scan_ts && (
            <>
              <span className="text-muted-foreground">T1</span>
              <span className="mono tabular text-foreground">{timeAgo(ctx.last_t1_scan_ts)}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {ctx?.macro_block === "LONG_BLOCKED" && (
            <Badge variant="rose" className="gap-1 text-[10px]">
              <ShieldOff className="h-2.5 w-2.5" />
              LONG BLOCKED
            </Badge>
          )}
          {ctx?.macro_block === "SHORT_BLOCKED" && (
            <Badge variant="rose" className="gap-1 text-[10px]">
              <ShieldOff className="h-2.5 w-2.5" />
              SHORT BLOCKED
            </Badge>
          )}
          {ctx?.capitulation_mode && (
            <Badge variant="amber" className="gap-1 text-[10px]">
              <Zap className="h-2.5 w-2.5" />
              CAPITULATION
            </Badge>
          )}
          <PublisherStatus
            ok={sysOk}
            ageMs={sysAge}
            reason={sysResponse && !sysResponse.ok ? sysResponse.reason : undefined}
            loading={sysResp.loading}
          />
        </div>
      </div>
    </div>
  );
}

function AssetRow({ label, asset }: { label: string; asset: ContextAsset | null | undefined }) {
  if (!asset) {
    return (
      <div className="grid grid-cols-[24px_1fr] gap-3 px-3 py-1 text-[11px] items-center border-b border-border/40 last:border-b-0">
        <span className="font-semibold text-foreground tabular">{label}</span>
        <span className="text-muted-foreground">aguardando publisher (precisa restart do monitor para context.json)</span>
      </div>
    );
  }
  const bullish = asset.bias.includes("BULL") || asset.bias.includes("bull");
  const Icon = bullish ? TrendingUp : TrendingDown;
  const TempIcon = asset.rsi5 < 25 ? Snowflake : asset.rsi5 > 75 ? Flame : null;
  return (
    <div className="grid grid-cols-[24px_auto_auto_auto_1fr_auto] gap-2 md:gap-3 px-3 py-1 text-[11px] items-center border-b border-border/40 last:border-b-0">
      <span className="font-semibold text-foreground tabular">{label}</span>
      <span className="mono tabular text-foreground font-medium">{formatPrice(asset.price)}</span>
      <span className="flex items-center gap-1">
        <Icon className={`h-2.5 w-2.5 ${bullish ? "text-emerald" : "text-rose"}`} />
        <span className={`text-[10px] tabular mono ${bullish ? "text-emerald" : "text-rose"}`}>{asset.tf_class}</span>
      </span>
      <span className="text-muted-foreground tabular text-[10px]">
        RSI <span className="text-foreground/90">{asset.rsi5.toFixed(0)}</span>
        {TempIcon && <TempIcon className="inline h-2.5 w-2.5 ml-0.5 text-amber" />}
      </span>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground tabular">
        <span>ADX <span className="text-foreground/90 tabular">{asset.adx.toFixed(0)}</span></span>
        <span>ATR <span className="text-foreground/90 tabular">{asset.atr_pct.toFixed(2)}%</span></span>
        <span>Vol <span className="text-foreground/90 tabular">{asset.vol_x.toFixed(1)}x</span></span>
        <span>EMA <span className={`tabular ${asset.ema_spread_pct >= 0 ? "text-emerald/80" : "text-rose/80"}`}>{asset.ema_spread_pct >= 0 ? "+" : ""}{asset.ema_spread_pct.toFixed(2)}%</span></span>
        {asset.funding_rate != null && (
          <span>Fund <span className={`tabular mono ${pnlClass(asset.funding_rate)}`}>{formatPct(asset.funding_rate * 100, 4)}</span></span>
        )}
      </div>
      <div className="flex items-center gap-1">
        {asset.rsi5 < 25 && <Badge variant="amber" className="text-[9px]">oversold</Badge>}
        {asset.rsi5 > 75 && <Badge variant="amber" className="text-[9px]">overbought</Badge>}
      </div>
    </div>
  );
}

function Separator() {
  return <span className="text-border">·</span>;
}

// referenced to silence unused-icon lint
void AlertTriangle; void Activity;
