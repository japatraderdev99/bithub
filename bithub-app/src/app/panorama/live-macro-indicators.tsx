"use client";
import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkline } from "@/components/sparkline";
import { formatCompact, formatPct, formatPrice, pnlClass } from "@/lib/utils";

interface MacroIndicator {
  id: string;
  label: string;
  value: number;
  previous: number | null;
  change: number | null;
  unit: "pct" | "index" | "usd_m" | "usd_b" | "spread";
  date: string;
  sparkline: number[];
  interpretation: "risk_on" | "risk_off" | "neutral";
}

interface MacroRegime {
  regime: "risk_on" | "neutral" | "risk_off";
  risk_score: number;
  confidence: "low" | "medium" | "high";
  as_of: string;
  drivers: string[];
  blockers: string[];
}

interface OkResp {
  ok: true;
  source: "fred";
  as_of: string;
  regime: MacroRegime;
  indicators: MacroIndicator[];
}

interface ErrResp {
  ok: false;
  source: "fred";
  reason: string;
  as_of: string;
}

interface FallbackIndex {
  name: string;
  value: number;
  change_pct: number;
  sparkline: number[];
}

export function LiveMacroIndicators({ fallback }: { fallback: FallbackIndex[] }) {
  const [resp, setResp] = useState<OkResp | ErrResp | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/fred/macro", { cache: "no-store" });
        const j = (await r.json()) as OkResp | ErrResp;
        if (alive) setResp(j);
      } catch (e) {
        if (alive) {
          setResp({
            ok: false,
            source: "fred",
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

  if (!resp) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 10 }, (_, i) => (
          <Card key={i}>
            <CardContent className="p-3 flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="text-xs">FRED…</span>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!resp.ok) {
    return (
      <div className="space-y-3">
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-rose">
            <AlertCircle className="h-4 w-4" />
            <span className="text-xs">FRED indisponível: {resp.reason}. Exibindo fixture.</span>
          </CardContent>
        </Card>
        <FallbackGrid data={fallback} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">Macro regime</span>
              <Badge variant={regimeVariant(resp.regime.regime)}>{resp.regime.regime.replace("_", " ")}</Badge>
              <Badge variant="outline">score {resp.regime.risk_score}</Badge>
              <Badge variant="muted">{resp.regime.confidence}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Drivers: {(resp.regime.drivers.length > 0 ? resp.regime.drivers : ["sem driver dominante"]).join(" · ")}
            </p>
          </div>
          <span className="text-[10px] text-muted-foreground">FRED as_of {resp.regime.as_of}</span>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-10 gap-3">
        {resp.indicators.map((idx) => {
          const positive = idx.interpretation === "risk_on";
          const negative = idx.interpretation === "risk_off";
          return (
            <Card key={idx.id}>
              <CardContent className="p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{idx.label}</span>
                  <Badge variant={positive ? "emerald" : negative ? "rose" : "muted"}>{idx.interpretation.replace("_", " ")}</Badge>
                </div>
                <div className="text-base font-semibold tabular">{formatMacroValue(idx)}</div>
                <div className={negative ? "text-rose" : positive ? "text-emerald" : "text-muted-foreground"}>
                  <Sparkline data={idx.sparkline} positive={!negative} />
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>{idx.date}</span>
                  <span className="tabular">{idx.change != null ? signedChange(idx.change, idx.unit) : "n/a"}</span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function FallbackGrid({ data }: { data: FallbackIndex[] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {data.map((idx) => (
        <Card key={idx.name}>
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{idx.name}</span>
              <Badge variant={idx.change_pct >= 0 ? "emerald" : "rose"}>{formatPct(idx.change_pct)}</Badge>
            </div>
            <div className="text-base font-semibold tabular">{formatPrice(idx.value)}</div>
            <div className={pnlClass(idx.change_pct)}>
              <Sparkline data={idx.sparkline} positive={idx.change_pct >= 0} />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function formatMacroValue(idx: MacroIndicator): string {
  if (idx.unit === "pct" || idx.unit === "spread") return `${idx.value.toFixed(2)}%`;
  if (idx.unit === "usd_m") return `$${formatCompact(idx.value * 1_000_000)}`;
  if (idx.unit === "usd_b") return `$${formatCompact(idx.value * 1_000_000_000)}`;
  return idx.value.toFixed(2);
}

function signedChange(change: number, unit: MacroIndicator["unit"]): string {
  const sign = change > 0 ? "+" : "";
  if (unit === "pct" || unit === "spread") return `${sign}${change.toFixed(2)}pp`;
  return `${sign}${change.toFixed(2)}`;
}

function regimeVariant(regime: MacroRegime["regime"]) {
  if (regime === "risk_on") return "emerald";
  if (regime === "risk_off") return "rose";
  return "muted";
}
