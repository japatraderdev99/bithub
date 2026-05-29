"use client";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Check, Rocket, ShieldAlert, Clock, X, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PublisherStatus } from "@/components/publisher-status";
import { useSystem, useEvents } from "@/hooks/use-monitor";
import { sleep, timeAgo } from "@/lib/utils";
import strategies from "@/data/strategies.json";
import launcherData from "@/data/launcher-mock.json";

export function LauncherPanel() {
  const sp = useSearchParams();
  const initialId = sp.get("strategy") ?? strategies[0].id;
  const [selectedId, setSelectedId] = useState(initialId);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [auditLog, setAuditLog] = useState(launcherData.audit_log);
  const [prepToken, setPrepToken] = useState("");
  const [killPhrase, setKillPhrase] = useState("");
  const [killSwitchOpen, setKillSwitchOpen] = useState(false);
  const [killFeedback, setKillFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const { response: sysResp, loading } = useSystem(3000);
  const evResp = useEvents(50, 4000);

  const strategy = useMemo(() => strategies.find((s) => s.id === selectedId) ?? strategies[0], [selectedId]);

  const sysOk = sysResp?.ok === true;
  const sysData = sysOk && sysResp ? sysResp.data : null;

  async function onSend() {
    setSending(true);
    setFeedback(null);
    await sleep(450);
    setAuditLog((l) => [
      {
        ts: new Date().toISOString(),
        actor: "operator",
        action: "launch",
        strategy_id: strategy.id,
        strategy_name: strategy.name,
        status: "accepted",
        monitor_ack_ms: 142,
      },
      ...l,
    ]);
    setFeedback({ kind: "ok", msg: `Comando UI-only (canal de escrita ainda não habilitado). Payload preview: {"strategy_id": "${strategy.id}"}` });
    setSending(false);
  }

  function onKillAll() {
    if (!prepToken.trim()) {
      setKillFeedback({ kind: "err", msg: "Prep-token vazio." });
      return;
    }
    if (killPhrase !== "KILL ALL") {
      setKillFeedback({ kind: "err", msg: `Frase incorreta. Digite literalmente "KILL ALL".` });
      return;
    }
    setAuditLog((l) => [
      {
        ts: new Date().toISOString(),
        actor: "operator",
        action: "kill-all",
        strategy_id: "*",
        strategy_name: "ALL RUNNING SESSIONS",
        status: "accepted",
        monitor_ack_ms: 88,
      } as typeof launcherData.audit_log[number],
      ...l,
    ]);
    setKillFeedback({ kind: "ok", msg: "KILL ALL registrado no audit log (UI-only — canal real ainda não habilitado)." });
    setPrepToken("");
    setKillPhrase("");
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>Launch a strategy</CardTitle>
                <CardDescription>Selecione e dispare. Payload é apenas {`{strategy_id}`}.</CardDescription>
              </div>
              <PublisherStatus ok={sysOk} reason={sysOk ? undefined : sysResp?.reason} ageMs={sysOk ? sysResp.age_ms : undefined} loading={loading} />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="strategy-select">Strategy</Label>
              <Select value={selectedId} onValueChange={setSelectedId}>
                <SelectTrigger id="strategy-select"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {strategies.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} · {s.regime} · Sharpe {s.sharpe.toFixed(2)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-md border border-border bg-secondary/30 p-3 space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Pre-flight checks</p>
              <CheckRow ok={sysOk} label="Publisher escrevendo state" />
              <CheckRow ok={sysData?.ws_private_status === "connected"} label={`WS privado: ${sysData?.ws_private_status ?? "?"}`} />
              <CheckRow ok={(sysData?.open_slots ?? 99) < (sysData?.max_slots ?? 0)} label={`Slot disponível (${sysData?.open_slots ?? "?"}/${sysData?.max_slots ?? "?"})`} />
              <CheckRow ok={true} label="Strategy spec resolvable (content hash bate)" />
            </div>

            <div className="rounded-md border border-border bg-secondary/30 p-3 space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Payload que será enviado</p>
              <pre className="mono text-[11px] text-foreground overflow-x-auto">{JSON.stringify({ strategy_id: strategy.id }, null, 2)}</pre>
              <p className="text-[10px] text-muted-foreground">
                Canal de escrita ainda não habilitado — esse botão registra no audit local apenas.
              </p>
            </div>

            <Button onClick={onSend} disabled={sending} className="w-full" variant="emerald">
              {sending ? "Enviando…" : (<><Rocket className="h-4 w-4" /> Enviar comando ao monitor</>)}
            </Button>

            {feedback && (
              <div className={`text-xs p-2 rounded-md border ${feedback.kind === "ok" ? "bg-emerald/10 border-emerald/40 text-emerald" : "bg-rose/10 border-rose/40 text-rose"}`}>
                {feedback.msg}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Audit log + eventos do monitor</CardTitle>
            <CardDescription>UI commands + tail de events.jsonl</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-secondary/30">
                  <th className="text-left px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">When</th>
                  <th className="text-left px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Action</th>
                  <th className="text-left px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Strategy / symbol</th>
                  <th className="text-left px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Detail</th>
                </tr>
              </thead>
              <tbody>
                {auditLog.map((e, i) => (
                  <tr key={`ui-${i}`} className="border-b border-border/30 hover:bg-secondary/20">
                    <td className="px-4 py-2 text-[11px] text-muted-foreground">{timeAgo(e.ts)}</td>
                    <td className="px-4 py-2"><Badge variant={e.action === "kill-all" ? "rose" : e.action === "stop" ? "amber" : "emerald"}>{e.action}</Badge></td>
                    <td className="px-4 py-2 text-xs">{e.strategy_name}</td>
                    <td className="px-4 py-2 text-[11px] text-muted-foreground">{e.status === "accepted" ? "accepted" : `rejected: ${e.reason ?? ""}`}</td>
                  </tr>
                ))}
                {evResp?.ok &&
                  [...evResp.events].reverse().map((e, i) => (
                    <tr key={`mon-${i}`} className="border-b border-border/30 hover:bg-secondary/20">
                      <td className="px-4 py-2 text-[11px] text-muted-foreground">{timeAgo(e.ts)}</td>
                      <td className="px-4 py-2"><Badge variant="muted">{e.event_type}</Badge></td>
                      <td className="px-4 py-2 text-xs mono">{e.symbol}</td>
                      <td className="px-4 py-2 text-[11px] text-muted-foreground truncate">{e.detail}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Monitor</CardTitle>
            <CardDescription>State publisher local</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {sysOk ? (
              <>
                <Row icon={Clock} label="Last heartbeat" value={timeAgo(sysData!.last_heartbeat_ts)} />
                <Row icon={Check} label="WS state" value={sysData!.ws_private_status} />
                <Row icon={Rocket} label="Slots" value={`${sysData!.open_slots} / ${sysData!.max_slots}`} />
                <Row icon={Check} label="Balance" value={`$${sysData!.balance_usdt.toFixed(2)}`} />
                <Row icon={Check} label="Free" value={`$${sysData!.free_usdt.toFixed(2)}`} />
                {sysData!.alerts.length > 0 && (
                  <div className="border-t border-border pt-2 space-y-1">
                    {sysData!.alerts.map((a, i) => (
                      <div key={i} className={`flex items-start gap-1.5 text-[11px] ${a.severity === "warn" ? "text-amber" : a.severity === "error" ? "text-rose" : "text-muted-foreground"}`}>
                        <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                        <span>{a.msg}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Publisher offline. Rode <span className="mono">node bithub-app/scripts/fake-publisher.mjs</span> em outro terminal para dry-run.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="border-rose/40">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-rose flex items-center gap-1.5">
                <ShieldAlert className="h-4 w-4" />
                Kill-switch
              </CardTitle>
              <Button size="sm" variant="ghost" onClick={() => setKillSwitchOpen(!killSwitchOpen)}>
                {killSwitchOpen ? <X className="h-3 w-3" /> : "Arm"}
              </Button>
            </div>
            <CardDescription>Fecharia todas posições + para todos sessions. Canal real desativado.</CardDescription>
          </CardHeader>
          {killSwitchOpen && (
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="prep-token">Prep-token</Label>
                <Input id="prep-token" value={prepToken} onChange={(e) => setPrepToken(e.target.value)} placeholder="Token gerado localmente" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="kill-phrase">Confirmation phrase</Label>
                <Input id="kill-phrase" value={killPhrase} onChange={(e) => setKillPhrase(e.target.value)} placeholder='Type literally: KILL ALL' />
              </div>
              <Button variant="destructive" onClick={onKillAll} className="w-full">
                <ShieldAlert className="h-3.5 w-3.5" />
                KILL ALL
              </Button>
              {killFeedback && (
                <div className={`text-[11px] p-2 rounded-md border ${killFeedback.kind === "ok" ? "bg-rose/10 border-rose/40 text-rose" : "bg-amber/10 border-amber/40 text-amber"}`}>
                  {killFeedback.msg}
                </div>
              )}
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}

function CheckRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {ok ? <Check className="h-3.5 w-3.5 text-emerald shrink-0" /> : <X className="h-3.5 w-3.5 text-rose shrink-0" />}
      <span className={ok ? "text-foreground" : "text-rose"}>{label}</span>
    </div>
  );
}

function Row({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </span>
      <span className="text-foreground font-medium tabular">{value}</span>
    </div>
  );
}
