import type { ReactNode } from "react";

export type ChipTone = "mint" | "amber" | "crimson" | "slate";

const TONE: Record<ChipTone, string> = {
  mint: "text-clean border-clean/60 bg-clean/10",
  amber: "text-med border-med/60 bg-med/10",
  crimson: "text-high border-high/60 bg-high/10",
  slate: "text-secondary border-border-emphasis bg-card",
};

/** Class string for a chip tone — zero-radius hairline, severity color, /10 fill. */
export function chipToneClasses(tone: ChipTone): string {
  return `border ${TONE[tone]}`;
}

export function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 font-mono text-2xs uppercase tracking-[0.18em] ${chipToneClasses(tone)}`}
    >
      {children}
    </span>
  );
}
