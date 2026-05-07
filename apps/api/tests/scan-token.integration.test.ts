import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens } from "@thirdeye/db";
import { cache } from "@thirdeye/helius";
import { app } from "../src/index";
import { generateToken } from "../src/lib/tokens";
import { type TestDb, setupTestDb } from "./setup";

const HAVE_KEY = Boolean(process.env.HELIUS_API_KEY);
const d = HAVE_KEY ? describe : describe.skip;
const dNoKey = HAVE_KEY ? describe.skip : describe;

// BONK is a stable, high-holder mint; results may vary but the pipeline
// must produce a complete event sequence and persist a row.
const FIXTURE_MINT =
  process.env.THIRDEYE_TEST_MINT ?? "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const INVALID_MINT = "not-a-real-mint";

let testDb: TestDb;
let token: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  if (!HAVE_KEY) {
    console.log("[skip] HELIUS_API_KEY not set — scan token integration tests skipped");
  }
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.sql.unsafe(
    "TRUNCATE auth_tokens, wallet_checks, wallets, token_scans, funders RESTART IDENTITY CASCADE;",
  );
  cache.clear();
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

d("Scan Token (real Helius)", () => {
  test("GET /api/token/:mint/scan streams full event sequence", async () => {
    const r = await app.request(`/api/token/${FIXTURE_MINT}/scan`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toContain("text/event-stream");

    const events = await consumeSse(r);
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("started");
    expect(names).toContain("metadata");
    expect(names).toContain("holders");
    expect(names).toContain("lpFilter");
    expect(names).toContain("fundingProgress");
    expect(names).toContain("clusters");
    expect(names[names.length - 1]).toBe("result");

    const result = events[events.length - 1]!.data as Record<string, unknown>;
    expect(result.mint).toBe(FIXTURE_MINT);
    expect(typeof result.risk).toBe("number");
    expect(typeof result.verdict).toBe("string");
    expect(typeof result.sybilFlag).toBe("boolean");
  }, 120_000);

  test("second call within cache window returns cached result", async () => {
    {
      const first = await app.request(`/api/token/${FIXTURE_MINT}/scan`, {
        headers: { "X-Auth-Token": token },
      });
      await consumeSse(first);
    }
    const r2 = await app.request(`/api/token/${FIXTURE_MINT}/scan`, {
      headers: { "X-Auth-Token": token },
    });
    const events = await consumeSse(r2);
    expect(events).toHaveLength(2);
    expect(events[0]!.event).toBe("started");
    expect((events[0]!.data as Record<string, unknown>).cached).toBe(true);
    expect(events[1]!.event).toBe("result");
  }, 120_000);

  test("GET /scans/latest returns persisted payload", async () => {
    {
      const first = await app.request(`/api/token/${FIXTURE_MINT}/scan`, {
        headers: { "X-Auth-Token": token },
      });
      await consumeSse(first);
    }
    const r = await app.request(`/api/token/${FIXTURE_MINT}/scans/latest`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.mint).toBe(FIXTURE_MINT);
  }, 120_000);

  test("scans/latest returns 404 when no recent scan", async () => {
    const r = await app.request(`/api/token/${FIXTURE_MINT}/scans/latest`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(404);
  });
});

describe("Scan Token (no Helius needed)", () => {
  test("invalid mint returns 400", async () => {
    const r = await app.request(`/api/token/${INVALID_MINT}/scan`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(400);
  });

  test("missing auth returns 401", async () => {
    const r = await app.request(`/api/token/${FIXTURE_MINT}/scan`);
    expect(r.status).toBe(401);
  });
});

dNoKey("Scan Token (no key fallback)", () => {
  test("emits error event when no server key set", async () => {
    const r = await app.request(`/api/token/${FIXTURE_MINT}/scan`, {
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
