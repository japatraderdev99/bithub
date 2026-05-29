"use client";
import { usePositions } from "@/hooks/use-monitor";
import type { ReactNode } from "react";

/**
 * 2-column grid pra zonas heatmap + active positions.
 * Quando há 2+ posições abertas, dá mais espaço pro lado direito.
 */
export function CockpitGrid({ children }: { children: ReactNode }) {
  const { response } = usePositions(2500);
  const openCount = (response?.ok ? response.data.open_count : 0) || 0;

  // When 0-1 positions, balance is 1.4/1 (heatmap dominates).
  // When 2+, balance is 1/1.4 (positions dominate).
  const cls =
    openCount >= 2
      ? "grid-cols-1 lg:grid-cols-[1fr_1.4fr]"
      : "grid-cols-1 lg:grid-cols-[1.4fr_1fr]";

  return <div className={`grid ${cls} gap-3`}>{children}</div>;
}
