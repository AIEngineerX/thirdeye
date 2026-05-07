// Postgres LISTEN/NOTIFY-backed pub/sub for intel feed events. Producers
// (route handlers + worker tasks) publish events that get notified across
// processes via Postgres. Consumers (the intel/feed SSE handler) subscribe
// in-process; a single LISTEN connection per process dispatches incoming
// notifications to all local handlers.
//
// Phase 6.0 migration from process-local Set<Handler>. See
// docs/superpowers/specs/2026-05-07-thirdeye-phase-6-design.md §3.

import type postgres from "postgres";

export type IntelEvent =
  | { event: "scan:start"; data: { mint: string; symbol: string | null } }
  | {
      event: "scan:complete";
      data: {
        id: number | null;
        mint: string;
        symbol: string | null;
        risk: number;
        sybilFlag: boolean;
      };
    }
  | { event: "check:start"; data: { address: string } }
  | {
      event: "check:complete";
      data: { address: string; score: number; verdict: string };
    }
  | { event: "tag:applied"; data: { address: string; tag: string } }
  | {
      event: "watch:event";
      data: {
        address: string;
        signature: string;
        type: string | null;
        source: string | null;
        description: string | null;
        timestamp: number | null;
      };
    };

type Handler = (evt: IntelEvent) => void;

// Postgres NOTIFY payload limit is 8000 bytes (Postgres docs §SQL-NOTIFY).
// We use a slightly conservative budget to leave room for JSON quoting.
const MAX_NOTIFY_BYTES = 7800;

const CHANNEL = "intel_bus";

// Wire format on the bus channel: either the full event inline, or a
// {event, ref} pointer to a row in intel_events for oversized payloads.
type WireEvent =
  | { event: IntelEvent["event"]; data: IntelEvent["data"] }
  | { event: IntelEvent["event"]; ref: number };

let sqlRef: postgres.Sql | null = null;
let listenInitialized = false;
const handlers = new Set<Handler>();

export async function initIntelBus(_sql: postgres.Sql): Promise<void> {
  throw new Error("initIntelBus not implemented yet");
}

export async function publish(_evt: IntelEvent): Promise<void> {
  throw new Error("publish not implemented yet");
}

export function subscribe(handler: Handler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function subscriberCount(): number {
  return handlers.size;
}

// Test-only helper to reset bus state between tests.
export function _resetIntelBus(): void {
  handlers.clear();
  listenInitialized = false;
  sqlRef = null;
}
