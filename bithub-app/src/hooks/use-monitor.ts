"use client";
import { useEffect, useState } from "react";
import type { PositionsFile, CandidatesFile, SystemFile, MonitorEvent, ContextFile } from "@/types/monitor";

interface OkResponse<T> {
  ok: true;
  age_ms: number;
  data: T;
}
interface ErrResponse {
  ok: false;
  reason: string;
}
type Response<T> = OkResponse<T> | ErrResponse;

function useSnapshot<T>(url: string, intervalMs = 3000) {
  const [resp, setResp] = useState<Response<T> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        const j = (await r.json()) as Response<T>;
        if (alive) {
          setResp(j);
          setLoading(false);
        }
      } catch (e) {
        if (alive) {
          setResp({ ok: false, reason: (e as Error).message });
          setLoading(false);
        }
      } finally {
        if (alive) timer = setTimeout(tick, intervalMs);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [url, intervalMs]);

  return { response: resp, loading };
}

export function usePositions(intervalMs = 3000) {
  return useSnapshot<PositionsFile>("/api/monitor/positions", intervalMs);
}
export function useCandidates(intervalMs = 4000) {
  return useSnapshot<CandidatesFile>("/api/monitor/candidates", intervalMs);
}
export function useSystem(intervalMs = 3000) {
  return useSnapshot<SystemFile>("/api/monitor/system", intervalMs);
}
export function useContext(intervalMs = 5000) {
  return useSnapshot<ContextFile>("/api/monitor/context", intervalMs);
}

interface EventsResponse {
  ok: true;
  age_ms: number;
  events: MonitorEvent[];
}
export function useEvents(limit = 60, intervalMs = 4000) {
  const [resp, setResp] = useState<EventsResponse | ErrResponse | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await fetch(`/api/monitor/events?limit=${limit}`, { cache: "no-store" });
        const j = (await r.json()) as EventsResponse | ErrResponse;
        if (alive) setResp(j);
      } catch (e) {
        if (alive) setResp({ ok: false, reason: (e as Error).message });
      } finally {
        if (alive) timer = setTimeout(tick, intervalMs);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [limit, intervalMs]);
  return resp;
}
