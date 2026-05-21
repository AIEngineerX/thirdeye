/**
 * Live event ticker — runs above the data section during an active SSE
 * stream. Each new event appears at the right with a brief fade-in; older
 * events shift left until they fall off the visible range.
 *
 * Reinforces "this is live, this is incoming" without occupying real estate
 * that the data needs.
 */

import type { ReactNode } from "react";

export interface TickerItem {
  id: string | number;
  label: string;
  /** Optional brief detail rendered in muted text after the label. */
  detail?: string;
}

interface TickerProps {
  items: TickerItem[];
  /** Max items to show. Older items beyond this fall off. Default 6. */
  max?: number;
  /** Status icon / prefix shown before the first item. */
  prefix?: ReactNode;
}

export function Ticker({ items, max = 6, prefix = "▸" }: TickerProps) {
  const visible = items.slice(-max);

  return (
    <div className="flex items-center gap-3 overflow-hidden border-b border-border-subtle bg-card/40 px-6 py-2">
      <span className="font-mono text-2xs uppercase tracking-[0.18em] text-accent">{prefix}</span>
      <ul className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden">
        {visible.length === 0 ? (
          <li className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
            waiting for stream…
          </li>
        ) : (
          visible.map((item) => (
            <li
              key={item.id}
              className="flex animate-ticker-fade items-center gap-2 whitespace-nowrap font-mono text-2xs uppercase tracking-[0.16em]"
            >
              <span className="text-secondary">{item.label}</span>
              {item.detail ? <span className="text-tertiary">· {item.detail}</span> : null}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
