"use client";

/**
 * /leaderboard — ranked view of tracked traders.
 *
 * Toggle between two sort modes sourced from a single getDashboard() fetch:
 *   - Outcome-scored (default): rank by signal_winrate desc, then signal_wins desc.
 *   - ST-PnL: rank by realized_pnl_usd desc.
 */

import { WalletClassGlyph, tagGlyphVariant } from "@/components/WalletClassGlyph";
import { getDashboard } from "@/lib/api";
import type { DashboardTrader } from "@/lib/api-types";
import { fmtUsdSigned, shortAddr } from "@/lib/format";
import Link from "next/link";
import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

function sortOutcome(traders: DashboardTrader[]): DashboardTrader[] {
  return [...traders].sort((a, b) => {
    // nulls last
    if (a.signal_winrate === null && b.signal_winrate === null)
      return b.signal_wins - a.signal_wins;
    if (a.signal_winrate === null) return 1;
    if (b.signal_winrate === null) return -1;
    if (b.signal_winrate !== a.signal_winrate) return b.signal_winrate - a.signal_winrate;
    return b.signal_wins - a.signal_wins;
  });
}

function sortPnl(traders: DashboardTrader[]): DashboardTrader[] {
  return [...traders].sort((a, b) => {
    if (a.realized_pnl_usd === null && b.realized_pnl_usd === null) return 0;
    if (a.realized_pnl_usd === null) return 1;
    if (b.realized_pnl_usd === null) return -1;
    return b.realized_pnl_usd - a.realized_pnl_usd;
  });
}

// ---------------------------------------------------------------------------
// Row components
// ---------------------------------------------------------------------------

function OutcomeRow({
  rank,
  trader,
}: {
  rank: number;
  trader: DashboardTrader;
}) {
  const display = trader.label ?? shortAddr(trader.address);
  const wr =
    trader.signal_winrate !== null && Number.isFinite(trader.signal_winrate)
      ? `${Math.round(trader.signal_winrate * 100)}%`
      : null;
  const glyphVariant = tagGlyphVariant("SMART_MONEY");

  return (
    <tr className="border-b border-border-subtle/60 last:border-b-0 hover:bg-card-hover/40">
      <td className="w-10 px-3 py-2 font-mono tabular text-2xs text-tertiary">{rank}</td>
      <td className="px-3 py-2">
        <span className="flex items-center gap-2">
          <WalletClassGlyph variant={glyphVariant} size={12} className="shrink-0 text-accent-dim" />
          <Link
            href={`/wallet/${trader.address}`}
            className="font-mono text-sm text-primary hover:text-accent"
            title={trader.address}
          >
            {display}
          </Link>
        </span>
      </td>
      <td className="px-3 py-2 text-right font-mono tabular text-xs text-tertiary">
        {trader.signal_wins}/{trader.signal_signals}
      </td>
      <td className="px-3 py-2 text-right font-mono tabular text-xs">
        {wr !== null ? (
          <span className="text-clean">{wr}</span>
        ) : (
          <span className="text-tertiary">—</span>
        )}
      </td>
    </tr>
  );
}

