import { describe, expect, test } from "bun:test";
import { sanitizePromptForStorage, truncateUtf16Safe } from "../src/text";

describe("truncateUtf16Safe", () => {
  test("returns input unchanged when under limit", () => {
    expect(truncateUtf16Safe("abc", 10)).toBe("abc");
  });

  test("truncates ASCII at exact boundary", () => {
    expect(truncateUtf16Safe("abcdef", 3)).toBe("abc");
  });

  test("stops short rather than splitting a surrogate pair", () => {
    // 🔥 is U+1F525 → UTF-16 surrogate pair (2 code units)
    // Input is 199 'x' + 🔥 + tail = 199 + 2 + tail UTF-16 units.
    // Budget = 200 UTF-16 units. Including 🔥 would push to 201, so we stop
    // at 199 instead of splitting the surrogate.
    const head = "x".repeat(199);
    const fire = "\u{1F525}";
    const out = truncateUtf16Safe(`${head}${fire}xxxxxx`, 200);
    expect(out).toBe(head);
    expect(out.length).toBe(199);
    expect(() => JSON.parse(JSON.stringify({ s: out }))).not.toThrow();
  });

  test("includes the surrogate pair when the budget exactly fits it", () => {
    const head = "x".repeat(198);
    const fire = "\u{1F525}";
    const out = truncateUtf16Safe(`${head}${fire}xxxxxx`, 200);
    expect(out).toBe(`${head}${fire}`);
    expect(out.length).toBe(200);
    // Final codepoint is the full emoji
    expect([...out].pop()).toBe(fire);
  });

  test("never returns a lone surrogate at any boundary", () => {
    // For every boundary near the emoji, the output must be a valid UTF-16
    // sequence (no orphan high surrogate).
    const fire = "\u{1F525}";
    const input = `${"a".repeat(50)}${fire}${"b".repeat(50)}`;
    for (let budget = 0; budget <= input.length + 2; budget++) {
      const out = truncateUtf16Safe(input, budget);
      // Last code unit, if any, must not be a high surrogate
      const lastCode = out.length === 0 ? 0 : out.charCodeAt(out.length - 1);
      const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
      expect(isHighSurrogate).toBe(false);
      expect(() => JSON.stringify({ s: out })).not.toThrow();
    }
  });

  test("budget=0 returns empty string", () => {
    expect(truncateUtf16Safe("anything", 0)).toBe("");
  });

  test("only emojis: truncates at code-unit boundary respecting pairs", () => {
    const fire = "\u{1F525}";
    // 5 emojis = 10 UTF-16 units. Budget=7 fits 3 emojis (6 units), not 4 (would be 8).
    const out = truncateUtf16Safe(fire.repeat(5), 7);
    expect(out).toBe(fire.repeat(3));
    expect(out.length).toBe(6);
  });
});

describe("sanitizePromptForStorage (M5)", () => {
  test("preserves ordinary text, tabs, and newlines", () => {
    const s = "check VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1\n\there";
    expect(sanitizePromptForStorage(s)).toBe(s);
  });

  test("strips C0 control characters except tab and newline", () => {
    expect(sanitizePromptForStorage("a\x00b\x07c")).toBe("abc");
    expect(sanitizePromptForStorage("ESC=\x1B[31mred\x1B[0m")).toBe("ESC=[31mred[0m");
    expect(sanitizePromptForStorage("DEL\x7Fhere")).toBe("DELhere");
  });

  test("strips C1 control characters", () => {
    expect(sanitizePromptForStorage("a\x80b\x9Fc")).toBe("abc");
  });

  test("strips zero-width characters that hide content visually", () => {
    // U+200B ZERO WIDTH SPACE between two visible chars
    expect(sanitizePromptForStorage("a​b")).toBe("ab");
    expect(sanitizePromptForStorage("a‌‍﻿b")).toBe("ab");
  });

  test("strips bidi override/isolate marks (homograph attack vector)", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE
    expect(sanitizePromptForStorage("safe‮dangerous")).toBe("safedangerous");
    expect(sanitizePromptForStorage("‪‫‬‭‮x⁦⁧⁨⁩")).toBe("x");
  });

  test("preserves emoji codepoints", () => {
    const fire = "\u{1F525}";
    expect(sanitizePromptForStorage(`hot ${fire}`)).toBe(`hot ${fire}`);
  });

  test("empty input → empty output", () => {
    expect(sanitizePromptForStorage("")).toBe("");
  });
});
