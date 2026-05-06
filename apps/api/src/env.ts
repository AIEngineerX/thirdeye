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
  WALLET_CHECK_LIMIT: Number(optional("WALLET_CHECK_LIMIT", "30")),
  WALLET_CHECK_WINDOW_SEC: Number(optional("WALLET_CHECK_WINDOW_SEC", "3600")),
  WALLET_CHECK_CACHE_HOURS: Number(optional("WALLET_CHECK_CACHE_HOURS", "24")),
  SCAN_TOKEN_LIMIT: Number(optional("SCAN_TOKEN_LIMIT", "3")),
  SCAN_TOKEN_WINDOW_SEC: Number(optional("SCAN_TOKEN_WINDOW_SEC", "3600")),
  SCAN_TOKEN_CACHE_HOURS: Number(optional("SCAN_TOKEN_CACHE_HOURS", "1")),
} as const;
