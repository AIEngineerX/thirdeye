import type {
  Leaderboard,
  TokenChart,
  WalletPerformance,
  WalletPnlSummary,
  WalletPositions,
  WalletTrades,
} from "./types";

const DEFAULT_BASE_URL = "https://data.solanatracker.io";
const DEFAULT_TIMEOUT_MS = 15_000;
// The free tier rate-limits bursts aggressively (429). A dashboard that
// navigates quickly or refreshes will hit this, so retry on 429 with backoff
// rather than surfacing it — honoring Retry-After when present.
const RETRY_429_MAX_ATTEMPTS = 3;
const RETRY_429_BASE_MS = 1000;
const RETRY_429_MAX_MS = 8000;

function parseRetryAfterMs(headerVal: string | null): number | null {
  if (headerVal === null) return null;
  const secs = Number.parseInt(headerVal, 10);
  if (!Number.isNaN(secs) && secs > 0) return Math.min(secs * 1000, RETRY_429_MAX_MS);
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SolanaTrackerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SolanaTrackerError";
  }
}

export interface SolanaTrackerClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Thin typed client over the Solana Tracker Data API. Auth is a single
 * `x-api-key` header; every method is a GET. Non-2xx responses throw
 * SolanaTrackerError so callers (api routes) can map status uniformly.
 */
export class SolanaTrackerClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: SolanaTrackerClientOptions) {
    if (!opts.apiKey) throw new Error("SolanaTrackerClient requires an apiKey");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Full PnL summary for a wallet (all-time, with gamed-PnL filtering). */
  walletPnl(wallet: string): Promise<WalletPnlSummary> {
    return this.get<WalletPnlSummary>(`/v2/pnl/wallets/${wallet}`);
  }

  /** Per-token positions with cost basis, ROI, and current value. */
  walletPositions(wallet: string): Promise<WalletPositions> {
    return this.get<WalletPositions>(`/v2/pnl/wallets/${wallet}/positions`);
  }

  /** Windowed performance (default 30 days) with per-day series and streaks. */
  walletPerformance(wallet: string, windowDays?: number): Promise<WalletPerformance> {
    const q = windowDays === undefined ? "" : `?window=${windowDays}`;
    return this.get<WalletPerformance>(`/v2/pnl/wallets/${wallet}/performance${q}`);
  }

  /** Paginated trade history. Pass the previous response's nextCursor to page. */
  walletTrades(wallet: string, cursor?: string): Promise<WalletTrades> {
    const q = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    return this.get<WalletTrades>(`/wallet/${wallet}/trades${q}`);
  }

  /** Top traders by realized PnL (ST's strict-mode leaderboard). */
  leaderboard(): Promise<Leaderboard> {
    return this.get<Leaderboard>("/v2/pnl/leaderboard/top");
  }

  /** OHLCV candles for a mint. `type` is the candle interval (e.g. "1h", "15m"). */
  tokenChart(mint: string, type = "1h"): Promise<TokenChart> {
    return this.get<TokenChart>(`/chart/${mint}?type=${encodeURIComponent(type)}`);
  }

  private async get<T>(path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchOnce(path);
      if (res.status === 429 && attempt < RETRY_429_MAX_ATTEMPTS) {
        const headerWait = parseRetryAfterMs(res.headers.get("retry-after"));
        const backoff = Math.min(RETRY_429_BASE_MS * 2 ** attempt, RETRY_429_MAX_MS);
        await sleep(Math.max(headerWait ?? 0, backoff));
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new SolanaTrackerError(
          res.status,
          `Solana Tracker ${res.status} on ${path}: ${body.slice(0, 200)}`,
        );
      }
      return (await res.json()) as T;
    }
  }

  private async fetchOnce(path: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        headers: { "x-api-key": this.apiKey },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new SolanaTrackerError(504, `Solana Tracker request timed out: ${path}`);
      }
      throw new SolanaTrackerError(
        502,
        `Solana Tracker unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
