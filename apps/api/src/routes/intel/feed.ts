import { type DbClient, authTokens } from "@thirdeye/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { type IntelEvent, subscribe } from "../../lib/intel-bus";

type Variables = { db: DbClient };

export const intelFeed = new Hono<{ Variables: Variables }>();

const HEARTBEAT_MS = 15_000;

// Track open SSE connections per token so a new connection from the same
// token aborts the prior one (spec §12 connection limit).
const openByToken = new Map<string, AbortController>();

intelFeed.get("/feed", async (c) => {
  const token = c.req.query("token");
  if (!token) {
    return c.json({ error: "missing_token", message: "?token=<X-Auth-Token> required" }, 401);
  }

  const db = c.get("db");
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
        await sendEvent(stream, evt);
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

async function sendEvent(stream: SSEStreamingApi, evt: IntelEvent): Promise<void> {
  await stream.writeSSE({ event: evt.event, data: JSON.stringify(evt.data) });
}

// Test-only helper to reset open connection map between tests.
export function _resetIntelFeed(): void {
  for (const ctrl of openByToken.values()) ctrl.abort();
  openByToken.clear();
}
