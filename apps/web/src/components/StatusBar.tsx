"use client";

import { getAuthClient } from "@/lib/auth";
import { fmtDaysUntil } from "@/lib/format";
import { useEffect, useState } from "react";

type HealthState = "checking" | "ok" | "down";

const HEALTH_POLL_MS = 30_000;
const SESSION_TICK_MS = 1_000;

interface SessionView {
  expiresAt: string | null;
}

/**
 * Persistent bottom status bar. Three segments:
 *
 *   [●] api: <state>   ·   session: <ttl>   ·   ready
 *
 * The api dot polls `/health` every 30s. Session TTL ticks every second so
 * the countdown feels live. The "ready" segment is a placeholder for a
 * future live event-tail subscription (deferred — see plan).
 */
export function StatusBar() {
  const [health, setHealth] = useState<HealthState>("checking");
  const [session, setSession] = useState<SessionView>({ expiresAt: null });
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;

    const ping = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const r = await fetch("/health", { signal: ctrl.signal, cache: "no-store" });
        if (cancelled) return;
        setHealth(r.ok ? "ok" : "down");
      } catch {
        if (!cancelled) setHealth("down");
      } finally {
        clearTimeout(timer);
      }
    };

    void ping();
    const id = setInterval(ping, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const tick = () => {
      const record = getAuthClient().peek();
      setSession({ expiresAt: record?.expiresAt ?? null });
      setNowMs(Date.now());
    };
    tick();
    const id = setInterval(tick, SESSION_TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <footer className="fixed inset-x-0 bottom-0 z-50 h-7 border-t border-border-subtle bg-base">
      <div className="mx-auto flex h-full max-w-6xl items-center gap-6 px-6 font-mono text-2xs uppercase tracking-[0.16em]">
        <HealthSegment state={health} />
        <span className="text-tertiary">·</span>
        <SessionSegment expiresAt={session.expiresAt} nowMs={nowMs} />
        <span className="text-tertiary">·</span>
        <ReadySegment />
      </div>
    </footer>
  );
}

function HealthSegment({ state }: { state: HealthState }) {
  const tone =
    state === "ok"
      ? { dot: "text-clean animate-heartbeat", label: "text-secondary" }
      : state === "down"
        ? { dot: "text-high", label: "text-high" }
        : { dot: "text-tertiary animate-heartbeat", label: "text-tertiary" };

  const stateText = state === "ok" ? "ok" : state === "down" ? "down" : "checking";

  return (
    <span className="flex items-center gap-2">
      <span className={tone.dot}>●</span>
      <span className={tone.label}>api: {stateText}</span>
    </span>
  );
}

function SessionSegment({
  expiresAt,
  nowMs,
}: {
  expiresAt: string | null;
  nowMs: number;
}) {
  if (!expiresAt) {
    return <span className="text-tertiary">session: —</span>;
  }
  const ttl = fmtDaysUntil(expiresAt, nowMs);
  const expiresMs = Date.parse(expiresAt);
  const remaining = expiresMs - nowMs;
  const tone =
    !Number.isFinite(expiresMs) || remaining <= 0
      ? "text-high"
      : remaining < 60 * 60 * 1000
        ? "text-med"
        : "text-secondary";
  return <span className={tone}>session: {ttl}</span>;
}

function ReadySegment() {
  // Placeholder — future enhancement: subscribe to /intel/feed at the layout
  // level and surface the most recent event here. Single-connection-per-token
  // limit (api feed.ts:67-69) makes this a real design decision; deferring
  // until the /intel page reveals what's actually useful.
  return <span className="text-tertiary">ready</span>;
}
