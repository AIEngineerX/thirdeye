"use client";

import { AddressBanner } from "@/components/AddressBanner";
import { MetricStamp } from "@/components/MetricStamp";
import { SeverityBadge } from "@/components/SeverityBadge";
import { Ticker, type TickerItem } from "@/components/Ticker";
import { useSse } from "@/hooks/useSse";
import type {
  LpHolder,
  TokenCluster,
  TokenMetadata,
  TokenScanResult,
  TokenVerdict,
  TopHolder,
} from "@/lib/api-types";
import { fmtInt, fmtPct, isValidSolanaAddress, shortAddr } from "@/lib/format";
import type { SseFrame } from "@/lib/sse";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";

interface TokenState {
  cached: boolean | null;
  metadata: (TokenMetadata & { launchpad: string | null }) | null;
  holdersTotal: number | null;
  holdersScanned: number | null;
  topHolders: TopHolder[];
  lpPct: number | null;
  lockedPct: number | null;
  lpHolders: LpHolder[];
  lockedHolders: LpHolder[];
  fundingProgress: { scanned: number; total: number; errored: number } | null;
  clusters: TokenCluster[];
  result: TokenScanResult | null;
  scannerError: { error: string; message: string } | null;
}

function reduceEvents(events: SseFrame[]): TokenState {
  // O(n) walk; assign in place. See wallet page's reduceEvents for rationale.
  const state: TokenState = {
    cached: null,
    metadata: null,
    holdersTotal: null,
    holdersScanned: null,
    topHolders: [],
    lpPct: null,
    lockedPct: null,
    lpHolders: [],
    lockedHolders: [],
    fundingProgress: null,
    clusters: [],
    result: null,
    scannerError: null,
  };
  for (const frame of events) {
    switch (frame.event) {
      case "started":
        state.cached = (frame.data as { cached: boolean }).cached;
        break;
      case "metadata":
        state.metadata = frame.data as TokenMetadata & { launchpad: string | null };
        break;
      case "holders": {
        const d = frame.data as {
          totalHolders: number;
          scannedHolders: number;
          top: TopHolder[];
        };
        state.holdersTotal = d.totalHolders;
        state.holdersScanned = d.scannedHolders;
        state.topHolders = d.top;
        break;
      }
      case "lpFilter": {
        const d = frame.data as {
          lpPct: number;
          lockedPct: number;
          lpHolders: LpHolder[];
          lockedHolders: LpHolder[];
        };
        state.lpPct = d.lpPct;
        state.lockedPct = d.lockedPct;
        state.lpHolders = d.lpHolders;
        state.lockedHolders = d.lockedHolders;
        break;
      }
      case "fundingProgress":
        state.fundingProgress = frame.data as {
          scanned: number;
          total: number;
          errored: number;
        };
        break;
      case "clusters":
        state.clusters = (frame.data as { clusters: TokenCluster[] }).clusters;
        break;
      case "result":
        state.result = frame.data as TokenScanResult;
        break;
      case "error":
        state.scannerError = frame.data as { error: string; message: string };
        break;
    }
  }
  return state;
}

function tickerFromEvents(events: SseFrame[]): TickerItem[] {
  const out: TickerItem[] = [];
  for (let i = 0; i < events.length; i++) {
    const f = events[i]!;
    let detail: string | undefined;
    switch (f.event) {
      case "metadata": {
        const d = f.data as { symbol: string | null };
        detail = d.symbol ?? undefined;
        break;
      }
      case "holders": {
        const d = f.data as { totalHolders: number; scannedHolders: number };
        detail = `${fmtInt(d.scannedHolders)}/${fmtInt(d.totalHolders)} holders`;
        break;
      }
      case "lpFilter": {
        const d = f.data as { lpPct: number; lockedPct: number };
        detail = `lp ${fmtPct(d.lpPct, 1)} · locked ${fmtPct(d.lockedPct, 1)}`;
        break;
      }
      case "fundingProgress": {
        const d = f.data as { scanned: number; total: number };
        detail = `funded ${fmtInt(d.scanned)}/${fmtInt(d.total)}`;
        break;
      }
      case "clusters": {
        const d = f.data as { clusters: TokenCluster[] };
        detail = `${d.clusters.length} clusters`;
        break;
      }
    }
    const item: TickerItem = { id: i, label: f.event };
    if (detail !== undefined) item.detail = detail;
    out.push(item);
  }
  return out;
}

