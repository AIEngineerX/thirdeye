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

export function logProxyEvent(c: Context, pathLabel: string, r: ProxyResult): void {
  const auth = c.req.header("X-Auth-Token");
  const tokenHash = auth ? createHash("sha256").update(auth).digest("hex").slice(0, 8) : "";
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
      tokenHash,
    }),
  );
}

export function respondError(c: Context, err: ProxyErrorPayload): Response {
  const { status, ...body } = err;
  return c.json(body, status as ContentfulStatusCode);
}

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
