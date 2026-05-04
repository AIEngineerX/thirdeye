export interface ProxyErrorPayload {
  status: number;
  error: string;
  message: string;
  upstreamStatus?: number;
}

export const ProxyError = {
  timeout: (): ProxyErrorPayload => ({
    status: 504,
    error: "upstream_timeout",
    message: "Helius did not respond within timeout",
  }),
  noKey: (): ProxyErrorPayload => ({
    status: 503,
    error: "no_helius_key",
    message: "No Helius API key configured (server env var or X-User-Helius-Key header)",
  }),
  invalidAddress: (): ProxyErrorPayload => ({
    status: 400,
    error: "invalid_address",
    message: "Address is not valid base58 or wrong length",
  }),
  invalidBody: (msg: string): ProxyErrorPayload => ({
    status: 400,
    error: "invalid_body",
    message: msg,
  }),
  invalidRpcBody: (msg: string): ProxyErrorPayload => ({
    status: 400,
    error: "invalid_rpc_body",
    message: msg,
  }),
  forbiddenRpcMethod: (method: string): ProxyErrorPayload => ({
    status: 403,
    error: "forbidden_rpc_method",
    message: `RPC method '${method}' is not allowed through this proxy`,
  }),
  rateLimited: (
    name: string,
    limit: number,
    windowSec: number,
    retryAfterSec: number,
  ): ProxyErrorPayload & { retryAfterSec: number; name: string } => ({
    status: 429,
    error: "rate_limited",
    message: `Limit ${limit}/${windowSec}s for ${name}`,
    retryAfterSec,
    name,
  }),
  upstreamMalformed: (upstreamStatus: number): ProxyErrorPayload => ({
    status: 502,
    error: "upstream_malformed",
    message: "Helius returned a non-JSON response",
    upstreamStatus,
  }),
};

export function mapUpstreamStatus(status: number): ProxyErrorPayload | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 500) {
    return {
      status: 502,
      error: "upstream_error",
      message: `Helius returned ${status}`,
      upstreamStatus: status,
    };
  }
  return {
    status,
    error: `upstream_${status}`,
    message: `Helius returned ${status}`,
    upstreamStatus: status,
  };
}
