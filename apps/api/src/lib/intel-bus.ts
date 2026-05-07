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
let listenMeta: { unlisten(): Promise<void> } | null = null;
const handlers = new Set<Handler>();

export async function initIntelBus(sql: postgres.Sql): Promise<void> {
  if (listenInitialized) return;
  sqlRef = sql;
  listenMeta = await sql.listen(CHANNEL, async (raw: string) => {
    let wire: WireEvent;
    try {
      wire = JSON.parse(raw) as WireEvent;
    } catch (e) {
      console.error("[intel-bus] malformed payload, dropping", e);
      return;
    }

    let evt: IntelEvent;
    if ("ref" in wire) {
      const rows = await sql<{ payload: IntelEvent["data"] }[]>`
        SELECT payload FROM intel_events WHERE id = ${wire.ref}
      `;
      if (rows.length === 0) {
        console.error(`[intel-bus] ref ${wire.ref} not found, dropping`);
        return;
      }
      // Delete after read so the table doesn't grow unboundedly. Best-effort:
      // a crashed subscriber leaves the row; a periodic sweep is unnecessary
      // because rows live milliseconds in the happy path.
      try {
        await sql`DELETE FROM intel_events WHERE id = ${wire.ref}`;
      } catch (e) {
        console.error(`[intel-bus] failed to delete overflow row ${wire.ref}`, e);
      }
      evt = { event: wire.event, data: rows[0]!.payload } as IntelEvent;
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
  const wireInline: WireEvent = { event: evt.event, data: evt.data };
  const json = JSON.stringify(wireInline);
  if (Buffer.byteLength(json, "utf8") <= MAX_NOTIFY_BYTES) {
    await sqlRef.notify(CHANNEL, json);
    return;
  }
  // Overflow: persist payload, notify with reference id.
  // postgres.js v3.4 + Bun bug: passing a JS object in a tagged-template parameter
  // triggers binary-protocol binding which Bun rejects. Workaround: stringify to
  // JSON manually and cast with ::jsonb so the server parses it as text-mode input.
  const payloadJson = JSON.stringify(evt.data);
  const rows = await sqlRef<{ id: number }[]>`
    INSERT INTO intel_events (kind, payload)
    VALUES (${evt.event}, ${payloadJson}::jsonb)
    RETURNING id
  `;
  const id = rows[0]!.id;
  const wireRef: WireEvent = { event: evt.event, ref: id };
  await sqlRef.notify(CHANNEL, JSON.stringify(wireRef));
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
export async function _resetIntelBus(): Promise<void> {
  handlers.clear();
  if (listenMeta) {
    try {
      await listenMeta.unlisten();
    } catch {
      // Ignore errors if connection is already closed.
    }
    listenMeta = null;
  }
  listenInitialized = false;
  sqlRef = null;
}
