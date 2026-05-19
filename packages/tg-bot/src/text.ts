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

// Sanitize untrusted text before persisting it as `metadata.prompt` on an
// agent_runs row. The audit (M5) flagged the storage path: a future
// Phase 6c worker that pulls recent prompts to build LLM context would
// re-inject attacker-controlled text into a higher-trust agent context
// (semantic injection across run boundaries).
//
// We strip:
//   - C0 control characters except tab (0x09) and newline (0x0A)
//   - DEL + C1 control characters (0x7F..0x9F)
//   - Zero-width family (U+200B..U+200D, U+FEFF) that hides text visually
//   - Bidi overrides + isolates (U+202A..U+202E, U+2066..U+2069) used in
//     homograph / direction-hijack attacks
// Tabs, newlines, and ordinary printable text are preserved.
//
// Iterating by codepoint (for..of) instead of using a regex character class
// sidesteps a biome lint conflict on ZWJ inside character classes AND
// correctly handles supplementary-plane characters.
function shouldStripCodepoint(cp: number): boolean {
  if (cp <= 0x08) return true;
  if (cp >= 0x0b && cp <= 0x1f) return true;
  if (cp >= 0x7f && cp <= 0x9f) return true;
  if (cp >= 0x200b && cp <= 0x200d) return true;
  if (cp === 0xfeff) return true;
  if (cp >= 0x202a && cp <= 0x202e) return true;
  if (cp >= 0x2066 && cp <= 0x2069) return true;
  return false;
}

export function sanitizePromptForStorage(text: string): string {
  // Fast path: scan once; if nothing matches, return the original string.
  let needsStrip = false;
  for (const ch of text) {
    if (shouldStripCodepoint(ch.codePointAt(0) ?? 0)) {
      needsStrip = true;
      break;
    }
  }
  if (!needsStrip) return text;
  let out = "";
  for (const ch of text) {
    if (!shouldStripCodepoint(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}
