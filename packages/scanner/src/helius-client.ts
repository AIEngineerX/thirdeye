import { ProxyError, type ProxyResult, TTL, proxyToHelius } from "@thirdeye/helius";
import type { ParsedTx } from "./tx-patterns";
import type { Balances, Identity, TokenBalance, TokenHolderAccount, TokenMetadata } from "./types";

export interface ClientOptions {
  serverKey: string | undefined;
  userKey?: string | undefined;
}

export interface FundedByResponse {
  funder: string | null;
  funderName: string | null;
  funderType: string | null; // "exchange" | other Helius classifications | null
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
    // Real shape: { balances: [{mint, symbol, name, balance, decimals,
    //   usdValue, pricePerToken, tokenProgram}], totalUsdValue, pagination }
    // Native SOL appears as one row with mint = NATIVE_SOL_SENTINEL and
    // `balance` already decimal-adjusted (NOT raw u64 lamports).
    const r = await this.rest<{
      balances?: Array<{
        mint?: string;
        symbol?: string | null;
        name?: string | null;
        balance?: number | string;
        decimals?: number;
        usdValue?: number | null;
        pricePerToken?: number | null;
      }>;
      totalUsdValue?: number;
    }>(`/v1/wallet/${addr}/balances`, TTL.DEFAULT, { showNative: "true", limit: "100" });

    const rows = r.balances ?? [];
    const native = rows.find((b) => b.mint === NATIVE_SOL_SENTINEL);
    const solBalance = typeof native?.balance === "number" ? native.balance : 0;

    const tokens: TokenBalance[] = rows
      .filter((b) => b.mint !== NATIVE_SOL_SENTINEL)
      .map((t) => ({
        mint: t.mint ?? "",
        // Helius returns decimal-adjusted; round-trip to raw u64 string for
        // our schema (clients can recompute via decimals).
        amount: rawAmountFromDecimal(t.balance, t.decimals ?? 0),
        decimals: t.decimals ?? 0,
        symbol: t.symbol ?? null,
        name: t.name ?? null,
        usdValue: typeof t.usdValue === "number" ? t.usdValue : null,
      }));

    return {
      solBalance,
      usdValue: typeof r.totalUsdValue === "number" ? r.totalUsdValue : 0,
      tokenCount: tokens.length,
      tokens,
    };
  }

  async fundedBy(addr: string): Promise<FundedByResponse> {
    // Helius returns 404 when there's no funding data on file (e.g. genesis
    // wallets, exchange hot wallets). Treat that as "no funder known", not
    // an error — the funding-chain trace just terminates cleanly.
    const result = await proxyToHelius({
      target: { kind: "rest", path: `/v1/wallet/${addr}/funded-by` },
      method: "GET",
      cacheTtlMs: TTL.IMMUTABLE,
      serverKey: this.opts.serverKey,
      ...(this.opts.userKey !== undefined && { userKey: this.opts.userKey }),
    });
    if (result.status === 404) {
      return { funder: null, funderName: null, funderType: null, signature: null, fundedAt: null };
    }
    if (result.error) throw new HeliusError(result);
    const r = (result.body ?? {}) as {
      funder?: string | null;
      funderName?: string | null;
      funderType?: string | null;
      signature?: string | null;
      timestamp?: number | null;
    };
    const ts = typeof r.timestamp === "number" ? r.timestamp : null;
    return {
      funder: r.funder ?? null,
      funderName: r.funderName ?? null,
      funderType: r.funderType ?? null,
      signature: r.signature ?? null,
      fundedAt: ts !== null ? new Date(ts * 1000).toISOString() : null,
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
    // showFungible: true is REQUIRED to get token_info (supply, decimals,
    // symbol) on fungible mints. Without it the response omits token_info
    // entirely and supply silently falls to 0 — meaningless scans.
    const result = await this.rpc<{
      content?: { metadata?: { name?: string; symbol?: string } };
      token_info?: {
        supply?: string | number;
        decimals?: number;
        symbol?: string;
      };
      authorities?: Array<{ address?: string; scopes?: string[] }>;
      creators?: Array<{ address?: string; verified?: boolean; share?: number }>;
    }>("getAsset", { id: mint, options: { showFungible: true } }, TTL.DEFAULT);

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
      // token_info.symbol is the canonical SPL symbol; metadata.symbol is the
      // display variant. Prefer token_info.symbol, fall back to metadata.
      symbol: result.token_info?.symbol ?? result.content?.metadata?.symbol ?? null,
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

// Helius wallet-api uses 41-char "So111...1" (note: ALL 1s) as the sentinel
// for native SOL in the balances flat array — distinct from the 42-char
// wrapped-SOL mint "So111...112". Matched by string equality below.
const NATIVE_SOL_SENTINEL = "So11111111111111111111111111111111111111111";

function rawAmountFromDecimal(balance: number | string | undefined, decimals: number): string {
  if (balance === undefined || balance === null) return "0";
  if (typeof balance === "string") return balance;
  // Reverse decimal scaling. Use BigInt math to avoid float precision loss
  // for high-decimal tokens. Floors fractional remainder.
  const scale = 10 ** decimals;
  const raw = Math.floor(balance * scale);
  return Number.isFinite(raw) ? String(raw) : "0";
}
