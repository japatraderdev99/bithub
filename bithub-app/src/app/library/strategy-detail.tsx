"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Loader2, Pause, Play, Rocket } from "lucide-react";
import equityCurve from "@/data/equity-curve.json";
import { useStrategySummary } from "@/hooks/use-trades";
import type { StrategySummaryRow } from "@/lib/trades-client";
import { formatPct, pnlClass, timeAgo } from "@/lib/utils";
import Link from "next/link";

interface Strategy {
  id: string;
  name: string;
  regime: string;
  timeframe: string;
  pair_universe: string[];
  sharpe: number;
  win_rate_pct: number;
  total_return_pct: number;
  max_dd_pct: number;
  trade_count: number;
  last_backtest_ts: string;
  freqtrade_version: string;
  tags: string[];
  content_hash: string;
  status?: string;
  collection_mode?: string;
  readiness?: string;
  hypothesis?: string;
  timeframes?: {
    regime?: string[];
    setup?: string[];
    trigger?: string[];
  };
  entry_model?: {
    bias?: string;
    anchor?: string;
    ttl_sec?: number;
    volume_min?: number;
    score_min?: number;
  };
  exit_model?: {
    mfe_lock_pct?: number;
    lock_profit_pct?: number;
    soft_sl_tape_contra?: number;
    trail?: string;
  };
  routing_features?: string[];
  next_action?: string;
  is_active?: number;
  activated_at?: string | null;
  activated_by?: string | null;
}

