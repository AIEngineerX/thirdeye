import { ProxyError, type ProxyResult, TTL, proxyToHelius } from "@thirdeye/helius";
import type { ParsedTx } from "./tx-patterns";
import type { Balances, Identity, TokenBalance, TokenHolderAccount, TokenMetadata } from "./types";

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

  async getAsset(mint: string): Promise<TokenMetadata> {
    const result = await this.rpc<{
      content?: { metadata?: { name?: string; symbol?: string } };
      token_info?: { supply?: string | number; decimals?: number };
      authorities?: Array<{ address?: string; scopes?: string[] }>;
      creators?: Array<{ address?: string; verified?: boolean; share?: number }>;
    }>("getAsset", { id: mint }, TTL.DEFAULT);

    const supplyRaw = result.token_info?.supply;
    const supply =
      typeof supplyRaw === "string"
        ? supplyRaw
        : typeof supplyRaw === "number"
          ? String(supplyRaw)
          : "0";

    return {
      mint,
      name: result.content?.metadata?.name ?? null,
      symbol: result.content?.metadata?.symbol ?? null,
      supply,
      decimals: result.token_info?.decimals ?? 0,
      updateAuthority: result.authorities?.[0]?.address ?? null,
      firstCreator: result.creators?.[0]?.address ?? null,
    };
  }

  async getTokenAccounts(mint: string, limit: number): Promise<TokenHolderAccount[]> {
    const result = await this.rpc<{
      token_accounts?: Array<{
        address?: string;
        owner?: string;
        amount?: string | number;
      }>;
    }>("getTokenAccounts", { mint, limit }, TTL.DEFAULT);

    const accounts = result.token_accounts;
    if (!Array.isArray(accounts)) {
      throw new HeliusError({
        status: 502,
        body: result,
        fromCache: false,
        durationMs: 0,
        isByok: false,
        error: ProxyError.upstreamMalformed(200),
      });
    }
    return accounts
      .filter(
        (a): a is { address: string; owner: string; amount: string | number } =>
          typeof a.address === "string" &&
          typeof a.owner === "string" &&
          (typeof a.amount === "string" || typeof a.amount === "number"),
      )
      .map((a) => ({
        address: a.address,
        owner: a.owner,
        amount: typeof a.amount === "string" ? a.amount : String(a.amount),
      }));
  }

  private async rpc<T>(
    method: string,
    params: Record<string, unknown>,
    cacheTtlMs: number,
  ): Promise<T> {
    const result = await proxyToHelius({
      target: { kind: "rpc", method, params },
      method: "POST",
      cacheTtlMs,
      serverKey: this.opts.serverKey,
      ...(this.opts.userKey !== undefined && { userKey: this.opts.userKey }),
    });
    if (result.error) throw new HeliusError(result);
    const body = result.body;
    if (typeof body !== "object" || body === null) throw malformedArray(result);
    if ("result" in body) return (body as { result: T }).result;
    return body as T;
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
