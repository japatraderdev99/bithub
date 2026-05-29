import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { MacroBar } from "./macro-bar";
import { RegimeBanner } from "./regime-banner";
import { ActivePositions } from "./active-positions";
import { EntryFunnel } from "./entry-funnel";
import { EventTail } from "./event-tail";
import { MarketHeatmap } from "./market-heatmap";
import { CockpitProvider } from "./cockpit-context";

export default function CockpitPage() {
  return (
    <CockpitProvider>
      <PageHeader
        title="Cockpit"
        subtitle="Bithub institutional cockpit · monitor v4 live · vitrine operacional do Registry"
        actions={<Badge variant="outline">Read-only · Bithub orchestrates, monitor executes</Badge>}
      />
      <div className="p-3 space-y-3">
        {/* Zone 0: regime banner (Research Bench context) */}
        <RegimeBanner />

        {/* Zone 1: macro context bar */}
        <MacroBar />

        {/* Zone 2: active positions (foco visual primário, Codex 2026-05-28) */}
        <ActivePositions />

        {/* Zone 3: entry funnel — primary candidate surface com motivos de rejeição */}
        <EntryFunnel />

        {/* Zone 4: market heatmap — auxiliar, colapsado por default */}
        <MarketHeatmap />

        {/* Zone 5: event tail */}
        <EventTail />

        <p className="text-[10px] text-muted-foreground text-center pt-2">
          Ordens executadas pelo Freqtrade local. Bithub observa via state publisher.
        </p>
      </div>
    </CockpitProvider>
  );
}
