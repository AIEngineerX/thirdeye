export const TTL = {
  IMMUTABLE: 24 * 60 * 60 * 1000,
  DEFAULT: 5 * 60 * 1000,
  NO_CACHE: 0,
} as const;

export const RPC_IMMUTABLE_METHODS: ReadonlySet<string> = new Set([
  "getTransaction",
  "getBlock",
  "getBlockTime",
  "getSignatureStatuses",
]);

export function rpcCacheTtlMs(method: string): number {
  return RPC_IMMUTABLE_METHODS.has(method) ? TTL.IMMUTABLE : TTL.DEFAULT;
}
