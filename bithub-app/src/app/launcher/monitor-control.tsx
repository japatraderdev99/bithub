"use client";
import { useEffect, useState } from "react";
import { Play, Square, Loader2, Check, X, AlertTriangle, Fingerprint, Activity, ShieldCheck } from "lucide-react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface PreflightCheck { id: string; label: string; ok: boolean; detail?: string; blocking: boolean; }
interface PreflightResponse {
  ok: boolean;
  checks: PreflightCheck[];
  snapshot: { balance_usdt: number; open_count: number } | null;
  presets_available: string[];
}

interface StatusResponse {
  ok: true;
  running: boolean;
  external_running?: boolean;
  external_pids?: number[];
  pid: number | null;
  started_at: string | null;
  preset: string | null;
  watchdog: { configured: boolean; alive: boolean; pid: number | null };
  auth: { registered: boolean; count: number };
  recent_audit: Array<{ ts: string; event: string; pid?: number; preset?: string; reason?: string }>;
}

const PRESET_LABELS: Record<string, { label: string; sub: string; risk: string }> = {
  aggressive: { label: "Aggressive", sub: "atual exec_bybit", risk: "RISK 0.40 · LEV 50 · 3 slots" },
  overnight: { label: "Overnight (sleep-safe)", sub: "noite supervisionada", risk: "RISK 0.20 · LEV 20 · 2 slots" },
  conservative: { label: "Conservative", sub: "teste mínimo", risk: "RISK 0.10 · LEV 10 · 1 slot" },
};

