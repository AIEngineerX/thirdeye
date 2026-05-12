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
  WALLET_CHECK_LIMIT: Number(optional("WALLET_CHECK_LIMIT", "120")),
  WALLET_CHECK_WINDOW_SEC: Number(optional("WALLET_CHECK_WINDOW_SEC", "3600")),
  WALLET_CHECK_CACHE_SEC: Number(optional("WALLET_CHECK_CACHE_SEC", "14400")),
  SCAN_TOKEN_LIMIT: Number(optional("SCAN_TOKEN_LIMIT", "60")),
  SCAN_TOKEN_WINDOW_SEC: Number(optional("SCAN_TOKEN_WINDOW_SEC", "3600")),
  SCAN_TOKEN_CACHE_SEC: Number(optional("SCAN_TOKEN_CACHE_SEC", "300")),
  SMART_MONEY_MIN_SOL: Number(optional("SMART_MONEY_MIN_SOL", "50")),

  // Phase 6b — agent engine
  ANTHROPIC_API_KEY: optionalUndef("ANTHROPIC_API_KEY"),
  AGENT_DAILY_COST_USD_CAP: Number(optional("AGENT_DAILY_COST_USD_CAP", "25")),
  AGENT_MAX_TOOL_CALLS_PER_RUN: Number(optional("AGENT_MAX_TOOL_CALLS_PER_RUN", "20")),
  AGENT_MAX_INPUT_TOKENS_PER_RUN: Number(optional("AGENT_MAX_INPUT_TOKENS_PER_RUN", "200000")),
  AGENT_CHEAP_MODEL: optionalUndef("AGENT_CHEAP_MODEL"),
  AGENT_REASONING_MODEL: optionalUndef("AGENT_REASONING_MODEL"),

  // Phase 6b.6 — Telegram bot (embedded in this process; both vars must
  // be set for the bot to start, otherwise startBot() returns immediately)
  TG_BOT_TOKEN: optionalUndef("TG_BOT_TOKEN"),
  TG_ALLOWED_CHAT_ID: process.env.TG_ALLOWED_CHAT_ID
    ? Number(process.env.TG_ALLOWED_CHAT_ID)
    : undefined,
} as const;

// Read fresh so secrets can be hot-rotated without restart.
export function publicBaseUrl(): string | undefined {
  const v = process.env.PUBLIC_BASE_URL;
  return v && v.length > 0 ? v : undefined;
}

export function heliusWebhookAuth(): string | undefined {
  const v = process.env.HELIUS_WEBHOOK_AUTH;
  return v && v.length > 0 ? v : undefined;
}
