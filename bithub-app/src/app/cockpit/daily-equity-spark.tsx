"use client";
import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import { useDailyStats } from "@/hooks/use-trades";
import { pnlClass } from "@/lib/utils";

/**
 * Tiny sparkline of cumulative PnL over last 24h. Renders inline next to the
 * daily total in the macro bar. Tracks `recent` trades from /stats — each
 * point is one closed trade's PnL added to running total.
 */
export function DailyEquitySpark() {
  const { stats } = useDailyStats(30000);
  const recent = stats?.recent ?? [];

  if (recent.length < 2) {
    return null; // not enough trades for a sparkline
  }

  const series = recent.reduce<Array<{ i: number; v: number }>>((acc, t, i) => {
    const prev = acc[i - 1]?.v ?? 0;
    acc.push({ i, v: parseFloat((prev + (t.pnl_abs ?? 0)).toFixed(4)) });
    return acc;
  }, []);
  const last = series[series.length - 1]?.v ?? 0;
  const stroke = last >= 0 ? "hsl(var(--emerald))" : "hsl(var(--rose))";

  return (
    <span className={`inline-block w-16 h-4 align-middle ${pnlClass(last)}`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series} margin={{ top: 1, bottom: 1, left: 0, right: 0 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line type="monotone" dataKey="v" stroke={stroke} strokeWidth={1.2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </span>
  );
}
