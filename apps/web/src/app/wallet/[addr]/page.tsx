"use client";

import { AddressBanner } from "@/components/AddressBanner";
import { ClusterPanel } from "@/components/ClusterPanel";
import { MetricStamp } from "@/components/MetricStamp";
import { SeverityBadge } from "@/components/SeverityBadge";
import { TagList } from "@/components/TagList";
import { Ticker, type TickerItem } from "@/components/Ticker";
import { useSse } from "@/hooks/useSse";
import type {
  Balances,
  Cluster,
  FundingHop,
  Identity,
  ScoreBucket,
  Tag,
  TxPattern,
  WalletCheckResult,
} from "@/lib/api-types";
import { fmtInt, fmtSol, fmtUsd, isValidSolanaAddress } from "@/lib/format";
import type { SseFrame } from "@/lib/sse";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";

interface WalletState {
  cached: boolean | null;
  identity: Identity | null;
  balances: Balances | null;
  fundingChain: FundingHop[];
  cluster: Cluster | null;
  txPattern: TxPattern | null;
  tags: Tag[] | null;
  result: WalletCheckResult | null;
  scannerError: { error: string; message: string } | null;
}

function reduceEvents(events: SseFrame[]): WalletState {
  // O(n) walk; assign in place. The reduce+spread pattern would be O(n²)
  // because each spread allocates a new state object every step.
  const state: WalletState = {
    cached: null,
    identity: null,
    balances: null,
    fundingChain: [],
    cluster: null,
    txPattern: null,
    tags: null,
    result: null,
    scannerError: null,
  };
  for (const frame of events) {
    switch (frame.event) {
      case "started":
        state.cached = (frame.data as { cached: boolean }).cached;
        break;
      case "identity":
        state.identity = frame.data as Identity;
        break;
      case "balances":
        state.balances = frame.data as Balances;
        break;
      case "funding":
        state.fundingChain = (frame.data as { chain: FundingHop[] }).chain;
        break;
      case "cluster":
        state.cluster = frame.data as Cluster;
        break;
      case "txPattern":
        state.txPattern = frame.data as TxPattern;
        break;
      case "tags":
        state.tags = (frame.data as { tags: Tag[] }).tags;
        break;
      case "result":
        state.result = frame.data as WalletCheckResult;
        break;
      case "error":
        state.scannerError = frame.data as { error: string; message: string };
        break;
    }
  }
  return state;
}

function tickerItemsFromEvents(events: SseFrame[]): TickerItem[] {
  const items: TickerItem[] = [];
  for (let i = 0; i < events.length; i++) {
    const f = events[i]!;
    let detail: string | undefined;
    switch (f.event) {
      case "balances": {
        const d = f.data as Balances;
        detail = `${fmtInt(d.tokenCount)} tokens`;
        break;
      }
      case "funding": {
        const d = f.data as { chain: FundingHop[] };
        detail = `${d.chain.length} hops`;
        break;
      }
      case "cluster": {
        const d = f.data as Cluster;
        detail = `cluster ${d.size}`;
        break;
      }
      case "txPattern": {
        const d = f.data as TxPattern;
        detail = `${fmtInt(d.txCount)} tx`;
        break;
      }
      case "tags": {
        const d = f.data as { tags: Tag[] };
        detail = `${d.tags.length} tags`;
        break;
      }
    }
    const item: TickerItem = { id: i, label: f.event };
    if (detail !== undefined) item.detail = detail;
    items.push(item);
  }
  return items;
}

