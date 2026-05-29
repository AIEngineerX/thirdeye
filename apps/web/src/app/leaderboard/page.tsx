"use client";

/**
 * /leaderboard — ranked view of tracked traders.
 *
 * Toggle between two sort modes sourced from a single getDashboard() fetch:
 *   - Outcome-scored (default): rank by signal_winrate desc.
 *   - ST-PnL: rank by realized_pnl_usd desc.
 */

import { type Column, DataTable } from "@/components/DataTable";
import { WalletClassGlyph, tagGlyphVariant } from "@/components/WalletClassGlyph";
import { getDashboard } from "@/lib/api";
import type { DashboardTrader } from "@/lib/api-types";
import { fmtUsdSigned, shortAddr } from "@/lib/format";
import Link from "next/link";
import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

type TraderRow = DashboardTrader & Record<string, unknown>;

const traderCol: Column<TraderRow> = {
  key: "address",
  label: "trader",
  sortable: false,
  align: "left",
  render: (row) => {
    const display = row.label ?? shortAddr(row.address);
    const glyphVariant = tagGlyphVariant("SMART_MONEY");
    return (
      <span className="flex items-center gap-2">
        <WalletClassGlyph variant={glyphVariant} size={12} className="shrink-0 text-accent-dim" />
        <Link
          href={`/wallet/${row.address}`}
          className="font-mono text-sm text-primary hover:text-accent"
          title={row.address}
        >
          {display}
        </Link>
      </span>
    );
  },
};

const outcomeCols: Column<TraderRow>[] = [
  traderCol,
  {
    key: "signal_wins",
    label: "wins/signals",
    sortable: true,
    align: "right",
    render: (row) => (
      <span className="text-tertiary">
        {row.signal_wins}/{row.signal_signals}
      </span>
    ),
  },
  {
    key: "signal_winrate",
    label: "win rate",
    sortable: true,
    align: "right",
    render: (row) => {
      const wr =
        row.signal_winrate !== null && Number.isFinite(row.signal_winrate as number)
          ? `${Math.round((row.signal_winrate as number) * 100)}%`
          : null;
      return wr !== null ? (
        <span className="text-clean">{wr}</span>
      ) : (
        <span className="text-tertiary">—</span>
      );
    },
  },
];

const pnlCols: Column<TraderRow>[] = [
  traderCol,
  {
    key: "realized_pnl_usd",
    label: "realized PnL",
    sortable: true,
    align: "right",
    render: (row) => {
      const pnlStr = fmtUsdSigned(row.realized_pnl_usd as number | null);
      const pnlTone =
        row.realized_pnl_usd === null
          ? "text-tertiary"
          : (row.realized_pnl_usd as number) > 0
            ? "text-clean"
            : (row.realized_pnl_usd as number) < 0
              ? "text-high"
              : "text-secondary";
      return <span className={`font-mono tabular ${pnlTone}`}>{pnlStr}</span>;
    },
  },
  {
    key: "win_rate",
    label: "win rate",
    sortable: true,
    align: "right",
    render: (row) => {
      const wr =
        row.win_rate !== null && Number.isFinite(row.win_rate as number)
          ? `${Math.round((row.win_rate as number) * 100)}%`
          : null;
      return wr !== null ? (
        <span className="text-secondary">{wr}</span>
      ) : (
        <span className="text-tertiary">—</span>
      );
    },
  },
];

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

  const rows = traders as TraderRow[];

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
          {rows.length === 0 ? (
            <div className="border border-border-subtle px-4 py-8">
              <p className="font-mono text-sm text-tertiary">no tracked traders yet</p>
            </div>
          ) : (
            <div className="border border-border-subtle bg-card">
              <DataTable
                rows={rows}
                columns={mode === "outcome" ? outcomeCols : pnlCols}
                initialSort={
                  mode === "outcome"
                    ? { key: "signal_winrate", dir: "desc" }
                    : { key: "realized_pnl_usd", dir: "desc" }
                }
              />
            </div>
          )}

          <p className="mt-3 font-mono text-2xs text-tertiary/60">
            {rows.length} trader{rows.length !== 1 ? "s" : ""}
          </p>
        </>
      )}
    </div>
  );
}
