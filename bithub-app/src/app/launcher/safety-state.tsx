"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface FilePayload<T> {
  ok: boolean;
  data?: T;
  mtime?: string;
  reason?: string;
}

interface KillSwitch {
  active: boolean;
  paused_at?: string | null;
  reason?: string | null;
  manual_override?: boolean;
  session_baseline_usd?: number | null;
  triggered_by?: Record<string, unknown> | null;
  last_check?: {
    balance?: number | null;
    d1_pnl_sum?: number | null;
    d1_trades?: number | null;
    streak_losses?: number | null;
  } | null;
}

interface RateLimit {
  can_enter: boolean;
  reason?: string | null;
  degraded?: boolean;
  counts?: { last_60min: number; last_24h: number; session: number };
  limits?: { per_hour: number; per_24h: number; per_session: number };
  next_slot_available_at?: string | null;
}

interface Cooldowns {
  degraded?: boolean;
  cooldowns: Record<string, { until: string; reason: string; pnl_pct: number | null }>;
  active_count: number;
}

interface MonitorHeartbeat {
  balance_usdt: number;
  open_slots: number;
  max_slots: number;
  ws_private_status: string;
  last_heartbeat_ts: string;
}

interface SafetyState {
  ok: boolean;
  as_of: string;
  state_dir: string;
  kill_switch: FilePayload<KillSwitch>;
  rate_limit: FilePayload<RateLimit>;
  cooldowns: FilePayload<Cooldowns>;
  monitor_heartbeat: FilePayload<MonitorHeartbeat>;
}

function freshnessLabel(mtime: string | undefined, asOf: string): { label: string; stale: boolean } {
  if (!mtime) return { label: "—", stale: true };
  const diffSec = Math.floor((new Date(asOf).getTime() - new Date(mtime).getTime()) / 1000);
  if (diffSec < 60) return { label: `${diffSec}s atrás`, stale: false };
  const min = Math.floor(diffSec / 60);
  if (min < 60) return { label: `${min}min atrás`, stale: min > 5 };
  return { label: `${Math.floor(min / 60)}h ${min % 60}min atrás`, stale: true };
}

function untilLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expirado";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}min ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}min`;
}

