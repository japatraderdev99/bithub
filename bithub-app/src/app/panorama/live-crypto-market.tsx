"use client";
import { useEffect, useState } from "react";
import { AlertCircle, Loader2, Flame } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SectorsHeatmap } from "./sectors-heatmap";
import { formatCompact, formatPct, pnlClass } from "@/lib/utils";

interface CryptoGlobal {
  active_cryptocurrencies: number;
  markets: number;
  total_market_cap_usd: number;
  total_volume_usd: number;
  btc_dominance_pct: number;
  eth_dominance_pct: number;
  market_cap_change_24h_pct: number;
}

interface CryptoSector {
  sector: string;
  category_id: string;
  perf_24h_pct: number;
  volume_24h_usd: number;
  market_cap_usd: number;
  leaders: string[];
}

interface SectorHeatmapData {
  sector: string;
  perf_24h_pct: number;
  volume_24h_usd: number;
  leaders: string[];
}

interface TrendingCoin {
  id: string;
  name: string;
  symbol: string;
  rank: number | null;
  score: number;
  price_usd: number | null;
  change_24h_pct: number | null;
}

interface OkResp {
  ok: true;
  source: "coingecko";
  as_of: string;
  global: CryptoGlobal;
  sectors: CryptoSector[];
  trending: TrendingCoin[];
}

interface ErrResp {
  ok: false;
  reason: string;
  source: "coingecko";
  as_of: string;
}

interface Props {
  fallbackSectors: SectorHeatmapData[];
}

export function LiveCryptoMarket({ fallbackSectors }: Props) {
  const [resp, setResp] = useState<OkResp | ErrResp | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/coingecko/market", { cache: "no-store" });
        const j = (await r.json()) as OkResp | ErrResp;
        if (alive) setResp(j);
      } catch (e) {
        if (alive) {
          setResp({
            ok: false,
            reason: (e as Error).message,
            source: "coingecko",
            as_of: new Date().toISOString(),
          });
        }
      }
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!resp) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardContent className="p-4 flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-xs">Carregando setores CoinGecko…</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-xs">Carregando trending…</span>
          </CardContent>
        </Card>
      </div>
    );
  }

  const sectors = resp.ok ? resp.sectors : fallbackSectors;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card className="lg:col-span-2">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Sectors — crypto categories</CardTitle>
              <CardDescription>
                {resp.ok ? "Live CoinGecko · categoria por volume e variação 24h" : "Fixture fallback · CoinGecko indisponível"}
              </CardDescription>
            </div>
            <Badge variant={resp.ok ? "emerald" : "amber"}>{resp.ok ? "CoinGecko · live" : "fixture"}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <SectorsHeatmap data={sectors} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Crypto breadth</CardTitle>
              <CardDescription>{resp.ok ? "Global market + trending" : "CoinGecko fallback state"}</CardDescription>
            </div>
            <Badge variant={resp.ok ? "emerald" : "rose"}>{resp.ok ? "live" : "offline"}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!resp.ok ? (
            <div className="flex items-start gap-2 text-rose">
              <AlertCircle className="h-4 w-4 mt-0.5" />
              <span className="text-xs">{resp.reason}</span>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <MiniMetric label="MCap" value={`$${formatCompact(resp.global.total_market_cap_usd)}`} />
                <MiniMetric label="Vol 24h" value={`$${formatCompact(resp.global.total_volume_usd)}`} />
                <MiniMetric label="BTC dom" value={formatPct(resp.global.btc_dominance_pct)} />
                <MiniMetric
                  label="MCap 24h"
                  value={formatPct(resp.global.market_cap_change_24h_pct)}
                  accent={pnlClass(resp.global.market_cap_change_24h_pct)}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <Flame className="h-3 w-3" />
                  Trending
                </div>
                {resp.trending.slice(0, 5).map((coin) => (
                  <div key={coin.id} className="flex items-center gap-2 text-xs">
                    <span className="mono font-medium w-14">{coin.symbol}</span>
                    <span className="truncate text-muted-foreground">{coin.name}</span>
                    <span className={`ml-auto tabular ${pnlClass(coin.change_24h_pct ?? 0)}`}>
                      {coin.change_24h_pct != null ? formatPct(coin.change_24h_pct) : "n/a"}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MiniMetric({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-md border border-border bg-secondary/20 p-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 text-sm font-semibold tabular ${accent ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}
