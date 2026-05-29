"use client";
import { Activity, AlertTriangle, Anchor, Target, TrendingDown, TrendingUp, ScrollText } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { usePositions, useCandidates } from "@/hooks/use-monitor";
import { useCockpitHighlight } from "./cockpit-context";
import { DecisionTrail } from "@/components/decision-trail";
import { formatPct, formatPrice, pnlClass, timeAgo } from "@/lib/utils";
import type { OpenPosition, Candidate } from "@/types/monitor";

export function ActivePositions() {
  const { response, loading } = usePositions(2500);
  const candResp = useCandidates(5000);
  const ok = response?.ok === true;
  const data = ok && response ? response.data : null;
  const positions = data?.positions ?? [];
  const maxSlots = data?.max_slots ?? 3;
  const emptySlots = Math.max(0, maxSlots - positions.length);

  // Próximos candidatos quase entrando (passing OR top score)
  const candidates: Candidate[] =
    candResp.response?.ok === true ? candResp.response.data.candidates : [];
  const nextCandidates = candidates
    .filter((c) => !positions.some((p) => p.symbol === c.symbol))
    .slice(0, emptySlots);

  if (loading) {
    return <Card><CardContent className="p-4 text-xs text-muted-foreground">Carregando posições…</CardContent></Card>;
  }

  if (!ok) {
    return (
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground">
          Publisher offline. Sem dados de posições.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-2">
        <Activity className="h-3 w-3" />
        Posições · {positions.length}/{maxSlots}
      </div>
      <div className={`grid gap-3 ${positions.length >= 2 ? "grid-cols-1 xl:grid-cols-2" : "grid-cols-1"}`}>
        {positions.map((p) => <PositionCard key={p.symbol} p={p} />)}
        {Array.from({ length: emptySlots }, (_, i) => (
          <EmptySlot key={`empty-${i}`} candidate={nextCandidates[i]} slotNum={positions.length + i + 1} />
        ))}
      </div>
    </div>
  );
}

function EmptySlot({ candidate, slotNum }: { candidate: Candidate | undefined; slotNum: number }) {
  if (!candidate) {
    return (
      <Card className="border-dashed border-border/40">
        <CardContent className="p-4 text-center text-xs text-muted-foreground space-y-1">
          <Activity className="h-4 w-4 mx-auto opacity-40" />
          <p>Slot {slotNum} livre</p>
          <p className="text-[10px]">Nenhum candidato no funil agora</p>
        </CardContent>
      </Card>
    );
  }
  const gap = Math.max(0, 60 - candidate.score);
  return (
    <Card className="border-dashed border-border/40">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Slot {slotNum} livre</div>
          <span className="text-[10px] text-muted-foreground">próximo candidato</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={candidate.direction === "long" ? "emerald" : "rose"} className="text-[9px]">
            {candidate.direction}
          </Badge>
          <span className="text-xs mono font-semibold">{candidate.symbol}</span>
          <span className="text-[10px] mono tabular text-muted-foreground ml-auto">{candidate.score}/100</span>
        </div>
        <div className="h-1 w-full rounded-full bg-secondary overflow-hidden">
          <div
            className={`h-full ${candidate.score >= 60 ? "bg-emerald" : candidate.score >= 40 ? "bg-amber" : "bg-rose"}`}
            style={{ width: `${Math.min(candidate.score, 100)}%` }}
          />
        </div>
        {gap > 0 ? (
          <p className="text-[10px] text-muted-foreground">
            Faltam <span className="text-foreground tabular">{gap} pts</span> pra threshold de entrada (60)
          </p>
        ) : (
          <p className="text-[10px] text-emerald">Acima do threshold — aguardando tape gate</p>
        )}
      </CardContent>
    </Card>
  );
}

function PositionCard({ p }: { p: OpenPosition }) {
  const { highlightedSymbol, setHighlighted } = useCockpitHighlight();
  // Derived metrics
  const sgn = p.side === "long" ? 1 : -1;
  const distSL = ((sgn * (p.current_price - p.sl)) / p.current_price) * 100;
  const distTP = ((sgn * (p.tp - p.current_price)) / p.current_price) * 100;
  const closenessToSL = distSL > 0 ? Math.min(distSL, 5) / 5 : 0; // 0..1 (1 = bem longe)
  const sideIcon = p.side === "long" ? TrendingUp : TrendingDown;
  const SideIcon = sideIcon;

  // Next event predictor (simplified — production version pulls thresholds from strategy)
  const nextEvent = nextEventPrediction(p);

  const isHi = highlightedSymbol === p.symbol;

  return (
    <Card
      onMouseEnter={() => setHighlighted(p.symbol)}
      onMouseLeave={() => setHighlighted(null)}
      className={`transition-all cursor-pointer ${
        isHi
          ? "ring-2 ring-amber"
          : p.pnl_pct > 0
          ? "border-emerald/30"
          : p.pnl_pct < 0
          ? "border-rose/30"
          : ""
      }`}
    >
      <CardContent className="p-4 space-y-3">
        {/* Header — symbol, side, leverage, size, PnL */}
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <SideIcon className={`h-3.5 w-3.5 ${p.side === "long" ? "text-emerald" : "text-rose"}`} />
              <span className="text-sm font-semibold mono">{p.symbol}</span>
              <Badge variant={p.side === "long" ? "emerald" : "rose"}>{p.side}</Badge>
              <span className="text-[10px] mono text-muted-foreground">{p.leverage}x</span>
              <span className="text-[10px] mono text-muted-foreground">${p.size_usd.toFixed(2)}</span>
            </div>
            <p className="text-[10px] text-muted-foreground">opened {timeAgo(p.opened_at)} · qty {p.qty}</p>
          </div>
          <div className="text-right">
            <p className={`text-xl font-semibold tabular leading-none ${pnlClass(p.pnl_pct)}`}>
              {formatPct(p.pnl_pct)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5 tabular">
              best {formatPct(p.best_pnl_pct)}
            </p>
          </div>
        </div>

        {/* Price ladder visualization — entry / SL / TP / current */}
        <div className="rounded-md border border-border bg-secondary/30 p-2.5 space-y-2">
          <div className="grid grid-cols-3 gap-2 text-[10px]">
            <PriceCell label="Entry" value={p.entry} muted />
            <PriceCell label="Now" value={p.current_price} accent={pnlClass(p.pnl_pct)} />
            <PriceCell label={p.side === "long" ? "SL ↓" : "SL ↑"} value={p.sl} accent="text-rose/70" />
          </div>
          <div className="space-y-1">
            <DistanceBar label="Distance to SL" pct={distSL} closeness={closenessToSL} variant="rose" />
            <DistanceBar label="Distance to TP" pct={distTP} closeness={1 - Math.min(Math.abs(distTP), 5) / 5} variant="emerald" />
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">TP {formatPrice(p.tp)}</span>
            {p.tp_extended && <Badge variant="amber">TP extended</Badge>}
          </div>
        </div>

        {/* Momentum + Tape pulse */}
        <div className="grid grid-cols-2 gap-2">
          <MomentumChip state={p.momentum_state} />
          <TapeChip bias={p.tape_bias} flow={p.tape_flow_pct} trend={p.tape_delta_trend} />
        </div>

        {/* Trail anchor + flags */}
        <div className="flex items-center gap-2 flex-wrap text-[10px]">
          <span className="text-muted-foreground flex items-center gap-1">
            <Anchor className="h-2.5 w-2.5" />
            trail: <span className="text-foreground mono">EMA{p.momentum_state === "STRONG" ? "21" : "9"}</span>
          </span>
          {p.partial_done && <Badge variant="muted">partial done</Badge>}
          {p.be_set && <Badge variant="emerald">BE set</Badge>}
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-[10px] gap-1">
                <ScrollText className="h-2.5 w-2.5" />
                Decision trail
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Decision trail — {p.symbol}</SheetTitle>
                <SheetDescription>
                  Lifecycle events desde a abertura · ancorado em symbol + opened_at
                </SheetDescription>
              </SheetHeader>
              <div className="mt-4">
                <DecisionTrail symbol={p.symbol} since={p.opened_at} />
              </div>
            </SheetContent>
          </Sheet>
        </div>

        {/* Next event predictor */}
        {nextEvent && (
          <div className="rounded-md border border-amber/30 bg-amber/5 p-2 flex items-start gap-2">
            <Target className="h-3 w-3 text-amber mt-0.5 shrink-0" />
            <div className="text-[10px]">
              <p className="text-amber font-medium">Próximo evento provável</p>
              <p className="text-muted-foreground mt-0.5">{nextEvent}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PriceCell({ label, value, accent, muted }: { label: string; value: number; accent?: string; muted?: boolean }) {
  return (
    <div>
      <p className={`uppercase tracking-wider text-[9px] ${muted ? "text-muted-foreground/70" : "text-muted-foreground"}`}>{label}</p>
      <p className={`mt-0.5 text-xs font-semibold tabular mono ${accent ?? "text-foreground"}`}>{formatPrice(value)}</p>
    </div>
  );
}

function DistanceBar({ label, pct, closeness, variant }: { label: string; pct: number; closeness: number; variant: "rose" | "emerald" }) {
  const safe = Math.max(0, Math.min(1, closeness));
  return (
    <div>
      <div className="flex items-center justify-between text-[9px] mb-0.5">
        <span className="text-muted-foreground">{label}</span>
        <span className={`tabular mono ${pct > 0 ? `text-${variant}` : "text-muted-foreground"}`}>{pct.toFixed(2)}%</span>
      </div>
      <div className="h-0.5 w-full rounded-full bg-secondary overflow-hidden">
        <div
          className={`h-full ${variant === "rose" ? "bg-rose" : "bg-emerald"}`}
          style={{ width: `${safe * 100}%` }}
        />
      </div>
    </div>
  );
}

function MomentumChip({ state }: { state: OpenPosition["momentum_state"] }) {
  const color = state === "STRONG" ? "emerald" : state === "NORMAL" ? "outline" : state === "WANING" ? "amber" : "rose";
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-2">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Momentum</p>
      <div className="mt-0.5 flex items-center gap-1.5">
        <Badge variant={color as "emerald" | "outline" | "amber" | "rose"} className="text-[9px]">{state}</Badge>
      </div>
    </div>
  );
}

function TapeChip({ bias, flow, trend }: { bias: number; flow: number; trend: string }) {
  const biasColor = bias >= 1 ? "emerald" : bias <= -1 ? "rose" : "muted";
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-2">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Tape</p>
      <div className="mt-0.5 flex items-center gap-1.5">
        <Badge variant={biasColor as "emerald" | "rose" | "muted"} className="text-[9px]">
          bias {bias > 0 ? `+${bias}` : bias}
        </Badge>
        <span className="text-[10px] tabular mono text-foreground">{flow}%</span>
        <span className="text-[9px] text-muted-foreground">{trend.toLowerCase()}</span>
      </div>
    </div>
  );
}

/**
 * Heurística pra próxima decisão provável do _decide().
 * É aproximação (não temos atr_pct no payload ainda) — quando o publisher
 * exportar atr_pct + profit_in_atr, vamos cravar o threshold exato.
 */
function nextEventPrediction(p: OpenPosition): string | null {
  const pnl = p.pnl_pct;
  const bestPnl = p.best_pnl_pct;

  // Quase no SL — primeiro warning
  const sgn = p.side === "long" ? 1 : -1;
  const distSL = ((sgn * (p.current_price - p.sl)) / p.current_price) * 100;
  if (distSL > 0 && distSL < 0.25) {
    return `SL próximo (${distSL.toFixed(2)}%) — SL trigger iminente se preço continuar contra`;
  }

  // Pullback >45% do pico + lucro > 0.2% + momentum REVERSING — FULL_EXIT condição 2
  if (bestPnl > 0.3 && pnl > 0.2) {
    const pullback = ((bestPnl - pnl) / bestPnl) * 100;
    if (pullback > 40) {
      return `pullback ${pullback.toFixed(0)}% do pico — FULL_EXIT se atingir 45% com momentum REVERSING`;
    }
  }

  // PARTIAL_EXIT: profit ≥ 1.0×ATR. Sem atr_pct no payload, estimamos com 0.8% como proxy típico.
  if (!p.partial_done && pnl > 0.5) {
    return `~PARTIAL_EXIT pendente (40% size). Adversidade do tape pode antecipar.`;
  }

  // tape contra forte
  if (p.tape_bias <= -1) {
    return `tape contra (bias ${p.tape_bias}) — TIGHT_TP / TRAIL apertando`;
  }

  // momentum strong + lucro modesto — pode estender TP
  if (p.momentum_state === "STRONG" && pnl > 0.15 && !p.tp_extended) {
    return `STRONG momentum — EXTEND_TP provável (até 2.5-3.0×ATR)`;
  }

  return null;
}

// referenced to silence unused-icon lint
void AlertTriangle;
