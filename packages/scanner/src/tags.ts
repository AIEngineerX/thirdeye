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
  realizedPnlSol: number | null;
  smartMoneyMinSol: number;
}

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

  // Gate on positive txCount: tx-patterns.ts returns ageDays=0 / txCount=0
  // as the no-parseable-txs sentinel. Without this guard, an OLD wallet whose
  // history Helius can't parse would falsely fire FRESH_WALLET (0<14, 0<20)
  // and tip the score/verdict toward FRESH.
  if (inputs.txCount > 0 && inputs.ageDays < FRESH_AGE_DAYS && inputs.txCount < FRESH_TX_COUNT) {
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

  // exchanges' PnL is operational, not strategic
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
