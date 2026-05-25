"use client";

import { fmtClockMs, shortAddr } from "@/lib/format";
import type { SseFrame } from "@/lib/sse";
import Link from "next/link";

export type SmartRow =
  | {
      kind: "trade";
      wallet: string;
      label: string | null;
      winRate: number | null;
      side: "buy" | "sell";
      mint: string;
      symbol: string | null;
      solAmount: number | null;
      signature: string;
      tradedAt: string;
    }
  | {
      kind: "confluence";
      mint: string;
      symbol: string | null;
      wallets: string[];
      count: number;
      windowMin: number;
      coFunded: boolean;
      sharedFunder: string | null;
    };

export function reduceSmartMoney(frames: SseFrame[]): SmartRow[] {
  const rows: SmartRow[] = [];
  for (const f of frames) {
    if (f.event === "smartmoney:trade") {
      const d = f.data as Omit<Extract<SmartRow, { kind: "trade" }>, "kind">;
      rows.push({ kind: "trade", ...d });
    } else if (f.event === "smartmoney:confluence") {
      const d = f.data as Omit<Extract<SmartRow, { kind: "confluence" }>, "kind">;
      rows.push({ kind: "confluence", ...d });
    }
  }
  return rows.reverse();
}

export function SmartMoneyFeed({ frames }: { frames: SseFrame[] }) {
  const rows = reduceSmartMoney(frames);
  if (rows.length === 0) {
    return (
      <p className="font-sans text-sm text-secondary">
        No smart-money activity yet. Add wallets to your watchlist.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border-subtle">
      {rows.map((r, i) =>
        r.kind === "confluence" ? (
          <li
            key={`c${i}`}
            className="flex items-center gap-3 border-l-2 border-brand bg-brand/5 px-3 py-2"
          >
            <span className="font-mono text-2xs uppercase tracking-widest text-brand">
              confluence ×{r.count}
            </span>
            <Link
              href={`/token/${r.mint}`}
              className="font-mono text-sm text-primary hover:underline"
            >
              {r.symbol ?? shortAddr(r.mint)}
            </Link>
            <span className="font-sans text-xs text-secondary">
              {r.count} tracked wallets bought · {r.windowMin}m
            </span>
            <span
              className={`ml-auto font-mono text-2xs ${r.coFunded ? "text-high" : "text-mint"}`}
            >
              {r.coFunded
                ? `⚠ co-funded (${shortAddr(r.sharedFunder ?? "")})`
                : "independent"}
            </span>
          </li>
        ) : (
          <li key={`t${i}`} className="flex items-center gap-3 px-3 py-2">
            <span
              className={`font-mono text-2xs uppercase ${r.side === "buy" ? "text-mint" : "text-high"}`}
            >
              {r.side}
            </span>
            <span className="font-mono text-sm text-primary">
              {r.label ?? shortAddr(r.wallet)}
            </span>
            {r.winRate !== null && (
              <span className="font-mono text-2xs text-tertiary">
                {Math.round(r.winRate)}% wr
              </span>
            )}
            <Link
              href={`/token/${r.mint}`}
              className="font-mono text-sm text-secondary hover:underline"
            >
              {r.symbol ?? shortAddr(r.mint)}
            </Link>
            {r.solAmount !== null && (
              <span className="font-mono text-xs text-secondary">
                {r.solAmount.toFixed(2)} SOL
              </span>
            )}
            <span className="ml-auto font-mono text-2xs text-tertiary">
              {fmtClockMs(r.tradedAt)}
            </span>
          </li>
        ),
      )}
    </ul>
  );
}
