import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createDb } from "@thirdeye/db";
import { _resetMcpDispatchCount, dispatchTool } from "../src/dispatch";

const DATABASE_URL = process.env.DATABASE_URL;
const HAVE_DB = Boolean(DATABASE_URL);
const d = HAVE_DB ? describe : describe.skip;

if (!HAVE_DB) {
  console.log("[skip] DATABASE_URL not set — mcp-server dispatch tests skipped");
}

d("dispatchTool", () => {
  let conn: ReturnType<typeof createDb>;

  beforeAll(() => {
    conn = createDb(DATABASE_URL!);
  });

  afterAll(async () => {
    await conn.sql.end();
  });

  beforeEach(() => {
    _resetMcpDispatchCount();
  });

  test("getHotTokens returns content array even when tokens table is empty", async () => {
    const r = await dispatchTool(
      "getHotTokens",
      { limit: 5 },
      { db: conn.db, serverHeliusKey: undefined, smartMoneyMinSol: 50 },
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toBeInstanceOf(Array);
    expect(r.content[0]?.type).toBe("text");
    const parsed = JSON.parse((r.content[0] as { text: string }).text);
    expect(parsed).toHaveProperty("tokens");
    expect(Array.isArray(parsed.tokens)).toBe(true);
  });

  test("unknown tool name returns isError:true", async () => {
    const r = await dispatchTool(
      "nonexistent",
      {},
      { db: conn.db, serverHeliusKey: undefined, smartMoneyMinSol: 50 },
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/unknown_tool/i);
  });

  test("invalid input (zod fails) returns isError:true with parse details", async () => {
    const r = await dispatchTool(
      "checkWallet",
      { address: "tooshort" },
      { db: conn.db, serverHeliusKey: undefined, smartMoneyMinSol: 50 },
    );
    expect(r.isError).toBe(true);
  });

  test("F5: refuses tool calls past MCP_MAX_TOOL_CALLS_PER_SESSION", async () => {
    process.env.MCP_MAX_TOOL_CALLS_PER_SESSION = "3";
    try {
      _resetMcpDispatchCount();
      const ctx = { db: conn.db, serverHeliusKey: undefined, smartMoneyMinSol: 50 };
      const r1 = await dispatchTool("getHotTokens", { limit: 1 }, ctx);
      const r2 = await dispatchTool("getHotTokens", { limit: 1 }, ctx);
      const r3 = await dispatchTool("getHotTokens", { limit: 1 }, ctx);
      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
      expect(r3.isError).toBeFalsy();

      const blocked = await dispatchTool("getHotTokens", { limit: 1 }, ctx);
      expect(blocked.isError).toBe(true);
      expect((blocked.content[0] as { text: string }).text).toMatch(/session_tool_cap_reached/);
    } finally {
      // biome-ignore lint/performance/noDelete: see env.ts notes — assigning undefined coerces to "undefined" string.
      delete process.env.MCP_MAX_TOOL_CALLS_PER_SESSION;
    }
  });

  test("F2: tool handler errors are logged but not echoed verbatim to caller", async () => {
    _resetMcpDispatchCount();
    // checkWallet with a syntactically valid b58 address but no Helius key
    // will throw from the scanner internals. The previous code returned the
    // raw e.message which can contain DB/library-internal detail.
    const r = await dispatchTool(
      "checkWallet",
      { address: "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1" },
      { db: conn.db, serverHeliusKey: undefined, smartMoneyMinSol: 50 },
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse((r.content[0] as { text: string }).text);
    expect(body.error).toBe("tool_error");
    expect(body.message).toMatch(/checkWallet failed/);
    // No raw library-internal detail in the message
    expect(body.message).not.toMatch(/at /); // stack traces include "at "
  });
});
