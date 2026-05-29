"use client";

import { ActionRow } from "@/components/ActionRow";
import { EvidenceStrip } from "@/components/EvidenceStrip";
import { MarketPanel, type MarketPanelData } from "@/components/MarketPanel";
import { MetricStamp } from "@/components/MetricStamp";
import { AMBER, MINT, PriceChart } from "@/components/PriceChart";
import { SeverityBadge } from "@/components/SeverityBadge";
import { Ticker, type TickerItem } from "@/components/Ticker";
import { useSse } from "@/hooks/useSse";
import { getOhlcv, getToken, getTokenMarkers } from "@/lib/api";
import type {
  LpHolder,
  TokenCluster,
  TokenMetadata,
  TokenScanResult,
  TokenVerdict,
  TopHolder,
} from "@/lib/api-types";
import { fmtInt, fmtPct, isValidSolanaAddress, shortAddr } from "@/lib/format";
import type { ChartMarker, OhlcvCandle } from "@/lib/ohlcv-types";
import type { SseFrame } from "@/lib/sse";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

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

function TokenForensicHero({
  state,
  risk,
  verdict,
  isStreaming,
  isDone,
}: {
  state: TokenState;
  risk: number | null;
  verdict: TokenVerdict | null;
  isStreaming: boolean;
  isDone: boolean;
}) {
  const topHolderPct = state.topHolders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0);
  const clusteredPct = state.result?.totalClusteredPct ?? 0;
  const scanned =
    state.fundingProgress === null
      ? 0
      : (state.fundingProgress.scanned / Math.max(1, state.fundingProgress.total)) * 100;
  const bars = [
    ["clustered", clusteredPct, clusteredPct > 50 ? "high" : clusteredPct > 20 ? "med" : "clean"],
    ["top 10", topHolderPct, topHolderPct > 50 ? "high" : topHolderPct > 25 ? "med" : "primary"],
    ["lp", state.lpPct ?? 0, "primary"],
    ["locked", state.lockedPct ?? 0, (state.lockedPct ?? 0) > 50 ? "clean" : "med"],
    ["scan", scanned, isStreaming ? "med" : isDone ? "clean" : "primary"],
  ] as const;

  return (
    <section className="mb-6 border border-border-subtle bg-card">
      <div className="grid gap-px bg-border-subtle lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.8fr)]">
        <div className="bg-card p-4">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
                forensic exposure
              </div>
              <div className="mt-2 flex flex-wrap items-baseline gap-3">
                <span className={`font-mono text-4xl tabular ${toneClass(verdictTone(verdict))}`}>
                  {risk === null ? "--" : risk}
                </span>
                <span className="font-mono text-2xs uppercase tracking-[0.18em] text-secondary">
                  {verdict ?? "scanning"}
                </span>
              </div>
            </div>
            <div className="font-mono text-2xs uppercase tracking-[0.14em] text-tertiary">
              {isStreaming ? (
                <span className="cursor-blink text-secondary">streaming scan</span>
              ) : isDone ? (
                "scan complete"
              ) : (
                "waiting"
              )}
            </div>
          </div>
          <ClusterBubbleMap clusters={state.clusters} topHolders={state.topHolders} />
        </div>
        <div className="bg-card p-4">
          <div className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
            exposure mix
          </div>
          <div className="mt-4 space-y-3">
            {bars.map(([label, value, tone]) => (
              <ExposureBar key={label} label={label} value={value} tone={tone} />
            ))}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-px bg-border-subtle font-mono">
            <MiniCell
              label="holders"
              value={state.holdersTotal === null ? "--" : fmtInt(state.holdersTotal)}
            />
            <MiniCell
              label="scanned"
              value={state.holdersScanned === null ? "--" : fmtInt(state.holdersScanned)}
            />
            <MiniCell label="clusters" value={fmtInt(state.clusters.length)} />
            <MiniCell
              label="bundle flag"
              value={state.result?.sybilFlag ? "detected" : state.result ? "clear" : "--"}
              tone={state.result?.sybilFlag ? "high" : "primary"}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function ClusterBubbleMap({
  clusters,
  topHolders,
}: {
  clusters: TokenCluster[];
  topHolders: TopHolder[];
}) {
  const items =
    clusters.length > 0
      ? clusters.slice(0, 14).map((c, i) => ({
          id: `${c.root}-${i}`,
          label: shortAddr(c.root, 3, 3),
          pct: c.totalPct,
          detail: `${fmtInt(c.members.length)} wallets`,
        }))
      : topHolders.slice(0, 14).map((h, i) => ({
          id: `${h.owner}-${i}`,
          label: shortAddr(h.owner, 3, 3),
          pct: h.pct,
          detail: "holder",
        }));
  if (items.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center border border-border-subtle bg-base font-mono text-2xs uppercase tracking-[0.2em] text-tertiary">
        awaiting holder stream
      </div>
    );
  }
  const max = Math.max(...items.map((i) => i.pct), 1);
  return (
    <div className="grid min-h-64 grid-cols-2 gap-px bg-border-subtle sm:grid-cols-4 lg:grid-cols-7">
      {items.map((item, i) => {
        const scale = 0.42 + (item.pct / max) * 0.58;
        const tone =
          item.pct > 10
            ? "bg-high text-primary"
            : item.pct > 3
              ? "bg-accent-bg text-accent"
              : "bg-base text-secondary";
        return (
          <div
            key={item.id}
            className="flex min-h-28 items-center justify-center bg-card p-2"
            title={`${item.label} · ${fmtPct(item.pct, 2)} · ${item.detail}`}
          >
            <div
              className={`flex aspect-square min-h-12 min-w-12 flex-col items-center justify-center rounded-full border border-border-emphasis px-2 text-center font-mono ${tone}`}
              style={{ transform: `scale(${scale})` }}
            >
              <span className="text-2xs tabular">{i + 1}</span>
              <span className="mt-1 text-2xs tabular">{fmtPct(item.pct, 1)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ExposureBar({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "primary" | "clean" | "med" | "high";
}) {
  const width = Math.max(2, Math.min(100, value));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between font-mono text-2xs uppercase tracking-[0.14em]">
        <span className="text-tertiary">{label}</span>
        <span className={toneClass(tone)}>{fmtPct(value, 1)}</span>
      </div>
      <div className="h-2 bg-base">
        <div className={`h-full ${barClass(tone)}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function MiniCell({
  label,
  value,
  tone = "primary",
}: {
  label: string;
  value: string;
  tone?: "primary" | "clean" | "med" | "high";
}) {
  return (
    <div className="bg-card px-3 py-2">
      <div className="text-2xs uppercase tracking-[0.15em] text-tertiary">{label}</div>
      <div className={`mt-1 text-sm tabular ${toneClass(tone)}`}>{value}</div>
    </div>
  );
}

function toneClass(tone: "primary" | "clean" | "med" | "high") {
  return tone === "clean"
    ? "text-clean"
    : tone === "med"
      ? "text-med"
      : tone === "high"
        ? "text-high"
        : "text-primary";
}

function barClass(tone: "primary" | "clean" | "med" | "high") {
  return tone === "clean"
    ? "bg-clean"
    : tone === "med"
      ? "bg-med"
      : tone === "high"
        ? "bg-high"
        : "bg-accent";
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

  const [candles, setCandles] = useState<OhlcvCandle[]>([]);
  const [markers, setMarkers] = useState<ChartMarker[]>([]);
  const [marketData, setMarketData] = useState<MarketPanelData | null>(null);

  useEffect(() => {
    if (!valid) return;
    let cancelled = false;

    async function load() {
      try {
        const [ohlcv, mk, tok] = await Promise.allSettled([
          getOhlcv(mint),
          getTokenMarkers(mint),
          getToken(mint),
        ]);

        if (cancelled) return;

        if (ohlcv.status === "fulfilled") setCandles(ohlcv.value);

        if (mk.status === "fulfilled") {
          const ms: ChartMarker[] = [];
          if (mk.value.call) {
            ms.push({
              time: mk.value.call.time,
              position: "aboveBar",
              color: AMBER,
              shape: "arrowDown",
              text: mk.value.call.multiplier ? `${mk.value.call.multiplier.toFixed(1)}x` : "call",
            });
          }
          for (const b of mk.value.buys) {
            ms.push({ time: b.time, position: "belowBar", color: MINT, shape: "circle" });
          }
          ms.sort((a, b) => a.time - b.time);
          setMarkers(ms);
        }

        if (tok.status === "fulfilled" && tok.value) {
          setMarketData({
            priceUsd: tok.value.priceUsd,
            mcUsd: tok.value.mcUsd,
            mc24hPct: tok.value.mc24hPct,
            liquidityUsd: tok.value.liquidityUsd,
            fdvUsd: null,
          });
        }
      } catch {
        // tolerate failure — chart/panel show "—"/empty state
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [mint, valid]);

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

        <div className="mb-4">
          <EvidenceStrip
            address={mint}
            kind="mint"
            label="mint evidence"
            meta={state.metadata?.symbol ?? undefined}
          />
          <div className="mt-2 px-1">
            <ActionRow address={mint} kind="mint" variant="extras" />
          </div>
        </div>

        <div className="mb-2 h-[260px]">
          <PriceChart candles={candles} markers={markers} />
        </div>
        <div className="mb-6">
          <MarketPanel data={marketData} />
        </div>

        <details className="mb-6 border border-border-subtle bg-card">
          <summary className="cursor-pointer px-4 py-3 font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
            ▸ forensics
          </summary>
          <div className="p-4">
            <TokenForensicHero
              state={state}
              risk={risk}
              verdict={verdict}
              isStreaming={isStreaming}
              isDone={isDone}
            />

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
                          verdict === "LOW_RISK"
                            ? "LOW"
                            : verdict === "HIGH_RISK"
                              ? "HIGH"
                              : "CLEAN"
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
                    label: "bundle flag",
                    value: state.result ? (
                      state.result.sybilFlag ? (
                        <span className="text-high">detected</span>
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
                        {fmtInt(state.fundingProgress.scanned)} /{" "}
                        {fmtInt(state.fundingProgress.total)}
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
        </details>
      </div>
    </div>
  );
}
