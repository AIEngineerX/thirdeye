// M1: one-time tickets for SSE upgrades. EventSource (browsers) can't set
// custom headers, so the auth token historically traveled in the URL as
// `?token=...` which logs everywhere (request logs, reverse-proxy logs,
// edge logs, browser history). The 256-bit entropy means brute force isn't
// the threat — log exfiltration is.
//
// New flow: client POSTs to /api/db/intel/feed/ticket with X-Auth-Token in
// the header, server returns an opaque ticket. The ticket is single-use
// (deleted on consume) and short-lived (30s TTL). The SSE URL uses
// `?ticket=` — even if logged, it's already expired by the time anyone
// reads the log.

import { type DbClient, sseTickets } from "@thirdeye/db";
import { and, eq, sql } from "drizzle-orm";

export const TICKET_TTL_MS = 30_000;

function generateTicket(): string {
  // 192 bits of entropy, base64url. More than enough for a 30s-TTL token.
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}

export async function issueSseTicket(
  db: DbClient,
  token: string,
): Promise<{
  ticket: string;
  expiresAt: Date;
}> {
  const ticket = generateTicket();
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
  await db.insert(sseTickets).values({ ticket, token, expiresAt });
  return { ticket, expiresAt };
}

// Atomic consume: DELETE … RETURNING. The row is gone after this call so
// the same ticket can't be reused. Returns the underlying auth token if
// the ticket was valid and unexpired, else null.
export async function consumeSseTicket(db: DbClient, ticket: string): Promise<string | null> {
  if (!ticket) return null;
  const nowIso = new Date().toISOString();
  const rows = (await db.execute(sql`
    DELETE FROM sse_tickets
    WHERE ticket = ${ticket}
      AND expires_at > ${nowIso}::timestamptz
    RETURNING token
  `)) as unknown as Array<{ token: string }>;
  return rows[0]?.token ?? null;
}

// Sweep expired rows (best-effort, called opportunistically).
export async function pruneExpiredTickets(db: DbClient): Promise<number> {
  const nowIso = new Date().toISOString();
  const result = (await db.execute(sql`
    DELETE FROM sse_tickets WHERE expires_at <= ${nowIso}::timestamptz
  `)) as unknown as { count?: number };
  return result.count ?? 0;
}

// Re-exports kept for callers that want to query directly.
export { sseTickets, and, eq };
