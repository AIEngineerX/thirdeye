"use client";
import type { ChartMarker, OhlcvCandle } from "@/lib/ohlcv-types";
import {
  CandlestickSeries,
  type UTCTimestamp,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

export const MINT = "#7be0b0";
export const CRIMSON = "#e0728a";
export const AMBER = "#e0a85a";
const GRID = "rgba(255,255,255,0.06)";
const TEXT = "rgba(220,210,200,0.6)";

export function PriceChart({
  candles,
  markers = [],
}: {
  candles: OhlcvCandle[];
  markers?: ChartMarker[];
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || candles.length < 2) return;

    const chart = createChart(el, {
      layout: {
        background: { color: "transparent" },
        textColor: TEXT,
        fontFamily: "var(--font-plex-mono)",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: GRID },
        horzLines: { color: GRID },
      },
      rightPriceScale: { borderColor: GRID },
      timeScale: { borderColor: GRID, timeVisible: true },
      width: el.clientWidth,
      height: el.clientHeight,
    });

    // v5 API: chart.addSeries(SeriesDefinition, options)
    const series = chart.addSeries(CandlestickSeries, {
      upColor: MINT,
      downColor: CRIMSON,
      borderVisible: false,
      wickUpColor: MINT,
      wickDownColor: CRIMSON,
    });

    series.setData(
      candles.map((k) => ({
        time: k.time as UTCTimestamp,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      })),
    );

    if (markers.length > 0) {
      // v5 API: createSeriesMarkers(series, markers)
      createSeriesMarkers(
        series,
        markers.map((m) => ({
          time: m.time as UTCTimestamp,
          position: m.position,
          color: m.color,
          shape: m.shape,
          text: m.text,
          size: 1,
        })),
      );
    }

    chart.timeScale().fitContent();

    const onResize = () => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, [candles, markers]);

  if (candles.length < 2) {
    return (
      <div className="flex h-full items-center justify-center border border-border-subtle bg-card font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
        no chart data
      </div>
    );
  }

  return <div ref={ref} className="h-full w-full border border-border-subtle bg-card" />;
}
