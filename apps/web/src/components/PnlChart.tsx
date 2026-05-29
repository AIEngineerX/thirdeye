"use client";

import type { WalletPerformanceDay } from "@/lib/pnl-types";
import { AreaSeries, createChart } from "lightweight-charts";
import { useEffect, useRef } from "react";

const MINT = "#7be0b0";
const GRID = "rgba(255,255,255,0.06)";
const TEXT = "rgba(220,210,200,0.6)";

function buildCumulative(days: WalletPerformanceDay[]) {
  const points: { time: number; value: number }[] = [];
  let acc = 0;
  for (const d of days) {
    acc += d.realizedPnl;
    points.push({ time: Math.floor(new Date(d.date).getTime() / 1000), value: acc });
  }
  return points;
}

export function PnlChart({ days }: { days: WalletPerformanceDay[] }) {
  const ref = useRef<HTMLDivElement>(null);

  // Render-time checks only (no reactive array identity issue).
  const hasEnough = days.length >= 2;
  const allZero = days.every((d) => d.realizedPnl === 0);

  useEffect(() => {
    const el = ref.current;
    if (!el || days.length < 2) return;

    const cumulative = buildCumulative(days);

    const chart = createChart(el, {
      layout: {
        background: { color: "transparent" },
        textColor: TEXT,
        fontFamily: "var(--font-plex-mono)",
        attributionLogo: false,
      },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      rightPriceScale: { borderColor: GRID },
      timeScale: { borderColor: GRID, timeVisible: false },
      width: el.clientWidth,
      height: el.clientHeight,
    });

    // v5 API: chart.addSeries(SeriesDefinition, options)
    const series = chart.addSeries(AreaSeries, {
      lineColor: MINT,
      topColor: "rgba(123,224,176,0.25)",
      bottomColor: "rgba(123,224,176,0.02)",
      lineWidth: 2,
    });

    series.setData(cumulative.map((p) => ({ time: p.time as never, value: p.value })));
    chart.timeScale().fitContent();

    const onResize = () => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, [days]);

  if (!hasEnough) {
    return (
      <div className="flex h-full items-center justify-center border border-border-subtle bg-card font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
        not enough history
      </div>
    );
  }

  return (
    <div className="relative h-full w-full border border-border-subtle bg-card">
      {allZero ? (
        <span className="absolute left-2 top-2 z-10 font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
          no realized pnl yet
        </span>
      ) : null}
      <div ref={ref} className="h-full w-full" />
    </div>
  );
}
