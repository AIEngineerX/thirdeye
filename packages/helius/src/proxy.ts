import { type CachedResponse, composeCacheKey, getCache } from "./cache";
import { ProxyError, type ProxyErrorPayload, mapUpstreamStatus } from "./errors";
import { composeRestUrl, composeRpcUrl } from "./urls";

export type ProxyTarget =
  | { kind: "rest"; path: string; query?: Record<string, string> | undefined }
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

function errorResult(
  err: ProxyErrorPayload,
  isByok: boolean,
  start: number,
  upstreamBody?: unknown,
): ProxyResult {
  return {
    status: err.status,
    body: {
      error: err.error,
      message: err.message,
      ...(err.upstreamStatus !== undefined && { upstreamStatus: err.upstreamStatus }),
      ...(upstreamBody !== undefined && { upstreamBody }),
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    const init: RequestInit = {
      method: target.kind === "rpc" ? "POST" : opts.method,
      headers,
      signal: controller.signal,
    };
    if (fetchBody !== null) init.body = fetchBody;
    res = await fetch(url, init);
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      return errorResult(ProxyError.timeout(), isByok, start);
    }
    const detail = err instanceof Error ? err.message : String(err);
    return errorResult(ProxyError.upstreamUnreachable(detail), isByok, start);
  }
  clearTimeout(timer);

  const text = await res.text();
  let body: unknown;
  if (text.length === 0) {
    body = null;
  } else {
    try {
      body = JSON.parse(text);
    } catch {
      return errorResult(ProxyError.upstreamMalformed(res.status), isByok, start, text);
    }
  }

  const upstreamErr = mapUpstreamStatus(res.status);
  if (upstreamErr) return errorResult(upstreamErr, isByok, start, body);

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
