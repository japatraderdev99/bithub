import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LiveKPIs } from "./live-kpis";
import { LiveFundingRates } from "./live-funding";
import { LiveCryptoMarket } from "./live-crypto-market";
import { LiveMacroIndicators } from "./live-macro-indicators";
import { LiveEventRiskNews } from "./live-event-risk-news";
import { LiveCrossAsset } from "./live-cross-asset";
import { LiveFearGreed } from "./live-fear-greed";
import { formatCompact } from "@/lib/utils";
import panorama from "@/data/panorama.json";
import { RefreshCw } from "lucide-react";

export default function PanoramaPage() {
  return (
    <>
      <PageHeader
        title="Market Panorama"
        subtitle="KPIs e funding: Bybit pública · macro: FRED · event risk: News RSS"
        actions={
          <Badge variant="outline" className="gap-1.5">
            <RefreshCw className="h-3 w-3" />
            Refresh 30s
          </Badge>
        }
      />
      <div className="p-6 space-y-6">
        <section>
          <LiveKPIs />
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Cross-asset tape</h2>
            <Badge variant="outline">Yahoo 60s cache</Badge>
          </div>
          <LiveCrossAsset />
        </section>

        <section>
          <LiveCryptoMarket fallbackSectors={panorama.bybit_sectors} />
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Funding rates — 8h</CardTitle>
              <CardDescription>Live · Bybit pública (sem credencial)</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <LiveFundingRates />
            </CardContent>
          </Card>
          <LiveFearGreed />
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Macro regime · FRED</h2>
            <Badge variant="outline">hourly cache</Badge>
          </div>
          <LiveMacroIndicators fallback={panorama.indices} />
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Event risk · headlines</h2>
            <Badge variant="outline">News RSS 5m cache</Badge>
          </div>
          <LiveEventRiskNews fallback={panorama.news_headlines} />
          <p className="mt-3 text-[10px] text-muted-foreground">
            Volume agregado: {formatCompact(panorama.bybit_sectors.reduce((sum, s) => sum + s.volume_24h_usd, 0))} USD em {panorama.bybit_sectors.length} setores monitorados.
          </p>
        </section>
      </div>
    </>
  );
}
