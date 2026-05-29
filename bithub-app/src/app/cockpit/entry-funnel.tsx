"use client";
import { Check, X, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useCandidates } from "@/hooks/use-monitor";
import { formatPct, pnlClass } from "@/lib/utils";
import type { Candidate } from "@/types/monitor";

const GATE_LABELS: Array<{ key: keyof Candidate["gates"]; short: string; label: string }> = [
  { key: "g_atr", short: "ATR", label: "Volatilidade mínima" },
  { key: "g_bb", short: "BB", label: "Bollinger não-extremo" },
  { key: "g_vol", short: "V", label: "Volume saudável" },
  { key: "g_ema", short: "EMA", label: "Pullback à EMA9/21" },
  { key: "g_rsi", short: "RSI", label: "RSI fora de extremos" },
  { key: "g_poc", short: "POC", label: "Longe da congestão" },
  { key: "g_fund", short: "F", label: "Funding alinhado" },
  { key: "g_book", short: "B", label: "Book imbalance" },
  { key: "liq_ok", short: "L", label: "Liquidações alinhadas" },
];

export function EntryFunnel() {
  const { response, loading } = useCandidates(4000);
  const ok = response?.ok === true;
  const data = ok && response ? response.data : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle>Funil de entrada</CardTitle>
            <CardDescription>
              T1 → T2 gates → score ≥ 60 → tape gate → entrada
            </CardDescription>
          </div>
          {data && (
            <div className="flex items-center gap-1 text-[10px] mono">
              <Stage label="T1" count={data.total} />
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <Stage label="T2 ok" count={data.passing} highlight={data.passing > 0} />
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <Stage label="score≥60" count={data.above_min_score} highlight={data.above_min_score > 0} />
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <Stage label="entry" count={0} />
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-0">
        {loading ? (
          <p className="px-4 py-4 text-xs text-muted-foreground">Carregando…</p>
        ) : !ok || !data ? (
          <p className="px-4 py-4 text-xs text-muted-foreground">
            {response?.ok === false ? response.reason : "Aguardando publisher"}
          </p>
        ) : data.candidates.length === 0 ? (
          <p className="px-4 py-4 text-xs text-muted-foreground">
            Nenhum candidato no momento. Próximo T1 scan em até 60s.
          </p>
        ) : (
          <div className="divide-y divide-border/30">
            {data.candidates.slice(0, 10).map((c) => (
              <CandidateRow key={c.symbol} c={c} />
            ))}
            {data.candidates.length > 10 && (
              <p className="px-4 py-2 text-[10px] text-muted-foreground">
                + {data.candidates.length - 10} candidatos com score menor
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stage({ label, count, highlight }: { label: string; count: number; highlight?: boolean }) {
  return (
    <div className={`flex flex-col items-center px-2 py-0.5 rounded ${highlight ? "bg-emerald/10 text-emerald" : "text-muted-foreground"}`}>
      <span className="text-[9px] uppercase tracking-wider">{label}</span>
      <span className="text-xs tabular font-semibold">{count}</span>
    </div>
  );
}

function CandidateRow({ c }: { c: Candidate }) {
  const isPassing = c.gate_ok && c.score >= 60;
  return (
    <div className="px-4 py-2.5 grid grid-cols-1 md:grid-cols-[120px_60px_1fr_240px] gap-2 items-center hover:bg-secondary/20">
      <div className="flex items-center gap-1.5">
        <Badge variant={c.direction === "long" ? "emerald" : "rose"} className="text-[9px]">
          {c.direction === "long" ? "L" : "S"}
        </Badge>
        <span className="text-xs mono font-semibold">{c.symbol}</span>
      </div>

      <ScoreBar score={c.score} />

      <div className="flex items-center gap-2 text-[10px] flex-wrap">
        {c.gates && GATE_LABELS.map(({ key, short }) => {
          const ok = c.gates?.[key];
          return (
            <span
              key={key}
              title={GATE_LABELS.find((g) => g.key === key)?.label}
              className={`mono tabular ${ok ? "text-emerald" : "text-rose/80"}`}
            >
              {ok ? "✓" : "✗"}{short}
            </span>
          );
        })}
        {!isPassing && c.score < 60 && (
          <Badge variant="muted">score baixo</Badge>
        )}
        {!c.gate_ok && c.score >= 60 && (
          <Badge variant="rose">gate fail</Badge>
        )}
        {isPassing && (
          <Badge variant="emerald">aguardando tape gate</Badge>
        )}
      </div>

      <div className="flex items-center gap-2 text-[10px] text-muted-foreground tabular mono justify-end">
        {c.indicators?.atr_pct != null && (
          <span>ATR {c.indicators.atr_pct.toFixed(2)}%</span>
        )}
        {c.indicators?.rsi5 != null && (
          <span>RSI {c.indicators.rsi5.toFixed(0)}</span>
        )}
        {c.indicators?.dist9 != null && (
          <span>EMA {c.indicators.dist9.toFixed(1)}%</span>
        )}
        {c.indicators?.book_imb_pct != null && (
          <span>book {c.indicators.book_imb_pct.toFixed(0)}%</span>
        )}
        {c.indicators?.funding_rate != null && (
          <span className={pnlClass(c.indicators.funding_rate)}>
            fund {formatPct(c.indicators.funding_rate * 100, 4)}
          </span>
        )}
        {(!c.indicators || c.indicators.atr_pct == null) && (
          <span className="text-amber/70">aguardando T2 enrichment</span>
        )}
      </div>
    </div>
  );
}

function ScoreBar({ score }: { score: number }) {
  const passing = score >= 60;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-1">
        <span className={`text-sm font-semibold tabular ${passing ? "text-emerald" : "text-muted-foreground"}`}>{score}</span>
        <span className="text-[9px] text-muted-foreground">/100</span>
      </div>
      <div className="h-1 w-full rounded-full bg-secondary overflow-hidden">
        <div
          className={`h-full ${passing ? "bg-emerald" : score >= 40 ? "bg-amber" : "bg-rose"}`}
          style={{ width: `${Math.min(score, 100)}%` }}
        />
      </div>
    </div>
  );
}

// Internal-only — keeps Check/X imports referenced even if some branches don't use them
void Check; void X;
