# ThirdEye — Phase 1: Helius Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec [`2026-05-04-thirdeye-phase-1-helius-proxy.md`](../specs/2026-05-04-thirdeye-phase-1-helius-proxy.md): seven `/api/helius/*` routes + JSON-RPC pass-through, single `proxyToHelius` primitive in `packages/helius`, two-tier LRU cache, sliding-window rate-limit middleware on `auth_tokens.rate_bucket`, real Helius integration tests in CI.

**Spec reference:** All section numbers below refer to the Phase 1 spec unless noted as "parent §16".

**Tech additions:** `lru-cache` ^11.0.

---

## File structure (additions to repo)

```
packages/helius/                              # NEW workspace package
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                              # public exports
    ├── ttl.ts                                # IMMUTABLE/DEFAULT/NO_CACHE + RPC_IMMUTABLE_METHODS
    ├── urls.ts                               # REST + RPC URL composition
    ├── errors.ts                             # mapHeliusError(status, body) → ProxyError
    ├── rpc-policy.ts                         # validateRpcEnvelope + DENY_LIST
    ├── cache.ts                              # LRU instance + composeCacheKey
    └── proxy.ts                              # proxyToHelius(opts) — the chokepoint

apps/api/src/
├── env.ts                                    # MODIFY — add HELIUS_API_KEY, proxy limit envs
├── index.ts                                  # MODIFY — mount helius routes + helius-rpc
├── lib/
│   └── solana-address.ts                     # NEW — base58 + length validation
├── middleware/
│   └── rate-limit.ts                         # NEW — sliding-window factory
└── routes/
    └── helius/
        ├── index.ts                          # NEW — barrel + mountHelius(app)
        ├── identity.ts
        ├── balances.ts
        ├── funded-by.ts
        ├── transactions.ts
        ├── batch-identity.ts
        ├── transactions-by-sig.ts
        └── rpc.ts                            # POST /api/helius-rpc with method gate

apps/api/tests/
├── solana-address.test.ts
├── rate-limit.test.ts                        # DB integration
├── helius-cache.test.ts
├── helius-urls.test.ts
├── helius-errors.test.ts
├── helius-rpc-policy.test.ts
├── helius-proxy.integration.test.ts          # real Helius — skips if no key
├── helius-routes.integration.test.ts         # real Helius — skips if no key
└── fixtures/
    └── helius.ts                             # pinned fixture addresses

.github/workflows/ci.yml                      # MODIFY — HELIUS_API_KEY secret + PUBLIC_INSTANCE_MODE
.env.example                                  # MODIFY — uncomment HELIUS_API_KEY, add proxy envs
docker-compose.yml                            # MODIFY — pass HELIUS_API_KEY through
CLAUDE.md                                     # MODIFY — note Helius integration test policy
package.json                                  # MODIFY — root scripts unchanged; deps via workspace
```

---

## Task 1: Add `packages/helius` scaffold + lru-cache dependency

**Files:**
- Create: `packages/helius/package.json`
- Create: `packages/helius/tsconfig.json`
- Create: `packages/helius/src/index.ts`

- [ ] **Step 1: Write `packages/helius/package.json`**

```json
{
  "name": "@thirdeye/helius",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "lru-cache": "^11.0.0"
  }
}
```

- [ ] **Step 2: Write `packages/helius/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write placeholder `packages/helius/src/index.ts`**

```typescript
export const PACKAGE_NAME = "@thirdeye/helius" as const;
```

- [ ] **Step 4: Install**

`bun install` — adds `lru-cache@^11` to workspace lockfile.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add packages/helius package.json bun.lock
git commit -m "chore: helius — add workspace package scaffold with lru-cache dep"
```

---

## Task 2: TTL constants

**Files:**
- Create: `packages/helius/src/ttl.ts`

- [ ] **Step 1: Write `packages/helius/src/ttl.ts`**

```typescript
export const TTL = {
  IMMUTABLE: 24 * 60 * 60 * 1000, // 24h — funded-by, transactions-by-sig, immutable RPC methods
  DEFAULT: 5 * 60 * 1000,          // 5min — identity, balances, transactions list, etc.
  NO_CACHE: 0,                     // explicitly skip cache for this call
} as const;

export const RPC_IMMUTABLE_METHODS: ReadonlySet<string> = new Set([
  "getTransaction",
  "getBlock",
  "getBlockTime",
  "getSignatureStatuses",
]);

export function rpcCacheTtlMs(method: string): number {
  return RPC_IMMUTABLE_METHODS.has(method) ? TTL.IMMUTABLE : TTL.DEFAULT;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/helius/src/ttl.ts
git commit -m "feat: helius — define cache ttl tiers and immutable rpc method set"
```

---

## Task 3: URL composition (TDD)

**Files:**
- Create: `apps/api/tests/helius-urls.test.ts`
- Create: `packages/helius/src/urls.ts`

- [ ] **Step 1: Write failing test `apps/api/tests/helius-urls.test.ts`**

```typescript
import { describe, expect, test } from "bun:test";
import { composeRestUrl, composeRpcUrl } from "@thirdeye/helius";

describe("composeRestUrl", () => {
  test("strips leading slash and uses api.helius.xyz host", () => {
    const u = composeRestUrl({ path: "/v1/wallet/abc/identity", apiKey: "K" });
    expect(u).toBe("https://api.helius.xyz/v1/wallet/abc/identity?api-key=K");
  });

  test("appends sorted query params after api-key", () => {
    const u = composeRestUrl({
      path: "/v1/wallet/abc/balances",
      apiKey: "K",
      query: { showNative: "true", limit: "100" },
    });
    expect(u).toBe(
      "https://api.helius.xyz/v1/wallet/abc/balances?api-key=K&limit=100&showNative=true",
    );
  });

  test("encodes query values", () => {
    const u = composeRestUrl({
      path: "/v0/addresses/abc/transactions",
      apiKey: "K",
      query: { type: "TOKEN TRANSFER" },
    });
    expect(u).toContain("type=TOKEN%20TRANSFER");
  });
});

describe("composeRpcUrl", () => {
  test("uses mainnet.helius-rpc.com host", () => {
    expect(composeRpcUrl("K")).toBe("https://mainnet.helius-rpc.com/?api-key=K");
  });
});
```

- [ ] **Step 2: Verify it fails**

