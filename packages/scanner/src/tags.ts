import { isExchangeAddress } from "@thirdeye/shared";
import type { Cluster, Identity, Tag, TxPattern } from "./types";

export interface TagInputs {
  identity: Identity;
  ageDays: number;
  txCount: number;
  usdValue: number;
  tokenCount: number;
  cluster: Cluster;
  txPattern: TxPattern;
  // Phase 5d: realized SOL PnL across recent SWAPs. Null when wallet has
  // no swap activity in the window or PnL was not computed for this scan.
  realizedPnlSol: number | null;
  // Threshold (in SOL) above which the wallet earns SMART_MONEY. Configurable
  // per env var SMART_MONEY_MIN_SOL — passed in by the route handler so the
  // scanner package stays env-agnostic.
  smartMoneyMinSol: number;
}

// Phase 5a tuning — values chosen for current Solana memecoin tempo
// (mid-2025 baseline). See docs/superpowers/specs/2026-05-06-thirdeye-phase-5-alpha-design.md §5a
// for rationale per constant. Revisit when launch dynamics shift.
const FRESH_AGE_DAYS = 14;
const FRESH_TX_COUNT = 20;
const DISTRIBUTOR_RECIPIENTS = 10;
const BUNDLER_MIN_SIZE = 2;
const TIME_WINDOW_MIN_TIGHT = 2;
const SYBIL_MAX_COV = 0.2;
const SNIPER_MAX_GAP_SEC = 30;
const WHALE_USD = 50_000;
const WHALE_MAX_TOKENS = 10;

export function computeTags(inputs: TagInputs): Tag[] {
  const tags: Tag[] = [];
  const funder = inputs.cluster.firstFunder;
  const funderIsExchange = isExchangeAddress(funder);

  if (inputs.identity.type === "exchange" || funderIsExchange) {
    tags.push("EXCHANGE");
  }

  if (inputs.ageDays < FRESH_AGE_DAYS && inputs.txCount < FRESH_TX_COUNT) {
    tags.push("FRESH_WALLET");
  }

  if (inputs.txPattern.uniqueOutboundRecipients >= DISTRIBUTOR_RECIPIENTS) {
    tags.push("FUND_DISTRIBUTOR");
  }

  const isBundler = inputs.cluster.size >= BUNDLER_MIN_SIZE && !funderIsExchange && funder !== null;
  if (isBundler) tags.push("BUNDLER");

  if (isBundler && inputs.cluster.timeWindowSiblings.length >= TIME_WINDOW_MIN_TIGHT) {
    tags.push("BUNDLER_TIGHT");
  }

  if (isBundler && inputs.cluster.cov !== null && inputs.cluster.cov < SYBIL_MAX_COV) {
    tags.push("SYBIL");
  }

  if (
    inputs.txPattern.rapidFire &&
    inputs.txPattern.swapOnly &&
    inputs.txPattern.avgGapSec !== null &&
    inputs.txPattern.avgGapSec < SNIPER_MAX_GAP_SEC
  ) {
    tags.push("SNIPER");
  }

  if (inputs.usdValue > WHALE_USD && inputs.tokenCount <= WHALE_MAX_TOKENS) {
    tags.push("WHALE");
  }

  // Phase 5d: SMART_MONEY — net SOL extraction from recent swaps. Suppress
  // for known exchanges (their PnL is operational, not strategic).
  if (
    inputs.realizedPnlSol !== null &&
    inputs.realizedPnlSol >= inputs.smartMoneyMinSol &&
    inputs.identity.type !== "exchange" &&
    !funderIsExchange
  ) {
    tags.push("SMART_MONEY");
  }

  return tags;
}
