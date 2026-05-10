import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "@thirdeye/db";
import { dispatchTool } from "../src/dispatch";

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
});
