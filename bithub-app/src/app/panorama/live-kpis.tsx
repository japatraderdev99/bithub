"use client";
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowUpRight, ArrowDownRight, Minus, Loader2, AlertCircle } from "lucide-react";
import { formatPct, formatPrice, pnlClass } from "@/lib/utils";

interface Ticker {
  symbol: string;
  lastPrice: string;
  price24hPcnt: string;
  highPrice24h: string;
  lowPrice24h: string;
  volume24h: string;
  fundingRate: string;
  nextFundingTime: string;
  openInterest: string;
}

interface OkResp {
  ok: true;
  tickers: Ticker[];
  as_of: string;
}
interface ErrResp {
  ok: false;
  reason: string;
  as_of: string;
}

const KPI_LABELS: Record<string, { label: string; precision: number }> = {
  BTCUSDT: { label: "BTC", precision: 2 },
  ETHUSDT: { label: "ETH", precision: 2 },
  SOLUSDT: { label: "SOL", precision: 2 },
  XRPUSDT: { label: "XRP", precision: 4 },
  DOGEUSDT: { label: "DOGE", precision: 4 },
  WIFUSDT: { label: "WIF", precision: 3 },
  PEPEUSDT: { label: "PEPE", precision: 8 },
};

export function LiveKPIs({ defaultSymbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"] as string[] }) {
  const [resp, setResp] = useState<OkResp | ErrResp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/bybit/tickers?symbols=${defaultSymbols.join(",")}`, { cache: "no-store" });
        const j = (await r.json()) as OkResp | ErrResp;
        if (alive) {
          setResp(j);
          setLoading(false);
        }
      } catch (e) {
        if (alive) {
          setResp({ ok: false, reason: (e as Error).message, as_of: new Date().toISOString() });
          setLoading(false);
        }
      }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [defaultSymbols]);

  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {defaultSymbols.map((s) => (
          <Card key={s}><CardContent className="p-4 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /><span className="text-xs">Loading {s}…</span></CardContent></Card>
        ))}
      </div>
    );
  }

  if (!resp?.ok) {
    return (
      <Card>
        <CardContent className="p-4 flex items-center gap-2 text-rose">
          <AlertCircle className="h-4 w-4" />
          <span className="text-xs">Bybit pública indisponível: {resp?.reason ?? "no response"}</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {resp.tickers.map((t) => {
        const change_pct = parseFloat(t.price24hPcnt) * 100;
        const last = parseFloat(t.lastPrice);
        const meta = KPI_LABELS[t.symbol] ?? { label: t.symbol, precision: 2 };
        const positive = change_pct > 0;
        const Icon = positive ? ArrowUpRight : change_pct < 0 ? ArrowDownRight : Minus;
        return (
          <Card key={t.symbol}>
            <CardContent className="p-4 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{meta.label}</span>
                <Badge variant="outline">Bybit · live</Badge>
              </div>
              <div className="text-xl font-semibold tabular tracking-tight">
                {meta.precision <= 4 ? formatPrice(last) : last.toFixed(meta.precision)}
              </div>
              <div className={`flex items-center gap-1 text-xs ${pnlClass(change_pct)}`}>
                <Icon className="h-3 w-3" />
                <span className="tabular">{formatPct(change_pct)}</span>
                <span className="ml-auto text-[10px] mono text-muted-foreground">
                  fund {(parseFloat(t.fundingRate) * 100).toFixed(4)}%
                </span>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
