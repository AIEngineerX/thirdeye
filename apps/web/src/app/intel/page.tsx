"use client";

import { SmartMoneyFeed } from "@/components/SmartMoneyFeed";
import { tagLabel } from "@/components/WalletClassGlyph";
import { Watchlist } from "@/components/Watchlist";
import { useSse } from "@/hooks/useSse";
import { fmtClockMs, shortAddr } from "@/lib/format";
import type { SseFrame } from "@/lib/sse";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const MAX_EVENTS = 200;

interface FeedEntry {
  id: number;
  receivedAt: string;
  event: string;
  data: unknown;
}

export default function IntelFeedPage() {
  const [tab, setTab] = useState<"smart" | "all">("smart");
  const [paused, setPaused] = useState(false);
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  // reconnectKey lets the user manually reset the connection (e.g. after a
  // reconnect-clobber from another tab).
  const [reconnectKey, setReconnectKey] = useState(0);

  const { events, status, error, abort } = useSse({
    path: "/api/db/intel/feed",
    ticketPath: "/api/db/intel/feed/ticket",
    reconnectKey,
  });

  // Fold the raw event list into our paginated entries (newest at top).
  // Filter out keepalives (`ping`/`hello`). Bail when paused so the user can
  // freeze the tail to copy/inspect.
  useEffect(() => {
    if (paused) return;
    if (events.length === 0) {
      setEntries([]);
      return;
    }
    const last = events[events.length - 1]!;
    if (last.event === "ping" || last.event === "hello") return;
    setEntries((prev) => {
      const entry: FeedEntry = {
        id: events.length,
        receivedAt: new Date().toISOString(),
        event: last.event,
        data: last.data,
      };
      const next = [entry, ...prev];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, [events, paused]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of entries) c[e.event] = (c[e.event] ?? 0) + 1;
    return c;
  }, [entries]);

  const reconnect = () => {
    abort();
    setEntries([]);
    setReconnectKey((n) => n + 1);
  };

  const isStreaming = status === "streaming";

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-border-subtle pb-4">
        <div>
          <h1 className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
            intel feed
          </h1>
          <p className="mt-1 font-sans text-sm text-secondary">
            {isStreaming ? (
              <span className="cursor-blink">streaming · live tail (last {MAX_EVENTS})</span>
            ) : status === "error" ? (
              <span className="text-high">{error?.message ?? "stream failed"}</span>
            ) : status === "done" ? (
              "stream closed"
            ) : (
              "connecting…"
            )}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setTab("smart")}
              className={`px-2 py-1 font-mono text-2xs uppercase ${tab === "smart" ? "text-brand" : "text-tertiary"}`}
            >
              smart money
            </button>
            <button
              type="button"
              onClick={() => setTab("all")}
              className={`px-2 py-1 font-mono text-2xs uppercase ${tab === "all" ? "text-brand" : "text-tertiary"}`}
            >
              all intel
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              className={`border border-border-emphasis px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.2em] transition-colors hover:bg-card-hover ${
                paused ? "text-med" : "text-tertiary"
              }`}
            >
              {paused ? "resume" : "pause"}
            </button>
            <button
              type="button"
              onClick={reconnect}
              className="border border-border-emphasis px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.2em] text-tertiary transition-colors hover:bg-card-hover"
            >
              reconnect
            </button>
            <button
              type="button"
              onClick={() => setEntries([])}
              className="border border-border-emphasis px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.2em] text-tertiary transition-colors hover:bg-card-hover"
            >
              clear
            </button>
          </div>
        </div>
      </header>

      {tab === "smart" ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <SmartMoneyFeed frames={events.slice(-MAX_EVENTS)} />
          <Watchlist />
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 font-mono text-2xs uppercase tracking-[0.16em] text-tertiary">
            <span>received: {entries.length}</span>
            {Object.entries(counts)
              .sort(([, a], [, b]) => b - a)
              .map(([kind, n]) => (
                <span key={kind}>
                  {kind}: <span className="tabular text-secondary">{n}</span>
                </span>
              ))}
          </div>

          {status === "error" && error ? (
            <section className="mb-4 border border-high/60 bg-high/10 p-4">
              <header className="mb-2 font-mono text-2xs uppercase tracking-[0.22em] text-high">
                ▸ stream failed
              </header>
              <p className="font-sans text-sm text-primary">{error.message}</p>
              <button
                type="button"
                onClick={reconnect}
                className="mt-3 border border-high/60 px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.2em] text-high hover:bg-high/20"
              >
                retry
              </button>
            </section>
          ) : null}

          <section className="border border-border-subtle">
            {entries.length === 0 ? (
              <div className="border-b border-border-subtle px-4 py-6 text-center font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
                ▸ awaiting activity… run a scan to see events appear here
              </div>
            ) : (
              <ol>
                {entries.map((entry) => (
                  <FeedRow key={entry.id} entry={entry} />
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function FeedRow({ entry }: { entry: FeedEntry }) {
  const detail = describeEvent(entry.event, entry.data);
  const tone = eventTone(entry.event);

  return (
    <li className="grid grid-cols-[7rem_8rem_1fr] items-baseline gap-4 border-b border-border-subtle/60 px-4 py-2 font-mono text-sm last:border-b-0">
      <time className="text-2xs tabular text-tertiary">{fmtClockMs(entry.receivedAt)}</time>
      <span className={`text-2xs uppercase tracking-[0.18em] ${tone}`}>{entry.event}</span>
      <span className="min-w-0">{detail}</span>
    </li>
  );
}

function eventTone(event: string): string {
  if (event.startsWith("scan:")) return "text-accent";
  if (event.startsWith("check:")) return "text-accent-dim";
  if (event === "tag:applied") return "text-clean";
  if (event === "watch:event") return "text-med";
  return "text-secondary";
}

function describeEvent(event: string, data: unknown): React.ReactNode {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (event) {
    case "scan:start": {
      const mint = typeof d.mint === "string" ? d.mint : "";
      const symbol = typeof d.symbol === "string" ? d.symbol : null;
      return (
        <span className="flex items-baseline gap-3">
          <Link
            href={`/token/${mint}`}
            className="tabular text-primary hover:text-accent"
            title={mint}
          >
            {shortAddr(mint, 6, 6)}
          </Link>
          {symbol ? <span className="text-2xs uppercase text-tertiary">· {symbol}</span> : null}
        </span>
      );
    }
    case "scan:complete": {
      const mint = typeof d.mint === "string" ? d.mint : "";
      const symbol = typeof d.symbol === "string" ? d.symbol : null;
      const risk = typeof d.risk === "number" ? d.risk : null;
      const sybil = d.sybilFlag === true;
      const verdict =
        risk === null ? "—" : risk >= 70 ? "HIGH_RISK" : risk >= 30 ? "LOW_RISK" : "CLEAN";
      const tone =
        verdict === "HIGH_RISK" ? "text-high" : verdict === "LOW_RISK" ? "text-med" : "text-clean";
      return (
        <span className="flex items-baseline gap-3">
          <Link
            href={`/token/${mint}`}
            className="tabular text-primary hover:text-accent"
            title={mint}
          >
            {shortAddr(mint, 6, 6)}
          </Link>
          {symbol ? <span className="text-2xs uppercase text-tertiary">· {symbol}</span> : null}
          <span className={`text-2xs uppercase tracking-[0.18em] ${tone}`}>{verdict}</span>
          <span className="ml-auto tabular text-2xs text-tertiary">
            risk {risk ?? "—"}
            {sybil ? " · bundle detected" : ""}
          </span>
        </span>
      );
    }
    case "check:start": {
      const address = typeof d.address === "string" ? d.address : "";
      return (
        <Link
          href={`/wallet/${address}`}
          className="tabular text-primary hover:text-accent"
          title={address}
        >
          {shortAddr(address, 6, 6)}
        </Link>
      );
    }
    case "check:complete": {
      const address = typeof d.address === "string" ? d.address : "";
      const score = typeof d.score === "number" ? d.score : null;
      const verdict = typeof d.verdict === "string" ? d.verdict : null;
      const bucket =
        score === null
          ? ""
          : score >= 70
            ? "HIGH"
            : score >= 40
              ? "MEDIUM"
              : score >= 15
                ? "LOW"
                : "CLEAN";
      const tone =
        bucket === "HIGH"
          ? "text-high"
          : bucket === "MEDIUM"
            ? "text-med"
            : bucket === "LOW"
              ? "text-secondary"
              : "text-clean";
      return (
        <span className="flex items-baseline gap-3">
          <Link
            href={`/wallet/${address}`}
            className="tabular text-primary hover:text-accent"
            title={address}
          >
            {shortAddr(address, 6, 6)}
          </Link>
          {verdict ? <span className="text-2xs uppercase text-tertiary">· {verdict}</span> : null}
          <span className={`ml-auto text-2xs uppercase tracking-[0.18em] ${tone}`}>
            score {score ?? "—"}
          </span>
        </span>
      );
    }
    case "tag:applied": {
      const address = typeof d.address === "string" ? d.address : "";
      const tag = typeof d.tag === "string" ? tagLabel(d.tag) : "?";
      return (
        <span className="flex items-baseline gap-3">
          <Link
            href={`/wallet/${address}`}
            className="tabular text-primary hover:text-accent"
            title={address}
          >
            {shortAddr(address, 6, 6)}
          </Link>
          <span className="text-2xs uppercase tracking-[0.18em] text-clean">+ {tag}</span>
        </span>
      );
    }
    case "watch:event": {
      const address = typeof d.address === "string" ? d.address : "";
      const sig = typeof d.signature === "string" ? d.signature : "";
      const type = typeof d.type === "string" ? d.type : "—";
      return (
        <span className="flex items-baseline gap-3">
          <Link
            href={`/wallet/${address}`}
            className="tabular text-primary hover:text-accent"
            title={address}
          >
            {shortAddr(address, 6, 6)}
          </Link>
          <span className="text-2xs uppercase text-tertiary">· {type}</span>
          <span className="ml-auto tabular text-2xs text-tertiary" title={sig}>
            {shortAddr(sig, 5, 5)}
          </span>
        </span>
      );
    }
    default:
      return (
        <span className="text-2xs text-tertiary">
          {typeof data === "object" && data !== null ? JSON.stringify(data) : String(data)}
        </span>
      );
  }
}
