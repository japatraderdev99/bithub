"use client";
import { useEffect, useState } from "react";
import {
  fetchTrades,
  fetchEvents,
  fetchStats,
  fetchRegimeCurrent,
  fetchLifecycleEvents,
  fetchStrategySummary,
  type Trade,
  type MonitorEvent,
  type StatsResponse,
  type RegimeCurrentResponse,
  type LifecycleEvent,
  type StrategySummaryRow,
} from "@/lib/trades-client";

// Hooks receive primitive args (not objects) so React's exhaustive-deps lint
// works cleanly and consumers don't accidentally trigger re-fetches by
// re-creating filter objects every render.

export function useTrades(symbol?: string, since?: string, limit?: number) {
  const [data, setData] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Effect rule: don't setState synchronously here. Loading state resets via
    // the new effect run; we only flip it false once the network call settles.
    let alive = true;
    fetchTrades({ symbol, since, limit })
      .then((r) => {
        if (!alive) return;
        if (r.ok) setData(r.trades);
        else setError("worker_error");
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [symbol, since, limit]);

  return { trades: data, error, loading };
}

export function useStats(since?: string) {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchStats(since)
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [since]);

  return { stats: data, error };
}

/**
 * Daily stats — uses /stats?since=<24h ago>. Re-fetches a cada `intervalMs`
 * para refletir trades fechados no D1 enquanto o cockpit está aberto.
 */
export function useDailyStats(intervalMs = 30000) {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
        const r = await fetchStats(since);
        if (alive) setData(r);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) timer = setTimeout(tick, intervalMs);
      }
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [intervalMs]);

  return { stats: data, error };
}

// Research Bench — GET /regime/current. Polled every `intervalMs`.
// Returns the entire Worker response so the UI can render staleness/degraded
// without recomputing from raw `ts`. Null `data` = pending first fetch; the
// banner should fall back to its `empty` state on null.
export function useCurrentRegime(intervalMs = 30000) {
  const [data, setData] = useState<RegimeCurrentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await fetchRegimeCurrent();
        if (alive) {
          setData(r);
          setError(null);
          setLoading(false);
        }
      } catch (e) {
        if (alive) {
          setError((e as Error).message);
          setLoading(false);
        }
      } finally {
        if (alive) timer = setTimeout(tick, intervalMs);
      }
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [intervalMs]);

  return { data, error, loading };
}

// Decision trail — lifecycle events for a single position. Anchor by
// `clientTradeId` (closed trades, History) or by `symbol`+`since` (open
// positions on the Cockpit, which don't have a trade_id until fill).
// Fetched once per param-change; lifecycle is append-only and the drawer
// closes quickly enough that polling isn't worth the noise.
export function useLifecycleEvents(
  clientTradeId?: string,
  symbol?: string,
  since?: string,
  limit = 50,
) {
  const [events, setEvents] = useState<LifecycleEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!clientTradeId && !symbol) {
      setEvents(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    fetchLifecycleEvents({
      client_trade_id: clientTradeId,
      symbol: clientTradeId ? undefined : symbol,
      since: clientTradeId ? undefined : since,
      sort: "asc",
      limit,
    })
      .then((r) => {
        if (!alive) return;
        if (r.ok) setEvents(r.events);
        else setError("worker_error");
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [clientTradeId, symbol, since, limit]);

  return { events, error, loading };
}

// Strategy summary — leaderboard rows (already JOINed with strategy_versions
// for `name`/`status`/`regime`). Used by Library's "By Regime" section, with
// optional filters for strategy and time window.
export function useStrategySummary(params: {
  versionId?: string;
  strategyVersionId?: string;
  since?: string;
  regimeSnapshotId?: string;
} = {}) {
  const [rows, setRows] = useState<StrategySummaryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const { versionId, strategyVersionId, since, regimeSnapshotId } = params;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchStrategySummary({
      version_id: versionId,
      strategy_version_id: strategyVersionId,
      since,
      regime_snapshot_id: regimeSnapshotId,
    })
      .then((r) => {
        if (!alive) return;
        if (r.ok) setRows(r.strategies);
        else setError("worker_error");
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [versionId, strategyVersionId, since, regimeSnapshotId]);

  return { rows, error, loading };
}

export function useEventLog(type?: string, symbol?: string, limit?: number) {
  const [data, setData] = useState<MonitorEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchEvents({ type, symbol, limit })
      .then((r) => {
        if (!alive) return;
        if (r.ok) setData(r.events);
        else setError("worker_error");
      })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [type, symbol, limit]);

  return { events: data, error };
}
