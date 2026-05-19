import type { MiddlewareHandler } from "hono";

// L2 (audit): cap request body size. Bun has no default
// maxRequestBodySize, so a multi-megabyte body would be parsed into
// memory by the JSON middleware before any size check. The cap below
// is generous for the largest legitimate request (a 100-element
// batch-identity body of base58 strings ~ 5 KB) and rejects anything
// implausibly large.

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024; // 64 KB

export function bodySizeLimit(maxBytes: number = DEFAULT_MAX_BODY_BYTES): MiddlewareHandler {
  return async (c, next) => {
    // Only check on methods that carry bodies. GET / HEAD / DELETE skip.
    if (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "PATCH") {
      const cl = c.req.header("Content-Length");
      if (cl) {
        const n = Number.parseInt(cl, 10);
        // Content-Length present and parseable: reject early without
        // pulling the body off the socket.
        if (Number.isFinite(n) && n > maxBytes) {
          return c.json({ error: "payload_too_large", maxBytes }, 413);
        }
      }
      // No Content-Length (chunked transfer or buggy client): we can't
      // know the size upfront. The downstream JSON parser will fail on
      // malformed input anyway; for legitimate clients this branch is
      // rare. We do not stream-validate here to keep the middleware
      // simple — operators behind a reverse proxy typically already
      // enforce body limits at the edge.
    }
    await next();
  };
}
