import { isLpOrLockOwner, isTerminalFunder } from "@thirdeye/shared";
import { HeliusClient } from "./helius-client";
import { computeRisk, tokenVerdict } from "./risk";
import { PROCESS_HELIUS_SEMAPHORE, Semaphore } from "./semaphore";
import type {
  LpHolder,
  ScanMode,
  ScanTokenEvent,
  TokenCluster,
  TokenHolderAccount,
  TokenScanResult,
  TopHolder,
} from "./types";

// Helius DAS getTokenAccounts returns indexer-order, NOT balance-sorted.
// We sort the returned sample by amount desc client-side, but a popular
// mint's TRUE top-N globally is not knowable in a single page. Limits below
// cap the sample size; cluster detection operates on the sampled top.
// True global top-N is a v1.1 enhancement (would require pagination + sort
// or getTokenLargestAccounts + SPL token-account owner deserialization).
//
// Phase 5a: bumped SHARED 100 → 200. Lower cap from earlier was a
// concession to the free-tier 429 risk; with paid Helius + the 429
// retry shipped in 9c735d5, 200 is back on the menu.
const SHARED_HOLDER_LIMIT = 200;
const BYOK_HOLDER_LIMIT = 500;
const PER_SCAN_CONCURRENCY = 10;

export interface ScanTokenOptions {
  mint: string;
  serverKey: string | undefined;
  userKey?: string | undefined;
  // Bulk lookup of prior wallet tags from `wallets` table. Returns a map
  // keyed by address. Missing addresses ⇒ no prior check on file.
  resolvePriorTags: (addresses: string[]) => Promise<Map<string, string[]>>;
}

