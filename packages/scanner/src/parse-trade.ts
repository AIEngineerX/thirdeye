// Parse a Helius enhanced-transaction event into a single wallet's swap.
// "buy" = wallet received a token and spent SOL; "sell" = wallet sent a token
// and received SOL. Stablecoin/SOL-wrapper mints are ignored as the "token"
// leg so a USDC<->SOL move isn't mistaken for a memecoin trade.

const LAMPORTS_PER_SOL = 1_000_000_000;

const QUOTE_MINTS = new Set<string>([
  "So11111111111111111111111111111111111111112", // wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export interface ParsedTrade {
  wallet: string;
  mint: string;
  side: "buy" | "sell";
  tokenAmount: number;
  // Unsigned magnitude in SOL (never negative); `side` carries the direction.
  solAmount: number | null;
  program: string | null;
  signature: string;
  tradedAt: Date;
}

interface HeliusTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  tokenAmount?: number;
}
interface HeliusNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number;
}
interface HeliusAccountData {
  account?: string;
  nativeBalanceChange?: number;
}
// Local adapter for the Helius enhanced-tx *stream* shape (as stored in
// watch_events.payload). Intentionally distinct from ParsedTx in tx-patterns.ts,
// which drops tokenTransfers/accountData/fee — don't try to merge the two.
interface HeliusEvent {
  signature?: string;
  source?: string;
  timestamp?: number;
  fee?: number;
  tokenTransfers?: HeliusTokenTransfer[];
  nativeTransfers?: HeliusNativeTransfer[];
  accountData?: HeliusAccountData[];
}

export function parseWalletTrade(raw: unknown, wallet: string): ParsedTrade | null {
  const e = raw as HeliusEvent;
  if (!e.signature || typeof e.timestamp !== "number") return null;

  let mint: string | null = null;
  let side: "buy" | "sell" | null = null;
  let tokenAmount = 0;
  for (const t of e.tokenTransfers ?? []) {
    if (!t.mint || QUOTE_MINTS.has(t.mint)) continue;
    if (t.toUserAccount === wallet) {
      mint = t.mint;
      side = "buy";
      tokenAmount = t.tokenAmount ?? 0;
      break;
    }
    if (t.fromUserAccount === wallet) {
      mint = t.mint;
      side = "sell";
      tokenAmount = t.tokenAmount ?? 0;
      break;
    }
  }
  if (mint === null || side === null) return null;

  return {
    wallet,
    mint,
    side,
    tokenAmount,
    solAmount: solAmountFor(e, wallet),
    program: e.source ?? null,
    signature: e.signature,
    tradedAt: new Date(e.timestamp * 1000),
  };
}

// SOL moved by the wallet, as an unsigned magnitude (never negative — the
// caller's `side` carries direction). Prefer the wallet's nativeBalanceChange
// (minus the fee it paid); fall back to summing native transfers to/from the
// wallet. Returns null if neither is present (e.g. WSOL-only route).
function solAmountFor(e: HeliusEvent, wallet: string): number | null {
  const ad = (e.accountData ?? []).find((a) => a.account === wallet);
  if (ad && typeof ad.nativeBalanceChange === "number") {
    // On a sell, nativeBalanceChange is already net-of-fee (the fee-payer is the
    // same wallet), so subtracting fee again underreports SOL received by ~5000
    // lamports (~$0.001). Fine for alpha signals; revisit before PnL accounting.
    const fee = typeof e.fee === "number" ? e.fee : 0;
    const gross = Math.abs(ad.nativeBalanceChange) - fee;
    return gross > 0 ? gross / LAMPORTS_PER_SOL : Math.abs(ad.nativeBalanceChange) / LAMPORTS_PER_SOL;
  }
  let lamports = 0;
  for (const t of e.nativeTransfers ?? []) {
    if (t.toUserAccount === wallet) lamports += t.amount ?? 0;
    if (t.fromUserAccount === wallet) lamports += t.amount ?? 0;
  }
  return lamports > 0 ? lamports / LAMPORTS_PER_SOL : null;
}
