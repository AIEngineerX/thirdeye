import { type CachedResponse, composeCacheKey, getCache } from "./cache";
import { ProxyError, type ProxyErrorPayload, mapUpstreamStatus } from "./errors";
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

  const cacheKey =
    opts.target.kind === "rest"
      ? composeCacheKey({
          method: opts.method,
          path: opts.target.path,
          ...(opts.target.query !== undefined && { query: opts.target.query }),
          ...(opts.body !== undefined && { body: opts.body }),
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

  const url =
    opts.target.kind === "rest"
      ? composeRestUrl({
          path: opts.target.path,
          apiKey,
          ...(opts.target.query !== undefined && { query: opts.target.query }),
        })
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
    const init: RequestInit = {
      method: opts.target.kind === "rpc" ? "POST" : opts.method,
      headers,
      signal: controller.signal,
    };
    if (fetchBody !== null) init.body = fetchBody;
    res = await fetch(url, init);
  } catch {
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
