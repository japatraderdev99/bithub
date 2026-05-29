import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { AdvisorForm } from "./advisor-form";

export default function AdvisorPage() {
  return (
    <>
      <PageHeader
        title="AI Advisor"
        subtitle="Sonnet 4.6 cruza seu contexto com o panorama atual e a Library — suggestion-only, sempre."
        actions={<Badge variant="amber">Suggestion only · IA nunca executa</Badge>}
      />
      <div className="p-6">
        <AdvisorForm />
      </div>
    </>
  );
}
