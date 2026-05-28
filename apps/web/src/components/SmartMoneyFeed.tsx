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
    }
  | {
      kind: "signal";
      id: number;
      mint: string;
      symbol: string | null;
      walletCount: number;
      trust: "independent" | "co_funded";
      callMc: number | null;
      currentMc: number | null;
      athMultiplier: number | null;
      safeAthMultiplier: number | null;
      isHit: boolean;
      status: "open" | "closed";
    };

// Ordering choice: single chronologically-ordered list.
// trade and confluence rows are pushed in frame order then reversed (newest first),
// signal rows are upserted into a Map keyed by id so duplicates collapse.
// After processing all frames, signal rows are sorted by id descending (proxy for recency)
// and prepended to the trade/confluence list. This keeps signals prominent at the top
// while preserving the existing newest-first ordering for trade/confluence rows.
export function reduceSmartMoney(frames: SseFrame[]): SmartRow[] {
  const tradeConfluenceRows: SmartRow[] = [];
  // Map<id, signal row> — ensures one row per signal id regardless of how many
  // smartmoney:outcome deltas arrive.
  const signalMap = new Map<number, Extract<SmartRow, { kind: "signal" }>>();

  for (const f of frames) {
    if (f.event === "smartmoney:trade") {
      const d = f.data as Omit<Extract<SmartRow, { kind: "trade" }>, "kind">;
      tradeConfluenceRows.push({ kind: "trade", ...d });
    } else if (f.event === "smartmoney:confluence") {
      const d = f.data as Omit<Extract<SmartRow, { kind: "confluence" }>, "kind">;
      tradeConfluenceRows.push({ kind: "confluence", ...d });
    } else if (f.event === "smartmoney:signal") {
      const d = f.data as {
        id: number;
        mint: string;
        symbol: string | null;
        walletCount: number;
        wallets: string[];
        trust: "independent" | "co_funded";
        sharedFunder: string | null;
        callMc: number | null;
        firstBuyAt: string;
      };
      // Upsert: seed outcome fields from null on first insert, preserve existing
      // outcome values if the row was already created by a prior outcome frame.
      const existing = signalMap.get(d.id);
      signalMap.set(d.id, {
        kind: "signal",
        id: d.id,
        mint: d.mint,
        symbol: d.symbol,
        walletCount: d.walletCount,
        trust: d.trust,
        callMc: d.callMc,
        currentMc: existing?.currentMc ?? null,
        athMultiplier: existing?.athMultiplier ?? null,
        safeAthMultiplier: existing?.safeAthMultiplier ?? null,
        isHit: existing?.isHit ?? false,
        status: existing?.status ?? "open",
      });
    } else if (f.event === "smartmoney:outcome") {
      const d = f.data as {
        id: number;
        mint: string;
        symbol: string | null;
        currentMc: number | null;
        athMultiplier: number | null;
        safeAthMultiplier: number | null;
        isHit: boolean;
        status: "open" | "closed";
      };
      // Patch existing signal row, or create a minimal one if no prior signal frame
      // arrived (e.g. client connected after the signal was emitted).
      const existing = signalMap.get(d.id);
      signalMap.set(d.id, {
        kind: "signal",
        id: d.id,
        mint: d.mint,
        symbol: d.symbol,
        walletCount: existing?.walletCount ?? 0,
        trust: existing?.trust ?? "independent",
        callMc: existing?.callMc ?? null,
        currentMc: d.currentMc,
        athMultiplier: d.athMultiplier,
        safeAthMultiplier: d.safeAthMultiplier,
        isHit: d.isHit,
        status: d.status,
      });
    }
  }

  // Signals sorted by id descending (higher id = more recently created signal)
  const signalRows = Array.from(signalMap.values()).sort((a, b) => b.id - a.id);

  return [...signalRows, ...tradeConfluenceRows.reverse()];
}

function fmtMultiplier(val: number | null): string | null {
  if (val === null) return null;
  return `${val.toFixed(1)}x`;
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
      {rows.map((r) =>
        r.kind === "confluence" ? (
          <li
            key={`c-${r.mint}-${r.count}-${r.wallets.join("-")}`}
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
              className={`ml-auto font-mono text-2xs ${r.coFunded ? "text-high" : "text-clean"}`}
            >
              {r.coFunded ? `⚠ co-funded (${shortAddr(r.sharedFunder ?? "")})` : "independent"}
            </span>
          </li>
        ) : r.kind === "signal" ? (
          <li
            key={`sig-${r.id}`}
            className="flex items-center gap-3 border-l-2 border-mint bg-mint/5 px-3 py-2"
          >
            {/* trust chip */}
            <span
              className={`font-mono text-2xs uppercase tracking-widest ${r.trust === "co_funded" ? "text-high" : "text-clean"}`}
            >
              {r.trust === "co_funded" ? "⚠ co-funded" : "indep"}
            </span>
            {/* symbol link */}
            <Link
              href={`/token/${r.mint}`}
              className="font-mono text-sm text-primary hover:underline"
            >
              {r.symbol ?? shortAddr(r.mint)}
            </Link>
            {/* wallet count */}
            <span className="font-mono text-2xs text-secondary tabular-nums">×{r.walletCount}</span>
            {/* outcome multiplier */}
            {(r.safeAthMultiplier !== null || r.athMultiplier !== null) && (
              <span className="font-mono text-xs text-secondary tabular-nums">
                {fmtMultiplier(r.safeAthMultiplier ?? r.athMultiplier)}
              </span>
            )}
            {/* HIT badge */}
            <span
              className={`font-mono text-2xs uppercase ${r.isHit ? "text-clean" : "text-high/50"}`}
            >
              {r.isHit ? "HIT" : "miss"}
            </span>
            {/* status */}
            <span className="ml-auto font-mono text-2xs text-tertiary uppercase">{r.status}</span>
          </li>
        ) : (
          <li key={`t-${r.signature}`} className="flex items-center gap-3 px-3 py-2">
            <span
              className={`font-mono text-2xs uppercase ${r.side === "buy" ? "text-clean" : "text-high"}`}
            >
              {r.side}
            </span>
            <span className="font-mono text-sm text-primary">{r.label ?? shortAddr(r.wallet)}</span>
            {r.winRate !== null && (
              <span className="font-mono text-2xs text-tertiary">{Math.round(r.winRate)}% wr</span>
            )}
            <Link
              href={`/token/${r.mint}`}
              className="font-mono text-sm text-secondary hover:underline"
            >
              {r.symbol ?? shortAddr(r.mint)}
            </Link>
            {r.solAmount !== null && (
              <span className="font-mono text-xs text-secondary">{r.solAmount.toFixed(2)} SOL</span>
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
