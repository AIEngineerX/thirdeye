import { WalletClassGlyph, tagGlyphVariant, tagLabel } from "./WalletClassGlyph";

type TagTone = "mint" | "amber" | "crimson" | "slate";

const TAG_TONE: Record<string, TagTone> = {
  SMART_MONEY: "mint",
  BUNDLER: "amber",
  BUNDLER_TIGHT: "amber",
  SYBIL: "crimson",
  FRESH_WALLET: "slate",
  FUND_DISTRIBUTOR: "amber",
  SNIPER: "crimson",
  WHALE: "slate",
  EXCHANGE: "slate",
};

const TONE_CLASSES: Record<TagTone, { color: string; border: string; bg: string }> = {
  mint: { color: "text-clean", border: "border-clean/60", bg: "bg-clean/10" },
  amber: { color: "text-med", border: "border-med/60", bg: "bg-med/10" },
  crimson: { color: "text-high", border: "border-high/60", bg: "bg-high/10" },
  slate: { color: "text-secondary", border: "border-border-emphasis", bg: "bg-card" },
};

interface TagListProps {
  tags: string[];
}

export function TagList({ tags }: TagListProps) {
  if (tags.length === 0) {
    return (
      <p className="font-mono text-2xs uppercase tracking-[0.18em] text-tertiary">
        — no tags applied —
      </p>
    );
  }

  return (
    <ul className="flex flex-wrap gap-2">
      {tags.map((tag) => {
        const tone = TONE_CLASSES[TAG_TONE[tag] ?? "slate"];
        return (
          <li
            key={tag}
            title={tag}
            className={[
              "inline-flex items-center gap-1.5 border px-2.5 py-1 font-mono text-2xs uppercase tracking-[0.18em]",
              tone.color,
              tone.border,
              tone.bg,
            ].join(" ")}
          >
            <WalletClassGlyph variant={tagGlyphVariant(tag)} size={12} className="opacity-75" />
            {tagLabel(tag)}
          </li>
        );
      })}
    </ul>
  );
}
