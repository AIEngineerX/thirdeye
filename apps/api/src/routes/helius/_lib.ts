import { createHash } from "node:crypto";
import {
  type ProxyErrorPayload,
  type ProxyOptions,
  type ProxyResult,
  proxyToHelius,
} from "@thirdeye/helius";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { env } from "../../env";

function tokenHash(token: string | undefined): string {
  if (!token) return "";
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

export function logProxyEvent(c: Context, pathLabel: string, r: ProxyResult): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      type: "helius_proxy",
      path: pathLabel,
      method: c.req.method,
      status: r.status,
      durationMs: r.durationMs,
      fromCache: r.fromCache,
      isByok: r.isByok,
      tokenHash: tokenHash(c.req.header("X-Auth-Token")),
    }),
  );
}

/**
 * Serialize a ProxyErrorPayload as an HTTP response. Strips `status` from the
 * body (HTTP already carries it) but preserves any additional fields the
 * specific error helper attached (e.g., retryAfterSec, name, upstreamStatus).
 */
export function respondError(c: Context, err: ProxyErrorPayload): Response {
  const { status, ...body } = err;
  return c.json(body, status as ContentfulStatusCode);
}

/**
 * Extract whitelisted query params from the request. Returns undefined when
 * none are present so the proxy URL doesn't grow an empty `&` suffix.
 */
export function pickQuery(c: Context, keys: readonly string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = c.req.query(k);
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export async function executeProxy(
  c: Context,
  opts: Omit<ProxyOptions, "serverKey" | "userKey">,
): Promise<Response> {
  const userKey = c.req.header("X-User-Helius-Key");
  const r = await proxyToHelius({
    ...opts,
    serverKey: env.HELIUS_API_KEY,
    ...(userKey !== undefined && { userKey }),
  });
  const pathLabel = opts.target.kind === "rest" ? opts.target.path : `/rpc/${opts.target.method}`;
  logProxyEvent(c, pathLabel, r);
  c.header("X-ThirdEye-Cache", r.fromCache ? "HIT" : "MISS");
  c.header("X-ThirdEye-Proxy-Duration-Ms", String(r.durationMs));
  return c.json(r.body as object, r.status as ContentfulStatusCode);
}
