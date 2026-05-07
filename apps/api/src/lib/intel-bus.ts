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

export async function initIntelBus(sql: postgres.Sql): Promise<void> {
  sqlRef = sql;
  if (listenInitialized) return;
  await sql.listen(CHANNEL, async (raw: string) => {
    let wire: WireEvent;
    try {
      wire = JSON.parse(raw) as WireEvent;
    } catch (e) {
      console.error("[intel-bus] malformed payload, dropping", e);
      return;
    }
    let evt: IntelEvent;
    if ("ref" in wire) {
      // Overflow path implemented in Task 6.
      console.error("[intel-bus] overflow ref received before overflow path implemented");
      return;
    } else {
      evt = wire as IntelEvent;
    }
    for (const h of handlers) {
      try {
        h(evt);
      } catch (e) {
        console.error("[intel-bus] handler threw", e);
      }
    }
  });
  listenInitialized = true;
}

export async function publish(evt: IntelEvent): Promise<void> {
  if (!sqlRef) throw new Error("intel-bus not initialized — call initIntelBus(sql) first");
  const wire: WireEvent = { event: evt.event, data: evt.data };
  const json = JSON.stringify(wire);
  if (Buffer.byteLength(json, "utf8") > MAX_NOTIFY_BYTES) {
    // Overflow path implemented in Task 6.
    throw new Error("payload exceeds NOTIFY limit; overflow path not yet implemented");
  }
  await sqlRef.notify(CHANNEL, json);
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
