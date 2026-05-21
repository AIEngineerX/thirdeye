/**
 * Cluster + funding chain renderer for the wallet detail page. Two stacked
 * sections separated by a hairline. Cluster summary is a definition list;
 * the funding chain is an ordered list of hops with terminus annotations.
 */

import { fmtNumber, shortAddr } from "@/lib/format";

export interface ClusterHop {
  depth: number;
  address: string;
  funder: string | null;
  fundedAt: string | null;
  signature: string | null;
  isExchange: boolean;
  isLaunchpad: boolean;
}

export interface ClusterPanelProps {
  firstFunder: string | null;
  size: number | null;
  cov: number | null;
  timeWindowSiblings?: number | null;
  fundingChain?: ClusterHop[];
}

export function ClusterPanel({
  firstFunder,
  size,
  cov,
  timeWindowSiblings,
  fundingChain = [],
}: ClusterPanelProps) {
  return (
    <section className="border border-border-subtle bg-card">
      <header className="border-b border-border-subtle px-4 py-3">
        <h3 className="font-mono text-2xs uppercase tracking-[0.22em] text-secondary">cluster</h3>
      </header>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 px-4 py-4 text-sm">
        <dt className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
          first funder
        </dt>
        <dd className="font-mono tabular text-primary">
          {firstFunder ? (
            <span title={firstFunder}>{shortAddr(firstFunder, 6, 6)}</span>
          ) : (
            <span className="text-tertiary">— unknown —</span>
          )}
        </dd>

        <dt className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
          cluster size
        </dt>
        <dd className="font-mono tabular text-primary">
          {size === null || size === 0 ? (
            <span className="text-tertiary">— singleton —</span>
          ) : (
            <span>
              {fmtNumber(size, 0)} <span className="text-tertiary">wallets</span>
            </span>
          )}
        </dd>

        <dt className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">cov</dt>
        <dd className="font-mono tabular text-primary">
          {cov === null ? (
            <span className="text-tertiary">— insufficient samples —</span>
          ) : (
            fmtNumber(cov, 3)
          )}
        </dd>

        {timeWindowSiblings !== undefined ? (
          <>
            <dt className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
              tight-window siblings
            </dt>
            <dd className="font-mono tabular text-primary">
              {timeWindowSiblings === null ? (
                <span className="text-tertiary">—</span>
              ) : (
                fmtNumber(timeWindowSiblings, 0)
              )}
            </dd>
          </>
        ) : null}
      </dl>

      {fundingChain.length > 0 ? (
        <>
          <header className="border-y border-border-subtle px-4 py-3">
            <h3 className="font-mono text-2xs uppercase tracking-[0.22em] text-secondary">
              funding chain
            </h3>
          </header>
          <ol className="px-4 py-3">
            {fundingChain.map((hop) => {
              const terminus = hop.isExchange
                ? "exchange"
                : hop.isLaunchpad
                  ? "launchpad"
                  : hop.funder === null
                    ? "unfunded"
                    : null;
              return (
                <li
                  key={`${hop.depth}-${hop.address}`}
                  className="flex items-baseline gap-3 border-b border-border-subtle/60 py-2 last:border-b-0"
                >
                  <span className="w-6 font-mono text-2xs tabular text-tertiary">{hop.depth}</span>
                  <span
                    className="flex-1 truncate font-mono tabular text-sm text-primary"
                    title={hop.address}
                  >
                    {shortAddr(hop.address, 6, 6)}
                  </span>
                  {terminus ? (
                    <span className="font-mono text-2xs uppercase tracking-[0.18em] text-accent-dim">
                      ┄ {terminus} ┄
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </section>
  );
}
