const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function isValidSolanaAddress(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  return BASE58_RE.test(s);
}
