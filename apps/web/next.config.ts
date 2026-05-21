import type { NextConfig } from "next";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

// /api/* requests from the browser are rewritten to the bun api so the
// browser sees same-origin and no CORS preflight fires in dev. Streaming
// responses (SSE) pass through unbuffered — Next preserves text/event-stream.
//
// If you set NEXT_PUBLIC_API_BASE_URL to a non-localhost value (e.g. staging),
// update CORS_ORIGIN on the api side to include the corresponding browser
// origin — otherwise the rewrite still works but direct fallback calls to
// the api will fail CORS preflight.
const config: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiBaseUrl}/api/:path*` },
      { source: "/health", destination: `${apiBaseUrl}/health` },
    ];
  },
};

export default config;
