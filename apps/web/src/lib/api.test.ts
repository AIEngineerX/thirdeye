import { beforeEach, describe, expect, test } from "bun:test";
import { createApiClient, getDashboard, listCandidates, promoteCandidate } from "./api";
import type { CandidateRow, DashboardBundle } from "./api-types";
import { type SessionStorageLike, createAuthClient } from "./auth";
import { createByokStore } from "./byok";

interface MemStorage extends SessionStorageLike {
  data: Map<string, string>;
}
function memStorage(): MemStorage {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Call {
  url: string;
  headers: Record<string, string>;
}
function harness(responses: Response[]): {
  fetchImpl: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    const h = new Headers(init?.headers);
    h.forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url: input as string, headers });
    const r = responses[i] ?? responses[responses.length - 1];
    i += 1;
    if (!r) throw new Error("no response queued");
    return r;
  };
  return { fetchImpl, calls };
}

describe("api wrapper", () => {
  let sessStorage: MemStorage;
  let localStorage: MemStorage;
  const now = () => Date.parse("2026-05-20T12:00:00Z");

  beforeEach(() => {
    sessStorage = memStorage();
    localStorage = memStorage();
  });

  function build(authResponses: Response[], apiResponses: Response[]) {
    const authFetch = harness(authResponses);
    const apiFetch = harness(apiResponses);
    const auth = createAuthClient({
      storage: sessStorage,
      fetchImpl: authFetch.fetchImpl,
      apiBase: "",
      now,
    });
    const byok = createByokStore(localStorage);
    const client = createApiClient({ auth, byok, fetchImpl: apiFetch.fetchImpl });
    return { client, byok, authCalls: authFetch.calls, apiCalls: apiFetch.calls };
  }

  test("adds X-Auth-Token from session", async () => {
    const { client, apiCalls } = build(
      [json({ token: "tok-1", expiresAt: "2026-05-27T12:00:00Z" })],
      [json({ ok: true })],
    );
    const resp = await client.fetch("/api/db/protected-probe");
    expect(resp.status).toBe(200);
    expect(apiCalls[0]!.headers["x-auth-token"]).toBe("tok-1");
  });

  test("includes BYOK headers when set, omits when not", async () => {
    const { client, byok, apiCalls } = build(
      [json({ token: "t", expiresAt: "2026-05-27T12:00:00Z" })],
      [json({ ok: true }), json({ ok: true }), json({ ok: true })],
    );
    await client.fetch("/api/test");
    expect(apiCalls[0]!.headers["x-user-helius-key"]).toBeUndefined();
    expect(apiCalls[0]!.headers["x-user-anthropic-key"]).toBeUndefined();

    byok.set("helius", "hel-xyz");
    await client.fetch("/api/test");
    expect(apiCalls[1]!.headers["x-user-helius-key"]).toBe("hel-xyz");
    expect(apiCalls[1]!.headers["x-user-anthropic-key"]).toBeUndefined();

    byok.set("anthropic", "sk-ant-abc");
    await client.fetch("/api/test");
    expect(apiCalls[2]!.headers["x-user-helius-key"]).toBe("hel-xyz");
    expect(apiCalls[2]!.headers["x-user-anthropic-key"]).toBe("sk-ant-abc");
  });

  test("401 → invalidates session + retries once with fresh token", async () => {
    const { client, apiCalls, authCalls } = build(
      [
        json({ token: "tok-1", expiresAt: "2026-05-27T12:00:00Z" }), // cold-start issue
        json({ token: "tok-2", expiresAt: "2026-05-27T12:00:00Z" }), // re-issue after 401
      ],
      [
        json({ error: "invalid_token" }, 401), // first attempt rejected
        json({ ok: true }), // retry succeeds
      ],
    );

    const resp = await client.fetch("/api/wallet/abc/check");
    expect(resp.status).toBe(200);
    // Two api calls (original + retry)
    expect(apiCalls).toHaveLength(2);
    expect(apiCalls[0]!.headers["x-auth-token"]).toBe("tok-1");
    expect(apiCalls[1]!.headers["x-auth-token"]).toBe("tok-2");
    // Two auth calls (cold start + post-401 re-issue)
    expect(authCalls).toHaveLength(2);
    // Stored token after retry is tok-2
    const stored = JSON.parse(sessStorage.data.get("thirdeye.session_token")!);
    expect(stored.token).toBe("tok-2");
  });

  test("non-401 status passes through without retry", async () => {
    const { client, apiCalls } = build(
      [json({ token: "tok", expiresAt: "2026-05-27T12:00:00Z" })],
      [json({ error: "rate_limited" }, 429)],
    );
    const resp = await client.fetch("/api/wallet/abc/check");
    expect(resp.status).toBe(429);
    expect(apiCalls).toHaveLength(1); // no retry
  });

  test("passes through method, body, custom headers", async () => {
    const { client, apiCalls } = build(
      [json({ token: "t", expiresAt: "2026-05-27T12:00:00Z" })],
      [json({ ok: true })],
    );
    await client.fetch("/api/test", {
      method: "POST",
      body: JSON.stringify({ x: 1 }),
      headers: { "Content-Type": "application/json", "X-Custom": "yes" },
    });
    expect(apiCalls[0]!.headers["content-type"]).toBe("application/json");
    expect(apiCalls[0]!.headers["x-custom"]).toBe("yes");
    expect(apiCalls[0]!.headers["x-auth-token"]).toBe("t");
  });
});