function verdictTone(v: TokenVerdict | null): "primary" | "clean" | "med" | "high" {
  switch (v) {
    case "CLEAN":
      return "clean";
    case "LOW_RISK":
      return "med";
    case "HIGH_RISK":
      return "high";
    default:
      return "primary";
  }
}

export default function TokenDetailPage() {
  const params = useParams<{ mint: string }>();
  const router = useRouter();
  const mint = decodeURIComponent(params.mint);
  const [force, setForce] = useState(0);

  const valid = isValidSolanaAddress(mint);
  const path = valid ? `/api/token/${mint}/scan${force > 0 ? "?force=true" : ""}` : null;

  const { events, status, error, abort } = useSse({
    path,
    reconnectKey: force,
  });

  const state = useMemo(() => reduceEvents(events), [events]);
  const tickerItems = useMemo(() => tickerFromEvents(events), [events]);

  if (!valid) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-12">
        <section className="border border-high/60 bg-high/10 p-5">
          <header className="mb-2 font-mono text-2xs uppercase tracking-[0.22em] text-high">
            ▸ invalid mint
          </header>
          <p className="font-sans text-sm text-primary">
            The provided mint is not a valid Solana base58 address (32-44 chars).
          </p>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="mt-4 border border-high/60 px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.2em] text-high hover:bg-high/20"
          >
            back to landing
          </button>
        </section>
      </div>
    );
  }

  const forceRescan = () => {
    abort();
    setForce((n) => n + 1);
  };

  const verdict = state.result?.verdict ?? null;
  const risk = state.result?.risk ?? null;
  const isStreaming = status === "streaming";
  const isDone = status === "done";

  return (
    <div className="flex flex-col">
      {isStreaming && tickerItems.length > 0 ? <Ticker items={tickerItems} /> : null}

      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
              token · {state.metadata?.symbol ?? "—"} ·{" "}
              {state.metadata?.name ?? <span className="text-tertiary">unknown</span>}
            </h1>
            <p className="mt-1 font-sans text-sm text-secondary">
              {isStreaming ? (
                <span className="cursor-blink">streaming</span>
              ) : isDone ? (
                <>{state.cached ? "cached — " : ""}scan complete</>
              ) : status === "error" ? (
                <span className="text-high">{error?.message ?? "stream failed"}</span>
              ) : (
                "idle"
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {state.cached ? (
              <span className="border border-border-emphasis bg-card px-2 py-1 font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
                cached
              </span>
            ) : null}
            <button
              type="button"
              onClick={forceRescan}
              className="border border-border-emphasis px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.2em] text-accent transition-colors hover:bg-accent-bg"
            >
              force re-scan
            </button>
          </div>
        </div>

        <div className="mb-8">
          <AddressBanner address={mint} label="mint address" />
        </div>

        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <MetricStamp
            rows={[
              {
                label: "risk",
                value:
                  risk === null ? (
                    <span className="text-tertiary">—</span>
                  ) : (
                    <span className="text-3xl">{risk}</span>
                  ),
                tone: verdictTone(verdict),
              },
              {
                label: "verdict",
                value: verdict ? (
                  <SeverityBadge
                    severity={
                      verdict === "LOW_RISK" ? "LOW" : verdict === "HIGH_RISK" ? "HIGH" : "CLEAN"
                    }
                    pulse={isDone}
                    className="text-2xs"
                  />
                ) : (
                  <span className="text-tertiary">—</span>
                ),
                mono: false,
              },
              {
                label: "sybil flag",
                value: state.result ? (
                  state.result.sybilFlag ? (
                    <span className="text-high">▲ true</span>
                  ) : (
                    "false"
                  )
                ) : (
                  "—"
                ),
              },
              {
                label: "supply",
                value: state.metadata ? state.metadata.supply : "—",
              },
              {
                label: "holders",
                value: state.holdersTotal === null ? "—" : `${fmtInt(state.holdersTotal)}`,
              },
              {
                label: "scanned",
                value: state.holdersScanned === null ? "—" : fmtInt(state.holdersScanned),
              },
              {
                label: "lp pct",
                value: fmtPct(state.lpPct, 2),
                tone: "primary",
              },
              {
                label: "locked pct",
                value: fmtPct(state.lockedPct, 2),
                tone: "primary",
              },
              {
                label: "clustered pct",
                value: state.result ? fmtPct(state.result.totalClusteredPct, 2) : "—",
                tone:
                  state.result && state.result.totalClusteredPct > 50
                    ? "high"
                    : state.result && state.result.totalClusteredPct > 20
                      ? "med"
                      : "primary",
              },
            ]}
          />

          <div className="space-y-6">
            {state.fundingProgress ? (
              <section className="border border-border-subtle bg-card px-4 py-3">
                <div className="flex items-center justify-between font-mono text-2xs uppercase tracking-[0.18em]">
                  <span className="text-tertiary">funder lookups</span>
                  <span className="tabular text-secondary">
                    {fmtInt(state.fundingProgress.scanned)} / {fmtInt(state.fundingProgress.total)}
                    {state.fundingProgress.errored > 0 ? (
                      <span className="ml-2 text-high">
                        · {fmtInt(state.fundingProgress.errored)} err
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="mt-2 h-[3px] w-full bg-base">
                  <div
                    className="h-full bg-accent transition-all duration-300"
                    style={{
                      width: `${Math.min(100, (state.fundingProgress.scanned / Math.max(1, state.fundingProgress.total)) * 100)}%`,
                    }}
                  />
                </div>
              </section>
            ) : null}

            {state.clusters.length > 0 ? (
              <section className="border border-border-subtle bg-card">
                <header className="flex items-baseline justify-between border-b border-border-subtle px-4 py-3">
                  <h3 className="font-mono text-2xs uppercase tracking-[0.22em] text-secondary">
                    clusters
                  </h3>
                  <span className="font-mono text-2xs tabular text-tertiary">
                    {state.clusters.length} detected
                  </span>
                </header>
                <ol>
                  {state.clusters.slice(0, 12).map((c, i) => (
                    <li
                      key={`${c.root}-${i}`}
                      className="grid grid-cols-[2rem_1fr_auto_auto] items-baseline gap-3 border-b border-border-subtle/60 px-4 py-2 last:border-b-0"
                    >
                      <span className="font-mono text-2xs tabular text-tertiary">{i + 1}</span>
                      <span
                        className="truncate font-mono tabular text-sm text-primary"
                        title={c.root}
                      >
                        {shortAddr(c.root, 6, 6)}
                      </span>
                      <span className="font-mono text-2xs tabular text-tertiary">
                        {fmtInt(c.members.length)} members
                      </span>
                      <span
                        className={`font-mono tabular text-sm ${
                          c.totalPct > 10
                            ? "text-high"
                            : c.totalPct > 3
                              ? "text-med"
                              : "text-primary"
                        }`}
                      >
                        {fmtPct(c.totalPct, 2)}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            {state.topHolders.length > 0 && state.clusters.length === 0 ? (
              <section className="border border-border-subtle bg-card">
                <header className="border-b border-border-subtle px-4 py-3">
                  <h3 className="font-mono text-2xs uppercase tracking-[0.22em] text-secondary">
                    top holders
                  </h3>
                </header>
                <ol>
                  {state.topHolders.slice(0, 10).map((h, i) => (
                    <li
                      key={`${h.owner}-${i}`}
                      className="grid grid-cols-[2rem_1fr_auto] items-baseline gap-3 border-b border-border-subtle/60 px-4 py-2 last:border-b-0"
                    >
                      <span className="font-mono text-2xs tabular text-tertiary">{i + 1}</span>
                      <span
                        className="truncate font-mono tabular text-sm text-primary"
                        title={h.owner}
                      >
                        {shortAddr(h.owner, 6, 6)}
                      </span>
                      <span className="font-mono tabular text-sm text-primary">
                        {fmtPct(h.pct, 2)}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            {state.scannerError ? (
              <section className="border border-high/60 bg-high/10 p-5">
                <header className="mb-2 font-mono text-2xs uppercase tracking-[0.22em] text-high">
                  ▸ {state.scannerError.error}
                </header>
                <p className="font-sans text-sm text-primary">{state.scannerError.message}</p>
                <button
                  type="button"
                  onClick={forceRescan}
                  className="mt-4 border border-high/60 px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.2em] text-high hover:bg-high/20"
                >
                  retry
                </button>
              </section>
            ) : null}

            {status === "error" && error ? (
              <section className="border border-high/60 bg-high/10 p-5">
                <header className="mb-2 font-mono text-2xs uppercase tracking-[0.22em] text-high">
                  ▸ stream failed
                </header>
                <p className="font-sans text-sm text-primary">{error.message}</p>
                <button
                  type="button"
                  onClick={forceRescan}
                  className="mt-4 border border-high/60 px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.2em] text-high hover:bg-high/20"
                >
                  retry
                </button>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
