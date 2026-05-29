"use client";
import { Badge } from "@/components/ui/badge";
import { useCurrentRegime } from "@/hooks/use-trades";

// H-RESEARCH-BENCH-002 Superficie 1 — context banner for the Research Bench.
// Reads /regime/current (Worker computes staleness_sec/is_stale, so all UIs
// see the same state). Never colors by bias — color is reserved for freshness
// and health, not for direction.
export function RegimeBanner() {
  const { data, loading } = useCurrentRegime(30000);

  if (loading && !data) {
    return (
      <BannerShell tone="muted">
        <span className="text-muted-foreground">REGIME</span>
        <span className="text-muted-foreground">carregando…</span>
      </BannerShell>
    );
  }

  // Empty state: Worker reached but no snapshot in D1 yet (regime: null).
  if (!data || !data.regime) {
    return (
      <BannerShell tone="muted">
        <span className="text-muted-foreground">REGIME</span>
        <span className="text-muted-foreground">
          classifier offline · rodar <code className="mono text-foreground/80">regime-classifier.mjs</code>
        </span>
      </BannerShell>
    );
  }

  const { regime, staleness_sec, is_stale, degraded, degraded_reason } = data;
  const buckets = formatBuckets(regime);
  const freshness = formatFreshness(staleness_sec);

  if (degraded) {
    return (
      <BannerShell tone="rose">
        <span className="font-semibold text-foreground tracking-wider text-[10px] uppercase">REGIME</span>
        <BucketList items={buckets} muted />
        <Badge variant="rose" className="text-[9px]">degraded</Badge>
        <Detail>
          {degraded_reason ? humanReason(degraded_reason) : "snapshot incompleto, classifier rodando com dado insuficiente"}
        </Detail>
      </BannerShell>
    );
  }

  if (is_stale) {
    return (
      <BannerShell tone="amber">
        <span className="font-semibold text-foreground tracking-wider text-[10px] uppercase">REGIME</span>
        <BucketList items={buckets} />
        <Badge variant="amber" className="text-[9px]">STALE</Badge>
        <Detail>
          {staleness_sec != null
            ? `snapshot de ${formatStaleness(staleness_sec)} atras — classifier pode estar parado`
            : "snapshot antigo — verificar classifier"}
        </Detail>
      </BannerShell>
    );
  }

  return (
    <BannerShell tone="default">
      <span className="font-semibold text-foreground tracking-wider text-[10px] uppercase">REGIME</span>
      <BucketList items={buckets} />
      {freshness && <span className="text-[10px] text-muted-foreground tabular mono">{freshness}</span>}
    </BannerShell>
  );
}

interface BannerShellProps {
  tone: "default" | "muted" | "amber" | "rose";
  children: React.ReactNode;
}
function BannerShell({ tone, children }: BannerShellProps) {
  const border =
    tone === "rose" ? "border-rose/30 bg-rose/5"
    : tone === "amber" ? "border-amber/30 bg-amber/5"
    : tone === "muted" ? "border-border/40 bg-secondary/20"
    : "border-border bg-card";
  return (
    <div className={`rounded-md border ${border} px-3 py-1.5 flex items-center gap-2 flex-wrap text-[11px]`}>
      {children}
    </div>
  );
}

function Detail({ children }: { children: React.ReactNode }) {
  return <span className="text-[10px] text-muted-foreground basis-full md:basis-auto md:ml-auto">{children}</span>;
}

interface BucketItem { label: string; value: string }

function BucketList({ items, muted }: { items: BucketItem[]; muted?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {items.map((it, i) => (
        <span key={it.label} className="flex items-center gap-1">
          {i > 0 && <span className="text-border">·</span>}
          <span className="text-[10px] text-muted-foreground">{it.label}</span>
          <span className={`mono tabular ${muted ? "text-muted-foreground" : "text-foreground"}`}>{it.value}</span>
        </span>
      ))}
    </div>
  );
}

// Buckets order matches handoff wire: bias · vol · funding · session.
// Omit alt_corr_regime when "unknown" (v0 classifier never computes it).
// Replace null/unknown values for bias/vol/funding/session with explicit
// "unknown" string so the operator sees gaps clearly.
function formatBuckets(r: NonNullable<ReturnType<typeof useCurrentRegime>["data"]>["regime"]): BucketItem[] {
  if (!r) return [];
  const items: BucketItem[] = [
    { label: "", value: r.btc_eth_bias ?? "unknown" },
    { label: "vol", value: r.vol_regime ?? "unknown" },
    { label: "funding", value: r.funding_regime ?? "unknown" },
    { label: "session", value: r.session_utc ?? "unknown" },
  ];
  if (r.alt_corr_regime && r.alt_corr_regime !== "unknown") {
    items.splice(3, 0, { label: "corr", value: r.alt_corr_regime });
  }
  return items;
}

function formatFreshness(staleness_sec: number | null): string | null {
  if (staleness_sec == null) return null;
  if (staleness_sec < 60) return `${staleness_sec}s`;
  const m = Math.floor(staleness_sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function formatStaleness(staleness_sec: number): string {
  const m = Math.floor(staleness_sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Translate a few well-known degraded reasons into operator-readable copy.
// Falls through to the raw reason for anything unknown — better than hiding it.
function humanReason(reason: string): string {
  if (reason.startsWith("context_json_")) return "context.json faltando — classifier rodando, dado insuficiente";
  if (reason.startsWith("smoke_")) return "smoke fixture — produção ainda não publica";
  return reason;
}
