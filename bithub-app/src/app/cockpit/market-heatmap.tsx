"use client";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useCandidates, usePositions } from "@/hooks/use-monitor";
import { useCockpitHighlight } from "./cockpit-context";
import { formatPct, pnlClass } from "@/lib/utils";
import type { Candidate } from "@/types/monitor";

/**
 * MarketHeatmap — vista Bloomberg-market-map dos candidatos T1+T2 do monitor.
 * Cada célula = símbolo com bias direcional. Cor por direção, opacidade por
 * score (mais opaco = score maior). Border destaca:
 *   - emerald: já em posição
 *   - amber: passou score≥60, aguardando tape gate
 *   - rose: rejeitado pelo tape gate ou gate_ok=false com score≥60
 */
export function MarketHeatmap() {
  const { response } = useCandidates(4000);
  const posResp = usePositions(2500);
  const ok = response?.ok === true;
  const data = ok && response ? response.data : null;
  const [selected, setSelected] = useState<Candidate | null>(null);
  // Collapsed by default — heatmap is auxiliary visualization, not primary
  // decision surface (Codex 2026-05-28 review).
  const [expanded, setExpanded] = useState(false);

  // Derive openSymbols from live positions
  const openSymbols =
    posResp.response?.ok === true
      ? posResp.response.data.positions.map((p) => p.symbol)
      : [];

  if (!ok || !data) {
    return (
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground">
          Aguardando candidatos…
        </CardContent>
      </Card>
    );
  }

  // Top 40 by score (already pre-sorted in publisher)
  const cells = data.candidates.slice(0, 40);

  return (
    <Card>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-2 flex items-center justify-between hover:bg-secondary/30 transition-colors"
      >
        <div className="flex items-center gap-2 text-left">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <div>
            <CardTitle className="text-xs">Market map · top {cells.length}</CardTitle>
            <CardDescription className="text-[10px]">
              {expanded
                ? "cor=bias TF · opacidade=score · border=status · click=detalhes"
                : "visualização auxiliar do universo — click para expandir"}
            </CardDescription>
          </div>
        </div>
        {expanded && (
          <div className="flex gap-1.5 text-[9px] mono items-center">
            <Legend color="emerald" label="BULL" />
            <Legend color="rose" label="BEAR" />
            <Legend color="amber" label="≥60 score" />
            <Legend color="emerald-border" label="open" />
          </div>
        )}
      </button>
      {expanded && (
        <CardContent className="p-2 pt-0">
          {cells.length === 0 ? (
            <p className="text-center py-4 text-xs text-muted-foreground">
              Sem candidatos — próximo T1 scan em até 60s.
            </p>
          ) : (
            // Grid auto-flow dense: cells with higher score (or open position)
            // span 2x1 / 2x2, making them visually proportional to importance.
            // Minimum cell 70px square, larger ones can dominate area.
            <div
              className="grid gap-1.5"
              style={{
                gridTemplateColumns: "repeat(auto-fill, minmax(70px, 1fr))",
                gridAutoRows: "60px",
                gridAutoFlow: "dense",
              }}
            >
              {cells.map((c) => (
                <Cell
                  key={c.symbol}
                  c={c}
                  isOpen={openSymbols.includes(c.symbol)}
                  onClick={() => setSelected(c)}
                />
              ))}
            </div>
          )}
        </CardContent>
      )}

      <Sheet open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent>
          {selected && <CandidateDetail c={selected} />}
        </SheetContent>
      </Sheet>
    </Card>
  );
}

// Silence the unused-import lint for CardHeader (kept for future expansion)
void CardHeader;

function Cell({ c, isOpen, onClick }: { c: Candidate; isOpen: boolean; onClick: () => void }) {
  const { highlightedSymbol, setHighlighted } = useCockpitHighlight();
  const isBull = c.direction === "long";
  const isHi = highlightedSymbol === c.symbol;
  // Score-driven opacity (40-100 scale → 0.20-0.85)
  const op = Math.max(0.18, Math.min(0.85, c.score / 100));
  const bg = isBull
    ? `hsl(var(--emerald) / ${op})`
    : `hsl(var(--rose) / ${op})`;
  const passing = c.score >= 60 && c.gate_ok;
  const rejected = c.score >= 60 && !c.gate_ok;
  const borderColor = isHi
    ? "hsl(var(--amber))"
    : isOpen
    ? "hsl(var(--emerald))"
    : passing
    ? "hsl(var(--amber))"
    : rejected
    ? "hsl(var(--rose) / 0.5)"
    : "hsl(var(--border))";

  // Proportional sizing: cells span more cells based on score + open status.
  // This is a treemap-like effect — important opportunities dominate.
  //
  //   open position    → 2×2 (4x area)
  //   passing (60+gate)→ 2×2 (4x)
  //   score 60+        → 2×1 (2x)
  //   score 50-59      → 1×1
  //   score 40-49      → 1×1
  //   score < 40       → 1×1 (mas com opacity baixa por dentro do estilo)
  let colSpan = 1;
  let rowSpan = 1;
  if (isOpen || passing) {
    colSpan = 2;
    rowSpan = 2;
  } else if (c.score >= 60) {
    colSpan = 2;
    rowSpan = 1;
  }

  // Font sizes scale with cell area
  const symbolSize = colSpan >= 2 && rowSpan >= 2 ? "text-sm" : colSpan >= 2 ? "text-xs" : "text-[10px]";
  const scoreSize = colSpan >= 2 && rowSpan >= 2 ? "text-base" : "text-[10px]";

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHighlighted(c.symbol)}
      onMouseLeave={() => setHighlighted(null)}
      className={`rounded p-1.5 border text-left transition-all cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring ${
        isHi ? "scale-105 z-10" : "hover:scale-[1.03]"
      }`}
      style={{
        background: bg,
        borderColor,
        borderWidth: isOpen || passing || isHi ? 2 : 1,
        gridColumn: `span ${colSpan}`,
        gridRow: `span ${rowSpan}`,
      }}
      title={`${c.symbol} ${c.direction} score=${c.score}${isOpen ? " · OPEN" : passing ? " · PASSING" : ""}`}
    >
      <div className="h-full flex flex-col justify-between">
        <div className="flex items-baseline justify-between gap-1">
          <span className={`mono font-semibold text-foreground truncate ${symbolSize}`}>{c.symbol.replace("USDT", "")}</span>
          <span className={`mono tabular text-foreground/90 font-semibold ${scoreSize}`}>{c.score}</span>
        </div>
        <div className="flex items-center justify-between text-[8px] uppercase tracking-wider text-foreground/60">
          <span>{isBull ? "long" : "short"}</span>
          {isOpen && <span className="text-emerald font-semibold">● open</span>}
          {passing && !isOpen && <span className="text-amber">▶ passing</span>}
        </div>
      </div>
    </button>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  const bg =
    color === "emerald" ? "hsl(var(--emerald) / 0.6)" :
    color === "rose" ? "hsl(var(--rose) / 0.6)" :
    color === "amber" ? "transparent" :
    "transparent";
  const border =
    color === "amber" ? "hsl(var(--amber))" :
    color === "emerald-border" ? "hsl(var(--emerald))" :
    "transparent";
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      <span
        className="inline-block w-3 h-3 rounded-sm border"
        style={{ background: bg, borderColor: border, borderWidth: 1.5 }}
      />
      {label}
    </span>
  );
}

