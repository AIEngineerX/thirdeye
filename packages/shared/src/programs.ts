// Curated allowlist of program IDs and pool-authority addresses we treat as
// LP-bound or locker-bound owners during Scan Token.
//
// Why an allowlist of *owners* and not pure program IDs: token accounts are
// owned by program-derived addresses (PDAs), not by program IDs themselves.
// The cleanest test is `getAccountInfo(owner).owner === <PROGRAM_ID>`, but
// that's an extra RPC call per holder. v1 short-circuits by matching owner
// directly against a small set of known LP pool authorities and locker
// program PDAs — fast, free, accepts some false negatives.
//
// Sources: Solscan + SolanaFM program directories (cross-checked 2026-05).

// LP / AMM programs — token accounts of liquidity pools
export const RAYDIUM_PROGRAMS: ReadonlySet<string> = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
]);

export const METEORA_PROGRAMS: ReadonlySet<string> = new Set([
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora DLMM
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", // Meteora DAMM v1
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", // Meteora DAMM v2
]);

export const ORCA_PROGRAMS: ReadonlySet<string> = new Set([
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool
]);

export const JUPITER_PROGRAMS: ReadonlySet<string> = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter Aggregator v6
  "j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X", // Jupiter Limit Order v2
]);

// Locker programs — token accounts holding locked supply
export const LOCKER_PROGRAMS: ReadonlySet<string> = new Set([
  "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m", // Streamflow
  "ToKLx75MGim1d1jRusuVX8xvdvvbSDESVaNXFKWJrWa", // Tokenlocker (toki.team)
  "GokivDYuQXPZCWRkwMhdH2h91KpDQXBEmKgBjFvFnzv7", // Goki Smart Wallet (multisig locker)
]);

const ALL_LP: ReadonlySet<string> = new Set([
  ...RAYDIUM_PROGRAMS,
  ...METEORA_PROGRAMS,
  ...ORCA_PROGRAMS,
  ...JUPITER_PROGRAMS,
]);

export type LpLockCategory = "lp" | "locked";

export function isLpOrLockOwner(owner: string | null | undefined): LpLockCategory | null {
  if (!owner) return null;
  if (ALL_LP.has(owner)) return "lp";
  if (LOCKER_PROGRAMS.has(owner)) return "locked";
  return null;
}
