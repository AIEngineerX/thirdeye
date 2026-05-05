import { ProxyError, type ProxyResult, TTL, proxyToHelius } from "@thirdeye/helius";
import type { ParsedTx } from "./tx-patterns";
import type { Balances, Identity, TokenBalance } from "./types";

export interface ClientOptions {
  serverKey: string | undefined;
  userKey?: string | undefined;
}

export interface FundedByResponse {
  funder: string | null;
  signature: string | null;
  fundedAt: string | null;
}

export class HeliusClient {
  constructor(private readonly opts: ClientOptions) {}

  async identity(addr: string): Promise<Identity> {
    const r = await this.rest<{
      address: string;
      name?: string;
      type?: string;
      category?: string;
    }>(`/v1/wallet/${addr}/identity`, TTL.DEFAULT);
    return {
      address: r.address ?? addr,
      name: r.name ?? null,
      type: r.type ?? null,
      category: r.category ?? null,
    };
  }

  async batchIdentity(addresses: string[]): Promise<Map<string, Identity>> {
    if (addresses.length === 0) return new Map();
    const result = await proxyToHelius({
      target: { kind: "rest", path: "/v1/wallet/batch-identity" },
      method: "POST",
      body: { addresses },
      cacheTtlMs: TTL.DEFAULT,
      serverKey: this.opts.serverKey,
      ...(this.opts.userKey !== undefined && { userKey: this.opts.userKey }),
    });
    if (result.error) throw new HeliusError(result);
    if (!Array.isArray(result.body)) throw malformedArray(result);
    const arr = result.body as Array<Record<string, unknown>>;
    const map = new Map<string, Identity>();
    for (const row of arr) {
      const address = typeof row.address === "string" ? row.address : null;
      if (!address) continue;
      map.set(address, {
        address,
        name: typeof row.name === "string" ? row.name : null,
        type: typeof row.type === "string" ? row.type : null,
        category: typeof row.category === "string" ? row.category : null,
      });
    }
    return map;
  }

  async balances(addr: string): Promise<Balances> {
    const r = await this.rest<{
      nativeBalance?: { lamports?: number; uiAmount?: number; usdValue?: number };
      tokens?: Array<{
        mint?: string;
        amount?: string | number;
        decimals?: number;
        symbol?: string;
        name?: string;
        usdValue?: number;
      }>;
    }>(`/v1/wallet/${addr}/balances`, TTL.DEFAULT, { showNative: "true", limit: "100" });

    const solLamports = r.nativeBalance?.lamports ?? 0;
    const solBalance = solLamports / 1_000_000_000;
    const solUsd = r.nativeBalance?.usdValue ?? 0;
    const tokens: TokenBalance[] = (r.tokens ?? []).map((t) => ({
      mint: t.mint ?? "",
      amount: String(t.amount ?? "0"),
      decimals: t.decimals ?? 0,
      symbol: t.symbol ?? null,
      name: t.name ?? null,
      usdValue: typeof t.usdValue === "number" ? t.usdValue : null,
    }));
    const tokenUsd = tokens.reduce((acc, t) => acc + (t.usdValue ?? 0), 0);
    return {
      solBalance,
      usdValue: solUsd + tokenUsd,
      tokenCount: tokens.length,
      tokens,
    };
  }

  async fundedBy(addr: string): Promise<FundedByResponse> {
    const r = await this.rest<{
      funder?: string | null;
      firstFunder?: string | null;
      signature?: string | null;
      blockTime?: number | null;
      timestamp?: number | null;
    }>(`/v1/wallet/${addr}/funded-by`, TTL.IMMUTABLE);
    const funder = r.funder ?? r.firstFunder ?? null;
    const signature = r.signature ?? null;
    const blockTime = r.blockTime ?? r.timestamp ?? null;
    return {
      funder,
      signature,
      fundedAt: blockTime !== null ? new Date(blockTime * 1000).toISOString() : null,
    };
  }

  async transactions(addr: string, limit = 100): Promise<ParsedTx[]> {
    const result = await proxyToHelius({
      target: {
        kind: "rest",
        path: `/v0/addresses/${addr}/transactions`,
        query: { limit: String(limit) },
      },
      method: "GET",
      cacheTtlMs: TTL.DEFAULT,
      serverKey: this.opts.serverKey,
      ...(this.opts.userKey !== undefined && { userKey: this.opts.userKey }),
    });
    if (result.error) throw new HeliusError(result);
    if (!Array.isArray(result.body)) throw malformedArray(result);
    return result.body.map(parseHeliusTx).filter((t): t is ParsedTx => t !== null);
  }

  private async rest<T>(
    path: string,
    cacheTtlMs: number,
    query?: Record<string, string>,
  ): Promise<T> {
    const result = await proxyToHelius({
      target: { kind: "rest", path, query },
      method: "GET",
      cacheTtlMs,
      serverKey: this.opts.serverKey,
      ...(this.opts.userKey !== undefined && { userKey: this.opts.userKey }),
    });
    if (result.error) throw new HeliusError(result);
    return result.body as T;
  }
}

function parseHeliusTx(raw: unknown): ParsedTx | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const signature = typeof r.signature === "string" ? r.signature : null;
  const timestamp = typeof r.timestamp === "number" ? r.timestamp : null;
  if (!signature || timestamp === null) return null;
  const type = typeof r.type === "string" ? r.type : null;
  const source = typeof r.source === "string" ? r.source : null;
  const native = Array.isArray(r.nativeTransfers)
    ? r.nativeTransfers
        .map((n) => {
          if (typeof n !== "object" || n === null) return null;
          const nn = n as Record<string, unknown>;
          if (
            typeof nn.fromUserAccount !== "string" ||
            typeof nn.toUserAccount !== "string" ||
            typeof nn.amount !== "number"
          ) {
            return null;
          }
          return {
            fromUserAccount: nn.fromUserAccount,
            toUserAccount: nn.toUserAccount,
            amount: nn.amount,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
    : undefined;
  return {
    signature,
    timestamp,
    type,
    source,
    destination: null,
    ...(native !== undefined && { nativeTransfers: native }),
  };
}

export class HeliusError extends Error {
  readonly status: number;
  readonly upstreamStatus: number | undefined;
  constructor(result: ProxyResult) {
    const err = result.error;
    super(err?.message ?? "Helius error");
    this.name = "HeliusError";
    this.status = result.status;
    this.upstreamStatus = err?.upstreamStatus;
  }
}

function malformedArray(result: ProxyResult): HeliusError {
  return new HeliusError({ ...result, error: ProxyError.upstreamMalformed(result.status) });
}
