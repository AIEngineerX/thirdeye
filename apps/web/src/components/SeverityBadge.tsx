/**
 * Bracketed severity label — `[ HIGH ]`, `[ CLEAN ]`, etc.
 *
 * Renders flat mono text inside straight-bracket characters with a border
 * matched to severity color. Reads as a stamped evidence label, not a
 * round-corner badge. Used for risk verdicts and score buckets.
 */

export type Severity = "CLEAN" | "LOW" | "LOW_RISK" | "MEDIUM" | "HIGH" | "HIGH_RISK";

const SEVERITY_TONE: Record<Severity, { color: string; border: string; bg: string }> = {
  CLEAN: {
    color: "text-clean",
    border: "border-clean/60",
    bg: "bg-clean/10",
  },
  LOW: {
    color: "text-secondary",
    border: "border-low/60",
    bg: "bg-low/10",
  },
  LOW_RISK: {
    color: "text-secondary",
    border: "border-low/60",
    bg: "bg-low/10",
  },
  MEDIUM: {
    color: "text-med",
    border: "border-med/60",
    bg: "bg-med/10",
  },
  HIGH: {
    color: "text-high",
    border: "border-high/60",
    bg: "bg-high/10",
  },
  HIGH_RISK: {
    color: "text-high",
    border: "border-high/60",
    bg: "bg-high/10",
  },
};

interface SeverityBadgeProps {
  severity: Severity | string;
  /** When true, briefly animates on appearance (used for the final verdict reveal). */
  pulse?: boolean;
  className?: string;
}

export function SeverityBadge({ severity, pulse, className }: SeverityBadgeProps) {
  const key = severity.toUpperCase() as Severity;
  const tone = SEVERITY_TONE[key] ?? SEVERITY_TONE.LOW;

  return (
    <span
      className={[
        "inline-flex items-center border px-3 py-1 font-mono text-2xs uppercase tracking-[0.22em]",
        tone.color,
        tone.border,
        tone.bg,
        pulse ? "animate-verdict-pulse" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      [ {severity.toUpperCase()} ]
    </span>
  );
}
