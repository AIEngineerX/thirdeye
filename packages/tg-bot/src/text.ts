// Return the longest prefix of `s` that fits within `maxCodeUnits` UTF-16
// code units AND does not split a surrogate pair. JavaScript's `.slice()` is
// UTF-16-indexed, so slicing inside a surrogate pair produces a lone
// surrogate — illegal in well-formed UTF-8, rejected by both JSON.stringify
// (orphan escape) and Telegram's sendMessage (invalid UTF-8). Telegram's
// own 4096-char limit is in UTF-16 code units, so this is the right bound.
export function truncateUtf16Safe(s: string, maxCodeUnits: number): string {
  if (s.length <= maxCodeUnits) return s; // fast path
  let end = 0;
  for (const ch of s) {
    if (end + ch.length > maxCodeUnits) break;
    end += ch.length;
  }
  return s.slice(0, end);
}
