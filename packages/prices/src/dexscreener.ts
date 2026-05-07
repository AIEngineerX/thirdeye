// DexScreener implementation of PriceSource.
//
// API: GET https://api.dexscreener.com/tokens/v1/solana/{addresses}
//   - addresses: comma-separated mint list, ≤ 30 per call
//   - public, no API key
//   - returns array of pair objects (one mint can have multiple pairs
//     across DEXes; we pick the deepest-liquidity pair per mint)
//
// Documented escape hatches (NOT implemented in v1):
//   - Birdeye public API: requires API key, richer historical data
//   - Jupiter quote API: spot prices only, no liquidity / FDV fields
//
// Either can be added by writing a sibling file that exports a class
// satisfying PriceSource and wiring it in apps/api/src/workers/runner.ts.

import { type PriceQuote, type PriceSource, PriceSourceError } from "./types";

const ENDPOINT = "https://api.dexscreener.com/tokens/v1/solana";
// DexScreener's documented per-call cap is 30 addresses.
const MAX_PER_CALL = 30;
// Public-tier DexScreener limit is 300 req/min on /tokens/v1/*.
// We don't enforce this client-side — the worker's 60-second cadence
// with batched calls keeps us well under the ceiling for reasonable
// tracked-token counts.
const DEFAULT_TIMEOUT_MS = 8_000;

interface DexPair {
  chainId?: string;
  baseToken?: {
    address?: string;
    symbol?: string | null;
    name?: string | null;
  };
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  priceChange?: { h24?: number };
}

// Minimal call signature for the fetch override — Bun's `typeof fetch`
// includes a `preconnect` property the test fixtures don't need to provide.
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface DexScreenerOptions {
  timeoutMs?: number;
  // Override fetch for tests that want to inject a recorded fixture
  // without standing up a fake HTTP server. Production code never
  // passes this.
  fetchImpl?: FetchFn;
}

export class DexScreenerSource implements PriceSource {
  readonly name = "dexscreener";
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchFn;

  constructor(opts: DexScreenerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetch(mints: string[]): Promise<PriceQuote[]> {
    if (mints.length === 0) return [];
    // Dedup so we don't waste a slot on a duplicate mint.
    const unique = [...new Set(mints)];
    const batches: string[][] = [];
    for (let i = 0; i < unique.length; i += MAX_PER_CALL) {
      batches.push(unique.slice(i, i + MAX_PER_CALL));
    }

    const results: PriceQuote[] = [];
    for (const batch of batches) {
      const pairs = await this.fetchBatch(batch);
      results.push(...this.collapse(pairs));
    }
    return results;
  }

  private async fetchBatch(mints: string[]): Promise<DexPair[]> {
    const url = `${ENDPOINT}/${mints.join(",")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new PriceSourceError(
        this.name,
        res.status,
        `DexScreener ${res.status} for ${mints.length} mints`,
      );
    }
    const body = (await res.json()) as DexPair[] | { pairs?: DexPair[] };
    // Endpoint nominally returns a top-level array; defensive against the
    // alternate `{pairs: [...]}` shape returned by the older /latest/dex/*
    // endpoints in case the URL is later swapped.
    if (Array.isArray(body)) return body;
    if (body && Array.isArray(body.pairs)) return body.pairs;
    return [];
  }

  // A single mint may appear in multiple pair rows (one per DEX). Pick the
  // pair with the largest liquidity and project to PriceQuote.
  private collapse(pairs: DexPair[]): PriceQuote[] {
    const best = new Map<string, DexPair>();
    for (const p of pairs) {
      const mint = p.baseToken?.address;
      if (!mint) continue;
      const prior = best.get(mint);
      if (!prior) {
        best.set(mint, p);
        continue;
      }
      const priorLiq = prior.liquidity?.usd ?? 0;
      const currLiq = p.liquidity?.usd ?? 0;
      if (currLiq > priorLiq) best.set(mint, p);
    }

    const out: PriceQuote[] = [];
    for (const [mint, p] of best) {
      out.push({
        mint,
        symbol: p.baseToken?.symbol ?? null,
        name: p.baseToken?.name ?? null,
        priceUsd: parseNum(p.priceUsd),
        // FDV is the canonical "market cap" surrogate on DexScreener.
        // marketCap is sometimes populated for tokens with verified
        // circulating-supply data; prefer it when available.
        mcUsd: p.marketCap ?? p.fdv ?? null,
        mc24hPct: p.priceChange?.h24 ?? null,
        liquidityUsd: p.liquidity?.usd ?? null,
      });
    }
    return out;
  }
}

function parseNum(v: string | number | undefined): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