describe("getDashboard", () => {
  let sessStorage: MemStorage;
  let localStorage: MemStorage;
  const now = () => Date.parse("2026-05-20T12:00:00Z");

  beforeEach(() => {
    sessStorage = memStorage();
    localStorage = memStorage();
  });

  function build(authResponses: Response[], apiResponses: Response[]) {
    const authFetch = harness(authResponses);
    const apiFetch = harness(apiResponses);
    const auth = createAuthClient({
      storage: sessStorage,
      fetchImpl: authFetch.fetchImpl,
      apiBase: "",
      now,
    });
    const byok = createByokStore(localStorage);
    const client = createApiClient({ auth, byok, fetchImpl: apiFetch.fetchImpl });
    return { client, apiCalls: apiFetch.calls };
  }

  test("resolves to parsed DashboardBundle and hits /api/db/dashboard with auth header", async () => {
    const bundle: DashboardBundle = {
      generated_at: "2026-05-28T00:00:00Z",
      stats: {
        total_signals: 10,
        hits: 4,
        hit_rate: 0.4,
        avg_multiplier: 2.5,
        best_multiplier: 5.1,
        best_multiplier_symbol: "BONK",
        open_signals: 3,
      },
      live_signals: [],
      trending: [],
      top_traders: [],
    };
    const { client, apiCalls } = build(
      [json({ token: "tok-dash", expiresAt: "2026-05-27T12:00:00Z" })],
      [json(bundle)],
    );
    const result = await getDashboard(client);
    expect(result).toEqual(bundle);
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0]!.url).toBe("/api/db/dashboard");
    expect(apiCalls[0]!.headers["x-auth-token"]).toBe("tok-dash");
  });
});

describe("listCandidates", () => {
  let sessStorage: MemStorage;
  let localStorage: MemStorage;
  const now = () => Date.parse("2026-05-20T12:00:00Z");

  beforeEach(() => {
    sessStorage = memStorage();
    localStorage = memStorage();
  });

  function build(authResponses: Response[], apiResponses: Response[]) {
    const authFetch = harness(authResponses);
    const apiFetch = harness(apiResponses);
    const auth = createAuthClient({
      storage: sessStorage,
      fetchImpl: authFetch.fetchImpl,
      apiBase: "",
      now,
    });
    const byok = createByokStore(localStorage);
    const client = createApiClient({ auth, byok, fetchImpl: apiFetch.fetchImpl });
    return { client, apiCalls: apiFetch.calls };
  }

  test("returns items and hits /api/db/candidates without options", async () => {
    const rows: CandidateRow[] = [
      {
        address: "CandAddr1111111111111111111111111111111111",
        handle: "@alpha",
        displayName: "Alpha Trader",
        twitterHandle: "alpha",
        source: "fomo_seed",
        srcPnlAll: 42000,
        srcWinRate: 0.72,
        earlyRate: 0.55,
        buysObserved: 30,
        tokensTraded: 18,
        promoted: false,
      },
    ];
    const { client, apiCalls } = build(
      [json({ token: "tok-cand", expiresAt: "2026-05-27T12:00:00Z" })],
      [json({ items: rows })],
    );
    const result = await listCandidates({}, client);
    expect(result).toEqual(rows);
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0]!.url).toBe("/api/db/candidates");
    expect(apiCalls[0]!.headers["x-auth-token"]).toBe("tok-cand");
  });

  test("appends query params when options are provided", async () => {
    const { client, apiCalls } = build(
      [json({ token: "tok-q", expiresAt: "2026-05-27T12:00:00Z" })],
      [json({ items: [] })],
    );
    await listCandidates({ limit: 15, includePromoted: false, source: "fomo_seed" }, client);
    expect(apiCalls[0]!.url).toBe(
      "/api/db/candidates?limit=15&includePromoted=false&source=fomo_seed",
    );
  });
});

describe("promoteCandidate", () => {
  let sessStorage: MemStorage;
  let localStorage: MemStorage;
  const now = () => Date.parse("2026-05-20T12:00:00Z");

  beforeEach(() => {
    sessStorage = memStorage();
    localStorage = memStorage();
  });

  function build(authResponses: Response[], apiResponses: Response[]) {
    const authFetch = harness(authResponses);
    const apiFetch = harness(apiResponses);
    const auth = createAuthClient({
      storage: sessStorage,
      fetchImpl: authFetch.fetchImpl,
      apiBase: "",
      now,
    });
    const byok = createByokStore(localStorage);
    const client = createApiClient({ auth, byok, fetchImpl: apiFetch.fetchImpl });
    return { client, apiCalls: apiFetch.calls };
  }

  test("POSTs to /api/db/candidates/:address/promote and resolves on 200", async () => {
    const addr = "PromAddr1111111111111111111111111111111111";
    const { client, apiCalls } = build(
      [json({ token: "tok-promo", expiresAt: "2026-05-27T12:00:00Z" })],
      [json({ promoted: addr })],
    );
    await expect(promoteCandidate(addr, client)).resolves.toBeUndefined();
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0]!.url).toBe(`/api/db/candidates/${addr}/promote`);
    expect(apiCalls[0]!.headers["x-auth-token"]).toBe("tok-promo");
  });

  test("throws on non-ok response", async () => {
    const addr = "PromAddr1111111111111111111111111111111111";
    const { client } = build(
      [json({ token: "tok-err", expiresAt: "2026-05-27T12:00:00Z" })],
      [json({ error: "not_a_candidate" }, 404)],
    );
    await expect(promoteCandidate(addr, client)).rejects.toThrow("promote 404");
  });
});
