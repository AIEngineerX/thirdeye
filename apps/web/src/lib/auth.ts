/**
 * Anonymous session-token bootstrap.
 *
 * The api issues short-lived tokens via `POST /api/db/auth`. We cache the
 * token + expiry in sessionStorage so it survives reloads within a tab but
 * NOT across browser-quit cycles (intentional — the token is anonymous and
 * tied to the tab session). All authenticated requests include the token in
 * the `X-Auth-Token` header.
 *
 * The store is designed for dependency injection: pass an alternative
 * Storage + fetch + apiBase to the factory and the same logic runs against
 * a controlled environment in tests.
 */

const STORAGE_KEY = "thirdeye.session_token";
// Issue a fresh token when fewer than this many ms remain. 60s of slack
// covers clock skew between client and server plus typical request latency.
const REFRESH_WINDOW_MS = 60_000;

export interface SessionRecord {
  token: string;
  expiresAt: string; // ISO8601
}

export interface AuthDeps {
  storage: SessionStorageLike | null;
  fetchImpl: typeof globalThis.fetch;
  apiBase: string;
  /** Source of "now" — overridable for tests. */
  now: () => number;
}

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class AuthError extends Error {
  readonly status: number;
  readonly retryAfterSec: number | null;
  constructor(message: string, status: number, retryAfterSec: number | null) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

interface AuthResponseBody {
  token: string;
  expiresAt: string;
  error?: string;
  retryAfterSec?: number;
}

export interface AuthClient {
  /** Resolve a fresh-or-recent session token. Re-issues when expiring. */
  getOrIssueToken(): Promise<string>;
  /** Drop the cached token. Next call re-issues. */
  invalidate(): void;
  /** Inspect the cached record without issuing. Returns null when absent. */
  peek(): SessionRecord | null;
}

function readRecord(storage: SessionStorageLike | null): SessionRecord | null {
  if (!storage) return null;
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as SessionRecord;
  if (typeof parsed.token !== "string" || typeof parsed.expiresAt !== "string") return null;
  return parsed;
}

function writeRecord(storage: SessionStorageLike | null, record: SessionRecord): void {
  if (!storage) return;
  storage.setItem(STORAGE_KEY, JSON.stringify(record));
}

function clearRecord(storage: SessionStorageLike | null): void {
  if (!storage) return;
  storage.removeItem(STORAGE_KEY);
}

function isFresh(record: SessionRecord, now: number): boolean {
  const expiresMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresMs)) return false;
  return expiresMs - now > REFRESH_WINDOW_MS;
}

export function createAuthClient(deps: AuthDeps): AuthClient {
  // Shared promise so concurrent callers during cold-start await the same
  // in-flight issuance rather than firing N parallel POST /auth calls.
  let inflight: Promise<string> | null = null;

  const issue = async (): Promise<string> => {
    const resp = await deps.fetchImpl(`${deps.apiBase}/api/db/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const text = await resp.text();
    const body =
      text.length > 0 ? (JSON.parse(text) as AuthResponseBody) : ({} as AuthResponseBody);

    if (!resp.ok) {
      const retryAfterRaw = resp.headers.get("Retry-After");
      const retryAfterSec =
        body.retryAfterSec ?? (retryAfterRaw ? Number.parseInt(retryAfterRaw, 10) : null);
      throw new AuthError(
        body.error ?? `auth failed (${resp.status})`,
        resp.status,
        Number.isFinite(retryAfterSec as number) ? (retryAfterSec as number) : null,
      );
    }

    const record: SessionRecord = { token: body.token, expiresAt: body.expiresAt };
    writeRecord(deps.storage, record);
    return record.token;
  };

  return {
    async getOrIssueToken() {
      const cached = readRecord(deps.storage);
      if (cached && isFresh(cached, deps.now())) return cached.token;

      if (inflight) return inflight;

      inflight = (async () => {
        try {
          return await issue();
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    invalidate() {
      clearRecord(deps.storage);
      inflight = null;
    },
    peek() {
      return readRecord(deps.storage);
    },
  };
}

let cachedClient: AuthClient | null = null;

export function getAuthClient(): AuthClient {
  if (cachedClient) return cachedClient;
  const storage: SessionStorageLike | null =
    typeof window !== "undefined" ? window.sessionStorage : null;
  cachedClient = createAuthClient({
    storage,
    fetchImpl:
      typeof globalThis.fetch !== "undefined"
        ? globalThis.fetch.bind(globalThis)
        : ((() => {
            throw new Error("global fetch is not available");
          }) as typeof globalThis.fetch),
    apiBase: "", // same-origin via Next rewrites
    now: () => Date.now(),
  });
  return cachedClient;
}
