export const RPC_DENY_LIST: ReadonlySet<string> = new Set([
  "sendTransaction",
  "simulateTransaction",
  "requestAirdrop",
]);

export type RpcEnvelope = {
  jsonrpc: string;
  id: unknown;
  method: string;
  params: unknown[];
};

export type RpcEnvelopeResult =
  | { kind: "ok"; method: string; envelope: RpcEnvelope }
  | { kind: "invalid"; reason: string }
  | { kind: "forbidden"; method: string };

export function validateRpcEnvelope(input: unknown): RpcEnvelopeResult {
  if (typeof input !== "object" || input === null) {
    return { kind: "invalid", reason: "body must be a JSON object" };
  }
  const e = input as Record<string, unknown>;
  if (e.jsonrpc !== "2.0") {
    return { kind: "invalid", reason: "jsonrpc must be '2.0'" };
  }
  if (typeof e.method !== "string" || e.method.length === 0) {
    return { kind: "invalid", reason: "method must be a non-empty string" };
  }
  if (!Array.isArray(e.params)) {
    return { kind: "invalid", reason: "params must be an array" };
  }
  if (RPC_DENY_LIST.has(e.method)) {
    return { kind: "forbidden", method: e.method };
  }
  return {
    kind: "ok",
    method: e.method,
    envelope: {
      jsonrpc: e.jsonrpc,
      id: e.id,
      method: e.method,
      params: e.params,
    },
  };
}
