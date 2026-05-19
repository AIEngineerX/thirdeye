// Integration tests for the SSE intel feed. Bun's app.request() buffers
// the response body until the handler completes — fine for finite-lifetime
// SSE streams (wallet/check) but useless for indefinite ones like
// intel/feed. So we boot a real Bun.serve on a random port and connect via
// real fetch, which streams chunks.
//
// M1 update: auth is now via a one-time ticket (POST /feed/ticket with
// X-Auth-Token, GET /feed?ticket=X). The old ?token= URL leaked the auth
// token into request logs; the ticket is short-lived (30s TTL) and
// single-use.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens, sseTickets } from "@thirdeye/db";
import { eq } from "drizzle-orm";
import { app } from "../src/index";
import { _resetIntelBus, initIntelBus, publish } from "../src/lib/intel-bus";
import { generateToken } from "../src/lib/tokens";
import { _resetIntelFeed } from "../src/routes/intel/feed";
import { type TestDb, setupTestDb } from "./setup";

let testDb: TestDb;
let token: string;
// biome-ignore lint/suspicious/noExplicitAny: Bun.serve return type narrowing varies across releases
let server: any;
let baseUrl: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  server = Bun.serve({ port: 0, fetch: app.fetch });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await testDb.cleanup();
});

afterEach(async () => {
  await _resetIntelBus();
});

beforeEach(async () => {
  await testDb.sql.unsafe("TRUNCATE auth_tokens, sse_tickets RESTART IDENTITY CASCADE;");
  _resetIntelFeed();
  await _resetIntelBus();
  await initIntelBus(testDb.sql);
  const t = generateToken();
  await testDb.db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
  token = t.token;
});

