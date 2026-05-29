"use client";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useLifecycleEvents } from "@/hooks/use-trades";
import type { LifecycleEvent } from "@/lib/trades-client";
import { formatPct } from "@/lib/utils";

// H-RESEARCH-BENCH-002 Superficie 2 — vertical timeline of lifecycle events
// anchored to a trade or open symbol. Honest empty state when nothing came
// back from the Worker; never falls back to monitor_events to fake content.
//
// Anchor by `clientTradeId` when the trade has closed (History row), or by
// `symbol`+`since` when looking at an open position (no trade_id yet).
export interface DecisionTrailProps {
  clientTradeId?: string;
  symbol?: string;
  since?: string;          // ISO, useful with `symbol` to scope to the open
                            // window of an active position
}

export function DecisionTrail({ clientTradeId, symbol, since }: DecisionTrailProps) {
  const { events, error, loading } = useLifecycleEvents(clientTradeId, symbol, since);

  const header = (
    <div className="text-[10px] text-muted-foreground space-y-0.5">
      {symbol && (
        <p>
          <span className="uppercase tracking-wider">symbol</span>{" "}
          <span className="mono text-foreground">{symbol}</span>
        </p>
      )}
      {clientTradeId && (
        <p className="truncate">
          <span className="uppercase tracking-wider">trade</span>{" "}
          <span className="mono text-foreground">{clientTradeId}</span>
        </p>
      )}
      {events && events.length > 0 && events[0].strategy_version_id && (
        <p className="truncate">
          <span className="uppercase tracking-wider">strategy</span>{" "}
          <span className="mono text-foreground">{events[0].strategy_version_id}</span>
        </p>
      )}
      {events && events.length > 0 && events[0].regime_snapshot_id && (
        <p className="truncate">
          <span className="uppercase tracking-wider">regime at entry</span>{" "}
          <span className="mono text-foreground">{events[0].regime_snapshot_id}</span>
        </p>
      )}
    </div>
  );

  if (loading) {
    return (
      <div className="space-y-2">
        {header}
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 className="h-3 w-3 animate-spin" />
          Carregando decision trail…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        {header}
        <p className="text-[11px] text-muted-foreground py-4">
          Worker indisponível ou sem permissão de leitura — tentar novamente em alguns segundos.
        </p>
      </div>
    );
  }

  if (!events || events.length === 0) {
    return (
      <div className="space-y-2">
        {header}
        <div className="text-[11px] text-muted-foreground space-y-1 py-2">
          <p>Sem lifecycle events para esta posição.</p>
          <p>
            Publisher ainda não instrumentado para enviar lifecycle ao D1.
            Patch agendado em <code className="mono text-foreground/80">H-RESEARCH-BENCH-003</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {header}
      <ol className="space-y-1.5">
        {events.map((ev) => <TrailRow key={ev.client_event_id} ev={ev} />)}
      </ol>
    </div>
  );
}

function TrailRow({ ev }: { ev: LifecycleEvent }) {
  const tone = toneOf(ev.event_type, ev.pnl_pct);
  return (
    <li className="grid grid-cols-[72px_140px_1fr] gap-2 items-start text-[11px]">
      <span className="text-muted-foreground tabular mono pt-0.5">{formatTs(ev.ts)}</span>
      <Badge variant={tone} className="text-[9px] justify-center whitespace-nowrap">
        {ev.event_type}
      </Badge>
      <div className="space-y-0.5 min-w-0">
        <p className="text-foreground/90 truncate">{detailLine(ev)}</p>
        {ev.reason && (
          <p className="text-[10px] text-muted-foreground truncate">
            <span className="text-muted-foreground/70">↳</span> {ev.reason}
          </p>
        )}
      </div>
    </li>
  );
}

// Detail line for one event. Each event_type emphasises the fields that
// matter for that phase — score+rr for evaluating, price+ttl for placed,
// pnl+net for exits. Falls through to a generic line for unknown types.
function detailLine(ev: LifecycleEvent): string {
  const parts: string[] = [];
  if (ev.event_type === "ENTRY_EVALUATING" || ev.event_type === "ENTRY_REJECTED") {
    if (ev.setup_score != null) parts.push(`score ${ev.setup_score}`);
    if (ev.tape_flow_pct != null) parts.push(`tape ${signed(ev.tape_flow_pct)}%`);
    if (ev.rr != null) parts.push(`rr ${ev.rr.toFixed(1)}`);
  } else if (ev.event_type === "ENTRY_BLOCKED") {
    if (ev.reason) {
      /* shown below */
    } else {
      parts.push("blocked");
    }
  } else if (ev.event_type === "ENTRY_ORDER_PLACED") {
    if (ev.entry_order_type) parts.push(ev.entry_order_type.toLowerCase());
    if (ev.price != null) parts.push(`@ ${ev.price.toFixed(4)}`);
    if (ev.sl != null) parts.push(`sl ${ev.sl.toFixed(4)}`);
  } else if (ev.event_type === "LIMIT_FILLED") {
    if (ev.price != null) parts.push(`fill ${ev.price.toFixed(4)}`);
    if (ev.entry_slippage_pct != null) parts.push(`slip ${signed(ev.entry_slippage_pct)}%`);
    if (ev.fill_latency_sec != null) parts.push(`${ev.fill_latency_sec.toFixed(1)}s`);
  } else if (ev.event_type === "EXIT_RECORDED") {
    if (ev.pnl_pct != null) parts.push(formatPct(ev.pnl_pct));
    if (ev.best_pnl_pct != null) parts.push(`mfe ${formatPct(ev.best_pnl_pct)}`);
    if (ev.mae_pct != null) parts.push(`mae ${formatPct(ev.mae_pct)}`);
  } else {
    if (ev.price != null) parts.push(`@ ${ev.price.toFixed(4)}`);
    if (ev.pnl_pct != null) parts.push(formatPct(ev.pnl_pct));
  }
  return parts.length ? parts.join(" · ") : ev.phase ?? "—";
}

function toneOf(eventType: string, pnlPct: number | null): "emerald" | "rose" | "amber" | "muted" | "outline" {
  if (eventType === "ENTRY_EVALUATING") return "muted";
  if (eventType === "ENTRY_BLOCKED" || eventType === "ENTRY_REJECTED") return "amber";
  if (eventType === "ENTRY_ORDER_PLACED" || eventType === "LIMIT_FILLED") return "emerald";
  if (eventType === "EXIT_RECORDED") {
    if (pnlPct == null) return "muted";
    if (pnlPct > 0) return "emerald";
    if (pnlPct < 0) return "rose";
    return "muted";
  }
  return "outline";
}

function signed(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

function formatTs(ts: string): string {
  // HH:MM:SS in UTC — operator works across sessions, local time would lie.
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().slice(11, 19);
}
