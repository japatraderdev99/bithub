"use client";
import { LineChart, Line, ResponsiveContainer, YAxis } from "recharts";

interface Props {
  data: number[];
  positive?: boolean;
}

export function Sparkline({ data, positive }: Props) {
  const rows = data.map((v, i) => ({ i, v }));
  const stroke = positive === undefined ? "currentColor" : positive ? "hsl(var(--emerald))" : "hsl(var(--rose))";
  return (
    <ResponsiveContainer width="100%" height={32}>
      <LineChart data={rows} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <Line type="monotone" dataKey="v" stroke={stroke} strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
