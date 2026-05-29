"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/utils";

interface OkResp {
  ok: true;
  value: number;
  classification: string;
  as_of: string;
  time_until_update_sec: number | null;
  interpretation: "contrarian_bullish" | "neutral" | "crowded_long";
  source: "alternative.me";
}

interface ErrResp {
  ok: false;
  source: "alternative.me";
  reason: string;
  as_of: string;
}

export function LiveFearGreed() {
  const [resp, setResp] = useState<OkResp | ErrResp | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/market/fear-greed", { cache: "no-store" });
        const j = (await r.json()) as OkResp | ErrResp;
        if (alive) setResp(j);
      } catch (e) {
        if (alive) {
          setResp({
            ok: false,
            source: "alternative.me",
            reason: (e as Error).message,
            as_of: new Date().toISOString(),
          });
        }
      }
    };
    tick();
    const id = setInterval(tick, 60 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fear & Greed</CardTitle>
        <CardDescription>Live · alternative.me</CardDescription>
      </CardHeader>
      <CardContent>
        {!resp ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="text-xs">Loading index...</span>
          </div>
        ) : !resp.ok ? (
          <div className="flex items-center gap-2 text-rose">
            <AlertCircle className="h-4 w-4" />
            <span className="text-xs">F&G indisponivel: {resp.reason}</span>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-3xl font-semibold tabular tracking-tight">{resp.value}</div>
                <div className="text-xs text-muted-foreground">0 fear · 100 greed</div>
              </div>
              <Badge variant={variantFor(resp.value)}>{resp.classification}</Badge>
            </div>
            <div className="h-2 overflow-hidden rounded bg-muted">
              <div className={barClass(resp.value)} style={{ width: `${Math.max(0, Math.min(100, resp.value))}%` }} />
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
              <span>{resp.interpretation.replace("_", " ")}</span>
              <span>{timeAgo(resp.as_of)}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function variantFor(value: number) {
  if (value <= 24) return "emerald";
  if (value <= 44) return "outline";
  if (value <= 54) return "muted";
  if (value <= 74) return "amber";
  return "rose";
}

function barClass(value: number) {
  const color = value <= 24 ? "bg-emerald" : value <= 44 ? "bg-primary" : value <= 54 ? "bg-muted-foreground" : value <= 74 ? "bg-amber" : "bg-rose";
  return `h-full ${color}`;
}