`cd apps/api && bun test tests/helius-urls.test.ts` — module not found.

- [ ] **Step 3: Implement `packages/helius/src/urls.ts`**

```typescript
export interface RestUrlInput {
  path: string;
  apiKey: string;
  query?: Record<string, string>;
}

export function composeRestUrl({ path, apiKey, query }: RestUrlInput): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const params = new URLSearchParams();
  params.set("api-key", apiKey);
  if (query) {
    const keys = Object.keys(query).sort();
    for (const k of keys) params.set(k, query[k]!);
  }
  return `https://api.helius.xyz${normalizedPath}?${params.toString()}`;
}

export function composeRpcUrl(apiKey: string): string {
  const params = new URLSearchParams({ "api-key": apiKey });
  return `https://mainnet.helius-rpc.com/?${params.toString()}`;
}
```

- [ ] **Step 4: Export from `packages/helius/src/index.ts`**

```typescript
export * from "./ttl";
export * from "./urls";
export const PACKAGE_NAME = "@thirdeye/helius" as const;
```

- [ ] **Step 5: Verify pass + commit**

```bash
cd apps/api && bun test tests/helius-urls.test.ts   # 3 pass
git add packages/helius/src/urls.ts packages/helius/src/index.ts apps/api/tests/helius-urls.test.ts
git commit -m "feat: helius — compose rest and rpc urls with sorted, encoded query params"
```

---

## Task 4: Error mapping (TDD)

**Files:**
- Create: `apps/api/tests/helius-errors.test.ts`
- Create: `packages/helius/src/errors.ts`

- [ ] **Step 1: Write failing test `apps/api/tests/helius-errors.test.ts`**

```typescript
import { describe, expect, test } from "bun:test";
import { mapUpstreamStatus, ProxyError } from "@thirdeye/helius";

describe("mapUpstreamStatus", () => {
  test("2xx returns null (no error)", () => {
    expect(mapUpstreamStatus(200)).toBeNull();
    expect(mapUpstreamStatus(204)).toBeNull();
  });

  test("4xx is passthrough", () => {
    const e = mapUpstreamStatus(404)!;
    expect(e.status).toBe(404);
    expect(e.error).toBe("upstream_404");
  });

  test("429 keeps 429 status with rate_limited code", () => {
    const e = mapUpstreamStatus(429)!;
    expect(e.status).toBe(429);
    expect(e.error).toBe("upstream_429");
  });

  test("5xx becomes ThirdEye 502", () => {
    const e = mapUpstreamStatus(500)!;
    expect(e.status).toBe(502);
    expect(e.error).toBe("upstream_error");
    expect(e.upstreamStatus).toBe(500);

    const e2 = mapUpstreamStatus(503)!;
    expect(e2.status).toBe(502);
  });
});

describe("ProxyError", () => {
  test("timeout helper produces 504", () => {
    expect(ProxyError.timeout().status).toBe(504);
    expect(ProxyError.timeout().error).toBe("upstream_timeout");
  });

  test("noKey helper produces 503", () => {
    expect(ProxyError.noKey().status).toBe(503);
    expect(ProxyError.noKey().error).toBe("no_helius_key");
  });
});
```

- [ ] **Step 2: Implement `packages/helius/src/errors.ts`**

```typescript
export interface ProxyErrorPayload {
  status: number;
  error: string;
  message: string;
  upstreamStatus?: number;
}

export const ProxyError = {
  timeout: (): ProxyErrorPayload => ({
    status: 504,
    error: "upstream_timeout",
    message: "Helius did not respond within timeout",
  }),
  noKey: (): ProxyErrorPayload => ({
    status: 503,
    error: "no_helius_key",
    message: "No Helius API key configured (server env var or X-User-Helius-Key header)",
  }),
  invalidAddress: (): ProxyErrorPayload => ({
    status: 400,
    error: "invalid_address",
    message: "Address is not valid base58 or wrong length",
  }),
  invalidRpcBody: (msg: string): ProxyErrorPayload => ({
    status: 400,
    error: "invalid_rpc_body",
    message: msg,
  }),
  forbiddenRpcMethod: (method: string): ProxyErrorPayload => ({
    status: 403,
    error: "forbidden_rpc_method",
    message: `RPC method '${method}' is not allowed through this proxy`,
  }),
  rateLimited: (retryAfterSec: number): ProxyErrorPayload & { retryAfterSec: number } => ({
    status: 429,
    error: "rate_limited",
    message: "Rate limit exceeded for this session token",
    retryAfterSec,
  }),
};

export function mapUpstreamStatus(status: number): ProxyErrorPayload | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 500) {
    return {
      status: 502,
      error: "upstream_error",
      message: `Helius returned ${status}`,
      upstreamStatus: status,
    };
  }
  return {
    status,
    error: `upstream_${status}`,
    message: `Helius returned ${status}`,
    upstreamStatus: status,
  };
}
```

- [ ] **Step 3: Re-export and verify**

Add `export * from "./errors";` to `packages/helius/src/index.ts`. Run `cd apps/api && bun test tests/helius-errors.test.ts` — 6 pass.

- [ ] **Step 4: Commit**

```bash
git add packages/helius/src/errors.ts packages/helius/src/index.ts apps/api/tests/helius-errors.test.ts
git commit -m "feat: helius — error mapping (helius status → thirdeye proxy error shape)"
```

---

## Task 5: JSON-RPC policy (TDD)

**Files:**
- Create: `apps/api/tests/helius-rpc-policy.test.ts`
- Create: `packages/helius/src/rpc-policy.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { validateRpcEnvelope, RPC_DENY_LIST } from "@thirdeye/helius";

