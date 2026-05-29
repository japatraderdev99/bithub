import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { CyclicalView } from "./cyclical-view";

export default function CyclicalPage() {
  return (
    <>
      <PageHeader
        title="Cyclical AI"
        subtitle="Haiku 4.5 acompanha sessões ativas em ciclos curtos · Apply sempre manual"
        actions={<Badge variant="amber">No auto-apply · Operator click required</Badge>}
      />
      <div className="p-6">
        <CyclicalView />
      </div>
    </>
  );
}
