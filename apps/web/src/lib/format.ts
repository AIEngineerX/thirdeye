/**
 * Display formatters. Pure functions, no DOM access, fully unit-testable.
 */

/** Truncate a base58 address to `{head}…{tail}` with default 4/4 char split. */
export function shortAddr(addr: string, head = 4, tail = 4): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** Number with thousands separator, no decimals. */
export function fmtInt(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

/** Number with thousands separator + variable decimals. */
export function fmtNumber(n: number, decimals = 2): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

/** Format SOL amounts with sign + 2 decimals, e.g. "+47.30 SOL" or "−12.40 SOL". */
export function fmtSol(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${fmtNumber(Math.abs(n), 2)} SOL`;
}

/** Percentage with N decimals + trailing %. Null → "—". */
export function fmtPct(n: number | null, decimals = 2): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${fmtNumber(n, decimals)}%`;
}

/** USD amount with $ prefix + thousands separator. Null → "—". */
export function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `$${fmtNumber(n, 2)}`;
}

function compactUsd(abs: number): string {
  if (abs >= 1e9) return `$${fmtNumber(abs / 1e9, 2)}B`;
  if (abs >= 1e6) return `$${fmtNumber(abs / 1e6, 2)}M`;
  if (abs >= 1e3) return `$${fmtNumber(abs / 1e3, 1)}K`;
  return `$${fmtNumber(abs, 2)}`;
}

/** USD with K/M/B suffix for large values. Null → "—". e.g. "$40.96M". */
export function fmtUsdCompact(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return compactUsd(Math.abs(n));
}

/** Compact USD with an explicit +/− sign — for PnL. e.g. "+$40.96M", "−$1.2K". */
export function fmtUsdSigned(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${compactUsd(Math.abs(n))}`;
}

/** Relative time from an epoch-millisecond timestamp: "12s ago", "4m ago". */
export function fmtRelativeMs(ms: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** ISO8601 → "HH:MM:SS.mmm" local time. Used in the intel feed tail. */
export function fmtClockMs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Relative time from now: "12s ago", "4m ago", "2h ago". */
export function fmtRelative(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const seconds = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Days remaining between now and an ISO timestamp. Returns whole days. */
export function fmtDaysUntil(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const seconds = Math.max(0, Math.floor((t - nowMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Base58 32-44 char check. Matches the api's `isValidSolanaAddress`. */
export function isValidSolanaAddress(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

/**
 * Compact money formatter for signal cards: $75k, $1.2m, $2.4b.
 * Lowercase suffixes to match the terminal aesthetic. Null → "—".
 */
export function fmtMoneyCompact(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(1)}b`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}m`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(0)}k`;
  return `$${abs.toFixed(0)}`;
}
