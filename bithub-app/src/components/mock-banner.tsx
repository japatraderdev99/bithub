import { AlertTriangle } from "lucide-react";

export function MockBanner() {
  return (
    <div className="flex items-center justify-center gap-2 border-b border-amber/40 bg-amber/10 px-4 py-1.5 text-[11px] font-medium tracking-wide text-amber">
      <AlertTriangle className="h-3.5 w-3.5" />
      <span className="uppercase">Mock mode</span>
      <span className="text-amber/70">— no live exchange data, no real orders, no LLM calls. Read-only preview of the platform UX.</span>
    </div>
  );
}
