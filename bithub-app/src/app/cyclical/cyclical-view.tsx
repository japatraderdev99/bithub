"use client";
import { useEffect, useState } from "react";
import { Activity, Clock, Check, AlertTriangle, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { PublisherStatus } from "@/components/publisher-status";
import { usePositions } from "@/hooks/use-monitor";
import { formatPct, formatPrice, pnlClass, timeAgo } from "@/lib/utils";
import cyclical from "@/data/cyclical-mock.json";
import type { OpenPosition } from "@/types/monitor";

type Analysis = typeof cyclical.last_analyses[number];

export function CyclicalView() {
  const { response, loading } = usePositions(3000);
  const [countdown, setCountdown] = useState(cyclical.cycle_config.next_analysis_in_sec);
  const [appliedIds, setAppliedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    const id = setInterval(() => {
      setCountdown((c) => (c <= 1 ? cyclical.cycle_config.interval_min * 60 : c - 1));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const ok = response?.ok === true;
  const positions: OpenPosition[] = ok && response ? response.data.positions : [];
  const session = positions[0] ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Sessão acompanhada</CardTitle>
            <PublisherStatus ok={ok} reason={ok ? undefined : response?.reason} ageMs={ok ? response.age_ms : undefined} loading={loading} />
          </div>
          <CardDescription>
            {session
              ? `Auto-selecionada: ${session.symbol} (primeira posição aberta). Em release futura, operador escolhe.`
              : ok
              ? "Nenhuma posição aberta — sem ciclo ativo. IA pausada."
              : "Aguardando publisher local."}
          </CardDescription>
        </CardHeader>
      </Card>

      {session && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <SessionCard session={session} />
          <div className="lg:col-span-2 space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-amber" />
                    <CardTitle className="text-sm">Cycle pulse</CardTitle>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    <span className="mono tabular">{countdown}s</span>
                    <span className="text-muted-foreground">até próxima análise (mock)</span>
                  </div>
                </div>
                <CardDescription>
                  Haiku 4.5 ainda não plugada — análises abaixo são da fixture · Budget restante hoje: ${cyclical.budget_remaining_today_usd.toFixed(2)}
                </CardDescription>
              </CardHeader>
            </Card>

            {cyclical.last_analyses.map((a, i) => (
              <AnalysisCard
                key={a.ts}
                analysis={a}
                isLatest={i === 0}
                applied={appliedIds.has(i)}
                onApply={() => setAppliedIds((s) => new Set(s).add(i))}
              />
            ))}
          </div>
        </div>
      )}

      {!session && ok && (
        <Card>
          <CardContent className="p-8 text-center text-xs text-muted-foreground">
            Quando o monitor abrir uma posição, o ciclo de análise começa automaticamente.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SessionCard({ session }: { session: OpenPosition }) {
  return (
    <Card className="lg:col-span-1">
      <CardHeader>
        <CardTitle>{session.symbol}</CardTitle>
        <CardDescription>{session.side} · momentum {session.momentum_state}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge variant="emerald">running</Badge>
          <Badge variant="outline">{session.leverage}x</Badge>
          <span className="text-[10px] mono text-muted-foreground ml-auto">opened {timeAgo(session.opened_at)}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Entry" value={formatPrice(session.entry)} mono />
          <Metric label="Now" value={formatPrice(session.current_price)} mono />
          <Metric label="SL" value={formatPrice(session.sl)} mono tone="text-rose" />
          <Metric label="TP" value={formatPrice(session.tp)} mono tone="text-emerald" />
        </div>
        <Separator />
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Unrealized P&L</span>
            <span className={`text-base font-semibold tabular ${pnlClass(session.pnl_pct)}`}>{formatPct(session.pnl_pct)}</span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">Best P&L</span>
            <span className={`mono tabular ${pnlClass(session.best_pnl_pct)}`}>{formatPct(session.best_pnl_pct)}</span>
          </div>
        </div>
        <Separator />
        <div className="space-y-1">
          <Row label="Size" value={`$${session.size_usd.toFixed(2)} USDT`} />
          <Row label="Tape flow" value={`${session.tape_flow_pct}% · ${session.tape_delta_trend.toLowerCase()}`} />
          <Row label="Tape bias" value={session.tape_bias.toString()} />
        </div>
        <div className="flex flex-wrap gap-1">
          {session.partial_done && <Badge variant="muted">partial done</Badge>}
          {session.tp_extended && <Badge variant="amber">tp extended</Badge>}
          {session.be_set && <Badge variant="emerald">BE set</Badge>}
        </div>
      </CardContent>
    </Card>
  );
}

function AnalysisCard({ analysis, isLatest, applied, onApply }: { analysis: Analysis; isLatest: boolean; applied: boolean; onApply: () => void }) {
  const verdictColor =
    analysis.verdict === "hold" ? "muted" :
    analysis.verdict === "trail" ? "amber" :
    analysis.verdict === "monitor" ? "outline" : "rose";

  return (
    <Card className={isLatest ? "border-amber/40" : ""}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Badge variant={verdictColor as "muted" | "amber" | "outline" | "rose"}>{analysis.verdict}</Badge>
            {isLatest && <Badge variant="emerald">latest</Badge>}
            <span className="text-[10px] text-muted-foreground">{timeAgo(analysis.ts)}</span>
          </div>
          <span className="text-[10px] mono text-muted-foreground">
            conf {(analysis.confidence * 100).toFixed(0)}% · ${analysis.cost_usd.toFixed(3)}
          </span>
        </div>

        <p className="text-xs leading-relaxed text-foreground/90">{analysis.rationale}</p>

        {analysis.suggested_adjustments.length > 0 && (
          <div className="rounded-md border border-amber/40 bg-amber/5 p-2.5 space-y-2">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-amber">
              <AlertTriangle className="h-3 w-3" />
              Suggested adjustments
            </div>
            {analysis.suggested_adjustments.map((adj, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="mono text-muted-foreground">{adj.field}</span>
                <span className="mono tabular">{adj.from}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="mono tabular text-foreground font-medium">{adj.to}</span>
                <span className="text-muted-foreground">({adj.reason})</span>
              </div>
            ))}
            <div className="flex items-center justify-between pt-1">
              <p className="text-[10px] text-muted-foreground">Apply é manual. IA nunca move ordem sem clique.</p>
              {applied ? (
                <Badge variant="emerald" className="gap-1"><Check className="h-2.5 w-2.5" />Applied</Badge>
              ) : (
                <Button size="sm" variant="outline" onClick={onApply}>Apply manually</Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: string }) {
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-xs font-semibold ${tone ?? "text-foreground"} ${mono ? "mono tabular" : ""}`}>{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="mono tabular text-foreground">{value}</span>
    </div>
  );
}