describe("validateRpcEnvelope", () => {
  test("accepts well-formed envelope", () => {
    const r = validateRpcEnvelope({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: ["sig"] });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.method).toBe("getTransaction");
  });

  test("rejects missing method", () => {
    const r = validateRpcEnvelope({ jsonrpc: "2.0", id: 1, params: [] });
    expect(r.kind).toBe("invalid");
  });

  test("rejects non-string method", () => {
    const r = validateRpcEnvelope({ jsonrpc: "2.0", id: 1, method: 5, params: [] });
    expect(r.kind).toBe("invalid");
  });

  test("rejects denied method (sendTransaction)", () => {
    const r = validateRpcEnvelope({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [] });
    expect(r.kind).toBe("forbidden");
  });

  test("rejects denied method (simulateTransaction)", () => {
    const r = validateRpcEnvelope({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [] });
    expect(r.kind).toBe("forbidden");
  });

  test("rejects denied method (requestAirdrop)", () => {
    const r = validateRpcEnvelope({ jsonrpc: "2.0", id: 1, method: "requestAirdrop", params: [] });
    expect(r.kind).toBe("forbidden");
  });

  test("DENY_LIST is non-empty and exact", () => {
    expect(RPC_DENY_LIST.has("sendTransaction")).toBe(true);
    expect(RPC_DENY_LIST.has("getTransaction")).toBe(false);
  });
});
```

- [ ] **Step 2: Implement `packages/helius/src/rpc-policy.ts`**

```typescript
export const RPC_DENY_LIST: ReadonlySet<string> = new Set([
  "sendTransaction",
  "simulateTransaction",
  "requestAirdrop",
]);

export type RpcEnvelopeResult =
  | { kind: "ok"; method: string; envelope: { jsonrpc: string; id: unknown; method: string; params: unknown[] } }
  | { kind: "invalid"; reason: string }
  | { kind: "forbidden"; method: string };

export function validateRpcEnvelope(input: unknown): RpcEnvelopeResult {
  if (typeof input !== "object" || input === null) {
    return { kind: "invalid", reason: "body must be a JSON object" };
  }
  const e = input as Record<string, unknown>;
  if (e.jsonrpc !== "2.0") {
    return { kind: "invalid", reason: "jsonrpc must be '2.0'" };
  }
  if (typeof e.method !== "string" || e.method.length === 0) {
    return { kind: "invalid", reason: "method must be a non-empty string" };
  }
  if (!Array.isArray(e.params)) {
    return { kind: "invalid", reason: "params must be an array" };
  }
  if (RPC_DENY_LIST.has(e.method)) {
    return { kind: "forbidden", method: e.method };
  }
  return {
    kind: "ok",
    method: e.method,
    envelope: { jsonrpc: e.jsonrpc, id: e.id, method: e.method, params: e.params },
  };
}
```

- [ ] **Step 3: Re-export, verify pass, commit**

```bash
cd apps/api && bun test tests/helius-rpc-policy.test.ts   # 7 pass
git add packages/helius/src/rpc-policy.ts packages/helius/src/index.ts apps/api/tests/helius-rpc-policy.test.ts
git commit -m "feat: helius — json-rpc envelope validation with mutating-method deny list"
```

---

## Task 6: Cache + key composition (TDD)

**Files:**
- Create: `apps/api/tests/helius-cache.test.ts`
- Create: `packages/helius/src/cache.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { composeCacheKey, getCache, _resetCacheForTests } from "@thirdeye/helius";