export function MonitorControl() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [preset, setPreset] = useState("overnight");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err" | "info"; msg: string } | null>(null);

  async function refreshStatus() {
    try {
      const r = await fetch("/api/launcher/monitor/status", { cache: "no-store" });
      setStatus((await r.json()) as StatusResponse);
    } catch { /* noop */ }
  }
  async function refreshPreflight() {
    try {
      const r = await fetch("/api/launcher/monitor/preflight", { cache: "no-store" });
      setPreflight((await r.json()) as PreflightResponse);
    } catch { /* noop */ }
  }

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      fetch("/api/launcher/monitor/status", { cache: "no-store" }).then((r) => r.json() as Promise<StatusResponse>),
      fetch("/api/launcher/monitor/preflight", { cache: "no-store" }).then((r) => r.json() as Promise<PreflightResponse>),
    ]).then(([nextStatus, nextPreflight]) => {
      if (!mounted) return;
      setStatus(nextStatus);
      setPreflight(nextPreflight);
    }).catch(() => { /* noop */ });
    const t = setInterval(() => { refreshStatus(); }, 3000);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, []);

  async function registerTouchID() {
    setBusy(true); setFlash(null);
    try {
      const opt = await fetch("/api/launcher/auth/register-options", { method: "POST" });
      const opts = await opt.json();
      const att = await startRegistration({ optionsJSON: opts });
      const v = await fetch("/api/launcher/auth/register-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(att),
      });
      const ver = await v.json();
      if (!ver.ok) throw new Error(ver.reason ?? "unknown");
      setFlash({ kind: "ok", msg: "Touch ID registrado com sucesso. Você pode usá-lo agora pra ligar/desligar o monitor." });
      await refreshStatus();
    } catch (e) {
      setFlash({ kind: "err", msg: `Registro falhou: ${(e as Error).message}` });
    } finally { setBusy(false); }
  }

  async function authenticateThenAction(action: "start" | "stop") {
    setBusy(true); setFlash(null);
    try {
      // 1. Get assertion options
      const opt = await fetch("/api/launcher/auth/login-options", { method: "POST" });
      if (opt.status === 404) throw new Error("Touch ID não cadastrado ainda — registre primeiro.");
      const opts = await opt.json();
      // 2. Prompt biometric
      const assertion = await startAuthentication({ optionsJSON: opts });
      // 3. Verify and get intent token
      const v = await fetch("/api/launcher/auth/login-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(assertion),
      });
      const ver = await v.json();
      if (!ver.ok) throw new Error(ver.reason ?? "auth_failed");

      // 4. Execute action
      const url = `/api/launcher/monitor/${action}`;
      const payload = action === "start"
        ? { intent_token: ver.intent_token, preset, spawn_watchdog: true, watchdog_autorestart: true }
        : { intent_token: ver.intent_token };
      const exec = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const out = await exec.json();
      if (!out.ok) throw new Error(out.reason ?? "execution_failed");

      const summary = action === "start"
        ? `Monitor iniciado · PID ${out.pid}${out.watchdog_pid ? ` · watchdog PID ${out.watchdog_pid}` : ""}`
        : `Monitor parado · PID ${out.pid}`;
      setFlash({ kind: "ok", msg: summary });
      await refreshStatus();
      await refreshPreflight();
    } catch (e) {
      setFlash({ kind: "err", msg: `${action.toUpperCase()} falhou: ${(e as Error).message}` });
    } finally { setBusy(false); }
  }

  const isRegistered = !!status?.auth.registered;
  const isRunning = !!status?.running || !!status?.external_running;
  const blockingFailed = !!(preflight && !preflight.ok);

  return (
    <div className="space-y-3">
      {/* Touch ID setup */}
      {status && !isRegistered && (
        <Card className="border-amber/40">
          <CardContent className="p-4 flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Fingerprint className="h-4 w-4 text-amber" />
                Touch ID não cadastrado
              </div>
              <p className="text-xs text-muted-foreground">
                Antes de poder ligar/desligar o monitor da UI, você precisa cadastrar a biometria local (1 vez só).
              </p>
            </div>
            <Button onClick={registerTouchID} disabled={busy} variant="default">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Fingerprint className="h-4 w-4" /> Registrar</>}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Status */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Monitor v4
              {isRunning ? (
                <Badge variant="emerald" className="gap-1"><Check className="h-2.5 w-2.5" /> running</Badge>
              ) : (
                <Badge variant="muted">offline</Badge>
              )}
              {status?.watchdog.alive && <Badge variant="amber" className="gap-1"><ShieldCheck className="h-2.5 w-2.5" /> watchdog</Badge>}
            </CardTitle>
            <CardDescription className="text-[10px] mono tabular">
              {status?.running && status.pid ? `PID ${status.pid} · preset ${status.preset} · since ${status.started_at?.split("T")[1]?.split(".")[0]}` : "aguardando comando"}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Preset selector */}
          {!isRunning && (
            <div className="space-y-1.5">
              <Label htmlFor="preset">Configuração</Label>
              <Select value={preset} onValueChange={setPreset} disabled={busy}>
                <SelectTrigger id="preset"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PRESET_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v.label} <span className="text-[10px] mono text-muted-foreground ml-2">— {v.risk}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">
                ⚠ presets são informativos no audit log. Os parâmetros reais vêm de <span className="mono">exec_bybit.py</span> em disco.
              </p>
            </div>
          )}

          {/* Preflight */}
          {preflight && !isRunning && (
            <div className="rounded-md border border-border bg-secondary/30 p-3 space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Pre-flight checks</p>
              {preflight.checks.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-xs">
                  {c.ok ? <Check className="h-3 w-3 text-emerald" /> : <X className={`h-3 w-3 ${c.blocking ? "text-rose" : "text-amber"}`} />}
                  <span className={c.ok ? "text-foreground" : c.blocking ? "text-rose" : "text-amber"}>{c.label}</span>
                  {c.detail && <span className="text-muted-foreground text-[10px]">— {c.detail}</span>}
                </div>
              ))}
              {preflight.snapshot && (
                <p className="text-[10px] text-muted-foreground pt-1 border-t border-border/40 mt-2">
                  Saldo Bybit (último snapshot): <span className="text-foreground tabular mono">${preflight.snapshot.balance_usdt.toFixed(2)}</span> · {preflight.snapshot.open_count} pos abertas
                </p>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            {!isRunning ? (
              <Button
                onClick={() => authenticateThenAction("start")}
                disabled={busy || !isRegistered || blockingFailed}
                variant="emerald"
                className="flex-1"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Fingerprint className="h-4 w-4" /><Play className="h-3.5 w-3.5" /> Touch ID + Start</>}
              </Button>
            ) : (
              <Button
                onClick={() => authenticateThenAction("stop")}
                disabled={busy}
                variant="destructive"
                className="flex-1"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Fingerprint className="h-4 w-4" /><Square className="h-3.5 w-3.5" /> Touch ID + Stop</>}
              </Button>
            )}
            <Button onClick={() => { refreshStatus(); refreshPreflight(); }} variant="ghost" size="sm" disabled={busy}>
              refresh
            </Button>
          </div>

          {flash && (
            <div className={`text-xs p-2 rounded-md border flex items-start gap-1.5 ${
              flash.kind === "ok" ? "bg-emerald/10 border-emerald/40 text-emerald" :
              flash.kind === "err" ? "bg-rose/10 border-rose/40 text-rose" :
              "bg-amber/10 border-amber/40 text-amber"
            }`}>
              {flash.kind === "err" && <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />}
              <span>{flash.msg}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Audit log */}
      {status?.recent_audit && status.recent_audit.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Audit log</CardTitle>
            <CardDescription>Últimos 20 eventos do launcher</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div className="divide-y divide-border/30 max-h-[280px] overflow-y-auto">
              {[...status.recent_audit].reverse().map((e, i) => (
                <div key={i} className="px-4 py-1.5 grid grid-cols-[80px_140px_1fr] gap-2 text-[10px] mono items-center">
                  <span className="text-muted-foreground tabular">{e.ts.split("T")[1]?.split(".")[0]}</span>
                  <Badge variant={
                    e.event.endsWith("success") || e.event.endsWith("ok") ? "emerald" :
                    e.event.includes("fail") || e.event.includes("verify_fail") ? "rose" :
                    e.event.includes("initiated") || e.event === "auth_challenge" ? "amber" :
                    "muted"
                  } className="text-[9px]">{e.event}</Badge>
                  <span className="text-muted-foreground truncate">
                    {e.pid && `pid ${e.pid} `}
                    {e.preset && `preset ${e.preset} `}
                    {e.reason && `· ${e.reason}`}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
