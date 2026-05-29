"use client";

import { type ReactNode, useState } from "react";

export type SortDir = "asc" | "desc";

/** Stable null-last sort over a numeric/string key. Pure; does not mutate. */
export function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  key: keyof T,
  dir: SortDir,
): T[] {
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (av < bv) return dir === "asc" ? -1 : 1;
    if (av > bv) return dir === "asc" ? 1 : -1;
    return 0;
  });
}

export interface Column<T> {
  key: keyof T & string;
  label: string;
  sortable?: boolean;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
}

export function DataTable<T extends Record<string, unknown>>({
  rows,
  columns,
  initialSort,
}: {
  rows: T[];
  columns: Column<T>[];
  initialSort?: { key: keyof T & string; dir: SortDir };
}) {
  const [sort, setSort] = useState<{ key: keyof T & string; dir: SortDir } | null>(
    initialSort ?? null,
  );
  const sorted = sort ? sortRows(rows, sort.key, sort.dir) : rows;
  return (
    <table className="w-full border-collapse font-mono text-2xs">
      <thead>
        <tr className="border-b border-border-emphasis uppercase tracking-[0.18em] text-tertiary">
          {columns.map((c) => {
            const active = sort?.key === c.key;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav handled via click toggle state
              <th
                key={c.key}
                className={`px-2 py-1.5 ${c.align === "right" ? "text-right" : "text-left"} ${
                  c.sortable ? "cursor-pointer select-none" : ""
                } ${active ? "text-accent" : ""}`}
                onClick={
                  c.sortable
                    ? () =>
                        setSort((s) =>
                          s?.key === c.key
                            ? { key: c.key, dir: s.dir === "desc" ? "asc" : "desc" }
                            : { key: c.key, dir: "desc" },
                        )
                    : undefined
                }
              >
                {c.label}
                {active ? (
                  <span className="ml-0.5 text-accent">{sort.dir === "desc" ? "▾" : "▴"}</span>
                ) : null}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id
          <tr key={i} className="border-b border-border-subtle/60">
            {columns.map((c) => (
              <td
                key={c.key}
                className={`px-2 py-1.5 tabular ${c.align === "right" ? "text-right" : ""}`}
              >
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
