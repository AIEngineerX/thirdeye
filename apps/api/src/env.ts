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

// Returns `undefined` for missing OR all-whitespace values. Without the trim
// step, `HELIUS_API_KEY="   "` would have appeared "set" to downstream
// `if (env.HELIUS_API_KEY)` checks and the proxy would send whitespace
// upstream — a confusing operator-config failure mode.
function optionalUndef(name: string): string | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Strict integer parser: rejects non-integer input (e.g. "12345abc",
// "1e10", "  ", "12.5") rather than silently producing NaN or a misleading
// 1. Used for all numeric env vars where a malformed value would be a
// silent logic bug.
function intStrict(name: string, raw: string): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} is empty (expected an integer)`);
  }
  if (!/^-?[0-9]+$/.test(trimmed)) {
    throw new Error(`${name} is not a valid integer: ${JSON.stringify(raw)}`);
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${name} is out of safe integer range: ${JSON.stringify(raw)}`);
  }
  return n;
}

function requiredInt(name: string): number {
  return intStrict(name, required(name));
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return intStrict(name, v);
}

function optionalIntUndef(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return undefined;
  return intStrict(name, v);
}

// Same shape as optionalInt but the parsed value must satisfy >= min and
// <= max — useful for thresholds that have no meaningful "off" value.
function optionalIntInRange(name: string, fallback: number, min: number, max: number): number {
  const n = optionalInt(name, fallback);
  if (n < min || n > max) {
    throw new Error(`${name}=${n} is out of range [${min}, ${max}]`);
  }
  return n;
}

// Re-exported for tests.
export { intStrict };

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  PORT: optionalInt("PORT", 3001),
  CORS_ORIGIN: optional("CORS_ORIGIN", "http://localhost:3000"),
  PUBLIC_INSTANCE_MODE: optional("PUBLIC_INSTANCE_MODE", "false") === "true",

  HELIUS_API_KEY: optionalUndef("HELIUS_API_KEY"),
  HELIUS_PROXY_LIMIT: optionalInt("HELIUS_PROXY_LIMIT", 600),
  HELIUS_PROXY_WINDOW_SEC: optionalInt("HELIUS_PROXY_WINDOW_SEC", 3600),
  WALLET_CHECK_LIMIT: optionalInt("WALLET_CHECK_LIMIT", 120),
  WALLET_CHECK_WINDOW_SEC: optionalInt("WALLET_CHECK_WINDOW_SEC", 3600),
  WALLET_CHECK_CACHE_SEC: optionalInt("WALLET_CHECK_CACHE_SEC", 14400),
  SCAN_TOKEN_LIMIT: optionalInt("SCAN_TOKEN_LIMIT", 60),
  SCAN_TOKEN_WINDOW_SEC: optionalInt("SCAN_TOKEN_WINDOW_SEC", 3600),
  SCAN_TOKEN_CACHE_SEC: optionalInt("SCAN_TOKEN_CACHE_SEC", 300),
  // F4: was `Number()` which silently coerced "foo" → NaN, making the
  // SMART_MONEY tag's threshold comparison always false (NaN < anything is
  // false). Now throws on malformed input so misconfiguration surfaces at
  // startup.
  SMART_MONEY_MIN_SOL: optionalInt("SMART_MONEY_MIN_SOL", 50),

  // H2 — per-IP issuance limit on POST /api/db/auth under PUBLIC mode.
  // Defaults: 10 issuances per IP per hour. Operator can tighten/loosen.
  AUTH_ISSUE_LIMIT_PER_HOUR: optionalInt("AUTH_ISSUE_LIMIT_PER_HOUR", 10),

  // Phase 6b — agent engine
  ANTHROPIC_API_KEY: optionalUndef("ANTHROPIC_API_KEY"),
  AGENT_DAILY_COST_USD_CAP: optionalInt("AGENT_DAILY_COST_USD_CAP", 25),
  AGENT_MAX_TOOL_CALLS_PER_RUN: optionalInt("AGENT_MAX_TOOL_CALLS_PER_RUN", 20),
  AGENT_MAX_INPUT_TOKENS_PER_RUN: optionalInt("AGENT_MAX_INPUT_TOKENS_PER_RUN", 200000),
  AGENT_CHEAP_MODEL: optionalUndef("AGENT_CHEAP_MODEL"),
  AGENT_REASONING_MODEL: optionalUndef("AGENT_REASONING_MODEL"),

  // Phase 6b.6 — Telegram bot (embedded in this process; both vars must
  // be set for the bot to start, otherwise startBot() returns immediately)
  TG_BOT_TOKEN: optionalUndef("TG_BOT_TOKEN"),
  // H5: was `Number()` which silently produced NaN on malformed input;
  // NaN !== anything (including itself) so the chat-allowlist comparison
  // would silently block every chat — safe by accident, but a future
  // refactor flipping the sense would silently allow every chat. Strict
  // parse + throw makes misconfiguration loud and immediate.
  TG_ALLOWED_CHAT_ID: optionalIntUndef("TG_ALLOWED_CHAT_ID"),
} as const;

// Re-export the range helper so callers that need bespoke ranges can use it
// (currently no callers; here for future tuning thresholds).
export { optionalIntInRange };

// Read fresh so secrets can be hot-rotated without restart.
export function publicBaseUrl(): string | undefined {
  const v = process.env.PUBLIC_BASE_URL;
  if (!v) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function heliusWebhookAuth(): string | undefined {
  const v = process.env.HELIUS_WEBHOOK_AUTH;
  if (!v) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
