/**
 * Authenticated fetch wrapper. Threads the session token and (optional) BYOK
 * keys into headers on every request. On 401 the cached token is invalidated
 * and the request is retried exactly once — covers the case where the
 * server-side `auth_tokens` row expired or was revoked while sessionStorage
 * still held a stale token.
 */

import type { CandidateRow, DashboardBundle } from "./api-types";
import { type AuthClient, getAuthClient } from "./auth";
import { type ByokStore, getByokStore } from "./byok";
import type { OhlcvCandle, TokenMarkers } from "./ohlcv-types";

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

/** Fetch candidate wallets from `GET /api/db/candidates`. */
export async function listCandidates(
  opts: { limit?: number; includePromoted?: boolean; source?: string } = {},
  client?: ApiClient,
): Promise<CandidateRow[]> {
  const c = client ?? getApiClient();
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.includePromoted !== undefined)
    params.set("includePromoted", String(opts.includePromoted));
  if (opts.source !== undefined) params.set("source", opts.source);
  const qs = params.toString();
  const res = await c.fetch(`/api/db/candidates${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`candidates ${res.status}`);
  return ((await res.json()) as { items: CandidateRow[] }).items;
}

/** Promote a candidate wallet via `POST /api/db/candidates/:address/promote`. */
export async function promoteCandidate(address: string, client?: ApiClient): Promise<void> {
  const c = client ?? getApiClient();
  const res = await c.fetch(`/api/db/candidates/${address}/promote`, { method: "POST" });
  if (!res.ok) throw new Error(`promote ${res.status}`);
}

/** Fetch OHLCV candles from `GET /api/db/tokens/:mint/ohlcv?type=`. */
export async function getOhlcv(
  mint: string,
  type = "1h",
  client?: ApiClient,
): Promise<OhlcvCandle[]> {
  const c = client ?? getApiClient();
  const res = await c.fetch(`/api/db/tokens/${mint}/ohlcv?type=${type}`);
  if (!res.ok) throw new Error(`ohlcv ${res.status}`);
  return ((await res.json()) as { candles: OhlcvCandle[] }).candles;
}

/** Fetch chart markers from `GET /api/db/tokens/:mint/markers`. */
export async function getTokenMarkers(mint: string, client?: ApiClient): Promise<TokenMarkers> {
  const c = client ?? getApiClient();
  const res = await c.fetch(`/api/db/tokens/${mint}/markers`);
  if (!res.ok) throw new Error(`markers ${res.status}`);
  return (await res.json()) as TokenMarkers;
}
