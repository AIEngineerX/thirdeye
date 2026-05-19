import { type DbClient, watchEvents, watches } from "@thirdeye/db";
import { and, eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { env, heliusWebhookAuth, publicBaseUrl } from "../../env";
import { clampInt } from "../../lib/http";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { syncHeliusWebhook } from "./sync";

type Variables = { db: DbClient };

export const watchesRoutes = new Hono<{ Variables: Variables }>();

interface AddBody {
  addresses?: unknown;
  label?: unknown;
}

type WebhookSync = { apiKey: string; webhookURL: string; authHeader: string };

// Returns the sync options or a Hono response carrying the specific 503.
function resolveWebhookSync(
  c: Context<{ Variables: Variables }>,
  detailed: boolean,
): WebhookSync | Response {
  const baseUrl = publicBaseUrl();
  const webhookAuth = heliusWebhookAuth();
  if (env.HELIUS_API_KEY && baseUrl && webhookAuth) {
    return {
      apiKey: env.HELIUS_API_KEY,
      webhookURL: `${baseUrl.replace(/\/$/, "")}/api/helius-webhook`,
      authHeader: webhookAuth,
    };
  }
  if (!detailed) return c.json({ error: "webhook_env_unset" }, 503);
  if (!env.HELIUS_API_KEY)
    return c.json(
      { error: "no_helius_key", message: "Server has no HELIUS_API_KEY configured" },
      503,
    );
  if (!baseUrl)
    return c.json(
      {
        error: "missing_public_base_url",
        message: "PUBLIC_BASE_URL must be set so Helius knows where to push events",
      },
      503,
    );
  return c.json(
    {
      error: "missing_webhook_auth",
      message:
        "HELIUS_WEBHOOK_AUTH must be set — it's the shared secret that authenticates Helius callbacks",
    },
    503,
  );
}

watchesRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as AddBody | null;
  const addresses = body?.addresses;
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 100) {
    return c.json(
      { error: "invalid_body", message: "expected { addresses: string[] } (1..100)" },
      400,
    );
  }
  for (const a of addresses) {
    if (typeof a !== "string" || !isValidSolanaAddress(a)) {
      return c.json({ error: "invalid_address", message: `${a}` }, 400);
    }
  }
  const label = typeof body?.label === "string" ? body.label : null;

  // Caller is authenticated by requireAuth middleware which ran before us;
  // it doesn't currently hand the token down via c.set, so re-read header.
  const token = c.req.header("X-Auth-Token");
  if (!token) {
    return c.json({ error: "missing_token" }, 401);
  }

  const sync = resolveWebhookSync(c, true);
  if (sync instanceof Response) return sync;

  const db = c.get("db");
  // Wrap inserts + sync in one transaction so a sync failure rolls back the
  // inserts atomically. The prior code used a manual catch-and-delete loop
  // that could itself fail mid-loop and leave inconsistent state.
  // The error message returned to the caller is intentionally generic —
  // forwarding String(e) can leak Helius URLs containing api-key fragments
  // if Bun's fetch error format ever includes them.
  try {
    await db.transaction(async (tx) => {
      for (const address of addresses as string[]) {
        await tx.execute(sql`
          INSERT INTO watches (address, label, token)
          SELECT ${address}::text, ${label}::text, ${token}::text
          WHERE NOT EXISTS (
            SELECT 1 FROM watches WHERE token = ${token} AND address = ${address}
          )
        `);
      }
      await syncHeliusWebhook(tx, sync);
    });
  } catch (e) {
    console.error("[watches.add] insert+sync failed — tx rolled back", e);
    return c.json({ error: "helius_sync_failed" }, 502);
  }

  return c.json({ added: addresses.length, label }, 200);
});

watchesRoutes.delete("/:address", async (c) => {
  const address = c.req.param("address");
  if (!isValidSolanaAddress(address)) {
    return c.json({ error: "invalid_address" }, 400);
  }
  const token = c.req.header("X-Auth-Token");
  if (!token) return c.json({ error: "missing_token" }, 401);
  const sync = resolveWebhookSync(c, false);
  if (sync instanceof Response) return sync;

  const db = c.get("db");
  // Wrap delete + sync in one tx so a sync failure rolls back the local
  // delete — otherwise the watch is gone from our DB but Helius still pushes
  // events for it, leaving orphaned watch_events with no parent watches row.
  // Generic error message (no String(e)) to avoid leaking api-key fragments.
  try {
    await db.transaction(async (tx) => {
      await tx.delete(watches).where(and(eq(watches.token, token), eq(watches.address, address)));
      await syncHeliusWebhook(tx, sync);
    });
  } catch (e) {
    console.error("[watches.delete] sync failed — tx rolled back", e);
    return c.json({ error: "helius_sync_failed" }, 502);
  }
  return c.json({ removed: 1 });
});

watchesRoutes.get("/", async (c) => {
  const token = c.req.header("X-Auth-Token");
  if (!token) return c.json({ error: "missing_token" }, 401);
  const db = c.get("db");
  const rows = await db
    .select({ address: watches.address, label: watches.label, createdAt: watches.createdAt })
    .from(watches)
    .where(eq(watches.token, token))
    .orderBy(sql`${watches.createdAt} DESC`);
  return c.json({ items: rows });
});

watchesRoutes.get("/:address/events", async (c) => {
  const address = c.req.param("address");
  if (!isValidSolanaAddress(address)) {
    return c.json({ error: "invalid_address" }, 400);
  }
  const token = c.req.header("X-Auth-Token");
  if (!token) return c.json({ error: "missing_token" }, 401);
  const limit = clampInt(c.req.query("limit"), 50, 1, 200);
  const db = c.get("db");

  // Token ownership gate: the caller must hold a watch on this address. Without
  // this check, any authenticated token can enumerate any address's full
  // event history (and the payloads contain enhanced-transaction detail about
  // unrelated parties). Return 404 (not 403) so callers can't probe which
  // addresses other tokens are watching.
  const owned = await db
    .select({ address: watches.address })
    .from(watches)
    .where(and(eq(watches.token, token), eq(watches.address, address)))
    .limit(1);
  if (owned.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }

  const rows = await db
    .select({
      id: watchEvents.id,
      signature: watchEvents.signature,
      type: watchEvents.type,
      receivedAt: watchEvents.receivedAt,
      payload: watchEvents.payload,
    })
    .from(watchEvents)
    .where(eq(watchEvents.address, address))
    .orderBy(sql`${watchEvents.receivedAt} DESC`)
    .limit(limit);
  return c.json({ address, items: rows });
});