export function StrategyDetail({ strategy }: { strategy: Strategy }) {
  return (
    <div className="mt-4 space-y-5">
      <ActivationCard strategy={strategy} />

      <div className="grid grid-cols-2 gap-3">
        <Metric label="Sharpe" value={strategy.sharpe.toFixed(2)} />
        <Metric label="Win rate" value={`${strategy.win_rate_pct.toFixed(1)}%`} />
        <Metric label="Total return" value={formatPct(strategy.total_return_pct)} tone={pnlClass(strategy.total_return_pct)} />
        <Metric label="Max drawdown" value={`${strategy.max_dd_pct.toFixed(1)}%`} tone="text-rose" />
        <Metric label="Trades" value={strategy.trade_count.toString()} />
        <Metric label="Mode" value={strategy.collection_mode ?? "backtest"} />
      </div>

      {strategy.hypothesis && (
        <div className="rounded-md border border-border bg-secondary/30 p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Hypothesis</p>
          <p className="text-xs leading-relaxed text-foreground/90">{strategy.hypothesis}</p>
          {strategy.next_action && <p className="mt-2 text-[11px] text-muted-foreground">{strategy.next_action}</p>}
        </div>
      )}

      {(strategy.entry_model || strategy.exit_model || strategy.timeframes) && (
        <div className="space-y-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Runtime contract</p>
          {strategy.timeframes && (
            <div className="grid grid-cols-3 gap-2">
              <MiniList label="Regime" values={strategy.timeframes.regime} />
              <MiniList label="Setup" values={strategy.timeframes.setup} />
              <MiniList label="Trigger" values={strategy.timeframes.trigger} />
            </div>
          )}
          {strategy.entry_model && (
            <div className="rounded-md border border-border p-3 space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Entry</p>
              <p className="text-[11px] text-foreground/90">{strategy.entry_model.bias}</p>
              <div className="grid grid-cols-3 gap-2 pt-1">
                <Metric label="Anchor" value={strategy.entry_model.anchor ?? "n/a"} />
                <Metric label="TTL" value={strategy.entry_model.ttl_sec ? `${strategy.entry_model.ttl_sec}s` : "n/a"} />
                <Metric label="Min score" value={strategy.entry_model.score_min?.toString() ?? "n/a"} />
              </div>
            </div>
          )}
          {strategy.exit_model && (
            <div className="rounded-md border border-border p-3 space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Exit</p>
              <p className="text-[11px] text-foreground/90">{strategy.exit_model.trail}</p>
              <div className="flex flex-wrap gap-1 pt-1">
                {strategy.exit_model.mfe_lock_pct !== undefined && <Badge variant="outline">MFE lock {strategy.exit_model.mfe_lock_pct}%</Badge>}
                {strategy.exit_model.lock_profit_pct !== undefined && <Badge variant="outline">lock +{strategy.exit_model.lock_profit_pct}%</Badge>}
                {strategy.exit_model.soft_sl_tape_contra !== undefined && <Badge variant="outline">soft SL tape {Math.round(strategy.exit_model.soft_sl_tape_contra * 100)}%</Badge>}
              </div>
            </div>
          )}
        </div>
      )}

      <ByRegimeSection strategyVersionId={strategy.id} />

      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Equity curve (last backtest)</p>
        <div className="h-40 -mx-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={equityCurve} margin={{ left: 0, right: 4, top: 4, bottom: 4 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={40} />
              <Tooltip
                contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 11 }}
                labelStyle={{ color: "hsl(var(--muted-foreground))" }}
              />
              <Line type="monotone" dataKey="equity" stroke="hsl(var(--emerald))" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <Separator />

      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Pair universe</p>
        <div className="flex flex-wrap gap-1">
          {strategy.pair_universe.map((p) => (
            <span key={p} className="text-[10px] mono text-foreground/90 px-1.5 py-0.5 rounded bg-secondary">
              {p}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Tags</p>
        <div className="flex flex-wrap gap-1">
          {strategy.tags.map((t) => (
            <Badge key={t} variant="muted">{t}</Badge>
          ))}
        </div>
      </div>

      {strategy.routing_features && (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Router features</p>
          <div className="flex flex-wrap gap-1">
            {strategy.routing_features.map((feature) => (
              <Badge key={feature} variant="outline">{feature}</Badge>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Identity</p>
        <div className="space-y-0.5 text-[11px] mono">
          <div className="flex justify-between gap-2"><span className="text-muted-foreground">strategy_id</span><span className="truncate">{strategy.id}</span></div>
          <div className="flex justify-between gap-2"><span className="text-muted-foreground">content_hash</span><span className="truncate">{strategy.content_hash}</span></div>
          <div className="flex justify-between gap-2"><span className="text-muted-foreground">freqtrade</span><span>{strategy.freqtrade_version}</span></div>
          <div className="flex justify-between gap-2"><span className="text-muted-foreground">status</span><span>{strategy.status ?? "published"}</span></div>
          <div className="flex justify-between gap-2"><span className="text-muted-foreground">last_test</span><span>{timeAgo(strategy.last_backtest_ts)}</span></div>
        </div>
      </div>

      <Separator />

      <Link href={`/launcher?strategy=${strategy.id}`}>
        <Button className="w-full" variant="emerald">
          <Rocket className="h-3.5 w-3.5" />
          Send to Launcher
        </Button>
      </Link>
      <p className="text-[10px] text-muted-foreground text-center">
        Spec é content-addressed — qualquer ajuste cria nova versão. Launcher recebe apenas o id.
      </p>
    </div>
  );
}

function ActivationCard({ strategy }: { strategy: Strategy }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = strategy.is_active === 1;
  const mode = strategy.collection_mode ?? "shadow";

  async function toggle() {
    setPending(true);
    setError(null);
    const action = active ? "pause" : "activate";
    try {
      const res = await fetch(`/api/strategies/${encodeURIComponent(strategy.id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: "operator-ui" }),
      });
      const body = await res.json();
      if (!res.ok || body.ok === false) {
        setError(body.reason || body.error || `worker_${res.status}`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  }

  const headline = active
    ? `Ativa em ${mode} — runner pode avaliar`
    : `Pausada — runner ignora esta versão`;
  const sub = active && strategy.activated_at
    ? `Ativada ${timeAgo(strategy.activated_at)}${strategy.activated_by ? ` por ${strategy.activated_by}` : ""}`
    : "Estratégia só roda quando o operador clicar ativar.";

  return (
    <div className={`rounded-md border p-3 ${active ? "border-emerald/40 bg-emerald/10" : "border-amber/40 bg-amber/10"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className={`text-[11px] font-semibold ${active ? "text-emerald" : "text-amber"}`}>{headline}</p>
          <p className="text-[10px] text-muted-foreground">{sub}</p>
          {error && <p className="text-[10px] text-rose">erro: {error}</p>}
        </div>
        <Button
          size="sm"
          variant={active ? "outline" : "emerald"}
          onClick={toggle}
          disabled={pending}
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {pending ? "..." : active ? "Pausar" : `Ativar (${mode})`}
        </Button>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 text-sm font-semibold tabular ${tone ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

function MiniList({ label, values }: { label: string; values?: string[] }) {
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-xs mono text-foreground">{values?.join(" / ") ?? "n/a"}</p>
    </div>
  );
}

// H-RESEARCH-BENCH-002 Superficie 3 — "By Regime".
//
// The Worker today groups by (strategy_id, version_id, mode), not by regime
// bucket. A real per-regime breakdown needs a backend group-by we have not
// landed yet (tracked as gap G6 in the contract review). Until that exists,
// this section shows the summary rows the Worker does return — one per
// collection mode — and is honest about why the per-regime table is not
// here. Mocking it would be worse than the empty state.
function ByRegimeSection({ strategyVersionId }: { strategyVersionId: string }) {
  const since = useMemo(() => {
    const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return d.toISOString().replace(/\.\d+Z$/, "Z");
  }, []);

  const { rows, error, loading } = useStrategySummary({
    strategyVersionId,
    since,
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">By regime</p>
        <span className="text-[9px] text-muted-foreground">últimos 30d · shadow + live</span>
      </div>

      <div className="rounded-md border border-border bg-secondary/20 p-3">
        {loading ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            consultando /strategy-summary…
          </div>
        ) : error ? (
          <p className="text-[11px] text-muted-foreground py-2">
            Worker indisponível — tentar novamente em alguns segundos.
          </p>
        ) : !rows || rows.length === 0 ? (
          <ByRegimeEmpty strategyVersionId={strategyVersionId} />
        ) : (
          <ByRegimeTable rows={rows} />
        )}
      </div>

      <p className="text-[10px] text-muted-foreground">
        Agrupamento atual é por <span className="mono text-foreground/80">mode</span> (shadow/paper/live).
        Tabela cruzada por bucket de regime (
        <span className="mono text-foreground/80">btc_eth_bias × vol_regime</span>
        ) depende de endpoint backend ainda não deployado (gap G6).
      </p>
    </div>
  );
}

function ByRegimeTable({ rows }: { rows: StrategySummaryRow[] }) {
  return (
    <table className="w-full text-[11px]">
      <thead>
        <tr className="text-muted-foreground border-b border-border/40">
          <th className="text-left py-1 font-normal text-[10px] uppercase tracking-wider">Mode</th>
          <th className="text-right py-1 font-normal text-[10px] uppercase tracking-wider">Signals</th>
          <th className="text-right py-1 font-normal text-[10px] uppercase tracking-wider">Entered</th>
          <th className="text-right py-1 font-normal text-[10px] uppercase tracking-wider">Win %</th>
          <th className="text-right py-1 font-normal text-[10px] uppercase tracking-wider">Avg PnL %</th>
          <th className="text-right py-1 font-normal text-[10px] uppercase tracking-wider">Sample</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const bucket = sampleBucket(r.entered);
          const winRate = computeWinRate(r);
          const colorPnl = bucket === "small" || bucket === "empty" ? "text-muted-foreground" : pnlClass(r.avg_pnl_pct ?? 0);
          const rowTone = bucket === "small" || bucket === "empty" ? "text-muted-foreground" : "text-foreground/90";
          return (
            <tr key={`${r.version_id}-${r.mode}`} className={`border-b border-border/20 last:border-b-0 ${rowTone}`}>
              <td className="py-1">
                <Badge variant={modeTone(r.mode)} className="text-[9px]">{r.mode}</Badge>
              </td>
              <td className="text-right tabular mono">{r.signals}</td>
              <td className="text-right tabular mono">{r.entered}</td>
              <td className="text-right tabular mono">{winRate != null ? `${winRate.toFixed(1)}%` : "—"}</td>
              <td className={`text-right tabular mono ${colorPnl}`}>
                {r.avg_pnl_pct != null ? formatPct(r.avg_pnl_pct) : "—"}
              </td>
              <td className="text-right">
                <SampleBadge bucket={bucket} n={r.entered} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ByRegimeEmpty({ strategyVersionId }: { strategyVersionId: string }) {
  return (
    <div className="text-[11px] text-muted-foreground space-y-1.5 py-2">
      <p>Sem sinais agregados para esta versão ainda.</p>
      <p>
        Possíveis causas:
      </p>
      <ul className="list-disc pl-4 space-y-0.5">
        <li>
          <span className="mono text-foreground/80">strategy_versions</span> ainda não tem registro
          para <span className="mono text-foreground/80">{strategyVersionId}</span>
        </li>
        <li>shadow farm não rodou tempo suficiente (default: aguardar 5-7 dias)</li>
        <li>publisher ainda não envia <span className="mono text-foreground/80">strategy_signals</span> (gap H-RESEARCH-BENCH-003)</li>
      </ul>
    </div>
  );
}

type SampleBucketKind = "empty" | "small" | "ok" | "solid";

function sampleBucket(entered: number): SampleBucketKind {
  if (entered <= 0) return "empty";
  if (entered < 30) return "small";
  if (entered < 100) return "ok";
  return "solid";
}

function SampleBadge({ bucket, n }: { bucket: SampleBucketKind; n: number }) {
  const label = bucket === "empty" ? "—" : `${bucket} (n=${n})`;
  const tone: "muted" | "outline" | "emerald" =
    bucket === "solid" ? "emerald" : bucket === "ok" ? "outline" : "muted";
  return <Badge variant={tone} className="text-[9px]">{label}</Badge>;
}

function modeTone(mode: string): "emerald" | "amber" | "outline" | "muted" {
  if (mode === "live") return "emerald";
  if (mode === "live_canary" || mode === "paper") return "amber";
  if (mode === "backtest") return "outline";
  return "muted"; // shadow
}

function computeWinRate(r: StrategySummaryRow): number | null {
  if (r.winners == null || r.losers == null) return null;
  const total = r.winners + r.losers;
  if (total === 0) return null;
  return (r.winners / total) * 100;
}
