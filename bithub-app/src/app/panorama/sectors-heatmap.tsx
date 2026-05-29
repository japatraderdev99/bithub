"use client";
import { formatPct, formatCompact, pnlClass } from "@/lib/utils";

interface Sector {
  sector: string;
  perf_24h_pct: number;
  volume_24h_usd: number;
  leaders: string[];
}

interface Props {
  data: Sector[];
}

export function SectorsHeatmap({ data }: Props) {
  // Simple grid heatmap. Cell size weighted by volume; background tinted by perf.
  if (data.length === 0) {
    return <div className="py-8 text-center text-xs text-muted-foreground">Sem setores disponíveis.</div>;
  }
  const maxVol = Math.max(...data.map((s) => s.volume_24h_usd));
  return (
    <div className="grid grid-cols-4 gap-2">
      {data.map((s) => {
        const volPct = s.volume_24h_usd / maxVol;
        const bgIntensity = Math.min(Math.abs(s.perf_24h_pct) / 5, 1);
        const isPositive = s.perf_24h_pct >= 0;
        const bg = isPositive
          ? `hsl(var(--emerald) / ${0.1 + bgIntensity * 0.4})`
          : `hsl(var(--rose) / ${0.1 + bgIntensity * 0.4})`;
        const border = isPositive
          ? `hsl(var(--emerald) / ${0.3 + bgIntensity * 0.5})`
          : `hsl(var(--rose) / ${0.3 + bgIntensity * 0.5})`;
        return (
          <div
            key={s.sector}
            className="rounded-md p-3 border transition-transform hover:scale-[1.02]"
            style={{
              background: bg,
              borderColor: border,
              minHeight: `${64 + volPct * 60}px`,
            }}
          >
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-medium text-foreground">{s.sector}</span>
              <span className={`text-[11px] tabular font-medium ${pnlClass(s.perf_24h_pct)}`}>
                {formatPct(s.perf_24h_pct)}
              </span>
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              vol {formatCompact(s.volume_24h_usd)}
            </div>
            <div className="mt-1.5 flex gap-1 flex-wrap">
              {s.leaders.map((l) => (
                <span key={l} className="text-[10px] mono text-foreground/80 px-1 rounded bg-background/40">
                  {l}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
