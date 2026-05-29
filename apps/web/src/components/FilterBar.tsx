"use client";

import { KbdInput } from "@/components/KbdInput";

export interface SignalFilters {
  independentOnly: boolean;
  minWallets: number;
  minCallMc: number | null;
}

export const DEFAULT_FILTERS: SignalFilters = {
  independentOnly: true,
  minWallets: 2,
  minCallMc: null,
};

const TOGGLE = (active: boolean) =>
  `border px-2 py-1 font-mono text-2xs uppercase tracking-[0.18em] transition-colors ${
    active
      ? "border-accent bg-accent-bg text-accent"
      : "border-border-emphasis text-tertiary hover:text-secondary"
  }`;

export function FilterBar({
  value,
  onChange,
}: {
  value: SignalFilters;
  onChange: (f: SignalFilters) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={TOGGLE(value.independentOnly)}
        onClick={() => onChange({ ...value, independentOnly: !value.independentOnly })}
      >
        independent only
      </button>
      <button
        type="button"
        className={TOGGLE(value.minWallets >= 3)}
        onClick={() => onChange({ ...value, minWallets: value.minWallets >= 3 ? 2 : 3 })}
      >
        ≥3 wallets
      </button>
      <span className="w-24">
        <KbdInput
          value={value.minCallMc === null ? "" : String(value.minCallMc)}
          onChange={(v: string) => {
            const tval = v.trim();
            const n = Number(tval);
            onChange({ ...value, minCallMc: tval === "" || !Number.isFinite(n) ? null : n });
          }}
          onSubmit={() => {}}
          placeholder="min MC"
          aria-label="min call market cap"
        />
      </span>
    </div>
  );
}
