function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalUndef(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  PORT: Number(optional("PORT", "3001")),
  CORS_ORIGIN: optional("CORS_ORIGIN", "http://localhost:3000"),
  PUBLIC_INSTANCE_MODE: optional("PUBLIC_INSTANCE_MODE", "false") === "true",

  HELIUS_API_KEY: optionalUndef("HELIUS_API_KEY"),
  HELIUS_PROXY_LIMIT: Number(optional("HELIUS_PROXY_LIMIT", "600")),
  HELIUS_PROXY_WINDOW_SEC: Number(optional("HELIUS_PROXY_WINDOW_SEC", "3600")),
  // Phase 5a: bumped wallet-check defaults (30 → 120 calls/hr, 24h → 4h cache)
  // and scan-token defaults (3 → 60 calls/hr, 1h → 5min cache). Cache unit
  // refactored hours → seconds so the new sub-hour defaults read cleanly.
  WALLET_CHECK_LIMIT: Number(optional("WALLET_CHECK_LIMIT", "120")),
  WALLET_CHECK_WINDOW_SEC: Number(optional("WALLET_CHECK_WINDOW_SEC", "3600")),
  WALLET_CHECK_CACHE_SEC: Number(optional("WALLET_CHECK_CACHE_SEC", "14400")),
  SCAN_TOKEN_LIMIT: Number(optional("SCAN_TOKEN_LIMIT", "60")),
  SCAN_TOKEN_WINDOW_SEC: Number(optional("SCAN_TOKEN_WINDOW_SEC", "3600")),
  SCAN_TOKEN_CACHE_SEC: Number(optional("SCAN_TOKEN_CACHE_SEC", "300")),
  // Phase 5d: realized SOL PnL threshold for SMART_MONEY tag. Tune to
  // your market — 50 SOL realized over 30d is a defensible default but
  // varies wildly by wallet population (memecoin vs blue-chip swappers).
  SMART_MONEY_MIN_SOL: Number(optional("SMART_MONEY_MIN_SOL", "50")),
} as const;

// Phase 5e: webhook subscription secrets. Read fresh from process.env on
// each access so they can be hot-rotated without restart (per design doc
// §5e "Stay manual" — operator changes the env, no redeploy needed) and
// so test setups can mutate the secret in beforeAll/beforeEach. Undefined
// by design until set; watch routes return 503 until both are present.
export function publicBaseUrl(): string | undefined {
  const v = process.env.PUBLIC_BASE_URL;
  return v && v.length > 0 ? v : undefined;
}

export function heliusWebhookAuth(): string | undefined {
  const v = process.env.HELIUS_WEBHOOK_AUTH;
  return v && v.length > 0 ? v : undefined;
}
