// Phase 5e: public ingest endpoint that Helius calls when watched addresses
// transact. Auth via Authorization header (the same value we set as
// authHeader at createWebhook time, stored in HELIUS_WEBHOOK_AUTH env).
//
// Flow per inbound batch:
//   1. Validate Authorization header — reject 401 on mismatch.
//   2. For each event in the array, derive which of OUR watched addresses
//      it relates to (an event mentions multiple accounts; we take the
//      intersection with the watches table).
//   3. Persist a watch_events row per (event, matched address).
//   4. Publish a watch:event to the intel-bus so connected SSE clients on
//      /api/db/intel/feed see it live.
//
// Helius retries with exponential backoff for 24h on non-200 responses, so
// we always 200 OK after parsing — even if downstream persistence partially
// fails. Per-event errors are logged but don't fail the batch.

import { type DbClient, watchEvents, watches } from "@thirdeye/db";
import type { HeliusInboundEvent } from "@thirdeye/helius";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { heliusWebhookAuth } from "../../env";
import { publish } from "../../lib/intel-bus";

type Variables = { db: DbClient };

export const heliusWebhook = new Hono<{ Variables: Variables }>();

heliusWebhook.post("/", async (c) => {
  const expectedAuth = heliusWebhookAuth();
  if (!expectedAuth) {
    // Misconfigured: we have no secret to validate against. 503 not 401 —
    // this is a server problem, not the caller's fault.
    return c.json({ error: "webhook_auth_unset" }, 503);
  }
  const auth = c.req.header("Authorization");
  if (auth !== expectedAuth) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body)) {
    return c.json({ error: "expected_array" }, 400);
  }
  const events = body as HeliusInboundEvent[];

  // Resolve which of OUR watched addresses appear in any of these events.
  const candidateAddresses = new Set<string>();
  for (const evt of events) {
    if (typeof evt.feePayer === "string") candidateAddresses.add(evt.feePayer);
    for (const t of evt.tokenTransfers ?? []) {
      if (typeof t.fromUserAccount === "string") candidateAddresses.add(t.fromUserAccount);
      if (typeof t.toUserAccount === "string") candidateAddresses.add(t.toUserAccount);
    }
    for (const a of evt.accountData ?? []) {
      if (typeof a.account === "string") candidateAddresses.add(a.account);
    }
  }

  const db = c.get("db");
  const watchedSet = await resolveWatched(db, [...candidateAddresses]);

  let persisted = 0;
  for (const evt of events) {
    if (!evt.signature) continue;
    const involved = collectInvolvedAddresses(evt).filter((a) => watchedSet.has(a));
    if (involved.length === 0) continue;

    for (const address of involved) {
      try {
        await db.insert(watchEvents).values({
          address,
          signature: evt.signature,
          type: evt.type ?? null,
          payload: evt as unknown as Record<string, unknown>,
        });
        publish({
          event: "watch:event",
          data: {
            address,
            signature: evt.signature,
            type: evt.type ?? null,
            source: evt.source ?? null,
            description: evt.description ?? null,
            timestamp: evt.timestamp ?? null,
          },
        });
        persisted++;
      } catch (e) {
        console.error(`[helius-webhook] persist ${address}/${evt.signature} failed`, e);
      }
    }
  }

  return c.json({ received: events.length, persisted });
});

async function resolveWatched(db: DbClient, candidates: string[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const rows = await db
    .select({ address: watches.address })
    .from(watches)
    .where(inArray(watches.address, candidates));
  return new Set(rows.map((r) => r.address));
}

function collectInvolvedAddresses(evt: HeliusInboundEvent): string[] {
  const out = new Set<string>();
  if (evt.feePayer) out.add(evt.feePayer);
  for (const t of evt.tokenTransfers ?? []) {
    if (t.fromUserAccount) out.add(t.fromUserAccount);
    if (t.toUserAccount) out.add(t.toUserAccount);
  }
  for (const a of evt.accountData ?? []) {
    if (a.account) out.add(a.account);
  }
  return [...out];
}
