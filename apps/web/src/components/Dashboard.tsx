"use client";

/**
 * Live alpha dashboard homepage.
 *
 * - Fetches DashboardBundle on mount via getDashboard().
 * - Opens the intel SSE feed (ticket flow) and merges smartmoney:signal /
 *   smartmoney:outcome deltas onto the live_signals list by id.
 * - Layout: top bar (wordmark + command search), stats strip, two-column
 *   responsive grid (live signals left, trending + top traders right).
 */

import { KbdInput } from "@/components/KbdInput";
import { SignalCard } from "@/components/SignalCard";
import { StatsStrip } from "@/components/StatsStrip";
import { WalletClassGlyph, tagGlyphVariant } from "@/components/WalletClassGlyph";
import { useSse } from "@/hooks/useSse";
import { getDashboard } from "@/lib/api";
import type { DashboardBundle, DashboardSignal } from "@/lib/api-types";
import { fmtMoneyCompact, fmtRelative, isValidSolanaAddress, shortAddr } from "@/lib/format";
import type { SseFrame } from "@/lib/sse";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// SSE delta merge
// ---------------------------------------------------------------------------

function mergeSignalFrame(signals: DashboardSignal[], frame: SseFrame): DashboardSignal[] {
  if (frame.event === "smartmoney:signal") {
    const d = frame.data as {
      id: number;
      mint: string;
      symbol: string | null;
      walletCount: number;
      trust: string;
      callMc: number | null;
    };
    const existing = signals.find((s) => s.id === d.id);
    const next: DashboardSignal = {
      id: d.id,
      mint: d.mint,
      symbol: d.symbol,
      wallet_count: d.walletCount,
      trust: d.trust,
      call_mc: d.callMc,
      current_mc: existing?.current_mc ?? null,
      ath_multiplier: existing?.ath_multiplier ?? null,
      safe_ath_multiplier: existing?.safe_ath_multiplier ?? null,
      is_hit: existing?.is_hit ?? false,
      status: existing?.status ?? "open",
      detected_at: existing?.detected_at ?? new Date().toISOString(),
    };
    // Upsert: replace existing row or prepend as new
    if (existing) {
      return signals.map((s) => (s.id === d.id ? next : s));
    }
    return [next, ...signals];
  }

  if (frame.event === "smartmoney:outcome") {
    const d = frame.data as {
      id: number;
      mint: string;
      symbol: string | null;
      currentMc: number | null;
      athMultiplier: number | null;
      safeAthMultiplier: number | null;
      isHit: boolean;
      status: string;
    };
    const existing = signals.find((s) => s.id === d.id);
    if (!existing) return signals; // outcome before signal — no card to patch
    return signals.map((s) =>
      s.id === d.id
        ? {
            ...s,
            current_mc: d.currentMc,
            ath_multiplier: d.athMultiplier,
            safe_ath_multiplier: d.safeAthMultiplier,
            is_hit: d.isHit,
            status: d.status,
          }
        : s,
    );
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Sub-components: Trending + Top Traders
// ---------------------------------------------------------------------------

function TrendingRow({
  mint,
  symbol,
  name,
  mc_usd,
  mc_24h_pct,
}: {
  mint: string;
  symbol: string | null;
  name: string | null;
  mc_usd: number | null;
  mc_24h_pct: number | null;
}) {
  const label = symbol ?? name ?? shortAddr(mint);
  const pctNum = mc_24h_pct;
  const pctStr =
    pctNum === null || !Number.isFinite(pctNum)
      ? null
      : `${pctNum >= 0 ? "+" : ""}${pctNum.toFixed(1)}%`;
  const pctTone = pctNum === null ? "text-tertiary" : pctNum >= 0 ? "text-clean" : "text-high";

  return (
    <li className="flex items-center gap-2 border-b border-border-subtle/60 px-3 py-2 last:border-b-0">
      <Link
        href={`/token/${mint}`}
        className="font-mono text-sm text-primary hover:text-accent"
        title={mint}
      >
        {label}
      </Link>
      <span className="ml-auto flex items-center gap-3">
        {pctStr ? <span className={`font-mono tabular text-xs ${pctTone}`}>{pctStr}</span> : null}
        <span className="font-mono tabular text-2xs text-tertiary">{fmtMoneyCompact(mc_usd)}</span>
      </span>
    </li>
  );
}

function TraderRow({
  address,
  label,
  signal_wins,
  signal_signals,
  signal_winrate,
}: {
  address: string;
  label: string | null;
  signal_wins: number;
  signal_signals: number;
  signal_winrate: number | null;
}) {
  const display = label ?? shortAddr(address);
  const wr =
    signal_winrate !== null && Number.isFinite(signal_winrate)
      ? `${Math.round(signal_winrate * 100)}%`
      : null;

  // Derive a glyph variant — smart money traders get the "smart" glyph
  const glyphVariant = tagGlyphVariant("SMART_MONEY");

  return (
    <li className="flex items-center gap-2 border-b border-border-subtle/60 px-3 py-2 last:border-b-0">
      <WalletClassGlyph variant={glyphVariant} size={12} className="text-accent-dim shrink-0" />
      <Link
        href={`/wallet/${address}`}
        className="font-mono text-sm text-primary hover:text-accent"
        title={address}
      >
        {display}
      </Link>
      <span className="ml-auto flex items-center gap-3">
        <span className="font-mono tabular text-2xs text-tertiary">
          {signal_wins}/{signal_signals}
        </span>
        {wr ? <span className="font-mono tabular text-xs text-clean">{wr}</span> : null}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main Dashboard component
// ---------------------------------------------------------------------------

type LoadState = "loading" | "error" | "ready";

export function Dashboard() {
  const router = useRouter();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<DashboardBundle | null>(null);
  const [signals, setSignals] = useState<DashboardSignal[]>([]);

  // Command-bar search
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchValue, setSearchValue] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);

  // Bootstrap: fetch initial bundle
  useEffect(() => {
    let cancelled = false;
    getDashboard()
      .then((b) => {
        if (cancelled) return;
        setBundle(b);
        setSignals(b.live_signals);
        setLoadState("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "failed to load dashboard");
        setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // SSE: open intel feed and merge signal/outcome deltas
  const { events } = useSse({
    path: loadState === "ready" ? "/api/db/intel/feed" : null,
    ticketPath: "/api/db/intel/feed/ticket",
  });

  // Merge incoming SSE frames onto the signals list
  useEffect(() => {
    if (events.length === 0) return;
    const last = events[events.length - 1];
    if (!last) return;
    if (last.event !== "smartmoney:signal" && last.event !== "smartmoney:outcome") return;
    setSignals((prev) => mergeSignalFrame(prev, last));
  }, [events]);

  // ⌘K / Ctrl+K focuses the search input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const submitSearch = useCallback(() => {
    const trimmed = searchValue.trim();
    if (!trimmed) {
      setSearchError("paste a wallet or mint address");
      return;
    }
    if (!isValidSolanaAddress(trimmed)) {
      setSearchError("invalid base58 address");
      return;
    }
    setSearchError(null);
    // Heuristic: 32-char addresses lean token; others lean wallet.
    // User can always navigate from either page. We route to wallet first
    // because wallets are more common search targets on this dashboard.
    router.push(`/wallet/${trimmed}`);
  }, [searchValue, router]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-6">
      {/* Top bar */}
      <header className="mb-4 flex items-center justify-between gap-4 border-b border-border-subtle pb-4">
        <span className="font-mono text-base font-semibold tracking-[0.28em] text-accent">
          THIRDEYE
        </span>

        <div className="flex w-full max-w-sm flex-col gap-1">
          <KbdInput
            ref={searchRef}
            value={searchValue}
            onChange={(v) => {
              setSearchValue(v);
              if (searchError) setSearchError(null);
            }}
            onSubmit={submitSearch}
            placeholder="wallet or mint…"
            aria-label="search wallet or mint"
            trailing={
              <kbd className="font-mono text-2xs text-tertiary opacity-60">
                {typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
                  ? "⌘K"
                  : "Ctrl+K"}
              </kbd>
            }
          />
          {searchError ? (
            <p role="alert" className="font-mono text-2xs text-high">
              ▸ {searchError}
            </p>
          ) : null}
        </div>
      </header>

      {/* Loading / error states */}
      {loadState === "loading" && (
        <div className="py-16 text-center">
          <span className="cursor-blink font-mono text-sm text-tertiary">loading dashboard</span>
        </div>
      )}

      {loadState === "error" && (
        <div className="border border-high/40 bg-high/10 px-4 py-6">
          <p className="font-mono text-sm text-high">▸ {loadError ?? "failed to load dashboard"}</p>
        </div>
      )}

      {loadState === "ready" && bundle && (
        <>
          {/* Stats strip */}
          <StatsStrip stats={bundle.stats} />

          {/* Two-column grid */}
          <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_360px]">
            {/* Left: Live Signals */}
            <section>
              <header className="mb-2 flex items-center gap-2 px-1">
                <span className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
                  ▸ LIVE SIGNALS
                </span>
                <span className="font-mono tabular text-2xs text-tertiary/60">
                  ({signals.length})
                </span>
              </header>

              {signals.length === 0 ? (
                <div className="border border-border-subtle px-4 py-8">
                  <p className="font-mono text-sm text-tertiary">
                    no signals yet — promote some smart-money wallets
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {signals.map((sig) => (
                    <SignalCard key={sig.id} signal={sig} />
                  ))}
                </div>
              )}
            </section>

            {/* Right: Trending + Top Traders */}
            <aside className="flex flex-col gap-4">
              {/* Trending */}
              <section>
                <header className="mb-2 px-1">
                  <span className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
                    ▸ TRENDING
                  </span>
                </header>
                {bundle.trending.length === 0 ? (
                  <div className="border border-border-subtle px-3 py-4">
                    <p className="font-mono text-2xs text-tertiary">no trending tokens</p>
                  </div>
                ) : (
                  <ul className="border border-border-subtle bg-card">
                    {bundle.trending.map((t) => (
                      <TrendingRow key={t.mint} {...t} />
                    ))}
                  </ul>
                )}
              </section>

              {/* Top Traders */}
              <section>
                <header className="mb-2 px-1">
                  <span className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
                    ▸ TOP TRADERS
                  </span>
                </header>
                {bundle.top_traders.length === 0 ? (
                  <div className="border border-border-subtle px-3 py-4">
                    <p className="font-mono text-2xs text-tertiary">no tracked traders</p>
                  </div>
                ) : (
                  <ul className="border border-border-subtle bg-card">
                    {bundle.top_traders.map((t) => (
                      <TraderRow key={t.address} {...t} />
                    ))}
                  </ul>
                )}
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
