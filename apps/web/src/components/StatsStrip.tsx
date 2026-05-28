/**
 * Horizontal stat strip rendered above the signal list.
 * Consumes the `DashboardStats` shape and renders a single hairline-separated
 * row of labelled values: SIGNALS · HIT · AVG · BEST · OPEN.
 */

import type { DashboardStats } from "@/lib/api-types";

interface StatsStripProps {
  stats: DashboardStats;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-mono text-2xs uppercase tracking-[0.2em] text-tertiary">{label}</span>
      <span className="font-mono tabular text-sm text-accent">{value}</span>
    </span>
  );
}

export function StatsStrip({ stats }: StatsStripProps) {
  const hitPct = Number.isFinite(stats.hit_rate) ? `${Math.round(stats.hit_rate * 100)}%` : "—";
  const avg =
    stats.avg_multiplier !== null && Number.isFinite(stats.avg_multiplier)
      ? `${stats.avg_multiplier.toFixed(1)}x`
      : "—";
  const best =
    stats.best_multiplier !== null && Number.isFinite(stats.best_multiplier)
      ? `${stats.best_multiplier.toFixed(1)}x`
      : "—";

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-border-subtle px-4 py-2">
      <Stat label="SIGNALS" value={String(stats.total_signals)} />
      <span className="font-mono text-2xs text-border-emphasis" aria-hidden="true">
        ·
      </span>
      <Stat label="HIT" value={hitPct} />
      <span className="font-mono text-2xs text-border-emphasis" aria-hidden="true">
        ·
      </span>
      <Stat label="AVG" value={avg} />
      <span className="font-mono text-2xs text-border-emphasis" aria-hidden="true">
        ·
      </span>
      <Stat label="BEST" value={best} />
      {stats.best_multiplier_symbol ? (
        <span className="font-mono text-2xs text-tertiary">({stats.best_multiplier_symbol})</span>
      ) : null}
      <span className="font-mono text-2xs text-border-emphasis" aria-hidden="true">
        ·
      </span>
      <Stat label="OPEN" value={String(stats.open_signals)} />
    </div>
  );
}
