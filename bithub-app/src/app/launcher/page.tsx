import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { MonitorControl } from "./monitor-control";
import { SafetyState } from "./safety-state";
import { LauncherPanel } from "./launcher-panel";

export default function LauncherPage() {
  return (
    <>
      <PageHeader
        title="Strategy Launcher"
        subtitle="Controle do monitor v4 com Touch ID + envio de comandos para o Freqtrade."
        actions={<Badge variant="amber">Local · Touch ID gated</Badge>}
      />
      <div className="p-6 space-y-6">
        <section>
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Monitor control</h2>
          <MonitorControl />
        </section>

        <section>
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Safety daemons (live state)</h2>
          <SafetyState />
        </section>

        <section>
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Strategy command (read-only por enquanto)</h2>
          <Suspense fallback={<div className="text-xs text-muted-foreground">Loading launcher…</div>}>
            <LauncherPanel />
          </Suspense>
        </section>
      </div>
    </>
  );
}
