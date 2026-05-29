"use client";
import { useState } from "react";
import { Sparkles, Loader2, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { sleep } from "@/lib/utils";
import advisorData from "@/data/advisor-mocks.json";
import strategies from "@/data/strategies.json";
import Link from "next/link";

type Suggestion = typeof advisorData.responses[number]["suggestion"];

export function AdvisorForm() {
  const [regime, setRegime] = useState("scalp");
  const [risk, setRisk] = useState("balanced");
  const [horizon, setHorizon] = useState("intraday");
  const [loading, setLoading] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [history, setHistory] = useState<Array<{ when: string; suggestion: Suggestion }>>([]);

  async function onSubmit() {
    setLoading(true);
    setSuggestion(null);
    await sleep(800);
    const match = advisorData.responses.find(
      (r) => r.match.regime_preference === regime && r.match.risk_tolerance === risk
    );
    const result = match ? match.suggestion : advisorData.default_response;
    setSuggestion(result);
    setHistory((h) => [{ when: new Date().toISOString(), suggestion: result }, ...h.slice(0, 4)]);
    setLoading(false);
  }

  const matchedStrategy = suggestion ? strategies.find((s) => s.id === suggestion.strategy_id) : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle>Contexto</CardTitle>
          <CardDescription>O que você quer agora?</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="regime">Regime preference</Label>
            <Select value={regime} onValueChange={setRegime}>
              <SelectTrigger id="regime"><SelectValue /></SelectTrigger>
              <SelectContent>
                {advisorData.context_options.regime_preference.map((o) => (
                  <SelectItem key={o} value={o}>{o}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="risk">Risk tolerance</Label>
            <Select value={risk} onValueChange={setRisk}>
              <SelectTrigger id="risk"><SelectValue /></SelectTrigger>
              <SelectContent>
                {advisorData.context_options.risk_tolerance.map((o) => (
                  <SelectItem key={o} value={o}>{o}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="horizon">Time horizon</Label>
            <Select value={horizon} onValueChange={setHorizon}>
              <SelectTrigger id="horizon"><SelectValue /></SelectTrigger>
              <SelectContent>
                {advisorData.context_options.time_horizon.map((o) => (
                  <SelectItem key={o} value={o}>{o}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Separator />

          <Button onClick={onSubmit} disabled={loading} className="w-full" variant="default">
            {loading ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Consultando IA…</>
            ) : (
              <><Sparkles className="h-4 w-4" /> Get suggestion</>
            )}
          </Button>

          <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex justify-between border-t border-border pt-3">
            <span>Budget mês</span>
            <span className="mono">${advisorData.budget_status.spent_this_month_usd.toFixed(2)} / ${advisorData.budget_status.monthly_cap_usd}</span>
          </div>
          <div className="text-[10px] text-muted-foreground flex justify-between">
            <span>Advisor restante</span>
            <span className="mono text-foreground">${advisorData.budget_status.advisor_remaining_usd.toFixed(2)}</span>
          </div>
        </CardContent>
      </Card>

      <div className="lg:col-span-2 space-y-4">
        {!suggestion && !loading && (
          <Card>
            <CardContent className="p-8 text-center space-y-2">
              <Sparkles className="h-8 w-8 text-muted-foreground mx-auto" />
              <p className="text-sm text-foreground font-medium">Nenhuma sugestão ainda</p>
              <p className="text-xs text-muted-foreground max-w-md mx-auto">
                Selecione seu contexto à esquerda e clique <strong className="text-foreground">Get suggestion</strong>. A IA cruza com o panorama atual e sugere a estratégia mais alinhada da Library.
              </p>
            </CardContent>
          </Card>
        )}

        {loading && (
          <Card>
            <CardContent className="p-8 text-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mx-auto" />
              <p className="mt-3 text-xs text-muted-foreground">Sonnet 4.6 cruzando panorama × seu contexto × Library…</p>
            </CardContent>
          </Card>
        )}

        {suggestion && (
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">{suggestion.headline}</CardTitle>
                  <CardDescription className="mt-1">
                    {matchedStrategy ? `${matchedStrategy.regime} · ${matchedStrategy.timeframe} · ${matchedStrategy.pair_universe.length} pairs` : "—"}
                  </CardDescription>
                </div>
                <Badge variant="amber" className="shrink-0">Suggestion only</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs leading-relaxed text-foreground/90">{suggestion.rationale}</p>

              <div className="grid grid-cols-3 gap-2 text-[10px]">
                <Metric label="Confidence" value={`${(suggestion.confidence * 100).toFixed(0)}%`} />
                <Metric label="Model" value={suggestion.model.split("/")[1] ?? suggestion.model} mono />
                <Metric label="Cost this call" value={`$${suggestion.cost_usd.toFixed(3)}`} mono />
              </div>

              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Riscos identificados</p>
                <ul className="space-y-1">
                  {suggestion.key_risks.map((r, i) => (
                    <li key={i} className="text-xs text-amber/90 flex gap-1.5">
                      <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Strategy sugerida</span>
                {matchedStrategy && (
                  <Link href={`/launcher?strategy=${matchedStrategy.id}`}>
                    <Button size="sm" variant="emerald">Send to Launcher</Button>
                  </Link>
                )}
              </div>

              <p className="text-[10px] text-muted-foreground">
                IA nunca dispara comando direto. Decisão final é sua — Launcher recebe apenas o {`{strategy_id}`}.
              </p>
            </CardContent>
          </Card>
        )}

        {history.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Histórico</CardTitle>
              <CardDescription>Últimas {history.length} sugestões nesta sessão</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {history.map((h, i) => (
                <div key={i} className="flex items-center justify-between border-b border-border/40 last:border-b-0 pb-1.5 last:pb-0">
                  <div className="min-w-0">
                    <p className="text-xs truncate">{h.suggestion.headline}</p>
                    <p className="text-[10px] text-muted-foreground">{new Date(h.when).toLocaleTimeString()}</p>
                  </div>
                  <span className="text-[10px] mono text-muted-foreground shrink-0">${h.suggestion.cost_usd.toFixed(3)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-2">
      <p className="uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-xs font-semibold text-foreground ${mono ? "mono" : "tabular"}`}>{value}</p>
    </div>
  );
}
