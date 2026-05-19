import type { Context } from "hono";

// Extract the client IP. In PUBLIC_INSTANCE_MODE the operator MUST run
// behind a reverse proxy (Railway, Caddy, nginx, Cloudflare, etc.) that
// (a) sets X-Forwarded-For with the client IP and
// (b) strips any client-supplied X-Forwarded-For from the request.
// Without (b), an attacker can forge their source IP and defeat the
// per-IP rate limit. We document this in CONTRIBUTING.md but cannot
// enforce it from inside the app.
//
// In non-PUBLIC mode we use a connection-level identifier when available
// and fall back to "local". Non-PUBLIC mode doesn't gate on IP, so the
// fallback is only consulted as a cache key, not for trust decisions.
export function getClientIp(c: Context, publicMode: boolean): string {
  if (publicMode) {
    const xff = c.req.header("X-Forwarded-For");
    if (xff) {
      // Standard convention: leftmost is the original client.
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
    // No X-Forwarded-For under PUBLIC mode is itself anomalous — the
    // reverse proxy should always set it. Group these into one bucket
    // ("unknown") so a misconfigured deploy is detectable as a single
    // hot key rather than going uncounted.
    return "unknown";
  }
  return "local";
}
