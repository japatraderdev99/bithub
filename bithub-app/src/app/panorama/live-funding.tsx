"use client";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { formatPct, pnlClass } from "@/lib/utils";

interface Ticker {
  symbol: string;
  fundingRate: string;
  nextFundingTime: string;
}

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "WIFUSDT", "PEPEUSDT"];

export function LiveFundingRates() {
  const [tickers, setTickers] = useState<Ticker[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/bybit/tickers?symbols=${SYMBOLS.join(",")}`, { cache: "no-store" });
        const j = await r.json();
        if (alive) {
          if (j.ok) setTickers(j.tickers);
          else setError(j.reason);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return <div className="px-4 py-3 text-xs text-rose">Bybit pública indisponível: {error}</div>;
  }
  if (!tickers) {
    return <div className="px-4 py-3 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</div>;
  }

  return (
    <>
      <div className="px-4 grid grid-cols-3 gap-2 text-[10px] uppercase tracking-wider text-muted-foreground pb-2 border-b border-border">
        <span>Symbol</span>
        <span className="text-right">Rate 8h</span>
        <span className="text-right">Next</span>
      </div>
      {tickers.map((t) => {
        const rate = parseFloat(t.fundingRate) * 100;
        const next_ms = parseInt(t.nextFundingTime, 10);
        const next_str = new Date(next_ms).toLocaleTimeString();
        return (
          <div key={t.symbol} className="px-4 grid grid-cols-3 gap-2 py-1.5 text-xs border-b border-border/30 last:border-b-0">
            <span className="mono">{t.symbol}</span>
            <span className={`text-right tabular mono ${pnlClass(rate)}`}>{formatPct(rate, 4)}</span>
            <span className="text-right tabular text-muted-foreground">{next_str}</span>
          </div>
        );
      })}
    </>
  );
}