function CandidateDetail({ c }: { c: Candidate }) {
  const isBull = c.direction === "long";
  const passing = c.score >= 60 && c.gate_ok;
  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2 mono">
          {c.symbol}
          <Badge variant={isBull ? "emerald" : "rose"}>{c.direction}</Badge>
          <span className="text-xs text-muted-foreground tabular">score {c.score}/100</span>
        </SheetTitle>
        <SheetDescription>
          TF {c.tf_alignment} · {passing ? "✅ Passou todos os gates" : c.gate_ok ? "⚠️ Gate ok mas score abaixo de 60" : "❌ Gate fail"}
        </SheetDescription>
      </SheetHeader>

      <div className="mt-4 space-y-4">
        {/* Score bar */}
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Score</p>
          <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
            <div
              className={`h-full ${c.score >= 60 ? "bg-emerald" : c.score >= 40 ? "bg-amber" : "bg-rose"}`}
              style={{ width: `${Math.min(c.score, 100)}%` }}
            />
          </div>
        </div>

        {/* Gates */}
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Gates</p>
          <div className="grid grid-cols-3 gap-1.5">
            {Object.entries(c.gates).map(([key, v]) => (
              <div key={key} className={`text-[10px] mono p-1.5 rounded border ${v ? "border-emerald/40 bg-emerald/5 text-emerald" : "border-rose/40 bg-rose/5 text-rose"}`}>
                {v ? "✓" : "✗"} {key}
              </div>
            ))}
          </div>
        </div>

        {/* Indicators */}
        {c.indicators && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Indicadores</p>
            <div className="grid grid-cols-2 gap-1.5 text-[11px]">
              {c.indicators.atr_pct != null && (
                <Metric label="ATR%" value={`${c.indicators.atr_pct.toFixed(2)}%`} />
              )}
              {c.indicators.rsi5 != null && (
                <Metric label="RSI5" value={c.indicators.rsi5.toFixed(0)} />
              )}
              {c.indicators.rsi15 != null && (
                <Metric label="RSI15" value={c.indicators.rsi15.toFixed(0)} />
              )}
              {c.indicators.bb_pct != null && (
                <Metric label="BB%" value={c.indicators.bb_pct.toFixed(0)} />
              )}
              {c.indicators.vol_x != null && (
                <Metric label="Vol" value={`${c.indicators.vol_x.toFixed(2)}x`} />
              )}
              {c.indicators.dist9 != null && (
                <Metric label="EMA9 dist" value={`${c.indicators.dist9.toFixed(1)}%`} />
              )}
              {c.indicators.book_imb_pct != null && (
                <Metric label="Book imb" value={`${c.indicators.book_imb_pct.toFixed(0)}%`} />
              )}
              {c.indicators.funding_rate != null && (
                <Metric label="Funding" value={formatPct(c.indicators.funding_rate * 100, 4)} tone={pnlClass(c.indicators.funding_rate)} />
              )}
              {c.indicators.poc_dist_pct != null && (
                <Metric label="POC dist" value={`${c.indicators.poc_dist_pct.toFixed(2)}%`} />
              )}
              {c.indicators.price != null && (
                <Metric label="Price" value={c.indicators.price.toString()} mono />
              )}
            </div>
          </div>
        )}

        {c.rejection_reason && (
          <div className="rounded-md border border-rose/40 bg-rose/5 p-2 text-[11px] text-rose">
            <strong>Rejeição:</strong> {c.rejection_reason}
          </div>
        )}
      </div>
    </>
  );
}

function Metric({ label, value, tone, mono }: { label: string; value: string; tone?: string; mono?: boolean }) {
  return (
    <div className="rounded border border-border bg-secondary/30 p-1.5">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-xs font-semibold tabular ${mono ? "mono" : ""} ${tone ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}