export async function* scanToken(opts: ScanTokenOptions): AsyncGenerator<ScanTokenEvent> {
  const mode: ScanMode = opts.userKey ? "byok" : "shared";
  const holderLimit = mode === "byok" ? BYOK_HOLDER_LIMIT : SHARED_HOLDER_LIMIT;

  yield { event: "started", data: { mint: opts.mint, mode, cached: false } };

  const client = new HeliusClient({
    serverKey: opts.serverKey,
    ...(opts.userKey !== undefined && { userKey: opts.userKey }),
  });

  const metadata = await client.getAsset(opts.mint);
  yield { event: "metadata", data: { ...metadata, launchpad: null } };

  const accounts = await client.getTokenAccounts(opts.mint, holderLimit);
  const supply = parseSupply(metadata.supply);
  const topHolders = aggregateHoldersByOwner(accounts, supply);
  yield {
    event: "holders",
    data: {
      totalHolders: accounts.length,
      scannedHolders: topHolders.length,
      top: topHolders,
    },
  };

  const lpHolders: LpHolder[] = [];
  const lockedHolders: LpHolder[] = [];
  const walletHolders: TopHolder[] = [];
  for (const h of topHolders) {
    const cat = isLpOrLockOwner(h.owner);
    if (cat === "lp") lpHolders.push({ owner: h.owner, pct: h.pct, category: "lp" });
    else if (cat === "locked")
      lockedHolders.push({ owner: h.owner, pct: h.pct, category: "locked" });
    else walletHolders.push(h);
  }
  const lpPct = sumPct(lpHolders);
  const lockedPct = sumPct(lockedHolders);
  yield {
    event: "lpFilter",
    data: { lpPct, lockedPct, lpHolders, lockedHolders },
  };

  // Bounded fan-out funded-by per spec §8.2: per-scan(10) ∩ process-wide(50)
  const perScan = new Semaphore(PER_SCAN_CONCURRENCY);
  const funderByOwner = new Map<string, string | null>();
  let scanned = 0;
  let errored = 0;

  await Promise.all(
    walletHolders.map((h) =>
      perScan.run(() =>
        PROCESS_HELIUS_SEMAPHORE.run(async () => {
          try {
            const r = await client.fundedBy(h.owner);
            funderByOwner.set(h.owner, r.funder);
          } catch (e) {
            errored++;
            funderByOwner.set(h.owner, null);
            console.error(`[scan-token ${opts.mint}] fundedBy(${h.owner}) failed`, e);
          }
          scanned++;
        }),
      ),
    ),
  );
  yield {
    event: "fundingProgress",
    data: { scanned, total: walletHolders.length, errored },
  };

  // Group by funder; drop nulls, terminal funders, singletons
  const byFunder = new Map<string, TopHolder[]>();
  for (const h of walletHolders) {
    const funder = funderByOwner.get(h.owner) ?? null;
    if (funder === null) continue;
    if (isTerminalFunder(funder)) continue;
    const list = byFunder.get(funder) ?? [];
    list.push(h);
    byFunder.set(funder, list);
  }

  // Cross-ref enrichment — bulk lookup tags for cluster members + roots
  const candidateClusters = [...byFunder.entries()].filter(([, members]) => members.length >= 2);
  const lookupAddresses = new Set<string>();
  for (const [root, members] of candidateClusters) {
    lookupAddresses.add(root);
    for (const m of members) lookupAddresses.add(m.owner);
  }
  const priorTagsMap = await opts.resolvePriorTags([...lookupAddresses]);

  const clusters: TokenCluster[] = candidateClusters.map(([root, members]) => {
    const totalPct = members.reduce((acc, m) => acc + m.pct, 0);
    const rootTags = priorTagsMap.get(root) ?? null;
    const isFreshFunder = rootTags === null || rootTags.includes("FRESH_WALLET");
    const priorTags: Record<string, string[]> = {};
    for (const m of members) {
      const t = priorTagsMap.get(m.owner);
      if (t && t.length > 0) priorTags[m.owner] = t;
    }
    return {
      root,
      members: members.map((m) => m.owner),
      totalPct: round2(totalPct),
      isFreshFunder,
      priorTags,
    };
  });
  yield { event: "clusters", data: { clusters } };

  const totalClusteredPct = round2(clusters.reduce((a, c) => a + c.totalPct, 0));
  const maxClusterPct = clusters.reduce((a, c) => Math.max(a, c.totalPct), 0);
  const freshFunderCount = clusters.filter((c) => c.isFreshFunder).length;
  const sybilFlag = clusters.some((c) => c.totalPct >= 5);
  const risk = computeRisk({
    totalClusteredPct,
    sybilFlag,
    maxClusterPct,
    freshFunderCount,
    totalClusters: clusters.length,
  });
  const verdict = tokenVerdict(risk);

  const result: TokenScanResult = {
    mint: opts.mint,
    mode,
    metadata,
    totalHolders: accounts.length,
    scannedHolders: topHolders.length,
    topHolders,
    lp: { totalPct: lpPct, holders: lpHolders },
    locked: { totalPct: lockedPct, holders: lockedHolders },
    clusters,
    totalClusteredPct,
    maxClusterPct: round2(maxClusterPct),
    freshFunderCount,
    risk,
    sybilFlag,
    verdict,
    scannedAt: new Date().toISOString(),
  };
  yield { event: "result", data: result };
}

function parseSupply(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

// A single owner can hold multiple token accounts of the same mint (e.g. one
// per program). Aggregate into a single owner-level holder before computing
// supply pct so the cluster pass keys on owner, not on token-account.
function aggregateHoldersByOwner(accounts: TokenHolderAccount[], supply: bigint): TopHolder[] {
  const totals = new Map<string, bigint>();
  for (const a of accounts) {
    const amt = parseSupply(a.amount);
    if (amt === 0n) continue;
    totals.set(a.owner, (totals.get(a.owner) ?? 0n) + amt);
  }
  if (supply === 0n) return [];
  const holders: TopHolder[] = [];
  for (const [owner, amount] of totals) {
    const pct = (Number(amount) / Number(supply)) * 100;
    holders.push({ owner, amount: amount.toString(), pct: round2(pct) });
  }
  holders.sort((a, b) => b.pct - a.pct);
  return holders;
}

function sumPct(holders: { pct: number }[]): number {
  return round2(holders.reduce((acc, h) => acc + h.pct, 0));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
