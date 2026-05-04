import { createHash } from "node:crypto";
import { type ProxyOptions, type ProxyResult, proxyToHelius } from "@thirdeye/helius";
import type { Context } from "hono";
import { env } from "../../env";

export function logProxyEvent(c: Context, pathLabel: string, r: ProxyResult): void {
  const token = c.req.header("X-Auth-Token") ?? "";
  const tokenHash = token ? createHash("sha256").update(token).digest("hex").slice(0, 8) : "";
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

type ContentfulStatus = 200 | 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503 | 504;

export async function executeProxy(
  c: Context,
  opts: Omit<ProxyOptions, "serverKey" | "userKey">,
): Promise<Response> {
  const userKey = c.req.header("X-User-Helius-Key");
  const proxyOpts: ProxyOptions = {
    ...opts,
    serverKey: env.HELIUS_API_KEY,
    ...(userKey !== undefined && { userKey }),
  };
  const r = await proxyToHelius(proxyOpts);
  const pathLabel = opts.target.kind === "rest" ? opts.target.path : `/rpc/${opts.target.method}`;
  logProxyEvent(c, pathLabel, r);
  c.header("X-ThirdEye-Cache", r.fromCache ? "HIT" : "MISS");
  c.header("X-ThirdEye-Proxy-Duration-Ms", String(r.durationMs));
  return c.json(r.body as object, r.status as ContentfulStatus);
}
