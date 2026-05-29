import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { LibraryTable } from "./library-table";

const WORKER_URL =
  process.env.BITHUB_WORKER_URL ??
  "https://bithub-trades-api.guiydantas.workers.dev";

interface WorkerStrategyVersion {
  version_id: string;
  strategy_id: string;
  name: string;
  regime: string;
  status: string;
  collection_mode: string;
  timeframe: string;
  timeframes_json: string | null;
  pair_universe_json: string | null;
  tags_json: string | null;
  spec_json: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
  is_active?: number;
  activated_at?: string | null;
  activated_by?: string | null;
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function adaptVersion(row: WorkerStrategyVersion) {
  const spec = safeParse<Record<string, unknown>>(row.spec_json) ?? {};
  const discovery = (spec.discovery ?? {}) as Record<string, number>;
  const inner = (spec.inner_config ?? {}) as Record<string, number>;
  const gates = (spec.gates ?? {}) as Record<string, unknown>;
  const pairs = safeParse<{ leads?: string[]; targets?: string[] }>(row.pair_universe_json) ?? {};
  const pair_universe = [...(pairs.targets ?? []), ...(pairs.leads ?? [])];
  const trade_count = Number(discovery.historical_entries ?? 0);
  const avg_net = Number(discovery.historical_avg_net_pct ?? 0);
  const total_return_pct = trade_count * avg_net;
  const routing_features = Object.keys(gates);

  return {
    id: row.version_id,
    name: row.name,
    regime: row.regime,
    timeframe: row.timeframe,
    pair_universe,
    sharpe: 0,
    win_rate_pct: 0,
    total_return_pct,
    max_dd_pct: 0,
    trade_count,
    last_backtest_ts: row.updated_at ?? row.created_at,
    freqtrade_version: String(spec.source ?? "n/a"),
    tags: safeParse<string[]>(row.tags_json) ?? [],
    content_hash: row.content_hash,
    status: row.status,
    collection_mode: row.collection_mode,
    readiness: row.status === "shadow" ? "shadow" : row.status,
    hypothesis: String(spec.purpose ?? spec.notes ?? ""),
    entry_model: {
      score_min: Number(inner.scoreMin ?? 0) || undefined,
      volume_min: Number(inner.volumeRatioMin ?? 0) || undefined,
      ttl_sec: Number(inner.maxHoldMin ?? 0) * 60 || undefined,
    },
    routing_features,
    is_active: Number(row.is_active ?? 0),
    activated_at: row.activated_at ?? null,
    activated_by: row.activated_by ?? null,
  };
}

async function loadStrategies() {
  try {
    const res = await fetch(`${WORKER_URL}/strategy-versions?limit=200`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { strategies: [], error: `worker_${res.status}` };
    const body = await res.json() as { ok: boolean; versions: WorkerStrategyVersion[] };
    if (!body.ok) return { strategies: [], error: "worker_not_ok" };
    return { strategies: body.versions.map(adaptVersion), error: null };
  } catch (e) {
    return { strategies: [], error: String(e) };
  }
}

export default async function LibraryPage() {
  const { strategies, error } = await loadStrategies();

  return (
    <>
      <PageHeader
        title="Strategy Library"
        subtitle="Estratégias persistidas no D1. Só rodam quando selecionadas pelo operador. Content-addressed, versionadas."
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline">{strategies.length} versions</Badge>
            {error ? <Badge variant="rose">worker: {error}</Badge> : null}
          </div>
        }
      />
      <div className="p-6">
        {strategies.length === 0 && !error ? (
          <div className="rounded border border-border/40 bg-card/40 p-6 text-sm text-muted-foreground">
            Nenhuma estratégia registrada no D1 ainda. Use{" "}
            <code className="text-foreground">scripts/sui-regime-register-strategy.mjs</code>{" "}
            ou um futuro fluxo de upload pra adicionar versões ao Registry.
          </div>
        ) : (
          <LibraryTable data={strategies} />
        )}
      </div>
    </>
  );
}
