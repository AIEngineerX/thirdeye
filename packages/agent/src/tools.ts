import { type DbClient, funders, tokens, wallets, watches } from "@thirdeye/db";
import {
  HeliusError,
  type WalletCheckResult,
  checkWallet as scannerCheckWallet,
  scanToken as scannerScanToken,
  type TokenScanResult,
} from "@thirdeye/scanner";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { type WalletSummary, summarizeWalletForLLM } from "./summarize";

// Tool handlers receive a context bag so they can access infra (DB, Helius
// keys, scanner config). Tools must not mutate global state outside what the
// agent_runs row tracks.
export interface ToolContext {
  db: DbClient;
  serverHeliusKey: string | undefined;
  userHeliusKey?: string | undefined;
  smartMoneyMinSol: number;
}

export interface AgentTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  handler: (input: unknown, ctx: ToolContext) => Promise<unknown>;
}

// Solana base58 addresses are 32–44 chars. Stricter validation (full b58
// charset) is the route layer's job; this is a quick filter that prevents
// the LLM from passing obvious garbage.
const ADDRESS = z.string().min(32).max(44);
const MINT = z.string().min(32).max(44);

async function resolveSiblings(
  db: DbClient,
  firstFunder: string,
  limit: number,
): Promise<{ address: string; fundedAt: string | null }[]> {
  const rows = await db
    .select({ address: wallets.address, fundedAt: wallets.fundedAt })
    .from(wallets)
    .where(sql`${wallets.firstFunder} = ${firstFunder}`)
    .limit(limit);
  return rows.map((r) => ({
    address: r.address,
    fundedAt: r.fundedAt ? r.fundedAt.toISOString() : null,
  }));
}

async function resolvePriorTags(
  db: DbClient,
  addresses: string[],
): Promise<Map<string, string[]>> {
  if (addresses.length === 0) return new Map();
  const rows = await db
    .select({ address: wallets.address, tags: wallets.tags })
    .from(wallets)
    .where(sql`${wallets.address} = ANY(${addresses})`);
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.address, r.tags);
  return out;
}

const checkWallet: AgentTool = {
  name: "checkWallet",
  description:
    "Run forensic analysis on a Solana wallet address. Returns a compact summary with score, verdict, tags, cluster, funding chain hops, and realized PnL. Use this when investigating a single wallet's risk profile.",
  input_schema: {
    type: "object",
    properties: {
      address: { type: "string", description: "Solana wallet address (base58)" },
    },
    required: ["address"],
  },
  handler: async (raw, ctx): Promise<WalletSummary> => {
    const { address } = z.object({ address: ADDRESS }).parse(raw);
    const generator = scannerCheckWallet({
      address,
      serverKey: ctx.serverHeliusKey,
      ...(ctx.userHeliusKey !== undefined && { userKey: ctx.userHeliusKey }),
      resolveSiblings: (funder, limit) => resolveSiblings(ctx.db, funder, limit),
      smartMoneyMinSol: ctx.smartMoneyMinSol,
    });
    let final: WalletCheckResult | null = null;
    try {
      for await (const evt of generator) {
        if (evt.event === "result") final = evt.data;
      }
    } catch (e) {
      if (e instanceof HeliusError) {
        throw new Error(`helius_error: ${e.message}`);
      }
      throw e;
    }
    if (!final) throw new Error("scanner produced no result event");
    return summarizeWalletForLLM(final);
  },
};

const scanToken: AgentTool = {
  name: "scanToken",
  description:
    "Scan a Solana SPL token mint for holder clustering, LP/locked %, bundler activity, and risk verdict. Returns a token-level summary with cluster count, top holders, and risk percentages.",
  input_schema: {
    type: "object",
    properties: { mint: { type: "string", description: "Solana SPL mint address (base58)" } },
    required: ["mint"],
  },
  handler: async (raw, ctx): Promise<TokenScanResult> => {
    const { mint } = z.object({ mint: MINT }).parse(raw);
    const generator = scannerScanToken({
      mint,
      serverKey: ctx.serverHeliusKey,
      ...(ctx.userHeliusKey !== undefined && { userKey: ctx.userHeliusKey }),
      resolvePriorTags: (addrs) => resolvePriorTags(ctx.db, addrs),
    });
    let final: TokenScanResult | null = null;
    try {
      for await (const evt of generator) {
        if (evt.event === "result") final = evt.data;
      }
    } catch (e) {
      if (e instanceof HeliusError) throw new Error(`helius_error: ${e.message}`);
      throw e;
    }
    if (!final) throw new Error("scanner produced no result event");
    return final;
  },
};

