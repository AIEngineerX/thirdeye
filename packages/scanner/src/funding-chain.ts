import { isExchangeAddress, isLaunchpadFunder, isTerminalFunder } from "@thirdeye/shared";
import type { FundingHop } from "./types";

export type FundedByResolver = (address: string) => Promise<{
  funder: string | null;
  signature: string | null;
  fundedAt: string | null;
}>;

export interface TraceInputs {
  startAddress: string;
  maxHops: number;
  resolveFundedBy: FundedByResolver;
}

// Cycle-guarded via Set<address> so a funder loop terminates.
export async function traceFundingChain(inputs: TraceInputs): Promise<FundingHop[]> {
  const chain: FundingHop[] = [];
  let cursor: string = inputs.startAddress;
  const seen = new Set<string>([cursor]);

  for (let depth = 0; depth < inputs.maxHops; depth++) {
    const r = await inputs.resolveFundedBy(cursor);
    const hop: FundingHop = {
      depth,
      address: cursor,
      funder: r.funder,
      fundedAt: r.fundedAt,
      signature: r.signature,
      isExchange: isExchangeAddress(r.funder),
      isLaunchpad: isLaunchpadFunder(r.funder),
    };
    chain.push(hop);

    if (r.funder === null) break;
    if (isTerminalFunder(r.funder)) break;
    if (seen.has(r.funder)) break; // cycle guard
    seen.add(r.funder);
    cursor = r.funder;
  }

  return chain;
}
