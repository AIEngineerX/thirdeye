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
// In addition, when a matched address is a TRACKED smart-money wallet, the
// event is parsed into a swap, persisted to smart_trades, and published as a
// smartmoney:trade; a buy that brings >=2 distinct tracked wallets onto the
// same mint within CONFLUENCE_WINDOW_MIN also publishes a smartmoney:confluence.
// The watch path and the smart-money path are independent (separate try/catch).
//
// Helius retries with exponential backoff for 24h on non-200 responses, so
// we always 200 OK after parsing — even if downstream persistence partially
// fails. Per-event errors are logged but don't fail the batch.

import { timingSafeEqual } from "node:crypto";
import { type DbClient, trackedWallets, watchEvents, watches } from "@thirdeye/db";
import type { HeliusInboundEvent } from "@thirdeye/helius";
import { parseWalletTrade } from "@thirdeye/scanner";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { heliusWebhookAuth } from "../../env";
import { publish } from "../../lib/intel-bus";
import { areCoFunded, detectBuyConfluence, persistTrade } from "../../lib/smart-money";

// Constant-time string compare. Plain !== short-circuits on the first
// differing byte, which lets a network attacker oracle the secret one
// character at a time via response-latency measurement. timingSafeEqual
// requires equal-length buffers, so do the length check first (different
// lengths are publicly distinguishable and a timing-safe compare would
// throw on them anyway).
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// minutes — how long two tracked buys count as confluence; tunable.
const CONFLUENCE_WINDOW_MIN = 30;

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
  if (!auth || !constantTimeEqual(auth, expectedAuth)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body)) {
    return c.json({ error: "expected_array" }, 400);
  }
  const events = body as HeliusInboundEvent[];

  // Walk addresses once per event; reuse the per-event list when filtering
  // against the watches table (avoids a second pass over the same fields).
  const involvedByEvent = events.map(collectInvolvedAddresses);
  const candidateAddresses = new Set<string>();
  for (const list of involvedByEvent) for (const a of list) candidateAddresses.add(a);

  const db = c.get("db");
  const candidates = [...candidateAddresses];
  const [watchedSet, trackedMeta] = await Promise.all([
    resolveWatched(db, candidates),
    resolveTracked(db, candidates),
  ]);
  // Union: care about any address that is watched OR tracked smart-money.
  // Tracked-only wallets (not in `watches`) would otherwise be silently
  // dropped before the smart-money path could run — this closes that gap.
  const careAbout = new Set<string>([...watchedSet, ...trackedMeta.keys()]);

  let persisted = 0;
  for (let i = 0; i < events.length; i++) {
    const evt = events[i]!;
    if (!evt.signature) continue;
    const involved = involvedByEvent[i]!.filter((a) => careAbout.has(a));
    if (involved.length === 0) continue;

    for (const address of involved) {
      // Generic watch:event path — only for addresses in watches table.
      // Isolated from the smart-money path: a transient failure here (e.g. a
      // DB error) must not starve the smart-money path for a wallet that is in
      // BOTH watches and tracked_wallets.
      if (watchedSet.has(address)) {
        try {
          await db.insert(watchEvents).values({
            address,
            signature: evt.signature,
            type: evt.type ?? null,
            payload: evt as unknown as Record<string, unknown>,
          });
          await publish({
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

      // Smart-money path — only for tracked wallets. Runs independently of the
      // watch path above; its own try/catch keeps a failure here from leaking.
      const meta = trackedMeta.get(address);
      if (meta) {
        try {
          const trade = parseWalletTrade(evt, address);
          if (trade) {
            const inserted = await persistTrade(db, trade, null);
            if (inserted) {
              await publish({
                event: "smartmoney:trade",
                data: {
                  wallet: address,
                  label: meta.label,
                  winRate: meta.winRate,
                  side: trade.side,
                  mint: trade.mint,
                  symbol: null,
                  solAmount: trade.solAmount,
                  signature: trade.signature,
                  tradedAt: trade.tradedAt.toISOString(),
                },
              });
              if (trade.side === "buy") {
                const conf = await detectBuyConfluence(db, trade.mint, CONFLUENCE_WINDOW_MIN);
                if (conf.count >= 2) {
                  const cf = await areCoFunded(db, conf.wallets);
                  await publish({
                    event: "smartmoney:confluence",
                    data: {
                      mint: conf.mint,
                      symbol: null,
                      wallets: conf.wallets,
                      count: conf.count,
                      windowMin: conf.windowMin,
                      coFunded: cf.coFunded,
                      sharedFunder: cf.sharedFunder,
                    },
                  });
                }
              }
            }
          }
        } catch (e) {
          console.error(`[helius-webhook] smart-money ${address}/${evt.signature} failed`, e);
        }
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

async function resolveTracked(
  db: DbClient,
  candidates: string[],
): Promise<Map<string, { label: string | null; winRate: number | null }>> {
  const out = new Map<string, { label: string | null; winRate: number | null }>();
  if (candidates.length === 0) return out;
  const rows = await db
    .select({
      address: trackedWallets.address,
      label: trackedWallets.label,
      winRate: trackedWallets.winRate,
    })
    .from(trackedWallets)
    .where(inArray(trackedWallets.address, candidates));
  for (const r of rows)
    out.set(r.address, { label: r.label, winRate: r.winRate === null ? null : Number(r.winRate) });
  return out;
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
