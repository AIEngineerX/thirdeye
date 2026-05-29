/**
 * Dense signal card for the live alpha dashboard.
 * Renders a DashboardSignal as a three-row terminal card: symbol + trust,
 * call→ATH multiple, and a proportional bar + relative age.
 */

import { ActionRow } from "@/components/ActionRow";
import { Chip } from "@/components/Chip";
import type { DashboardSignal } from "@/lib/api-types";
import { fmtMoneyCompact, fmtRelative, shortAddr } from "@/lib/format";
import Link from "next/link";

interface SignalCardProps {
  signal: DashboardSignal;
}

/** Clamp bar width 4–100% proportional to multiple, capped at 20x = 100%. */
function barWidth(multiple: number | null): string {
  if (multiple === null || !Number.isFinite(multiple) || multiple <= 1) return "4%";
  const pct = Math.min(100, Math.max(4, ((multiple - 1) / 19) * 100));
  return `${pct.toFixed(1)}%`;
}

export function SignalCard({ signal }: SignalCardProps) {
  const {
    mint,
    symbol,
    wallet_count,
    trust,
    call_mc,
    current_mc,
    ath_multiplier,
    safe_ath_multiplier,
    is_hit,
    detected_at,
  } = signal;

  const label = symbol ?? shortAddr(mint);
  const isIndep = trust === "independent" || trust === "indep";
  const headline = safe_ath_multiplier ?? ath_multiplier;
  // Target MC: show ATH MC proxy (call_mc * headline) if available, else current_mc
  const targetMc = headline !== null && call_mc !== null ? call_mc * headline : current_mc;

  const dots = Math.min(wallet_count, 8);

  return (
    <article className="border border-border-subtle bg-card transition-colors hover:bg-card-hover">
      {/* Row 1: symbol link · wallet dots · trust chip */}
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <Link
          href={`/token/${mint}`}
          className="font-mono text-sm font-medium text-primary hover:text-accent"
          title={mint}
        >
          {label}
        </Link>

        {/* wallet dot count */}
        <span
          className="flex items-center gap-0.5 font-mono text-2xs text-tertiary"
          title={`${wallet_count} wallets`}
        >
          {Array.from({ length: dots }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: purely visual positional dots
            <span key={i} className="text-accent" aria-hidden="true">
              ●
            </span>
          ))}
          {wallet_count > 8 ? (
            <span className="ml-0.5 tabular text-tertiary">+{wallet_count - 8}</span>
          ) : null}
          <span className="ml-1 tabular text-secondary">×{wallet_count}</span>
        </span>

        {/* trust chip — right-aligned */}
        <span className="ml-auto flex items-center gap-1.5">
          <Chip tone={isIndep ? "mint" : "crimson"}>{isIndep ? "indep" : "⚠ co-funded"}</Chip>
          {is_hit ? <Chip tone="mint">HIT</Chip> : null}
        </span>
      </div>

      {/* Row 2: call MC → ATH MC · multiple · HIT badge */}
      <div className="flex items-baseline gap-2 px-3 py-1.5">
        <span className="font-mono tabular text-xs text-secondary">
          call <span className="text-primary">{fmtMoneyCompact(call_mc)}</span>
        </span>
        <span className="font-mono text-2xs text-tertiary" aria-hidden="true">
          →
        </span>
        <span className="font-mono tabular text-xs text-secondary">
          ath <span className="text-primary">{fmtMoneyCompact(targetMc)}</span>
        </span>

        {headline !== null ? (
          <span className="font-mono tabular text-sm font-medium text-accent">
            {headline.toFixed(1)}x
          </span>
        ) : null}

        {!is_hit ? (
          <span className="ml-auto font-mono text-2xs uppercase tracking-[0.18em] text-tertiary/60">
            open
          </span>
        ) : null}
      </div>

      {/* Row 3: proportional bar + age */}
      <div className="flex items-center gap-3 px-3 pb-2.5">
        <div className="h-0.5 flex-1 bg-border-subtle">
          <div
            className={`h-full ${is_hit ? "bg-clean" : "bg-accent-dim"}`}
            style={{ width: barWidth(headline) }}
          />
        </div>
        <span className="shrink-0 font-mono text-2xs tabular text-tertiary">
          {fmtRelative(detected_at)}
        </span>
      </div>

      {/* Footer: action buttons */}
      <div className="border-t border-border-subtle/60 px-3 py-2">
        <ActionRow address={mint} kind="mint" />
      </div>
    </article>
  );
}
