"use client";
import { useEffect, useRef } from "react";
import { init, dispose } from "klinecharts";
import type { Chart, KLineData } from "klinecharts";

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Trade {
  id: string;
  ts: number;
  side: string;
  entry: number;
  exit: number | null;
  status: string;
}

interface Props {
  candles: Candle[];
  trades?: Trade[];
}

export function CandleChart({ candles, trades = [] }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = init(ref.current, {
      styles: {
        grid: {
          horizontal: { color: "rgba(255,255,255,0.05)" },
          vertical: { color: "rgba(255,255,255,0.05)" },
        },
        candle: {
          bar: {
            upColor: "rgb(52, 211, 153)",
            downColor: "rgb(244, 63, 94)",
            upBorderColor: "rgb(52, 211, 153)",
            downBorderColor: "rgb(244, 63, 94)",
            upWickColor: "rgb(52, 211, 153)",
            downWickColor: "rgb(244, 63, 94)",
          },
        },
        xAxis: {
          axisLine: { color: "rgba(255,255,255,0.1)" },
          tickLine: { color: "rgba(255,255,255,0.1)" },
          tickText: { color: "rgb(161, 161, 170)", size: 10 },
        },
        yAxis: {
          axisLine: { color: "rgba(255,255,255,0.1)" },
          tickLine: { color: "rgba(255,255,255,0.1)" },
          tickText: { color: "rgb(161, 161, 170)", size: 10 },
        },
      },
    }) as Chart;

    chart.setSymbol({ ticker: "BTCUSDT" });
    chart.setPeriod({ span: 5, type: "minute" });

    const data: KLineData[] = candles.map((c) => ({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    chart.setDataLoader({
      getBars: ({ callback }) => {
        callback(data);
      },
    });

    chart.createIndicator("EMA");
    chart.createIndicator("VOL", { pane: { id: "vol_pane", height: 80 } });

    trades.forEach((t) => {
      if (t.status === "open") {
        chart.createOverlay({
          name: "priceLine",
          points: [{ value: t.entry }],
          styles: { line: { color: "rgb(52, 211, 153)", style: "dashed" } },
        });
      }
    });

    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (ref.current) dispose(ref.current);
    };
  }, [candles, trades]);

  return <div ref={ref} style={{ width: "100%", height: 420 }} />;
}
