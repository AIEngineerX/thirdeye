import { type CachedResponse, cache, composeCacheKey } from "./cache";
import { ProxyError, type ProxyErrorPayload, mapUpstreamStatus } from "./errors";
import { composeRestUrl, composeRpcUrl } from "./urls";

export type RpcParams = unknown[] | Record<string, unknown>;

export type ProxyTarget =
  | { kind: "rest"; path: string; query?: Record<string, string> | undefined }
  | { kind: "rpc"; method: string; params: RpcParams };

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
const RETRY_429_DEFAULT_MS = 1000;
const RETRY_429_MAX_MS = 5000;
// Two retries on 429 instead of one. Free-tier Helius and bursty
// concurrent-scan workloads (per-scan semaphore = 10) blow through a
// single retry's budget; the extra attempt with 2x backoff catches the
// common case of a rolling-window cooldown that needs >5s to clear.
const RETRY_429_MAX_ATTEMPTS = 2;

export function parseRetryAfterMs(headerVal: string | null): number {
  if (headerVal === null) return RETRY_429_DEFAULT_MS;
  // Retry-After can be either delta-seconds (RFC 7231) or HTTP-date.
  const asInt = Number.parseInt(headerVal, 10);
  if (!Number.isNaN(asInt) && asInt > 0) {
    return Math.min(asInt * 1000, RETRY_429_MAX_MS);
  }
  const asDate = Date.parse(headerVal);
  if (!Number.isNaN(asDate)) {
    return Math.min(Math.max(0, asDate - Date.now()), RETRY_429_MAX_MS);
  }
  return RETRY_429_DEFAULT_MS;
}

function errorResult(
  err: ProxyErrorPayload,
  isByok: boolean,
  start: number,
  upstreamBody?: unknown,
): ProxyResult {
  // L5 (audit): the Helius upstream body can mirror request URL fragments
  // (including ?api-key=...). Log it server-side for diagnostics, do NOT
  // include it in the response payload that leaves the proxy module
  // boundary. No external caller consumes this field today; removing it
  // closes a defense-in-depth gap before future log/forward paths exist.
  if (upstreamBody !== undefined) {
    const preview =
      typeof upstreamBody === "string"
        ? upstreamBody.slice(0, 500)
        : JSON.stringify(upstreamBody).slice(0, 500);
    console.warn(`[helius-proxy] upstream error ${err.status}: ${preview}`);
  }
  return {
    status: err.status,
    body: {
      error: err.error,
      message: err.message,
      ...(err.upstreamStatus !== undefined && { upstreamStatus: err.upstreamStatus }),
    },
    fromCache: false,
    durationMs: Date.now() - start,
    isByok,
    error: err,
  };
}

export async function proxyToHelius(opts: ProxyOptions): Promise<ProxyResult> {
  const start = Date.now();
  const isByok = Boolean(opts.userKey);
  const apiKey = opts.userKey ?? opts.serverKey;
  if (!apiKey) return errorResult(ProxyError.noKey(), isByok, start);

  const { target } = opts;
  const cacheKey =
    target.kind === "rpc"
      ? composeCacheKey({
          method: "POST",
          path: `/rpc/${target.method}`,
          body: { params: target.params },
        })
      : composeCacheKey({
          method: opts.method,
          path: target.path,
          query: target.query,
          body: opts.body,
        });

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

  const url =
    target.kind === "rpc"
      ? composeRpcUrl(apiKey)
      : composeRestUrl({ path: target.path, apiKey, query: target.query });

  const fetchBody =
    target.kind === "rpc"
      ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: target.method, params: target.params })
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : null;

  const headers: Record<string, string> = { "X-ThirdEye-Proxy": "1" };
  if (fetchBody !== null) headers["Content-Type"] = "application/json";

  const init: RequestInit = {
    method: target.kind === "rpc" ? "POST" : opts.method,
    headers,
  };
  if (fetchBody !== null) init.body = fetchBody;

  // On 429, retry up to RETRY_429_MAX_ATTEMPTS more times. Each retry
  // honors Retry-After when present, otherwise applies an exponential
  // backoff (1s → 2s, capped). Helius's rolling-window quota typically
  // clears within seconds, but bursty parallel-scan workloads
  // (per-scan semaphore = 10) regularly need more than a single 5s
  // retry to clear.
  let attempt = await attemptFetch(url, init, opts.timeoutMs);
  for (let i = 0; i < RETRY_429_MAX_ATTEMPTS; i++) {
    if (attempt.kind !== "result" || attempt.res.status !== 429) break;
    const headerWait = parseRetryAfterMs(attempt.res.headers.get("retry-after"));
    const expBackoff = Math.min(RETRY_429_DEFAULT_MS * 2 ** i, RETRY_429_MAX_MS);
    const waitMs = Math.max(headerWait, expBackoff);
    await new Promise((r) => setTimeout(r, waitMs));
    attempt = await attemptFetch(url, init, opts.timeoutMs);
  }

  if (attempt.kind === "timeout") return errorResult(ProxyError.timeout(), isByok, start);
  if (attempt.kind === "unreachable")
    return errorResult(ProxyError.upstreamUnreachable(attempt.detail), isByok, start);

  const { res } = attempt;
  const text = await res.text();
  let body: unknown = null;
  let parseFailed = false;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }

  // Status check first: a non-2xx with an HTML body (e.g. Cloudflare 429 page)
  // should report the actual upstream status, not get masked as upstream_malformed.
  const upstreamErr = mapUpstreamStatus(res.status);
  if (upstreamErr) {
    return errorResult(upstreamErr, isByok, start, parseFailed ? text : body);
  }
  if (parseFailed) {
    return errorResult(ProxyError.upstreamMalformed(res.status), isByok, start, text);
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

type FetchAttempt =
  | { kind: "result"; res: Response }
  | { kind: "timeout" }
  | { kind: "unreachable"; detail: string };

async function attemptFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
): Promise<FetchAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { kind: "result", res };
  } catch (err) {
    if (controller.signal.aborted) return { kind: "timeout" };
    return { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
