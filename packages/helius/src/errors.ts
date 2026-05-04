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
    message:
      "No Helius API key configured (server env var or X-User-Helius-Key header)",
  }),
  invalidAddress: (): ProxyErrorPayload => ({
    status: 400,
    error: "invalid_address",
    message: "Address is not valid base58 or wrong length",
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
    retryAfterSec: number,
  ): ProxyErrorPayload & { retryAfterSec: number } => ({
    status: 429,
    error: "rate_limited",
    message: "Rate limit exceeded for this session token",
    retryAfterSec,
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
