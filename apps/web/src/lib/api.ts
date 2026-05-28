/**
 * Authenticated fetch wrapper. Threads the session token and (optional) BYOK
 * keys into headers on every request. On 401 the cached token is invalidated
 * and the request is retried exactly once — covers the case where the
 * server-side `auth_tokens` row expired or was revoked while sessionStorage
 * still held a stale token.
 */

import type { DashboardBundle } from "./api-types";
import { type AuthClient, getAuthClient } from "./auth";
import { type ByokStore, getByokStore } from "./byok";

export interface ApiClient {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Mount-time bootstrap — confirms session token exists before first request. */
  bootstrap(): Promise<void>;
}

export interface ApiDeps {
  auth: AuthClient;
  byok: ByokStore;
  fetchImpl: typeof globalThis.fetch;
}

function buildHeaders(
  base: HeadersInit | undefined,
  token: string,
  helius: string | null,
  anthropic: string | null,
): Headers {
  const h = new Headers(base);
  h.set("X-Auth-Token", token);
  if (helius) h.set("X-User-Helius-Key", helius);
  if (anthropic) h.set("X-User-Anthropic-Key", anthropic);
  return h;
}

export function createApiClient(deps: ApiDeps): ApiClient {
  return {
    async bootstrap() {
      await deps.auth.getOrIssueToken();
    },
    async fetch(path, init = {}) {
      const token = await deps.auth.getOrIssueToken();
      const snap = deps.byok.snapshot();
      const headers = buildHeaders(init.headers, token, snap.helius, snap.anthropic);
      const first = await deps.fetchImpl(path, { ...init, headers });

      if (first.status !== 401) return first;

      // 401: token may have been revoked or expired on the server while we
      // held a fresh-looking copy in sessionStorage. Invalidate and try
      // exactly once with a brand-new token.
      deps.auth.invalidate();
      const newToken = await deps.auth.getOrIssueToken();
      const retryHeaders = buildHeaders(init.headers, newToken, snap.helius, snap.anthropic);
      return deps.fetchImpl(path, { ...init, headers: retryHeaders });
    },
  };
}

let cachedClient: ApiClient | null = null;

export function getApiClient(): ApiClient {
  if (cachedClient) return cachedClient;
  cachedClient = createApiClient({
    auth: getAuthClient(),
    byok: getByokStore(),
    fetchImpl:
      typeof globalThis.fetch !== "undefined"
        ? globalThis.fetch.bind(globalThis)
        : ((() => {
            throw new Error("global fetch is not available");
          }) as typeof globalThis.fetch),
  });
  return cachedClient;
}

/** Convenience wrapper for non-reactive callers. */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return getApiClient().fetch(path, init);
}

/** Fetch the dashboard bundle from `GET /api/db/dashboard`. */
export async function getDashboard(client?: ApiClient): Promise<DashboardBundle> {
  const c = client ?? getApiClient();
  const res = await c.fetch("/api/db/dashboard");
  if (!res.ok) throw new Error(`dashboard ${res.status}`);
  return (await res.json()) as DashboardBundle;
}
