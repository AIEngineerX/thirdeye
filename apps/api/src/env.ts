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

// Re-exported for tests.
export { intStrict };
export { validateCorsOrigin };

// M3: CORS_ORIGIN is a literal string match (no wildcard expansion).
// Validate at startup so operator-config errors don't fail silently when
// the first browser request shows up with a CORS error in devtools.
function validateCorsOrigin(raw: string, credentials: boolean): string {
  const v = raw.trim();
  if (v.length === 0) {
    throw new Error("CORS_ORIGIN must be a non-empty origin URL");
  }
  if (v === "*") {
    if (credentials) {
      throw new Error(
        "CORS_ORIGIN='*' is incompatible with credentials:true — browsers reject this. Set a specific origin like https://app.example.com.",
      );
    }
    return v;
  }
  if (v.includes("*")) {
    throw new Error(
      `CORS_ORIGIN=${JSON.stringify(v)} contains a wildcard; this is a literal string match, not a glob. Set the exact origin (no wildcards).`,
    );
  }
  // Must parse as a URL with scheme + host. Hono's cors() accepts comma-
  // separated values too; we permit them but validate each.
  for (const candidate of v.split(",").map((s) => s.trim())) {
    try {
      const u = new URL(candidate);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error("must be http or https");
      }
    } catch (e) {
      throw new Error(
        `CORS_ORIGIN entry ${JSON.stringify(candidate)} is not a valid origin URL: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  return v;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  PORT: optionalInt("PORT", 3001),
  // credentials is true in apps/api/src/index.ts, so we validate accordingly.
  CORS_ORIGIN: validateCorsOrigin(optional("CORS_ORIGIN", "http://localhost:3000"), true),
  PUBLIC_INSTANCE_MODE: optional("PUBLIC_INSTANCE_MODE", "false") === "true",

  HELIUS_API_KEY: optionalUndef("HELIUS_API_KEY"),
  // Solana Tracker Data API — alpha-data spine (PnL, trends, leaderboard,
  // trades). Server-side only; no BYOK header (single-tenant personal tool).
  SOLANATRACKER_API_KEY: optionalUndef("SOLANATRACKER_API_KEY"),
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
} as const;

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
