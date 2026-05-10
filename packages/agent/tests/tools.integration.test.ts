import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createDb } from "@thirdeye/db";
import { resolvePriorTags } from "../src/tools";

const DATABASE_URL = process.env.DATABASE_URL;
const HAVE_DB = Boolean(DATABASE_URL);
const d = HAVE_DB ? describe : describe.skip;

if (!HAVE_DB) {
  console.log("[skip] DATABASE_URL not set — agent tools integration tests skipped");
}

d("resolvePriorTags", () => {
  let conn: ReturnType<typeof createDb>;

  beforeAll(() => {
    conn = createDb(DATABASE_URL!);
  });

  afterAll(async () => {
    await conn.sql.end();
  });

  beforeEach(async () => {
    await conn.sql`TRUNCATE wallets RESTART IDENTITY CASCADE`;
  });

  test("returns empty map for empty input without hitting the DB", async () => {
    const out = await resolvePriorTags(conn.db, []);
    expect(out.size).toBe(0);
  });

  test("binds JS-array param against text PK without postgres.js array-binding bug", async () => {
    // Regression: tools.ts originally used `sql\`${wallets.address} = ANY(${addresses})\``
    // which postgres.js + Bun expand to `ANY(($1, $2, ...))` — invalid SQL.
    // The fix is `inArray()`. This test fails on the old pattern, passes on the fix.
    await conn.sql`
      INSERT INTO wallets (address, tags) VALUES
        ('A', ARRAY['BUNDLER']::text[]),
        ('B', ARRAY['FRESH','SMART_MONEY']::text[]),
        ('C', ARRAY[]::text[])
    `;

    const out = await resolvePriorTags(conn.db, ["A", "B", "Z"]);

    expect(out.size).toBe(2);
    expect(out.get("A")).toEqual(["BUNDLER"]);
    expect(out.get("B")).toEqual(["FRESH", "SMART_MONEY"]);
    expect(out.has("Z")).toBe(false);
  });
});
