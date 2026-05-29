"use client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useEvents } from "@/hooks/use-monitor";
import { useCockpitHighlight } from "./cockpit-context";
import { timeAgo } from "@/lib/utils";

export function EventTail() {
  const resp = useEvents(60, 4000);
  const { highlightedSymbol, setHighlighted } = useCockpitHighlight();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Eventos recentes</CardTitle>
        <CardDescription>
          Tail do `events.jsonl` · hover destaca posição relacionada · ENTRY · EXIT · TRAIL · PARTIAL · TAPE_SIGNAL
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {resp == null ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">Carregando…</p>
        ) : resp.ok === false ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">{resp.reason}</p>
        ) : resp.events.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">Sem eventos ainda.</p>
        ) : (
          <div className="divide-y divide-border/30 max-h-[280px] overflow-y-auto">
            {[...resp.events].reverse().slice(0, 60).map((e, i) => {
              const isHi = highlightedSymbol === e.symbol;
              return (
                <div
                  key={i}
                  onMouseEnter={() => setHighlighted(e.symbol)}
                  onMouseLeave={() => setHighlighted(null)}
                  className={`px-4 py-1.5 grid grid-cols-[60px_100px_90px_1fr] gap-2 text-[11px] items-center transition-colors cursor-pointer ${
                    isHi ? "bg-amber/10 border-l-2 border-amber" : "hover:bg-secondary/20"
                  }`}
                >
                  <span className="text-muted-foreground tabular">{timeAgo(e.ts)}</span>
                  <Badge variant={colorOf(e.event_type)} className="text-[9px] justify-center">{e.event_type}</Badge>
                  <span className={`mono ${isHi ? "text-amber font-semibold" : "text-foreground"}`}>{e.symbol}</span>
                  <span className="text-muted-foreground truncate">{e.detail}</span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function colorOf(t: string): "emerald" | "rose" | "amber" | "outline" | "muted" {
  if (t === "ENTRY") return "emerald";
  if (t === "EXIT_FULL") return "rose";
  if (t === "EXIT_PARTIAL") return "amber";
  if (t === "TAPE_SIGNAL") return "amber";
  if (t === "TRAIL") return "outline";
  if (t === "EXTEND_TP" || t === "TIGHT_TP") return "muted";
  return "muted";
}
