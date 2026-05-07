import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens } from "@thirdeye/db";
import { app } from "../src/index";
import { generateToken } from "../src/lib/tokens";
import { FIXTURE_INVALID_ADDRESS, FIXTURE_WALLET } from "./fixtures/helius";
import { type TestDb, setupTestDb } from "./setup";

const HAVE_KEY = Boolean(process.env.HELIUS_API_KEY);
const d = HAVE_KEY ? describe : describe.skip;
const dNoKey = HAVE_KEY ? describe.skip : describe;

let testDb: TestDb;
let token: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  // Don't clear the Helius LRU cache — `bun test` runs every integration
  // file in the same process, so a warm cache from earlier files saves real
  // Helius calls here. Free-tier rate limits in CI are tight enough that any
  // per-file clear risks 429s. Tests still get fresh DB state via the
  // beforeEach TRUNCATE; the wallet_check cache (which the tests actually
  // exercise) lives in `wallet_checks` rows, not the LRU.
  if (!HAVE_KEY) {
    console.log("[skip] HELIUS_API_KEY not set — wallet check integration tests skipped");
  }
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.sql.unsafe(
    "TRUNCATE auth_tokens, wallet_checks, wallets, funders RESTART IDENTITY CASCADE;",
  );
  const t = generateToken();
  await testDb.db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
  token = t.token;
});

async function consumeSse(r: Response): Promise<{ event: string; data: unknown }[]> {
  const events: { event: string; data: unknown }[] = [];
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
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
  }
  return events;
}

d("Check Wallet (real Helius)", () => {
  test("GET /api/wallet/:addr/check streams full event sequence", async () => {
    const r = await app.request(`/api/wallet/${FIXTURE_WALLET}/check`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toContain("text/event-stream");

    const events = await consumeSse(r);
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("started");
    expect(names).toContain("identity");
    expect(names).toContain("balances");
    expect(names).toContain("funding");
    expect(names).toContain("cluster");
    expect(names).toContain("txPattern");
    expect(names).toContain("tags");
    expect(names[names.length - 1]).toBe("result");

    const result = events[events.length - 1]!.data as Record<string, unknown>;
    expect(result.address).toBe(FIXTURE_WALLET);
    expect(typeof result.score).toBe("number");
    expect(typeof result.verdict).toBe("string");
    expect(typeof result.scoreBucket).toBe("string");
  }, 60_000);

  test("second call within cache window returns cached result", async () => {
    {
      const first = await app.request(`/api/wallet/${FIXTURE_WALLET}/check`, {
        headers: { "X-Auth-Token": token },
      });
      await consumeSse(first);
    }

    const r2 = await app.request(`/api/wallet/${FIXTURE_WALLET}/check`, {
      headers: { "X-Auth-Token": token },
    });
    const events = await consumeSse(r2);
    expect(events).toHaveLength(2);
    expect(events[0]!.event).toBe("started");
    expect((events[0]!.data as Record<string, unknown>).cached).toBe(true);
    expect(events[1]!.event).toBe("result");
  }, 60_000);

  test("?force=true bypasses cache", async () => {
    {
      const first = await app.request(`/api/wallet/${FIXTURE_WALLET}/check`, {
        headers: { "X-Auth-Token": token },
      });
      await consumeSse(first);
    }

    const r2 = await app.request(`/api/wallet/${FIXTURE_WALLET}/check?force=true`, {
      headers: { "X-Auth-Token": token },
    });
    const events = await consumeSse(r2);
    expect(events.length).toBeGreaterThan(2);
    expect((events[0]!.data as Record<string, unknown>).cached).toBe(false);
  }, 60_000);

  test("GET /api/wallet/:addr/last-check returns persisted payload", async () => {
    {
      const first = await app.request(`/api/wallet/${FIXTURE_WALLET}/check`, {
        headers: { "X-Auth-Token": token },
      });
      await consumeSse(first);
    }

    const r = await app.request(`/api/wallet/${FIXTURE_WALLET}/last-check`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.address).toBe(FIXTURE_WALLET);
  }, 60_000);

  test("last-check returns 404 when no recent check", async () => {
    const r = await app.request(`/api/wallet/${FIXTURE_WALLET}/last-check`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(404);
  });
});

describe("Check Wallet (no Helius needed)", () => {
  test("invalid address returns 400", async () => {
    const r = await app.request(`/api/wallet/${FIXTURE_INVALID_ADDRESS}/check`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(400);
  });

  test("missing auth returns 401", async () => {
    const r = await app.request(`/api/wallet/${FIXTURE_WALLET}/check`);
    expect(r.status).toBe(401);
  });
});

dNoKey("Check Wallet (no key fallback)", () => {
  test("emits error event and no result when no server key set", async () => {
    const r = await app.request(`/api/wallet/${FIXTURE_WALLET}/check`, {
      headers: { "X-Auth-Token": token },
    });
    const events = await consumeSse(r);
    const hasResult = events.some((e) => e.event === "result");
    expect(hasResult).toBe(false);
    const errEvent = events.find((e) => e.event === "error");
    expect(errEvent).toBeDefined();
    expect((errEvent!.data as Record<string, unknown>).error).toBe("helius_error");
  });
});
