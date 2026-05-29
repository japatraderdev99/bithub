"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatPct, formatPrice, timeAgo } from "@/lib/utils";

type Group = "us_futures" | "asia" | "rates" | "fx_commodities";

interface CrossAssetQuote {
  symbol: string;
  label: string;
  group: Group;
  value: number;
  previous: number | null;
  change_abs: number | null;
  change_pct: number | null;
  as_of: string;
  source: "yahoo";
  interpretation: "risk_on" | "risk_off" | "neutral";
}

interface OkResp {
  ok: true;
  source: "yahoo";
  as_of: string;
  quotes: CrossAssetQuote[];
  breadth: {
    risk_on_count: number;
    risk_off_count: number;
    neutral_count: number;
    dominant: "risk_on" | "risk_off" | "mixed";
  };
}

interface ErrResp {
  ok: false;
  source: "yahoo";
  reason: string;
  as_of: string;
  quotes: [];
}

const GROUP_LABELS: Record<Group, string> = {
  us_futures: "US futures",
  asia: "Asia",
  rates: "Market rates",
  fx_commodities: "FX / commodities",
};

export function LiveCrossAsset() {
  const [resp, setResp] = useState<OkResp | ErrResp | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/market/cross-asset", { cache: "no-store" });
        const j = (await r.json()) as OkResp | ErrResp;
        if (alive) setResp(j);
      } catch (e) {
        if (alive) {
          setResp({
            ok: false,
            source: "yahoo",
            reason: (e as Error).message,
            as_of: new Date().toISOString(),
            quotes: [],
          });
        }
      }
    };
    tick();
    const id = setInterval(tick, 60 * 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const groups = useMemo(() => {
    if (!resp?.ok) return new Map<Group, CrossAssetQuote[]>();
    const out = new Map<Group, CrossAssetQuote[]>();
    for (const q of resp.quotes) {
      const list = out.get(q.group) ?? [];
      list.push(q);
      out.set(q.group, list);
    }
    return out;
  }, [resp]);

  if (!resp) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i}>
            <CardContent className="p-3 flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="text-xs">Cross-asset...</span>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!resp.ok) {
    return (
      <Card>
        <CardContent className="p-3 flex items-center gap-2 text-rose">
          <AlertCircle className="h-4 w-4" />
          <span className="text-xs">Yahoo indisponivel: {resp.reason}</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>Yahoo · {timeAgo(resp.as_of)}</span>
        <Badge variant={dominantVariant(resp.breadth.dominant)}>{resp.breadth.dominant.replace("_", " ")}</Badge>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {([...groups.entries()] as Array<[Group, CrossAssetQuote[]]>).map(([group, quotes]) => (
          <Card key={group}>
            <CardContent className="p-3 space-y-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{GROUP_LABELS[group]}</div>
              <div className="space-y-2">
                {quotes.map((q) => (
                  <div key={q.symbol} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground">{q.label}</div>
                      <div className="text-[10px] text-muted-foreground">{q.symbol}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs tabular text-foreground">{formatQuoteValue(q)}</div>
                      <div className={deltaClass(q.interpretation)}>
                        {q.change_pct == null ? "n/a" : formatPct(q.change_pct)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function formatQuoteValue(q: CrossAssetQuote): string {
  if (q.group === "rates") return `${q.value.toFixed(2)}%`;
  if (q.symbol === "DX-Y.NYB") return q.value.toFixed(2);
  return formatPrice(q.value);
}

function deltaClass(interpretation: CrossAssetQuote["interpretation"]) {
  if (interpretation === "risk_on") return "text-[10px] tabular text-emerald";
  if (interpretation === "risk_off") return "text-[10px] tabular text-rose";
  return "text-[10px] tabular text-muted-foreground";
}

function dominantVariant(dominant: OkResp["breadth"]["dominant"]) {
  if (dominant === "risk_on") return "emerald";
  if (dominant === "risk_off") return "rose";
  return "muted";
}
