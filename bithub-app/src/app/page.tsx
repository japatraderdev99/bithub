import Link from "next/link";
import { Globe2, Library, Sparkles, Rocket, Activity, LineChart, ArrowUpRight } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const PRODUCTS = [
  {
    href: "/panorama",
    icon: Globe2,
    title: "Market Panorama",
    sub: "Como o mercado está agora",
    body: "Indices futuros, setores Bybit, fear & greed, funding rates, manchetes essenciais. Snapshot do contexto antes de abrir uma operação.",
    badge: "Macro",
  },
  {
    href: "/library",
    icon: Library,
    title: "Strategy Library",
    sub: "Suas estratégias validadas",
    body: "Todas as estratégias com backtest persistido — Sharpe, win rate, drawdown, equity curve. Filtros por regime, timeframe, performance.",
    badge: "Registry",
  },
  {
    href: "/advisor",
    icon: Sparkles,
    title: "AI Advisor",
    sub: "Sugestão de setup contextual",
    body: "Você passa preferência (scalp/swing/...), tolerância a risco e horizonte. IA cruza com panorama atual e sugere qual estratégia rodar agora. Suggestion-only.",
    badge: "Sonnet 4.6",
  },
  {
    href: "/launcher",
    icon: Rocket,
    title: "Strategy Launcher",
    sub: "Inicie um run com 1 comando",
    body: "Selecione uma estratégia validada e dispare o comando para o Freqtrade local. Pre-flight de risk envelope, audit log, kill-switch atômico.",
    badge: "Local",
  },
  {
    href: "/cyclical",
    icon: Activity,
    title: "Cyclical AI",
    sub: "Análise em ciclo da operação",
    body: "Enquanto sua estratégia está rodando, IA analisa a cada 2min e sugere ajustes de TP/SL. Apply é manual — IA nunca move ordem sem sua autorização.",
    badge: "Haiku 4.5",
  },
  {
    href: "/cockpit",
    icon: LineChart,
    title: "Cockpit",
    sub: "Workspace de trade ativo",
    body: "Gráfico de candles com indicadores (EMA, ADX, ATR), trade blotter, P&L em tempo real. Read-only — execução continua sendo do Freqtrade.",
    badge: "Live",
  },
];

export default function Home() {
  return (
    <>
      <PageHeader
        title="Welcome to Bithub"
        subtitle="Strategy research platform. Local-first. Audit-friendly. Pick a workflow below."
      />
      <div className="p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {PRODUCTS.map(({ href, icon: Icon, title, sub, body, badge }) => (
            <Link key={href} href={href} className="group">
              <Card className="h-full transition-colors hover:border-foreground/30 hover:bg-secondary/30">
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="rounded-md border border-border p-1.5 bg-secondary/50">
                        <Icon className="h-4 w-4 text-foreground" />
                      </div>
                      <Badge variant="outline">{badge}</Badge>
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{sub}</p>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>

        <div className="mt-8 border-t border-border pt-6">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Hard stops permanentes</h2>
          <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-5">
            <li>Bithub nunca executa ordens — execução é sempre do Freqtrade local.</li>
            <li>AI Advisor e Cyclical são <strong>suggestion-only</strong>; nenhum botão move ordem real.</li>
            <li>Launcher envia apenas <code className="mono text-foreground">{`{strategy_id}`}</code> — sem position size, sem leverage, sem credencial.</li>
            <li>Kill-switch atômico requer prep-token + frase literal &ldquo;KILL ALL&rdquo;.</li>
            <li>Bybit acessada apenas em endpoints públicos (preço, OI, funding). Zero credencial privada na plataforma.</li>
          </ul>
        </div>
      </div>
    </>
  );
}