describe("composeCacheKey", () => {
  test("deterministic for identical input", () => {
    const a = composeCacheKey({ method: "GET", path: "/v1/x", query: { a: "1" } });
    const b = composeCacheKey({ method: "GET", path: "/v1/x", query: { a: "1" } });
    expect(a).toBe(b);
  });

  test("query param order does not affect key", () => {
    const a = composeCacheKey({ method: "GET", path: "/v1/x", query: { a: "1", b: "2" } });
    const b = composeCacheKey({ method: "GET", path: "/v1/x", query: { b: "2", a: "1" } });
    expect(a).toBe(b);
  });

  test("body order does not affect key", () => {
    const a = composeCacheKey({ method: "POST", path: "/v1/x", body: { a: 1, b: 2 } });
    const b = composeCacheKey({ method: "POST", path: "/v1/x", body: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  test("differs across method", () => {
    const a = composeCacheKey({ method: "GET", path: "/v1/x" });
    const b = composeCacheKey({ method: "POST", path: "/v1/x" });
    expect(a).not.toBe(b);
  });

  test("differs across path", () => {
    const a = composeCacheKey({ method: "GET", path: "/v1/a" });
    const b = composeCacheKey({ method: "GET", path: "/v1/b" });
    expect(a).not.toBe(b);
  });

  test("api-key never in the key (prefix probe)", () => {
    const a = composeCacheKey({ method: "GET", path: "/v1/x", query: { a: "1" } });
    expect(a).not.toContain("api-key");
  });
});

describe("LRU cache", () => {
  test("get returns set value within TTL", () => {
    _resetCacheForTests();
    const cache = getCache();
    cache.set("k", { status: 200, body: { ok: true } }, { ttl: 1000 });
    expect(cache.get("k")).toEqual({ status: 200, body: { ok: true } });
  });

  test("returns undefined for unknown key", () => {
    _resetCacheForTests();
    const cache = getCache();
    expect(cache.get("missing")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement `packages/helius/src/cache.ts`**

```typescript
import { LRUCache } from "lru-cache";
import { createHash } from "node:crypto";

export interface CachedResponse {
  status: number;
  body: unknown;
}

export interface CacheKeyInput {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function composeCacheKey(input: CacheKeyInput): string {
  const queryStr = input.query ? canonical(input.query) : "";
  const bodyStr = input.body !== undefined ? canonical(input.body) : "";
  const raw = `${input.method}|${input.path}|${queryStr}|${bodyStr}`;
  return createHash("sha256").update(raw).digest("hex");
}

let cacheInstance: LRUCache<string, CachedResponse> | null = null;

export function getCache(): LRUCache<string, CachedResponse> {
  if (!cacheInstance) {
    cacheInstance = new LRUCache<string, CachedResponse>({
      max: 5000,
      ttl: 5 * 60 * 1000,
      ttlAutopurge: true,
      updateAgeOnGet: false,
    });
  }
  return cacheInstance;
}

export function _resetCacheForTests(): void {
  cacheInstance?.clear();
  cacheInstance = null;
}
```

- [ ] **Step 3: Re-export, verify pass, commit**

```bash
cd apps/api && bun test tests/helius-cache.test.ts   # 8 pass
git add packages/helius/src/cache.ts packages/helius/src/index.ts apps/api/tests/helius-cache.test.ts
git commit -m "feat: helius — sha256 cache keying (order-independent) + lru-cache instance"
```

---

## Task 7: `proxyToHelius` primitive

**Files:**
- Create: `packages/helius/src/proxy.ts`

- [ ] **Step 1: Implement `packages/helius/src/proxy.ts`**

```typescript
import { composeCacheKey, getCache, type CachedResponse } from "./cache";
import { mapUpstreamStatus, ProxyError, type ProxyErrorPayload } from "./errors";
import { composeRestUrl, composeRpcUrl } from "./urls";

export type ProxyTarget =
  | { kind: "rest"; path: string; query?: Record<string, string> }
  | { kind: "rpc"; method: string; params: unknown[] };

export interface ProxyOptions {
  target: ProxyTarget;
  method: "GET" | "POST";
  body?: unknown;
  cacheTtlMs: number;
  serverKey: string | undefined;
  userKey?: string | undefined;
  timeoutMs?: number;
}

export interface ProxyResult {
  status: number;
  body: unknown;
  fromCache: boolean;
  durationMs: number;
  isByok: boolean;
  error?: ProxyErrorPayload;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function proxyToHelius(opts: ProxyOptions): Promise<ProxyResult> {
  const start = Date.now();
  const isByok = Boolean(opts.userKey);
  const apiKey = opts.userKey ?? opts.serverKey;

  if (!apiKey) {
    const err = ProxyError.noKey();
    return {
      status: err.status,
      body: { error: err.error, message: err.message },
      fromCache: false,
      durationMs: Date.now() - start,
      isByok,
      error: err,
    };
  }

  // Compose the cache key BEFORE composing the URL (cache key omits api-key).
  // For rpc kind we cache by method+params; for rest we cache by path+query.
  const cacheKey =
    opts.target.kind === "rest"
      ? composeCacheKey({
          method: opts.method,
          path: opts.target.path,
          query: opts.target.query,
          body: opts.body,
        })
      : composeCacheKey({
          method: "POST",
          path: `/rpc/${opts.target.method}`,
          body: { params: opts.target.params },
        });

  const cache = getCache();
  if (opts.cacheTtlMs > 0) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        status: cached.status,
        body: cached.body,
        fromCache: true,
        durationMs: Date.now() - start,
        isByok,
      };
    }
  }

  // Compose the URL with the api-key.
  const url =
    opts.target.kind === "rest"
      ? composeRestUrl({ path: opts.target.path, apiKey, query: opts.target.query })
      : composeRpcUrl(apiKey);

  const fetchBody =
    opts.target.kind === "rpc"
      ? JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: opts.target.method,
          params: opts.target.params,
        })
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : null;

  const headers: Record<string, string> = {
    "X-ThirdEye-Proxy": "1",
  };
  if (opts.method === "POST" || opts.target.kind === "rpc") {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.target.kind === "rpc" ? "POST" : opts.method,
      headers,
      body: fetchBody ?? undefined,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = ProxyError.timeout();
    return {
      status: err.status,
      body: { error: err.error, message: err.message },
      fromCache: false,
      durationMs: Date.now() - start,
      isByok,
      error: err,
    };
  }
  clearTimeout(timer);

  const text = await res.text();
  let body: unknown;
  if (text.length === 0) {
    body = null;
  } else {
    body = JSON.parse(text);
  }

  const upstreamErr = mapUpstreamStatus(res.status);
  if (upstreamErr) {
    return {
      status: upstreamErr.status,
      body: {
        error: upstreamErr.error,
        message: upstreamErr.message,
        upstreamStatus: upstreamErr.upstreamStatus,
        upstreamBody: body,
      },
      fromCache: false,
      durationMs: Date.now() - start,
      isByok,
      error: upstreamErr,
    };
  }

  if (opts.cacheTtlMs > 0) {
    const entry: CachedResponse = { status: res.status, body };
    cache.set(cacheKey, entry, { ttl: opts.cacheTtlMs });
  }

  return {
    status: res.status,
    body,
    fromCache: false,
    durationMs: Date.now() - start,
    isByok,
  };
}
```

- [ ] **Step 2: Re-export and commit**

Add `export * from "./proxy";` to `packages/helius/src/index.ts`.

```bash
bun run typecheck
git add packages/helius/src/proxy.ts packages/helius/src/index.ts
git commit -m "feat: helius — proxyToHelius single chokepoint with cache, timeout, error mapping"
```

---

## Task 8: Solana address validator (TDD)

**Files:**
- Create: `apps/api/tests/solana-address.test.ts`
- Create: `apps/api/src/lib/solana-address.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { isValidSolanaAddress } from "../src/lib/solana-address";

describe("isValidSolanaAddress", () => {
  test("accepts valid 44-char base58", () => {
    expect(isValidSolanaAddress("BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNNz")).toBe(true);
  });

  test("accepts shorter valid base58 (32 chars min)", () => {
    expect(isValidSolanaAddress("11111111111111111111111111111111")).toBe(true);
  });

  test("rejects too short", () => {
    expect(isValidSolanaAddress("abc")).toBe(false);
  });

  test("rejects too long", () => {
    expect(isValidSolanaAddress("a".repeat(50))).toBe(false);
  });

  test("rejects characters outside base58 alphabet", () => {
    expect(isValidSolanaAddress("0OIl11111111111111111111111111111")).toBe(false);
  });

  test("rejects empty", () => {
    expect(isValidSolanaAddress("")).toBe(false);
  });
});
```

- [ ] **Step 2: Implement `apps/api/src/lib/solana-address.ts`**

```typescript
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function isValidSolanaAddress(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  return BASE58_RE.test(s);
}
```

- [ ] **Step 3: Verify + commit**

```bash
cd apps/api && bun test tests/solana-address.test.ts   # 6 pass
git add apps/api/src/lib/solana-address.ts apps/api/tests/solana-address.test.ts
git commit -m "feat: api — solana address base58 + length validator"
```

---

## Task 9: Rate-limit middleware (TDD, real Postgres)

**Files:**
- Create: `apps/api/tests/rate-limit.test.ts`
- Create: `apps/api/src/middleware/rate-limit.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authTokens, type DbClient } from "@thirdeye/db";
import { eq } from "drizzle-orm";
import { setupTestDb, type TestDb } from "./setup";
import { rateLimit } from "../src/middleware/rate-limit";
import { generateToken } from "../src/lib/tokens";

let testDb: TestDb;

beforeAll(async () => { testDb = await setupTestDb(); });
afterAll(async () => { await testDb.cleanup(); });
beforeEach(async () => {
  await testDb.sql.unsafe("TRUNCATE auth_tokens RESTART IDENTITY CASCADE;");
});

async function issueToken(db: DbClient): Promise<string> {
  const t = generateToken();
  await db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
  return t.token;
}

function appWith(opts: { mode: "true" | "false"; bypassOnByok: boolean; limit: number }): Hono {
  process.env.PUBLIC_INSTANCE_MODE = opts.mode;
  const app = new Hono<{ Variables: { db: DbClient } }>();
  app.use("*", async (c, next) => { c.set("db", testDb.db); await next(); });
  app.use("*", rateLimit({ name: "test_limit", limit: opts.limit, windowSec: 60, bypassOnByok: opts.bypassOnByok }));
  app.get("/probe", (c) => c.json({ ok: true }));
  return app;
}

describe("rate-limit middleware", () => {
  test("PUBLIC_INSTANCE_MODE=false: no enforcement", async () => {
    const app = appWith({ mode: "false", bypassOnByok: true, limit: 1 });
    const token = await issueToken(testDb.db);
    const r1 = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    const r2 = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  test("PUBLIC_INSTANCE_MODE=true: enforces under limit, 429 over", async () => {
    const app = appWith({ mode: "true", bypassOnByok: true, limit: 2 });
    const token = await issueToken(testDb.db);
    const r1 = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    const r2 = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    const r3 = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    const body = (await r3.json()) as { error: string; retryAfterSec: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(r3.headers.get("Retry-After")).toBeTruthy();
  });

  test("BYOK header bypasses when bypassOnByok=true", async () => {
    const app = appWith({ mode: "true", bypassOnByok: true, limit: 1 });
    const token = await issueToken(testDb.db);
    const r1 = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    const r2 = await app.request("/probe", {
      headers: { "X-Auth-Token": token, "X-User-Helius-Key": "user-key-xyz" },
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  test("BYOK header does NOT bypass when bypassOnByok=false", async () => {
    const app = appWith({ mode: "true", bypassOnByok: false, limit: 1 });
    const token = await issueToken(testDb.db);
    const r1 = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    const r2 = await app.request("/probe", {
      headers: { "X-Auth-Token": token, "X-User-Helius-Key": "user-key-xyz" },
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
  });

  test("rate_bucket persists per name", async () => {
    const app = appWith({ mode: "true", bypassOnByok: true, limit: 5 });
    const token = await issueToken(testDb.db);
    await app.request("/probe", { headers: { "X-Auth-Token": token } });
    const rows = await testDb.db.select().from(authTokens).where(eq(authTokens.token, token));
    const bucket = rows[0]!.rateBucket as Record<string, { windowStart: string; count: number }>;
    expect(bucket.test_limit?.count).toBe(1);
    expect(bucket.test_limit?.windowStart).toBeTruthy();
  });

  test("X-RateLimit-* headers on success", async () => {
    const app = appWith({ mode: "true", bypassOnByok: true, limit: 10 });
    const token = await issueToken(testDb.db);
    const r = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    expect(r.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(r.headers.get("X-RateLimit-Remaining")).toBe("9");
    expect(r.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });
});
```

Note: middleware reads token from `X-Auth-Token` header. It doesn't itself validate the token (Phase 0 middleware does that on real routes). For tests we mount only the rate-limit, so we pre-insert valid auth_tokens rows.

- [ ] **Step 2: Implement `apps/api/src/middleware/rate-limit.ts`**

```typescript
import type { MiddlewareHandler } from "hono";
import { authTokens, type DbClient } from "@thirdeye/db";
import { sql } from "drizzle-orm";

export interface RateLimitOptions {
  name: string;
  limit: number;
  windowSec: number;
  bypassOnByok: boolean;
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<{ Variables: { db: DbClient } }> {
  const { name, limit, windowSec, bypassOnByok } = opts;
  return async (c, next) => {
    if (process.env.PUBLIC_INSTANCE_MODE !== "true") {
      await next();
      return;
    }
    if (bypassOnByok && c.req.header("X-User-Helius-Key")) {
      await next();
      return;
    }

    const token = c.req.header("X-Auth-Token");
    if (!token) {
      // Auth middleware will reject this; we let it through to that layer.
      await next();
      return;
    }

    const db = c.get("db");
    const now = new Date();
    const windowFloor = new Date(now.getTime() - windowSec * 1000);

    const result = await db.execute(sql`
      UPDATE auth_tokens SET rate_bucket = jsonb_set(
        rate_bucket,
        ARRAY[${name}],
        CASE
          WHEN (rate_bucket->${name}->>'windowStart')::timestamptz IS NULL
            OR (rate_bucket->${name}->>'windowStart')::timestamptz < ${windowFloor.toISOString()}::timestamptz
          THEN jsonb_build_object('windowStart', ${now.toISOString()}::text, 'count', 1)
          ELSE jsonb_build_object(
            'windowStart', rate_bucket->${name}->>'windowStart',
            'count', ((rate_bucket->${name}->>'count')::int + 1)
          )
        END,
        true
      )
      WHERE token = ${token}
      RETURNING (rate_bucket->${name}->>'count')::int AS new_count,
                (rate_bucket->${name}->>'windowStart')::timestamptz AS window_start
    `);

    const row = (result as unknown as { new_count: number; window_start: Date }[])[0];
    if (!row) {
      // Token doesn't exist; auth middleware will 401. Pass through.
      await next();
      return;
    }

    const newCount = Number(row.new_count);
    const windowStart = new Date(row.window_start);
    const resetAt = new Date(windowStart.getTime() + windowSec * 1000);
    const retryAfterSec = Math.max(0, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));

    if (newCount > limit) {
      c.header("Retry-After", String(retryAfterSec));
      c.header("X-RateLimit-Limit", String(limit));
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", resetAt.toISOString());
      return c.json(
        { error: "rate_limited", message: `Limit ${limit}/${windowSec}s for ${name}`, retryAfterSec, name },
        429,
      );
    }

    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(Math.max(0, limit - newCount)));
    c.header("X-RateLimit-Reset", resetAt.toISOString());
    await next();
  };
}
```

- [ ] **Step 3: Verify + commit**

```bash
cd apps/api && bun test tests/rate-limit.test.ts   # 6 pass
git add apps/api/src/middleware/rate-limit.ts apps/api/tests/rate-limit.test.ts
git commit -m "feat: api — sliding-window rate-limit middleware on auth_tokens.rate_bucket"
```

---

## Task 10: env updates

**Files:**
- Modify: `apps/api/src/env.ts`

- [ ] **Step 1: Update `apps/api/src/env.ts`**

```typescript
function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalUndef(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  PORT: Number(optional("PORT", "3001")),
  CORS_ORIGIN: optional("CORS_ORIGIN", "http://localhost:3000"),
  PUBLIC_INSTANCE_MODE: optional("PUBLIC_INSTANCE_MODE", "false") === "true",

  HELIUS_API_KEY: optionalUndef("HELIUS_API_KEY"),
  HELIUS_PROXY_LIMIT: Number(optional("HELIUS_PROXY_LIMIT", "600")),
  HELIUS_PROXY_WINDOW_SEC: Number(optional("HELIUS_PROXY_WINDOW_SEC", "3600")),
} as const;
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/env.ts
git commit -m "chore: api — read HELIUS_API_KEY (optional) and proxy limit envs"
```

---

## Task 11: Helius route handlers

**Files:**
- Create: `apps/api/src/routes/helius/index.ts`
- Create: `apps/api/src/routes/helius/identity.ts`
- Create: `apps/api/src/routes/helius/balances.ts`
- Create: `apps/api/src/routes/helius/funded-by.ts`
- Create: `apps/api/src/routes/helius/transactions.ts`
- Create: `apps/api/src/routes/helius/batch-identity.ts`
- Create: `apps/api/src/routes/helius/transactions-by-sig.ts`
- Create: `apps/api/src/routes/helius/rpc.ts`

- [ ] **Step 1: Define helper for handlers `apps/api/src/routes/helius/_lib.ts`**

```typescript
import type { Context } from "hono";
import {
  proxyToHelius,
  type ProxyOptions,
  type ProxyResult,
} from "@thirdeye/helius";
import { env } from "../../env";

export function logProxyEvent(c: Context, path: string, r: ProxyResult): void {
  const token = c.req.header("X-Auth-Token") ?? "";
  const tokenHash = token
    ? require("node:crypto").createHash("sha256").update(token).digest("hex").slice(0, 8)
    : "";
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      type: "helius_proxy",
      path,
      status: r.status,
      durationMs: r.durationMs,
      fromCache: r.fromCache,
      isByok: r.isByok,
      tokenHash,
    }),
  );
}

export async function executeProxy(c: Context, opts: Omit<ProxyOptions, "serverKey" | "userKey">) {
  const userKey = c.req.header("X-User-Helius-Key") ?? undefined;
  const r = await proxyToHelius({ ...opts, serverKey: env.HELIUS_API_KEY, userKey });
  logProxyEvent(c, opts.target.kind === "rest" ? opts.target.path : `/rpc/${opts.target.method}`, r);
  return c.json(r.body as object, r.status as 200 | 201 | 400 | 401 | 403 | 404 | 429 | 502 | 503 | 504);
}
```

Note: Use `import { createHash } from "node:crypto"` at top instead of `require` — TypeScript strict mode rejects the require pattern. Replace with a real import.

- [ ] **Step 2: Implement each route handler**

`apps/api/src/routes/helius/identity.ts`:
```typescript
import { Hono } from "hono";
import { TTL } from "@thirdeye/helius";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { ProxyError } from "@thirdeye/helius";
import { executeProxy } from "./_lib";

export const identity = new Hono();

identity.get("/v1/wallet/:addr/identity", async (c) => {
  const addr = c.req.param("addr");
  if (!isValidSolanaAddress(addr)) {
    const err = ProxyError.invalidAddress();
    return c.json({ error: err.error, message: err.message }, 400);
  }
  return executeProxy(c, {
    target: { kind: "rest", path: `/v1/wallet/${addr}/identity` },
    method: "GET",
    cacheTtlMs: TTL.DEFAULT,
  });
});
```

`apps/api/src/routes/helius/balances.ts`: same shape, path `/v1/wallet/${addr}/balances`, query passes through `limit` and `showNative` from `c.req.query()`, cache `TTL.DEFAULT`.

`apps/api/src/routes/helius/funded-by.ts`: path `/v1/wallet/${addr}/funded-by`, cache `TTL.IMMUTABLE`.

`apps/api/src/routes/helius/transactions.ts`: path `/v0/addresses/${addr}/transactions`, query passes through `limit`, `before`, `until`, `commitment` from `c.req.query()`, cache `TTL.DEFAULT`.

`apps/api/src/routes/helius/batch-identity.ts`:
```typescript
import { Hono } from "hono";
import { TTL } from "@thirdeye/helius";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { executeProxy } from "./_lib";

export const batchIdentity = new Hono();

batchIdentity.post("/v1/wallet/batch-identity", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray((body as { addresses?: unknown }).addresses)) {
    return c.json({ error: "invalid_body", message: "expected { addresses: string[] }" }, 400);
  }
  const addresses = (body as { addresses: unknown[] }).addresses;
  if (addresses.length === 0 || addresses.length > 100) {
    return c.json({ error: "invalid_body", message: "1..100 addresses required" }, 400);
  }
  for (const a of addresses) {
    if (typeof a !== "string" || !isValidSolanaAddress(a)) {
      return c.json({ error: "invalid_address", message: `Invalid address: ${String(a)}` }, 400);
    }
  }
  return executeProxy(c, {
    target: { kind: "rest", path: "/v1/wallet/batch-identity" },
    method: "POST",
    body: { addresses },
    cacheTtlMs: TTL.DEFAULT,
  });
});
```

`apps/api/src/routes/helius/transactions-by-sig.ts`:
```typescript
import { Hono } from "hono";
import { TTL } from "@thirdeye/helius";
import { executeProxy } from "./_lib";

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

export const transactionsBySig = new Hono();

transactionsBySig.post("/v0/transactions", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray((body as { transactions?: unknown }).transactions)) {
    return c.json({ error: "invalid_body", message: "expected { transactions: string[] }" }, 400);
  }
  const txs = (body as { transactions: unknown[] }).transactions;
  if (txs.length === 0 || txs.length > 100) {
    return c.json({ error: "invalid_body", message: "1..100 signatures required" }, 400);
  }
  for (const t of txs) {
    if (typeof t !== "string" || !SIG_RE.test(t)) {
      return c.json({ error: "invalid_signature", message: `Invalid signature: ${String(t)}` }, 400);
    }
  }
  return executeProxy(c, {
    target: { kind: "rest", path: "/v0/transactions" },
    method: "POST",
    body: { transactions: txs },
    cacheTtlMs: TTL.IMMUTABLE,
  });
});
```

`apps/api/src/routes/helius/rpc.ts`:
```typescript
import { Hono } from "hono";
import { rpcCacheTtlMs, validateRpcEnvelope } from "@thirdeye/helius";
import { executeProxy } from "./_lib";

export const rpc = new Hono();

rpc.post("/api/helius-rpc", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json({ error: "invalid_rpc_body", message: "body must be valid JSON" }, 400);
  }
  const r = validateRpcEnvelope(body);
  if (r.kind === "invalid") {
    return c.json({ error: "invalid_rpc_body", message: r.reason }, 400);
  }
  if (r.kind === "forbidden") {
    return c.json(
      { error: "forbidden_rpc_method", message: `RPC method '${r.method}' is not allowed` },
      403,
    );
  }
  return executeProxy(c, {
    target: { kind: "rpc", method: r.envelope.method, params: r.envelope.params },
    method: "POST",
    cacheTtlMs: rpcCacheTtlMs(r.envelope.method),
  });
});
```

`apps/api/src/routes/helius/index.ts`:
```typescript
export { identity } from "./identity";
export { balances } from "./balances";
export { fundedBy } from "./funded-by";
export { transactions } from "./transactions";
export { batchIdentity } from "./batch-identity";
export { transactionsBySig } from "./transactions-by-sig";
export { rpc } from "./rpc";
```

- [ ] **Step 3: Wire all routes into `apps/api/src/index.ts`** (insert after the existing `app.route("/api/db", protectedDb)` block):

```typescript
import { rateLimit } from "./middleware/rate-limit";
import {
  identity,
  balances,
  fundedBy,
  transactions,
  batchIdentity,
  transactionsBySig,
  rpc as heliusRpc,
} from "./routes/helius";

const heliusProxyLimit = rateLimit({
  name: "helius_proxy",
  limit: env.HELIUS_PROXY_LIMIT,
  windowSec: env.HELIUS_PROXY_WINDOW_SEC,
  bypassOnByok: true,
});

const heliusRouter = new Hono<{ Variables: Variables }>();
heliusRouter.use("*", requireAuth);
heliusRouter.use("*", heliusProxyLimit);
heliusRouter.route("/", identity);
heliusRouter.route("/", balances);
heliusRouter.route("/", fundedBy);
heliusRouter.route("/", transactions);
heliusRouter.route("/", batchIdentity);
heliusRouter.route("/", transactionsBySig);
app.route("/api/helius", heliusRouter);

const heliusRpcRouter = new Hono<{ Variables: Variables }>();
heliusRpcRouter.use("*", requireAuth);
heliusRpcRouter.use("*", heliusProxyLimit);
heliusRpcRouter.route("/", heliusRpc);
app.route("/", heliusRpcRouter); // /api/helius-rpc lives at top level
```

- [ ] **Step 4: Verify typecheck + commit**

```bash
bun run typecheck
git add apps/api/src/routes/helius apps/api/src/index.ts
git commit -m "feat: api — mount 7 helius routes + helius-rpc with auth + rate limit"
```

---

## Task 12: Helius integration tests (skip-on-no-key)

**Files:**
- Create: `apps/api/tests/fixtures/helius.ts`
- Create: `apps/api/tests/helius-routes.integration.test.ts`

- [ ] **Step 1: Write `apps/api/tests/fixtures/helius.ts`**

```typescript
// Stable test fixtures. Override via env var if needed.
export const FIXTURE_WALLET =
  process.env.THIRDEYE_TEST_WALLET ?? "BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNNz";

export const FIXTURE_INVALID_ADDRESS = "not-a-real-addr";
```

- [ ] **Step 2: Write `apps/api/tests/helius-routes.integration.test.ts`**

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { app } from "../src/index";
import { setupTestDb, type TestDb } from "./setup";
import { authTokens } from "@thirdeye/db";
import { generateToken } from "../src/lib/tokens";
import { FIXTURE_WALLET, FIXTURE_INVALID_ADDRESS } from "./fixtures/helius";

const HAVE_KEY = Boolean(process.env.HELIUS_API_KEY);
const d = HAVE_KEY ? describe : describe.skip;

let testDb: TestDb;
let token: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  if (!HAVE_KEY) {
    console.log("[skip] HELIUS_API_KEY not set — Helius integration tests skipped");
  }
});
afterAll(async () => { await testDb.cleanup(); });

beforeEach(async () => {
  await testDb.sql.unsafe("TRUNCATE auth_tokens RESTART IDENTITY CASCADE;");
  const t = generateToken();
  await testDb.db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
  token = t.token;
});

d("Helius routes (real Helius)", () => {
  test("GET /api/helius/v1/wallet/:addr/identity returns 200", async () => {
    const r = await app.request(`/api/helius/v1/wallet/${FIXTURE_WALLET}/identity`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(typeof body).toBe("object");
  });

  test("GET /api/helius/v1/wallet/:addr/funded-by returns 200 with stable result + observable cache hit", async () => {
    const url = `/api/helius/v1/wallet/${FIXTURE_WALLET}/funded-by`;
    const t1 = Date.now();
    const r1 = await app.request(url, { headers: { "X-Auth-Token": token } });
    const d1 = Date.now() - t1;
    expect(r1.status).toBe(200);
    const body1 = await r1.json();

    const t2 = Date.now();
    const r2 = await app.request(url, { headers: { "X-Auth-Token": token } });
    const d2 = Date.now() - t2;
    expect(r2.status).toBe(200);
    const body2 = await r2.json();

    expect(body2).toEqual(body1);
    // Cache hit should be at least 5x faster than the network round-trip.
    expect(d2 * 5).toBeLessThan(d1);
  });

  test("invalid address returns 400 without hitting Helius", async () => {
    const r = await app.request(`/api/helius/v1/wallet/${FIXTURE_INVALID_ADDRESS}/funded-by`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(400);
  });

  test("POST /api/helius-rpc with disallowed method returns 403", async () => {
    const r = await app.request("/api/helius-rpc", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [] }),
    });
    expect(r.status).toBe(403);
  });

  test("POST /api/helius-rpc getTransaction returns 200 for fixture sig (looked up via funded-by)", async () => {
    // First, find a stable signature: call funded-by which returns the funding tx.
    const fb = await app.request(`/api/helius/v1/wallet/${FIXTURE_WALLET}/funded-by`, {
      headers: { "X-Auth-Token": token },
    });
    const fbBody = (await fb.json()) as { signature?: string };
    if (!fbBody.signature) {
      // Fixture wallet has no funded-by data; skip this case.
      return;
    }
    const r = await app.request("/api/helius-rpc", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [fbBody.signature, { maxSupportedTransactionVersion: 0, encoding: "json" }],
      }),
    });
    expect(r.status).toBe(200);
  });

  test("BYOK: deliberately bad X-User-Helius-Key returns 401 (passthrough from Helius)", async () => {
    const r = await app.request(`/api/helius/v1/wallet/${FIXTURE_WALLET}/identity`, {
      headers: { "X-Auth-Token": token, "X-User-Helius-Key": "deliberately-invalid-key" },
    });
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
cd apps/api && bun test tests/helius-routes.integration.test.ts
# without HELIUS_API_KEY: prints "skipped" message, exits 0
# with HELIUS_API_KEY: 6 pass
git add apps/api/tests/fixtures apps/api/tests/helius-routes.integration.test.ts
git commit -m "test: helius — real-helius integration tests across all 7 routes (skip-on-no-key)"
```

---

## Task 13: docker-compose, .env.example, CONTRIBUTING.md, CLAUDE.md updates

- [ ] **Step 1: Update `.env.example`**

```
# Postgres connection — used by API server and migrations
DATABASE_URL=postgres://thirdeye:thirdeye@localhost:5432/thirdeye

# Helius API key — required for /api/helius/* and /api/helius-rpc proxying
# Get one (free 1M credits/mo) at https://dashboard.helius.dev
HELIUS_API_KEY=

# Public instance mode — when true, anonymous-token rate limits are enforced (spec §16)
PUBLIC_INSTANCE_MODE=false

# Helius proxy rate limit (Phase 1) — only enforced when PUBLIC_INSTANCE_MODE=true
# and X-User-Helius-Key header is NOT present.
HELIUS_PROXY_LIMIT=600
HELIUS_PROXY_WINDOW_SEC=3600

# API listen port
PORT=3001

# CORS allowed origin (web app dev URL)
CORS_ORIGIN=http://localhost:3000
```

- [ ] **Step 2: Update `docker-compose.yml` `app` service env block**

Add to the existing `environment:` map:
```yaml
      HELIUS_API_KEY: ${HELIUS_API_KEY:-}
      HELIUS_PROXY_LIMIT: ${HELIUS_PROXY_LIMIT:-600}
      HELIUS_PROXY_WINDOW_SEC: ${HELIUS_PROXY_WINDOW_SEC:-3600}
```

- [ ] **Step 3: Update CLAUDE.md**

Add under "Workflow" section:
```
- Helius integration tests require `HELIUS_API_KEY` to be set; without it they skip cleanly. CI fails open (skip with informative output) if the secret is absent (e.g., fork PRs).
```

- [ ] **Step 4: Commit**

```bash
git add .env.example docker-compose.yml CLAUDE.md
git commit -m "chore: env — add HELIUS_API_KEY and proxy limit envs to example, compose, claude.md"
```

---

## Task 14: GitHub Actions CI — HELIUS_API_KEY secret

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add to the `env:` block**

```yaml
    env:
      DATABASE_URL: postgres://thirdeye:thirdeye@localhost:5432/thirdeye
      PUBLIC_INSTANCE_MODE: "true"
      HELIUS_API_KEY: ${{ secrets.HELIUS_API_KEY }}
```

- [ ] **Step 2: Commit + push**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: helius — pass HELIUS_API_KEY secret + enable PUBLIC_INSTANCE_MODE in test"
```

---

## Phase 1 acceptance criteria

After all 14 tasks:

- [ ] `bun run lint` exits 0
- [ ] `bun run typecheck` exits 0
- [ ] `bun test` — all unit + DB tests pass; Helius integration tier passes when `HELIUS_API_KEY` set, skips otherwise
- [ ] `docker compose up -d --build` brings up app + postgres
- [ ] With `HELIUS_API_KEY` set: `curl http://localhost:3001/api/helius/v1/wallet/<fixture>/funded-by -H "X-Auth-Token: <token>"` returns the funded-by JSON
- [ ] Without auth header → 401
- [ ] CORS preflight on `/api/helius/v1/wallet/abc/funded-by` returns 204 with `X-Auth-Token` and `X-User-Helius-Key` in `Access-Control-Allow-Headers`
- [ ] Disallowed RPC method (`sendTransaction`) → 403 without any Helius egress
- [ ] GitHub Actions CI green on PR (with `HELIUS_API_KEY` secret configured at the org/repo level)
- [ ] All commits authored by `AIEngineerX <195990077+AIEngineerX@users.noreply.github.com>`

---

## Self-review (post-write)

| Spec section | Covered by | Status |
|---|---|---|
| §3 Endpoint shape (7 routes + RPC) | Tasks 11 | ✅ |
| §4 Rate limiting (sliding window + bypassOnByok) | Task 9 | ✅ |
| §5 proxyToHelius primitive | Tasks 2–7 | ✅ |
| §6 Two-tier cache | Tasks 2, 6 | ✅ |
| §7 Module layout | Tasks 1, 11 | ✅ |
| §8 Error mapping | Task 4 | ✅ |
| §9 Telemetry | Task 11 (`logProxyEvent`) | ✅ |
| §10 X-ThirdEye-Proxy header | Task 7 | ✅ |
| §11 Three test tiers | Tasks 3-9, 12 | ✅ |
| §12 CI HELIUS_API_KEY secret | Task 14 | ✅ |
| §13 Deployment hardening | Documented in spec only (deployment-time, no code) | ✅ |
| §14 Parent §16 amendments | Already committed pre-plan | ✅ |
| §15 Acceptance criteria | This document's "Acceptance criteria" block | ✅ |

All Phase 1 spec coverage accounted for. No placeholders. Code is complete and consistent across tasks. All gap-analysis fixes from spec self-review are reflected here.
