/**
 * Address banner — the visual anchor of every wallet/token detail page.
 *
 * Renders the full 32-44 character base58 address as a grid of bordered
 * cells, one cell per character. The first `head` and last `tail` characters
 * are highlighted in the brand accent color; the middle is dimmed. This
 * treats the address as evidence to be examined — the inverse of every
 * dashboard that hides it in tiny grey text.
 */

interface AddressBannerProps {
  address: string;
  /** Highlighted prefix length. Default 4. */
  head?: number;
  /** Highlighted suffix length. Default 4. */
  tail?: number;
  /** Optional kind label rendered above the banner. */
  label?: string;
}

export function AddressBanner({ address, head = 4, tail = 4, label }: AddressBannerProps) {
  const chars = Array.from(address);
  const total = chars.length;
  const tailStart = Math.max(head, total - tail);

  // 11 columns gives a readable layout for 32-44 char addresses (3-4 rows).
  // 44 / 11 = 4 rows exactly for the longest case.
  const cols = 11;

  return (
    <section className="font-mono">
      {label ? (
        <div className="mb-2 text-2xs uppercase tracking-[0.18em] text-tertiary">{label}</div>
      ) : null}
      <div
        className="grid w-full select-all gap-px overflow-hidden border border-border-subtle"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        aria-label="address"
      >
        {chars.map((ch, i) => {
          const isHighlight = i < head || i >= tailStart;
          return (
            <span
              key={`${i}-${ch}`}
              className={[
                "flex aspect-[3/4] items-center justify-center border-border-subtle bg-card text-2xl font-medium tabular leading-none",
                isHighlight ? "text-accent" : "text-tertiary",
              ].join(" ")}
            >
              {ch}
            </span>
          );
        })}
      </div>
      <div className="mt-2 break-all font-mono text-2xs uppercase tracking-[0.1em] text-tertiary">
        {address}
      </div>
    </section>
  );
}
