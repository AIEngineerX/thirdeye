import { type DbClient, authTokens } from "@thirdeye/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sendSseEvent } from "../../lib/http";
import { type IntelEvent, subscribe } from "../../lib/intel-bus";
import { consumeSseTicket, issueSseTicket } from "../../lib/sse-tickets";

type Variables = { db: DbClient };

export const intelFeed = new Hono<{ Variables: Variables }>();

const HEARTBEAT_MS = 15_000;

// Track open SSE connections per token so a new connection from the same
// token aborts the prior one (spec §12 connection limit).
const openByToken = new Map<string, AbortController>();

// M1: issue a one-time, short-lived ticket. Client posts with X-Auth-Token
// in the header (not URL), receives an opaque ticket that's valid for 30s
// and consumed on first use. Authenticated via the same auth-token check
// used elsewhere — inlined here because /api/db/intel/* sub-routers don't
// share a use("*", requireAuth).
intelFeed.post("/feed/ticket", async (c) => {
  const token = c.req.header("X-Auth-Token");
  if (!token) return c.json({ error: "missing_token" }, 401);

  const db = c.get("db");
  const rows = await db.select().from(authTokens).where(eq(authTokens.token, token));
  const row = rows[0];
  if (!row) return c.json({ error: "invalid_token" }, 401);
  if (row.expiresAt.getTime() <= Date.now()) {
    return c.json({ error: "token_expired" }, 401);
  }

  const { ticket, expiresAt } = await issueSseTicket(db, token);
  return c.json({ ticket, expiresAt: expiresAt.toISOString() });
});

intelFeed.get("/feed", async (c) => {
  const ticket = c.req.query("ticket");
  if (!ticket) {
    return c.json(
      {
        error: "missing_ticket",
        message:
          "POST /api/db/intel/feed/ticket with X-Auth-Token to obtain a ticket; then GET ?ticket=...",
      },
      401,
    );
  }

  const db = c.get("db");
  const token = await consumeSseTicket(db, ticket);
  if (!token) return c.json({ error: "invalid_or_expired_ticket" }, 401);

  // Re-validate the underlying token in case it was revoked or expired
  // between ticket issue and SSE upgrade.
  const rows = await db.select().from(authTokens).where(eq(authTokens.token, token));
  const row = rows[0];
  if (!row) return c.json({ error: "invalid_token" }, 401);
  if (row.expiresAt.getTime() <= Date.now()) {
    return c.json({ error: "token_expired" }, 401);
  }

  // Preempt any prior connection from the same token.
  const prior = openByToken.get(token);
  if (prior) prior.abort();
  const ctrl = new AbortController();
  openByToken.set(token, ctrl);

  return streamSSE(c, async (stream) => {
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    try {
      unsubscribe = subscribe(async (evt: IntelEvent) => {
        if (ctrl.signal.aborted) return;
        await sendSseEvent(stream, evt);
      });

      heartbeat = setInterval(() => {
        if (ctrl.signal.aborted) return;
        // hono/streaming will throw if the client disconnected; we swallow.
        stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
      }, HEARTBEAT_MS);

      // Initial hello so the client knows the stream is live.
      await stream.writeSSE({
        event: "hello",
        data: JSON.stringify({ at: new Date().toISOString() }),
      });

      await new Promise<void>((resolve) => {
        if (ctrl.signal.aborted) {
          resolve();
          return;
        }
        ctrl.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      unsubscribe();
      if (heartbeat !== null) clearInterval(heartbeat);
      if (openByToken.get(token) === ctrl) openByToken.delete(token);
    }
  });
});

// Test-only helper to reset open connection map between tests.
export function _resetIntelFeed(): void {
  for (const ctrl of openByToken.values()) ctrl.abort();
  openByToken.clear();
}
