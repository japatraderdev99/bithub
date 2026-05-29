"use client";
import { useMemo, useState } from "react";
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from "recharts";
import { Cloud, AlertCircle, Loader2, ScrollText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useTrades, useStats } from "@/hooks/use-trades";
import { DecisionTrail } from "@/components/decision-trail";
import { formatPct, formatPrice, pnlClass, timeAgo } from "@/lib/utils";

export function HistoryView() {
  const [symbol, setSymbol] = useState("");
  const [limit, setLimit] = useState(100);
  const { trades, loading, error } = useTrades(symbol || undefined, undefined, limit);
  const { stats } = useStats();

  // Equity curve preferentially uses net PnL (gross - fees - funding) when
  // a trade has it; falls back to gross for older rows that pre-date Gate B
  // backfill. The chart will smoothly transition once backfill completes.
  const equityCurve = useMemo(() => {
    if (!stats?.recent) return [];
    let cum = 0;
    return stats.recent.map((p) => {
      const delta = p.pnl_net_usd ?? p.pnl_abs ?? 0;
      cum += delta;
      return { ts: p.ts, equity: parseFloat(cum.toFixed(4)) };
    });
  }, [stats]);

  return (
    <div className="space-y-4">
      {error && (
        <Card className="border-rose/40">
          <CardContent className="p-4 flex items-center gap-2 text-rose">
            <AlertCircle className="h-4 w-4" />
            <span className="text-xs">Worker indisponível: {error}</span>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI label="Total trades" value={stats?.overall?.total_trades?.toString() ?? "—"} />
        <KPI label="Win rate" value={stats?.overall && stats.overall.total_trades > 0 ? `${((stats.overall.winners ?? 0) / stats.overall.total_trades * 100).toFixed(1)}%` : "—"} />
        <KPI label="Gross PnL $" value={stats?.overall?.total_pnl_abs != null ? `$${stats.overall.total_pnl_abs.toFixed(2)}` : "—"} accent={pnlClass(stats?.overall?.total_pnl_abs ?? 0)} />
        <KPI
          label={
            stats?.overall?.total_pnl_net_usd != null
              ? `Net PnL $ (− $${(stats.overall.total_fee_usd ?? 0).toFixed(2)} fees)`
              : "Net PnL $"
          }
          value={stats?.overall?.total_pnl_net_usd != null ? `$${stats.overall.total_pnl_net_usd.toFixed(2)}` : "—"}
          accent={pnlClass(stats?.overall?.total_pnl_net_usd ?? 0)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Equity curve (cumulative PnL)</CardTitle>
          <CardDescription>Últimas {equityCurve.length} trades fechadas · ordem cronológica</CardDescription>
        </CardHeader>
        <CardContent>
          {equityCurve.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground py-8">Nenhuma trade fechada ainda no histórico.</p>
          ) : (
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={equityCurve} margin={{ left: 0, right: 4, top: 4, bottom: 4 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="ts" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} hide />
                  <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={50} />
                  <Tooltip
                    contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 11 }}
                    labelFormatter={(ts) => new Date(ts as string).toLocaleString()}
                    formatter={(v) => [`$${(v as number).toFixed(4)}`, "Equity"]}
                  />
                  <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="2 2" />
                  <Line type="monotone" dataKey="equity" stroke="hsl(var(--emerald))" strokeWidth={1.8} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <div className="space-y-1.5">
            <Label htmlFor="symbol-filter">Symbol</Label>
            <Input id="symbol-filter" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="e.g. BTCUSDT" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="limit-filter">Limit</Label>
            <Input id="limit-filter" type="number" min={10} max={1000} value={limit} onChange={(e) => setLimit(parseInt(e.target.value) || 100)} />
          </div>
          <div className="text-[10px] text-muted-foreground">
            <Cloud className="h-3 w-3 inline mr-1" />
            Cloudflare D1 · ENAM region · idempotência via client_trade_id
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Histórico de trades</CardTitle>
          <CardDescription>{loading ? "Carregando…" : `${trades?.length ?? 0} trades`}</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {loading ? (
            <div className="px-4 py-8 flex justify-center text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
          ) : !trades || trades.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">
              Sem trades ainda. Quando o monitor v4 fechar uma posição, ela aparece aqui.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-secondary/30">
                    <th className="text-left px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">When</th>
                    <th className="text-left px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Symbol</th>
                    <th className="text-left px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Side</th>
                    <th className="text-right px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Entry</th>
                    <th className="text-right px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Exit</th>
                    <th className="text-right px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Qty</th>
                    <th className="text-right px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">PnL %</th>
                    <th className="text-right px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Gross $</th>
                    <th className="text-right px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Net $</th>
                    <th className="text-right px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Fee $</th>
                    <th className="text-left px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Reason</th>
                    <th className="text-right px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Duration</th>
                    <th className="text-right px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Trail</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.client_trade_id} className="border-b border-border/30 last:border-b-0 hover:bg-secondary/20">
                      <td className="px-4 py-2 text-[11px] text-muted-foreground">{timeAgo(t.ts_entry)}</td>
                      <td className="px-4 py-2 text-xs font-medium mono">{t.symbol}</td>
                      <td className="px-4 py-2">
                        <Badge variant={t.side === "long" ? "emerald" : "rose"}>{t.side}</Badge>
                      </td>
                      <td className="px-4 py-2 text-right text-xs mono tabular">{formatPrice(t.entry)}</td>
                      <td className="px-4 py-2 text-right text-xs mono tabular">{t.exit != null ? formatPrice(t.exit) : "—"}</td>
                      <td className="px-4 py-2 text-right text-xs mono tabular text-muted-foreground">{t.qty}</td>
                      <td className={`px-4 py-2 text-right text-xs mono tabular font-medium ${pnlClass(t.pnl_pct ?? 0)}`}>
                        {t.pnl_pct != null ? formatPct(t.pnl_pct) : "—"}
                      </td>
                      <td className={`px-4 py-2 text-right text-xs mono tabular ${pnlClass(t.pnl_abs ?? 0)}`}>
                        {t.pnl_abs != null ? `$${t.pnl_abs.toFixed(2)}` : "—"}
                      </td>
                      <td className={`px-4 py-2 text-right text-xs mono tabular font-medium ${pnlClass(t.pnl_net_usd ?? 0)}`}>
                        {t.pnl_net_usd != null ? `$${t.pnl_net_usd.toFixed(2)}` : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right text-[10px] mono text-muted-foreground tabular">
                        {t.fee_usd != null ? `$${t.fee_usd.toFixed(3)}` : "—"}
                      </td>
                      <td className="px-4 py-2 text-[10px] text-muted-foreground">{t.exit_reason ?? "—"}</td>
                      <td className="px-4 py-2 text-right text-[10px] mono text-muted-foreground">
                        {t.duration_sec != null ? `${Math.floor(t.duration_sec / 60)}m ${t.duration_sec % 60}s` : "—"}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Sheet>
                          <SheetTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]">
                              <ScrollText className="h-3 w-3" />
                            </Button>
                          </SheetTrigger>
                          <SheetContent>
                            <SheetHeader>
                              <SheetTitle>Decision trail — {t.symbol}</SheetTitle>
                              <SheetDescription>
                                Lifecycle events para <span className="mono">{t.client_trade_id}</span>
                              </SheetDescription>
                            </SheetHeader>
                            <div className="mt-4">
                              <DecisionTrail clientTradeId={t.client_trade_id} />
                            </div>
                          </SheetContent>
                        </Sheet>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {stats?.by_symbol && stats.by_symbol.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Performance por símbolo</CardTitle>
            <CardDescription>Top 20 símbolos por número de trades</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-secondary/30">
                  <th className="text-left px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Symbol</th>
                  <th className="text-right px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Trades</th>
                  <th className="text-right px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">PnL %</th>
                </tr>
              </thead>
              <tbody>
                {stats.by_symbol.map((s) => (
                  <tr key={s.symbol} className="border-b border-border/30 last:border-b-0 hover:bg-secondary/20">
                    <td className="px-4 py-2 text-xs mono">{s.symbol}</td>
                    <td className="px-4 py-2 text-right text-xs tabular">{s.n}</td>
                    <td className={`px-4 py-2 text-right text-xs mono tabular ${pnlClass(s.pnl_total ?? 0)}`}>
                      {s.pnl_total != null ? formatPct(s.pnl_total) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function KPI({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={`mt-1 text-lg font-semibold tabular ${accent ?? "text-foreground"}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
