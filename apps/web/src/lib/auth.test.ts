import { beforeEach, describe, expect, test } from "bun:test";
import { AuthError, type SessionStorageLike, createAuthClient } from "./auth";

interface MemStorage extends SessionStorageLike {
  data: Map<string, string>;
}

function memStorage(): MemStorage {
  const data = new Map<string, string>();
  return {
    data,
    getItem(k) {
      return data.get(k) ?? null;
    },
    setItem(k, v) {
      data.set(k, v);
    },
    removeItem(k) {
      data.delete(k);
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

interface FetchLog {
  calls: { url: string | URL | Request; init?: RequestInit }[];
}

function recordingFetch(responder: (call: number) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  log: FetchLog;
} {
  const log: FetchLog = { calls: [] };
  let n = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    log.calls.push({ url: input as string | URL | Request, init });
    const r = responder(n);
    n += 1;
    return r;
  };
  return { fetch, log };
}

describe("auth client", () => {
  let storage: MemStorage;
  let now: number;
  const nowFn = () => now;

  beforeEach(() => {
    storage = memStorage();
    now = Date.parse("2026-05-20T12:00:00Z");
  });

  test("cold start: empty storage → POST /auth → cache + return token", async () => {
    const { fetch, log } = recordingFetch(() =>
      jsonResponse({ token: "tok-1", expiresAt: "2026-05-27T12:00:00Z" }),
    );
    const client = createAuthClient({ storage, fetchImpl: fetch, apiBase: "", now: nowFn });

    const token = await client.getOrIssueToken();
    expect(token).toBe("tok-1");
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.url).toBe("/api/db/auth");
    expect(log.calls[0]!.init?.method).toBe("POST");

    const stored = JSON.parse(storage.data.get("thirdeye.session_token")!);
    expect(stored.token).toBe("tok-1");
  });

  test("fresh cache: returns stored token without fetching", async () => {
    storage.setItem(
      "thirdeye.session_token",
      JSON.stringify({ token: "cached-tok", expiresAt: "2026-05-27T12:00:00Z" }),
    );
    const { fetch, log } = recordingFetch(() => {
      throw new Error("should not be called");
    });
    const client = createAuthClient({ storage, fetchImpl: fetch, apiBase: "", now: nowFn });

    const token = await client.getOrIssueToken();
    expect(token).toBe("cached-tok");
    expect(log.calls).toHaveLength(0);
  });

  test("expiring within refresh window: re-issues", async () => {
    // Expires in 30s — under the 60s refresh window
    const expiresAt = new Date(now + 30_000).toISOString();
    storage.setItem("thirdeye.session_token", JSON.stringify({ token: "stale-tok", expiresAt }));
    const { fetch, log } = recordingFetch(() =>
      jsonResponse({ token: "fresh-tok", expiresAt: "2026-05-27T12:00:00Z" }),
    );
    const client = createAuthClient({ storage, fetchImpl: fetch, apiBase: "", now: nowFn });

    const token = await client.getOrIssueToken();
    expect(token).toBe("fresh-tok");
    expect(log.calls).toHaveLength(1);
  });

  test("expired token (past expiresAt): re-issues", async () => {
    storage.setItem(
      "thirdeye.session_token",
      JSON.stringify({ token: "old-tok", expiresAt: "2026-05-19T12:00:00Z" }),
    );
    const { fetch, log } = recordingFetch(() =>
      jsonResponse({ token: "new-tok", expiresAt: "2026-05-27T12:00:00Z" }),
    );
    const client = createAuthClient({ storage, fetchImpl: fetch, apiBase: "", now: nowFn });

    const token = await client.getOrIssueToken();
    expect(token).toBe("new-tok");
    expect(log.calls).toHaveLength(1);
  });

  test("concurrent callers share one in-flight POST", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const log: { calls: number } = { calls: 0 };
    const fetch: typeof globalThis.fetch = async () => {
      log.calls += 1;
      return fetchPromise;
    };
    const client = createAuthClient({ storage, fetchImpl: fetch, apiBase: "", now: nowFn });

    const p1 = client.getOrIssueToken();
    const p2 = client.getOrIssueToken();
    const p3 = client.getOrIssueToken();

    resolveFetch(jsonResponse({ token: "shared-tok", expiresAt: "2026-05-27T12:00:00Z" }));

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual(["shared-tok", "shared-tok", "shared-tok"]);
    expect(log.calls).toBe(1);
  });

  test("invalidate clears cache; next call re-fetches", async () => {
    storage.setItem(
      "thirdeye.session_token",
      JSON.stringify({ token: "cached", expiresAt: "2026-05-27T12:00:00Z" }),
    );
    const { fetch, log } = recordingFetch(() =>
      jsonResponse({ token: "reissued", expiresAt: "2026-05-28T12:00:00Z" }),
    );
    const client = createAuthClient({ storage, fetchImpl: fetch, apiBase: "", now: nowFn });

    expect(await client.getOrIssueToken()).toBe("cached");
    client.invalidate();
    expect(storage.data.has("thirdeye.session_token")).toBe(false);
    expect(await client.getOrIssueToken()).toBe("reissued");
    expect(log.calls).toHaveLength(1);
  });

  test("non-2xx response throws AuthError with status + retryAfterSec", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: "auth_issue_rate_limited", retryAfterSec: 3600 }, 429, {
        "Retry-After": "3600",
      }),
    );
    const client = createAuthClient({ storage, fetchImpl: fetch, apiBase: "", now: nowFn });

    let caught: unknown = null;
    try {
      await client.getOrIssueToken();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthError);
    const err = caught as AuthError;
    expect(err.status).toBe(429);
    expect(err.retryAfterSec).toBe(3600);
    expect(err.message).toBe("auth_issue_rate_limited");
  });

  test("apiBase is honored", async () => {
    const { fetch, log } = recordingFetch(() =>
      jsonResponse({ token: "t", expiresAt: "2026-05-27T12:00:00Z" }),
    );
    const client = createAuthClient({
      storage,
      fetchImpl: fetch,
      apiBase: "http://api.example",
      now: nowFn,
    });
    await client.getOrIssueToken();
    expect(log.calls[0]!.url).toBe("http://api.example/api/db/auth");
  });

  test("null storage: works but never caches", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse({ token: `t-${calls}`, expiresAt: "2026-05-27T12:00:00Z" });
    };
    const client = createAuthClient({ storage: null, fetchImpl: fetch, apiBase: "", now: nowFn });
    expect(await client.getOrIssueToken()).toBe("t-1");
    expect(await client.getOrIssueToken()).toBe("t-2");
    expect(calls).toBe(2);
  });
});
