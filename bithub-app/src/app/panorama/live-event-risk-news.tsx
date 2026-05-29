"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { timeAgo } from "@/lib/utils";

type EventSeverity = "critical" | "high" | "medium" | "low";

interface EventRiskHeadline {
  id: string;
  topic: "geopolitical" | "macro" | "crypto_policy" | "market_plumbing";
  severity: EventSeverity;
  risk_score: number;
  rank_score: number;
  age_hours: number;
  is_breaking: boolean;
  is_stale: boolean;
  title: string;
  source: string;
  url: string;
  published_at: string;
  source_country: string | null;
  matched_terms: string[];
}

interface OkResp {
  ok: true;
  source: "google_news_rss" | "gdelt";
  as_of: string;
  window: "24h";
  risk_level: "quiet" | "watch" | "elevated" | "critical";
  max_risk_score: number;
  headlines: EventRiskHeadline[];
}

interface ErrResp {
  ok: false;
  source: string;
  reason: string;
  as_of: string;
  headlines: [];
}

interface FixtureHeadline {
  ts: string;
  source: string;
  headline: string;
  severity: string;
}

export function LiveEventRiskNews({ fallback }: { fallback: FixtureHeadline[] }) {
  const [resp, setResp] = useState<OkResp | ErrResp | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/market/event-risk", { cache: "no-store" });
        const j = (await r.json()) as OkResp | ErrResp;
        if (alive) setResp(j);
      } catch (e) {
        if (alive) {
          setResp({
            ok: false,
            source: "event_risk",
            reason: (e as Error).message,
            as_of: new Date().toISOString(),
            headlines: [],
          });
        }
      }
    };
    tick();
    const id = setInterval(tick, 5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!resp) {
    return (
      <Card>
        <CardContent className="p-3 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="text-xs">Event risk...</span>
        </CardContent>
      </Card>
    );
  }

  if (!resp.ok) {
    return (
      <div className="space-y-2">
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-amber">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-xs">Event risk indisponivel: {resp.reason}. Exibindo fixture.</span>
          </CardContent>
        </Card>
        {fallback.slice(0, 5).map((h, i) => (
          <Card key={i}>
            <CardContent className="p-3 flex items-start justify-between gap-3">
              <div className="space-y-0.5 min-w-0">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <span>{h.source}</span>
                  <span>·</span>
                  <span>{timeAgo(h.ts)}</span>
                </div>
                <p className="text-xs leading-relaxed text-foreground">{h.headline}</p>
              </div>
              <Badge variant={fixtureVariant(h.severity)}>{h.severity}</Badge>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (resp.headlines.length === 0) {
    return (
      <Card>
        <CardContent className="p-3 text-xs text-muted-foreground">Nenhum headline relevante nas ultimas 24h.</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{resp.source.replaceAll("_", " ")} · {resp.window} · {timeAgo(resp.as_of)}</span>
        <Badge variant={riskVariant(resp.risk_level)}>{resp.risk_level}</Badge>
      </div>
      {resp.headlines.slice(0, 8).map((h) => (
        <Card key={h.id}>
          <CardContent className="p-3 flex items-start justify-between gap-3">
            <a href={h.url} target="_blank" rel="noopener noreferrer" className="space-y-1 min-w-0 group">
              <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                <span>{h.source}</span>
                <span>·</span>
                <span>{timeAgo(h.published_at)}</span>
                <span>·</span>
                <span>{h.topic.replace("_", " ")}</span>
                {h.is_breaking && (
                  <>
                    <span>·</span>
                    <span className="text-rose">breaking</span>
                  </>
                )}
                {h.is_stale && (
                  <>
                    <span>·</span>
                    <span>watch</span>
                  </>
                )}
                {h.source_country && (
                  <>
                    <span>·</span>
                    <span>{h.source_country}</span>
                  </>
                )}
              </div>
              <p className="text-xs leading-relaxed text-foreground group-hover:text-primary">
                {h.title}
                <ExternalLink className="ml-1 inline h-3 w-3 align-[-2px] opacity-60" />
              </p>
              {h.matched_terms.length > 0 && (
                <p className="text-[10px] text-muted-foreground">
                  terms: {h.matched_terms.slice(0, 5).join(", ")} · age {h.age_hours.toFixed(1)}h
                </p>
              )}
            </a>
            <Badge variant={severityVariant(h.severity)}>{h.risk_score}</Badge>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function riskVariant(level: OkResp["risk_level"]) {
  if (level === "critical") return "rose";
  if (level === "elevated") return "amber";
  if (level === "watch") return "outline";
  return "muted";
}

function severityVariant(severity: EventSeverity) {
  if (severity === "critical") return "rose";
  if (severity === "high") return "amber";
  if (severity === "medium") return "outline";
  return "muted";
}

function fixtureVariant(severity: string) {
  if (severity.includes("positive")) return "emerald";
  if (severity.includes("bearish")) return "rose";
  return "muted";
}
