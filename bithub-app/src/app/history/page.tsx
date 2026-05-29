import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { HistoryView } from "./history-view";

export default function HistoryPage() {
  return (
    <>
      <PageHeader
        title="Histórico"
        subtitle="Trades fechados e eventos do monitor v4 · persistido em Cloudflare D1"
        actions={<Badge variant="outline" className="gap-1.5">Cloudflare D1</Badge>}
      />
      <div className="p-6">
        <HistoryView />
      </div>
    </>
  );
}
