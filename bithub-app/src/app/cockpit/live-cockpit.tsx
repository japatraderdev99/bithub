"use client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PublisherStatus } from "@/components/publisher-status";
import { usePositions, useEvents } from "@/hooks/use-monitor";
import { formatPct, formatPrice, pnlClass, timeAgo } from "@/lib/utils";

export function LiveCockpit() {
  const { response, loading } = usePositions(2500);
  const events = useEvents(40, 4000);

  const ok = response?.ok === true;
  const data = ok && response ? response.data : null;
  const positions = data?.positions ?? [];
  const openCount = data?.open_count ?? 0;
  const maxSlots = data?.max_slots ?? 4;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Posições abertas · {openCount}/{maxSlots}</CardTitle>
              <CardDescription>
                {ok ? `Snapshot at ${data ? new Date(data.as_of).toLocaleTimeString() : "—"}` : "Aguardando publisher local"}
              </CardDescription>
            </div>
            <PublisherStatus ok={ok} reason={ok ? undefined : response?.reason} ageMs={ok ? response.age_ms : undefined} loading={loading} />
          </div>
        </CardHeader>
        {ok && positions.length === 0 && (
          <CardContent className="text-center text-xs text-muted-foreground py-6">
            Nenhuma posição aberta no momento. O monitor está rodando — aguardando setup score ≥ 60 + tape gate.
          </CardContent>
        )}
      </Card>

      {positions.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {positions.map((p) => (
            <PositionCard key={p.symbol} p={p} />
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Eventos recentes</CardTitle>
          <CardDescription>
            Tail do events.jsonl · entries, exits, trails, partials
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {events && events.ok ? (
            events.events.length === 0 ? (
              <p className="px-4 py-3 text-xs text-muted-foreground">Sem eventos ainda.</p>
            ) : (
              <div className="divide-y divide-border/30">
                {[...events.events].reverse().map((e, i) => (
                  <div key={i} className="px-4 py-2 grid grid-cols-[60px_80px_80px_1fr] gap-2 text-[11px] items-center">
                    <span className="text-muted-foreground">{timeAgo(e.ts)}</span>
                    <Badge variant={eventColor(e.event_type)}>{e.event_type}</Badge>
                    <span className="mono text-foreground">{e.symbol}</span>
                    <span className="text-muted-foreground truncate">{e.detail}</span>
                  </div>
                ))}
              </div>
            )
          ) : (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              {events?.ok === false ? events.reason : "Carregando…"}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PositionCard({ p }: { p: NonNullable<ReturnType<typeof usePositions>["response"] & { ok: true }>["data"]["positions"][number] }) {
  return (
    <Card className={p.pnl_pct > 0 ? "border-emerald/30" : p.pnl_pct < 0 ? "border-rose/30" : ""}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold mono">{p.symbol}</span>
              <Badge variant={p.side === "long" ? "emerald" : "rose"}>{p.side}</Badge>
              <Badge variant="outline">{p.momentum_state}</Badge>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Opened {timeAgo(p.opened_at)} · {p.leverage}x · {formatPrice(p.size_usd)} USDT
            </p>
          </div>
          <div className="text-right">
            <p className={`text-base font-semibold tabular ${pnlClass(p.pnl_pct)}`}>{formatPct(p.pnl_pct)}</p>
            <p className="text-[10px] text-muted-foreground">best {formatPct(p.best_pnl_pct)}</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-[10px]">
          <Cell label="Entry" value={formatPrice(p.entry)} />
          <Cell label="Now" value={formatPrice(p.current_price)} />
          <Cell label="Qty" value={p.qty.toString()} />
          <Cell label="SL" value={formatPrice(p.sl)} tone="text-rose" />
          <Cell label="TP" value={formatPrice(p.tp)} tone="text-emerald" />
          <Cell label="Tape" value={`${p.tape_flow_pct}%`} tone={p.tape_bias > 0 ? "text-emerald" : p.tape_bias < 0 ? "text-rose" : "text-muted-foreground"} />
        </div>

        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {p.partial_done && <Badge variant="muted">partial done</Badge>}
          {p.tp_extended && <Badge variant="amber">tp extended</Badge>}
          {p.be_set && <Badge variant="emerald">BE set</Badge>}
          <span className="ml-auto mono">delta {p.tape_delta_trend.toLowerCase()}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <p className="uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-xs font-semibold tabular mono ${tone ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

function eventColor(t: string): "muted" | "emerald" | "rose" | "amber" | "outline" {
  if (t === "ENTRY") return "emerald";
  if (t === "EXIT_FULL") return "rose";
  if (t === "EXIT_PARTIAL") return "amber";
  if (t === "TRAIL") return "outline";
  return "muted";
}