export default function WalletDetailPage() {
  const params = useParams<{ addr: string }>();
  const router = useRouter();
  const addr = decodeURIComponent(params.addr);
  const [force, setForce] = useState(0);

  const valid = isValidSolanaAddress(addr);
  const path = valid ? `/api/wallet/${addr}/check${force > 0 ? "?force=true" : ""}` : null;

  const { events, status, error, abort } = useSse({
    path,
    reconnectKey: force,
  });

  const state = useMemo(() => reduceEvents(events), [events]);
  const tickerItems = useMemo(() => tickerItemsFromEvents(events), [events]);

  if (!valid) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-12">
        <ErrorCard
          title="invalid address"
          message="The provided address is not a valid Solana base58 address (32-44 chars, no 0/O/I/l)."
          actionLabel="back to landing"
          onAction={() => router.push("/")}
        />
      </div>
    );
  }

  const forceRescan = () => {
    abort();
    setForce((n) => n + 1);
  };

  const score = state.result?.score ?? null;
  const verdict = state.result?.verdict ?? null;
  const scoreBucket = state.result?.scoreBucket ?? null;
  const scoreTone = bucketToTone(scoreBucket);

  const isStreaming = status === "streaming";
  const isDone = status === "done";
  const tags = state.tags ?? state.result?.tags ?? [];

  return (
    <div className="flex flex-col">
      {isStreaming && tickerItems.length > 0 ? <Ticker items={tickerItems} /> : null}

      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
              wallet · /wallet/{addr.slice(0, 6)}…
            </h1>
            <p className="mt-1 font-sans text-sm text-secondary">
              {isStreaming ? (
                <span className="cursor-blink">streaming</span>
              ) : isDone ? (
                <>
                  {state.cached ? "cached — " : ""}
                  scan complete
                </>
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
          <AddressBanner address={addr} label="subject address" />
        </div>

        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <MetricStamp
            rows={[
              {
                label: "score",
                value:
                  score === null ? (
                    <span className="text-tertiary">—</span>
                  ) : (
                    <span className="text-3xl">{score}</span>
                  ),
                tone: scoreTone,
              },
              {
                label: "verdict",
                value: verdict ? (
                  <SeverityBadge
                    severity={scoreBucket ?? "LOW"}
                    pulse={isDone}
                    className="text-2xs"
                  />
                ) : (
                  <span className="text-tertiary">—</span>
                ),
                mono: false,
              },
              {
                label: "age",
                value:
                  state.txPattern && state.txPattern.ageDays >= 0
                    ? `${fmtInt(state.txPattern.ageDays)} d`
                    : "—",
              },
              {
                label: "tx count",
                value: state.txPattern ? fmtInt(state.txPattern.txCount) : "—",
              },
              {
                label: "usd value",
                value: state.balances ? fmtUsd(state.balances.usdValue) : "—",
              },
              {
                label: "sol balance",
                value: state.balances ? fmtSol(state.balances.solBalance) : "—",
              },
              {
                label: "tokens",
                value: state.balances ? fmtInt(state.balances.tokenCount) : "—",
              },
              {
                label: "realized pnl",
                value: state.result ? fmtSol(state.result.realizedPnlSol) : "—",
                tone:
                  state.result?.realizedPnlSol && state.result.realizedPnlSol > 0
                    ? "clean"
                    : state.result?.realizedPnlSol && state.result.realizedPnlSol < 0
                      ? "high"
                      : "primary",
              },
            ]}
          />

          <div className="space-y-6">
            <section className="border border-border-subtle bg-card">
              <header className="border-b border-border-subtle px-4 py-3">
                <h3 className="font-mono text-2xs uppercase tracking-[0.22em] text-secondary">
                  tags
                </h3>
              </header>
              <div className="px-4 py-4">
                <TagList tags={tags} />
              </div>
            </section>

            {state.cluster ? (
              <ClusterPanel
                firstFunder={state.cluster.firstFunder}
                size={state.cluster.size}
                cov={state.cluster.cov}
                timeWindowSiblings={state.cluster.timeWindowSiblings.length}
                fundingChain={state.fundingChain}
              />
            ) : state.fundingChain.length > 0 ? (
              <ClusterPanel
                firstFunder={null}
                size={null}
                cov={null}
                fundingChain={state.fundingChain}
              />
            ) : null}

            {state.txPattern ? (
              <section className="border border-border-subtle bg-card">
                <header className="border-b border-border-subtle px-4 py-3">
                  <h3 className="font-mono text-2xs uppercase tracking-[0.22em] text-secondary">
                    tx pattern
                  </h3>
                </header>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 px-4 py-4 text-sm">
                  <dt className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
                    avg gap
                  </dt>
                  <dd className="font-mono tabular text-primary">
                    {state.txPattern.avgGapSec === null
                      ? "—"
                      : `${fmtInt(state.txPattern.avgGapSec)} s`}
                  </dd>
                  <dt className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
                    swap-only
                  </dt>
                  <dd className="font-mono text-primary">
                    {state.txPattern.swapOnly ? "yes" : "no"}
                  </dd>
                  <dt className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
                    rapid fire
                  </dt>
                  <dd
                    className={`font-mono ${state.txPattern.rapidFire ? "text-high" : "text-primary"}`}
                  >
                    {state.txPattern.rapidFire ? "yes" : "no"}
                  </dd>
                  <dt className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
                    unique recipients
                  </dt>
                  <dd className="font-mono tabular text-primary">
                    {fmtInt(state.txPattern.uniqueOutboundRecipients)}
                  </dd>
                </dl>
              </section>
            ) : null}

            {state.scannerError ? (
              <ErrorCard
                title={state.scannerError.error}
                message={state.scannerError.message}
                actionLabel="retry"
                onAction={forceRescan}
              />
            ) : null}

            {status === "error" && error ? (
              <ErrorCard
                title="stream failed"
                message={error.message}
                actionLabel="retry"
                onAction={forceRescan}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function bucketToTone(bucket: ScoreBucket | null): "primary" | "clean" | "med" | "high" {
  switch (bucket) {
    case "CLEAN":
      return "clean";
    case "LOW":
      return "primary";
    case "MEDIUM":
      return "med";
    case "HIGH":
      return "high";
    default:
      return "primary";
  }
}

function ErrorCard({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section className="border border-high/60 bg-high/10 p-5">
      <header className="mb-2 font-mono text-2xs uppercase tracking-[0.22em] text-high">
        ▸ {title}
      </header>
      <p className="font-sans text-sm text-primary">{message}</p>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="mt-4 border border-high/60 px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.2em] text-high hover:bg-high/20"
        >
          {actionLabel}
        </button>
      ) : null}
    </section>
  );
}
