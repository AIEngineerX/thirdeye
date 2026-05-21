/**
 * Metadata stamp — the left rail on wallet/token detail pages.
 *
 * Renders a stack of label/value rows separated by hairlines. Designed to
 * carry the wallet's identifying numbers (score, age, tx count, USD value,
 * realized PnL) plus an optional verdict slot and action button.
 *
 * Single-column to keep the stamp narrow; pairs with a wider streaming
 * detail zone on the right.
 */

import type { ReactNode } from "react";

export interface MetricRow {
  label: string;
  value: ReactNode;
  /** Apply mono font + tabular-nums to the value cell. Defaults true. */
  mono?: boolean;
  /** Color override for the value (e.g. clean/med/high). */
  tone?: "primary" | "accent" | "clean" | "med" | "high";
}

interface MetricStampProps {
  rows: MetricRow[];
  children?: ReactNode;
}

const TONE_CLASS: Record<NonNullable<MetricRow["tone"]>, string> = {
  primary: "text-primary",
  accent: "text-accent",
  clean: "text-clean",
  med: "text-med",
  high: "text-high",
};

export function MetricStamp({ rows, children }: MetricStampProps) {
  return (
    <aside className="w-full border border-border-subtle bg-card">
      <ul>
        {rows.map((r, i) => {
          const valueClass = [
            r.mono === false ? "font-sans" : "font-mono tabular",
            TONE_CLASS[r.tone ?? "primary"],
            "text-right",
          ].join(" ");
          return (
            <li
              key={`${r.label}-${i}`}
              className="flex items-baseline justify-between gap-4 border-b border-border-subtle px-4 py-3 last:border-b-0"
            >
              <span className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
                {r.label}
              </span>
              <span className={valueClass}>{r.value}</span>
            </li>
          );
        })}
      </ul>
      {children ? <div className="border-t border-border-subtle p-3">{children}</div> : null}
    </aside>
  );
}