async function getTicket(authToken: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/db/intel/feed/ticket`, {
    method: "POST",
    headers: { "X-Auth-Token": authToken },
  });
  if (r.status !== 200) {
    throw new Error(`ticket request failed: ${r.status}`);
  }
  const body = (await r.json()) as { ticket: string };
  return body.ticket;
}

interface SseEvent {
  event: string;
  data: unknown;
}

function makeSseReader(r: Response) {
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: SseEvent[] = [];

  async function read(): Promise<SseEvent[]> {
    const { value, done } = await reader.read();
    if (done) return events;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const evt: { event: string; data: string } = { event: "", data: "" };
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) evt.event = line.slice(7);
        else if (line.startsWith("data: ")) evt.data = line.slice(6);
      }
      if (evt.event) events.push({ event: evt.event, data: JSON.parse(evt.data) });
      idx = buffer.indexOf("\n\n");
    }
    return events;
  }

  function close() {
    reader.cancel().catch(() => {});
  }

  async function readUntil(predicate: (events: SseEvent[]) => boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(events) && Date.now() < deadline) {
      await read();
    }
    if (!predicate(events)) throw new Error("readUntil: predicate never satisfied");
    return events;
  }

  return { read, readUntil, events, close };
}

describe("POST /api/db/intel/feed/ticket", () => {
  test("issues a ticket for a valid auth token (header, not URL)", async () => {
    const r = await fetch(`${baseUrl}/api/db/intel/feed/ticket`, {
      method: "POST",
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ticket: string; expiresAt: string };
    expect(typeof body.ticket).toBe("string");
    expect(body.ticket.length).toBeGreaterThan(20);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const rows = await testDb.db.select().from(sseTickets);
    expect(rows.length).toBe(1);
    expect(rows[0]!.token).toBe(token);
  });

  test("missing X-Auth-Token → 401", async () => {
    const r = await fetch(`${baseUrl}/api/db/intel/feed/ticket`, { method: "POST" });
    expect(r.status).toBe(401);
  });

  test("invalid token → 401", async () => {
    const r = await fetch(`${baseUrl}/api/db/intel/feed/ticket`, {
      method: "POST",
      headers: { "X-Auth-Token": "bogus" },
    });
    expect(r.status).toBe(401);
  });

  test("expired token → 401 token_expired", async () => {
    await testDb.db
      .update(authTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authTokens.token, token));
    const r = await fetch(`${baseUrl}/api/db/intel/feed/ticket`, {
      method: "POST",
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("token_expired");
  });
});

describe("GET /api/db/intel/feed (ticket auth)", () => {
  test("missing ticket → 401 missing_ticket", async () => {
    const r = await fetch(`${baseUrl}/api/db/intel/feed`);
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("missing_ticket");
  });

  test("invalid ticket → 401 invalid_or_expired_ticket", async () => {
    const r = await fetch(`${baseUrl}/api/db/intel/feed?ticket=does-not-exist`);
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_or_expired_ticket");
  });

  test("ticket is single-use (second connect with same ticket → 401)", async () => {
    const ticket = await getTicket(token);
    const r1 = await fetch(`${baseUrl}/api/db/intel/feed?ticket=${ticket}`);
    expect(r1.status).toBe(200);
    const sse1 = makeSseReader(r1);
    await sse1.readUntil((e) => e.some((x) => x.event === "hello"));

    // Same ticket again — must fail.
    const r2 = await fetch(`${baseUrl}/api/db/intel/feed?ticket=${ticket}`);
    expect(r2.status).toBe(401);

    sse1.close();
  }, 5000);

  test("expired ticket → 401", async () => {
    // Manually insert an already-expired ticket
    await testDb.db.insert(sseTickets).values({
      ticket: "expired-ticket-xyz",
      token,
      expiresAt: new Date(Date.now() - 1000),
    });
    const r = await fetch(`${baseUrl}/api/db/intel/feed?ticket=expired-ticket-xyz`);
    expect(r.status).toBe(401);
  });

  test("valid ticket: receives hello frame, then forwarded intel-bus event", async () => {
    const ticket = await getTicket(token);
    const r = await fetch(`${baseUrl}/api/db/intel/feed?ticket=${ticket}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toContain("text/event-stream");

    const sse = makeSseReader(r);
    await sse.readUntil((e) => e.some((x) => x.event === "hello"));
    expect(sse.events[0]!.event).toBe("hello");
    expect((sse.events[0]!.data as { at: string }).at).toMatch(/T.*Z$/);

    await publish({
      event: "scan:complete",
      data: { id: 1, mint: "MINT_X", symbol: "XX", risk: 50, sybilFlag: true },
    });

    await sse.readUntil((e) => e.some((x) => x.event === "scan:complete"));
    const got = sse.events.find((x) => x.event === "scan:complete")!;
    expect((got.data as { mint: string }).mint).toBe("MINT_X");

    sse.close();
  }, 8000);

  test("second connection from same token preempts the first", async () => {
    const ticket1 = await getTicket(token);
    const r1 = await fetch(`${baseUrl}/api/db/intel/feed?ticket=${ticket1}`);
    const sse1 = makeSseReader(r1);
    await sse1.readUntil((e) => e.some((x) => x.event === "hello"));

    const ticket2 = await getTicket(token);
    const r2 = await fetch(`${baseUrl}/api/db/intel/feed?ticket=${ticket2}`);
    const sse2 = makeSseReader(r2);
    await sse2.readUntil((e) => e.some((x) => x.event === "hello"));

    await publish({ event: "check:start", data: { address: "abc" } });
    await sse2.readUntil((e) => e.some((x) => x.event === "check:start"));
    expect(sse2.events.find((x) => x.event === "check:start")).toBeDefined();

    sse1.close();
    sse2.close();
  }, 8000);

  test("unsubscribe happens on disconnect (no zombie handlers)", async () => {
    const { subscriberCount } = await import("../src/lib/intel-bus");
    const before = subscriberCount();
    const ticket = await getTicket(token);
    const r = await fetch(`${baseUrl}/api/db/intel/feed?ticket=${ticket}`);
    const sse = makeSseReader(r);
    await sse.readUntil((e) => e.some((x) => x.event === "hello"));
    expect(subscriberCount()).toBe(before + 1);

    _resetIntelFeed();
    await new Promise((r) => setTimeout(r, 50));
    expect(subscriberCount()).toBe(before);
    sse.close();
  }, 5000);

  test("M1: auth token does NOT appear in the SSE URL", async () => {
    // The whole point of M1: tokens stay out of URLs. The ticket is opaque
    // and the auth token never travels in a query string.
    const ticket = await getTicket(token);
    const sseUrl = `${baseUrl}/api/db/intel/feed?ticket=${ticket}`;
    expect(sseUrl).not.toContain(token);
  });
});
