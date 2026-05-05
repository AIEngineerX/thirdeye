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
  firstFunder: string | null;
}

const FRESH_AGE_DAYS = 30;
const FRESH_TX_COUNT = 50;
const DISTRIBUTOR_RECIPIENTS = 20;
const BUNDLER_MIN_SIZE = 3;
const TIME_WINDOW_MIN_TIGHT = 3;
const SYBIL_MAX_COV = 0.15;
const SNIPER_MAX_GAP_SEC = 60;
const WHALE_USD = 10_000;
const WHALE_MAX_TOKENS = 5;

export function computeTags(inputs: TagInputs): Tag[] {
  const tags: Tag[] = [];

  if (inputs.identity.type === "exchange" || isExchangeAddress(inputs.firstFunder)) {
    tags.push("EXCHANGE");
  }

  if (inputs.ageDays < FRESH_AGE_DAYS && inputs.txCount < FRESH_TX_COUNT) {
    tags.push("FRESH_WALLET");
  }

  if (inputs.txPattern.uniqueOutboundRecipients >= DISTRIBUTOR_RECIPIENTS) {
    tags.push("FUND_DISTRIBUTOR");
  }

  const funderIsExchange = isExchangeAddress(inputs.firstFunder);
  const isBundler = inputs.cluster.size >= BUNDLER_MIN_SIZE && !funderIsExchange;
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

  return tags;
}