export function SafetyState() {
  const [state, setState] = useState<SafetyState | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchState() {
      try {
        const r = await fetch("/api/launcher/safety/state", { cache: "no-store" });
        const j: SafetyState = await r.json();
        if (!cancelled) {
          setState(j);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    }
    fetchState();
    const iv = setInterval(fetchState, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  if (err) {
    return (
      <Card className="border-rose/40">
        <CardContent className="p-3 text-xs text-rose">Erro lendo safety state: {err}</CardContent>
      </Card>
    );
  }

  if (!state) {
    return <Card><CardContent className="p-3 text-xs text-muted-foreground">Carregando…</CardContent></Card>;
  }

  const ks = state.kill_switch;
  const rl = state.rate_limit;
  const cd = state.cooldowns;
  const hb = state.monitor_heartbeat;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {/* Kill Switch */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            Kill switch
            <KSBadge data={ks} />
          </CardTitle>
          <CardDescription className="text-[10px]">
            {ks.ok ? `state: ${freshnessLabel(ks.mtime, state.as_of).label}` : `daemon offline (${ks.reason})`}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {ks.ok && ks.data ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-muted-foreground">reason</dt>
              <dd className="mono">{ks.data.reason ?? "—"}</dd>
              <dt className="text-muted-foreground">baseline</dt>
              <dd className="mono">{ks.data.session_baseline_usd != null ? `$${ks.data.session_baseline_usd.toFixed(2)}` : "—"}</dd>
              <dt className="text-muted-foreground">balance</dt>
              <dd className="mono">{ks.data.last_check?.balance != null ? `$${ks.data.last_check.balance.toFixed(2)}` : "—"}</dd>
              <dt className="text-muted-foreground">streak</dt>
              <dd className="mono">{ks.data.last_check?.streak_losses ?? "—"}</dd>
              <dt className="text-muted-foreground">manual override</dt>
              <dd className="mono">{ks.data.manual_override ? "🟡 sim" : "não"}</dd>
            </dl>
          ) : (
            <p className="text-[11px] text-muted-foreground">Sem dados.</p>
          )}
        </CardContent>
      </Card>

      {/* Rate Limit */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            Rate limit
            <RLBadge data={rl} />
          </CardTitle>
          <CardDescription className="text-[10px]">
            {rl.ok ? `state: ${freshnessLabel(rl.mtime, state.as_of).label}` : `daemon offline (${rl.reason})`}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {rl.ok && rl.data ? (
            <div className="space-y-1 text-[11px]">
              <Row label="hour" current={rl.data.counts?.last_60min} max={rl.data.limits?.per_hour} />
              <Row label="24h" current={rl.data.counts?.last_24h} max={rl.data.limits?.per_24h} />
              <Row label="sessão" current={rl.data.counts?.session} max={rl.data.limits?.per_session} />
              {rl.data.next_slot_available_at && (
                <p className="text-muted-foreground pt-1">próx slot: {new Date(rl.data.next_slot_available_at).toLocaleTimeString()}</p>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">Sem dados.</p>
          )}
        </CardContent>
      </Card>

      {/* Cooldowns */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            Cooldowns por símbolo
            <CDBadge data={cd} />
          </CardTitle>
          <CardDescription className="text-[10px]">
            {cd.ok ? `state: ${freshnessLabel(cd.mtime, state.as_of).label}` : `daemon offline (${cd.reason})`}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {cd.ok && cd.data && cd.data.active_count > 0 ? (
            <ul className="space-y-1 text-[11px]">
              {Object.entries(cd.data.cooldowns).map(([sym, info]) => (
                <li key={sym} className="flex items-center justify-between border-b border-border/30 last:border-0 py-0.5">
                  <span className="mono">{sym}</span>
                  <span className={`mono ${info.pnl_pct != null && info.pnl_pct <= -1 ? "text-rose" : "text-muted-foreground"}`}>
                    {info.pnl_pct != null ? `${info.pnl_pct.toFixed(2)}%` : "—"}
                  </span>
                  <span className="text-muted-foreground">{untilLabel(info.until)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {cd.ok ? "Nenhum símbolo em cooldown." : "Sem dados."}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Monitor heartbeat */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            Monitor heartbeat
            <HBBadge data={hb} asOf={state.as_of} />
          </CardTitle>
          <CardDescription className="text-[10px]">
            {hb.ok ? `system.json: ${freshnessLabel(hb.mtime, state.as_of).label}` : `(${hb.reason})`}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {hb.ok && hb.data ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-muted-foreground">balance</dt>
              <dd className="mono">${hb.data.balance_usdt.toFixed(2)}</dd>
              <dt className="text-muted-foreground">slots</dt>
              <dd className="mono">{hb.data.open_slots}/{hb.data.max_slots}</dd>
              <dt className="text-muted-foreground">ws privado</dt>
              <dd className="mono">{hb.data.ws_private_status}</dd>
            </dl>
          ) : (
            <p className="text-[11px] text-muted-foreground">Sem dados.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, current, max }: { label: string; current?: number; max?: number }) {
  const overflow = current != null && max != null && current >= max;
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`mono ${overflow ? "text-rose font-medium" : ""}`}>
        {current ?? "—"} / {max ?? "—"}
      </span>
    </div>
  );
}

function KSBadge({ data }: { data: FilePayload<KillSwitch> }) {
  if (!data.ok) return <Badge variant="amber">offline</Badge>;
  if (data.data?.manual_override) return <Badge variant="amber">override</Badge>;
  return data.data?.active
    ? <Badge variant="emerald">active</Badge>
    : <Badge variant="rose">paused</Badge>;
}

function RLBadge({ data }: { data: FilePayload<RateLimit> }) {
  if (!data.ok) return <Badge variant="amber">offline</Badge>;
  if (data.data?.degraded) return <Badge variant="amber">degraded</Badge>;
  return data.data?.can_enter
    ? <Badge variant="emerald">ok</Badge>
    : <Badge variant="rose">capped</Badge>;
}

function CDBadge({ data }: { data: FilePayload<Cooldowns> }) {
  if (!data.ok) return <Badge variant="amber">offline</Badge>;
  if (!data.data || data.data.active_count === 0) return <Badge variant="emerald">livre</Badge>;
  return <Badge variant="rose">{data.data.active_count} ativos</Badge>;
}

function HBBadge({ data, asOf }: { data: FilePayload<MonitorHeartbeat>; asOf: string }) {
  if (!data.ok) return <Badge variant="amber">offline</Badge>;
  const { stale } = freshnessLabel(data.mtime, asOf);
  return stale ? <Badge variant="rose">stale</Badge> : <Badge variant="emerald">vivo</Badge>;
}