function PnlRow({
  rank,
  trader,
}: {
  rank: number;
  trader: DashboardTrader;
}) {
  const display = trader.label ?? shortAddr(trader.address);
  const pnlStr = fmtUsdSigned(trader.realized_pnl_usd);
  const pnlTone =
    trader.realized_pnl_usd === null
      ? "text-tertiary"
      : trader.realized_pnl_usd > 0
        ? "text-clean"
        : trader.realized_pnl_usd < 0
          ? "text-high"
          : "text-secondary";
  const wr =
    trader.win_rate !== null && Number.isFinite(trader.win_rate)
      ? `${Math.round(trader.win_rate * 100)}%`
      : null;
  const glyphVariant = tagGlyphVariant("SMART_MONEY");

  return (
    <tr className="border-b border-border-subtle/60 last:border-b-0 hover:bg-card-hover/40">
      <td className="w-10 px-3 py-2 font-mono tabular text-2xs text-tertiary">{rank}</td>
      <td className="px-3 py-2">
        <span className="flex items-center gap-2">
          <WalletClassGlyph variant={glyphVariant} size={12} className="shrink-0 text-accent-dim" />
          <Link
            href={`/wallet/${trader.address}`}
            className="font-mono text-sm text-primary hover:text-accent"
            title={trader.address}
          >
            {display}
          </Link>
        </span>
      </td>
      <td className={`px-3 py-2 text-right font-mono tabular text-xs ${pnlTone}`}>{pnlStr}</td>
      <td className="px-3 py-2 text-right font-mono tabular text-xs">
        {wr !== null ? (
          <span className="text-secondary">{wr}</span>
        ) : (
          <span className="text-tertiary">—</span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type ViewMode = "outcome" | "pnl";
type LoadState = "loading" | "error" | "ready";

export default function LeaderboardPage() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [traders, setTraders] = useState<DashboardTrader[]>([]);
  const [mode, setMode] = useState<ViewMode>("outcome");

  useEffect(() => {
    let cancelled = false;
    getDashboard()
      .then((b) => {
        if (cancelled) return;
        setTraders(b.top_traders);
        setLoadState("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "failed to load leaderboard");
        setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = mode === "outcome" ? sortOutcome(traders) : sortPnl(traders);

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      {/* Page header */}
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-border-subtle pb-4">
        <div>
          <div className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
            <Link href="/" className="hover:text-accent">
              THIRDEYE
            </Link>
            <span className="mx-2 text-tertiary/40">/</span>
            <span>leaderboard</span>
          </div>
          <h1 className="mt-1 font-mono text-base font-semibold tracking-[0.18em] text-primary">
            TRADERS
          </h1>
        </div>

        {/* View toggle */}
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setMode("outcome")}
            className={`px-3 py-1 font-mono text-2xs uppercase tracking-[0.18em] transition-colors ${
              mode === "outcome" ? "text-accent" : "text-tertiary hover:text-secondary"
            }`}
          >
            outcome-scored
          </button>
          <button
            type="button"
            onClick={() => setMode("pnl")}
            className={`px-3 py-1 font-mono text-2xs uppercase tracking-[0.18em] transition-colors ${
              mode === "pnl" ? "text-accent" : "text-tertiary hover:text-secondary"
            }`}
          >
            ST-PnL
          </button>
        </div>
      </header>

      {/* Loading */}
      {loadState === "loading" && (
        <div className="py-16 text-center">
          <span className="cursor-blink font-mono text-sm text-tertiary">loading leaderboard</span>
        </div>
      )}

      {/* Error */}
      {loadState === "error" && (
        <div className="border border-high/40 bg-high/10 px-4 py-6">
          <p className="font-mono text-sm text-high">
            ▸ {loadError ?? "failed to load leaderboard"}
          </p>
        </div>
      )}

      {/* Table */}
      {loadState === "ready" && (
        <>
          {sorted.length === 0 ? (
            <div className="border border-border-subtle px-4 py-8">
              <p className="font-mono text-sm text-tertiary">no tracked traders yet</p>
            </div>
          ) : (
            <div className="border border-border-subtle bg-card">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border-subtle">
                    <th className="px-3 py-2 text-left font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
                      #
                    </th>
                    <th className="px-3 py-2 text-left font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
                      trader
                    </th>
                    {mode === "outcome" ? (
                      <>
                        <th className="px-3 py-2 text-right font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
                          wins/signals
                        </th>
                        <th className="px-3 py-2 text-right font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
                          win rate
                        </th>
                      </>
                    ) : (
                      <>
                        <th className="px-3 py-2 text-right font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
                          realized PnL
                        </th>
                        <th className="px-3 py-2 text-right font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
                          win rate
                        </th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {mode === "outcome"
                    ? sorted.map((t, i) => <OutcomeRow key={t.address} rank={i + 1} trader={t} />)
                    : sorted.map((t, i) => <PnlRow key={t.address} rank={i + 1} trader={t} />)}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-3 font-mono text-2xs text-tertiary/60">
            {sorted.length} trader{sorted.length !== 1 ? "s" : ""}
          </p>
        </>
      )}
    </div>
  );
}
