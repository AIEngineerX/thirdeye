// Pure signal math — no DB, no I/O. Shared by the live outcome worker
// (apps/api/src/workers/signals-refresh.ts) and the offline backtest
// (scripts/backtest/replay.ts) so both score signals identically.

export interface OutcomeInput {
  /** Market cap (USD) snapshotted when the signal fired. */
  callMc: number | null;
  /** Conservative base re-snapshotted ~3 min after first buy. */
  safeCallMc: number | null;
  /** Latest observed market cap (USD). */
  currentMc: number | null;
  /** Highest market cap seen so far for this signal (USD), or null if none yet. */
  priorAthMc: number | null;
  /** A signal "hits" when ath/callMc >= this multiple. */
  hitMultiplier: number;
}

export interface OutcomeResult {
  athMc: number | null;
  athMultiplier: number | null;
  safeAthMultiplier: number | null;
  isHit: boolean;
  safeIsHit: boolean;
  /** True when currentMc set a new all-time-high this evaluation. */
  newPeak: boolean;
}

export function computeOutcome(input: OutcomeInput): OutcomeResult {
  const { callMc, safeCallMc, currentMc, priorAthMc, hitMultiplier } = input;

  const prior = priorAthMc ?? 0;
  const cur = currentMc ?? 0;
  const newPeak = currentMc !== null && cur > prior;
  const athNum = Math.max(prior, cur);
  const athMc = athNum > 0 ? athNum : null;

  const athMultiplier = callMc && callMc > 0 && athMc ? athMc / callMc : null;
  const safeAthMultiplier = safeCallMc && safeCallMc > 0 && athMc ? athMc / safeCallMc : null;

  return {
    athMc,
    athMultiplier,
    safeAthMultiplier,
    isHit: athMultiplier !== null && athMultiplier >= hitMultiplier,
    safeIsHit: safeAthMultiplier !== null && safeAthMultiplier >= hitMultiplier,
    newPeak,
  };
}