const getClusterSiblings: AgentTool = {
  name: "getClusterSiblings",
  description:
    "Given a wallet, return the cluster of sibling addresses that share its first funder. Useful for expanding a single suspicious wallet into a cohort. Capped at 50 siblings.",
  input_schema: {
    type: "object",
    properties: { address: { type: "string" } },
    required: ["address"],
  },
  handler: async (raw, ctx) => {
    const { address } = z.object({ address: ADDRESS }).parse(raw);
    const target = await ctx.db
      .select({ firstFunder: wallets.firstFunder })
      .from(wallets)
      .where(sql`${wallets.address} = ${address}`)
      .limit(1);
    const firstFunder = target[0]?.firstFunder;
    if (!firstFunder) return { firstFunder: null, siblings: [] };
    const siblings = await resolveSiblings(ctx.db, firstFunder, 50);
    return { firstFunder, siblings };
  },
};

const getFunderClusters: AgentTool = {
  name: "getFunderClusters",
  description:
    "Top funder addresses by fan-out (count of distinct wallets they funded). Returns up to `limit` rows ordered by fanout_count descending. Use to find suspicious funding hubs.",
  input_schema: {
    type: "object",
    properties: { limit: { type: "integer", description: "Max funders to return (default 20)" } },
    required: [],
  },
  handler: async (raw, ctx) => {
    const { limit } = z
      .object({ limit: z.number().int().min(1).max(100).default(20) })
      .parse(raw ?? {});
    const rows = await ctx.db
      .select({
        address: funders.address,
        fanoutCount: funders.fanoutCount,
        clusterCount: funders.clusterCount,
      })
      .from(funders)
      .orderBy(sql`${funders.fanoutCount} DESC`)
      .limit(limit);
    return { funders: rows };
  },
};

const getHotTokens: AgentTool = {
  name: "getHotTokens",
  description:
    "Top tokens by recent market-cap velocity (mc_24h_pct). Returns mint, symbol, mcUsd, mc24hPct. Use for discovery loop seed mints.",
  input_schema: {
    type: "object",
    properties: { limit: { type: "integer", description: "Max tokens to return (default 10)" } },
    required: [],
  },
  handler: async (raw, ctx) => {
    const { limit } = z
      .object({ limit: z.number().int().min(1).max(50).default(10) })
      .parse(raw ?? {});
    const rows = await ctx.db
      .select({
        mint: tokens.mint,
        symbol: tokens.symbol,
        mcUsd: tokens.mcUsd,
        mc24hPct: tokens.mc24hPct,
      })
      .from(tokens)
      .where(sql`${tokens.mc24hPct} IS NOT NULL`)
      .orderBy(sql`${tokens.mc24hPct} DESC`)
      .limit(limit);
    return { tokens: rows };
  },
};

const getWatchlist: AgentTool = {
  name: "getWatchlist",
  description:
    "Distinct watched wallet addresses across all sessions. Use for the anomaly-detector seed list (every wallet someone has asked us to watch).",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
  handler: async (_raw, ctx) => {
    const rows = await ctx.db
      .selectDistinct({ address: watches.address })
      .from(watches)
      .orderBy(sql`${watches.address}`);
    return { addresses: rows.map((r) => r.address) };
  },
};

export const tools: AgentTool[] = [
  checkWallet,
  scanToken,
  getClusterSiblings,
  getFunderClusters,
  getHotTokens,
  getWatchlist,
];

export function getToolByName(name: string): AgentTool | undefined {
  return tools.find((t) => t.name === name);
}
