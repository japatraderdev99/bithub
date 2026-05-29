"use client";
import { AlertCircle, CircleDot, Loader2 } from "lucide-react";

interface Props {
  ok: boolean;
  reason?: string;
  ageMs?: number;
  loading?: boolean;
}

export function PublisherStatus({ ok, reason, ageMs, loading }: Props) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Conectando ao monitor…
      </span>
    );
  }
  if (!ok) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-amber">
        <AlertCircle className="h-3 w-3" />
        Publisher offline — {reason ?? "no data"}
      </span>
    );
  }
  const fresh = (ageMs ?? 0) < 10000;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider ${fresh ? "text-emerald" : "text-amber"}`}>
      <CircleDot className={`h-3 w-3 ${fresh ? "" : "opacity-50"}`} />
      Live · {ageMs != null ? `${Math.round(ageMs / 100) / 10}s` : "—"}
    </span>
  );
}
