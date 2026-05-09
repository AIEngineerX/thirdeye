import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { createDb } from "@thirdeye/db";

const DATABASE_URL = process.env.DATABASE_URL;
const HAVE_DB = Boolean(DATABASE_URL);
const d = HAVE_DB ? describe : describe.skip;

if (!HAVE_DB) {
  console.log("[skip] DATABASE_URL not set — agent budget integration tests skipped");
}

d("acquireBudget multi-process race", () => {
  let conn: ReturnType<typeof createDb>;

  beforeAll(() => {
    conn = createDb(DATABASE_URL!);
  });

  afterAll(async () => {
    await conn.sql.end();
  });

  beforeEach(async () => {
    await conn.sql`TRUNCATE agent_runs RESTART IDENTITY CASCADE`;
  });

  test("two concurrent acquireBudget calls near the cap admit exactly one", async () => {
    // Pre-load $4.99 spent today; cap is $5; each estimate is $0.05.
    // Without the lock, both could pass the SUM check independently and
    // both insert 'running' — the test assertion below would fail.
    await conn.sql`
      INSERT INTO agent_runs (kind, status, model, cost_usd, started_at, ended_at)
      VALUES ('discovery', 'success', 'claude-haiku-4-5-20251001', '4.99', now(), now())
    `;

    const childScript = path.join(import.meta.dir, "budget-child.ts");
    const child = (label: string) =>
      spawn("bun", [childScript, label], {
        env: { ...process.env, DATABASE_URL: DATABASE_URL! },
        stdio: ["ignore", "pipe", "inherit"],
      });

    const collect = (proc: ReturnType<typeof spawn>) =>
      new Promise<{ admitted: boolean; runId: number }>((resolve, reject) => {
        let out = "";
        proc.stdout!.on("data", (c: Buffer) => {
          out += c.toString();
        });
        proc.on("close", (code) => {
          if (code !== 0) return reject(new Error(`child exited with code ${code}: ${out}`));
          const lastLine = out.trim().split("\n").pop();
          if (!lastLine) return reject(new Error("child produced no output"));
          try {
            resolve(JSON.parse(lastLine));
          } catch (e) {
            reject(new Error(`child output not JSON: ${lastLine}`));
          }
        });
      });

    const [a, b] = [child("A"), child("B")];
    const [resA, resB] = await Promise.all([collect(a), collect(b)]);
    const admittedCount = [resA.admitted, resB.admitted].filter(Boolean).length;
    expect(admittedCount).toBe(1);

    const rows = (await conn.sql`
      SELECT status FROM agent_runs
       WHERE started_at > now() - interval '1 minute'
         AND id > (SELECT MAX(id)-2 FROM agent_runs)
       ORDER BY id ASC
    `) as Array<{ status: string }>;
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toEqual(["running", "skipped_budget"].sort());
  }, 30_000);

  test("solo acquireBudget below cap admits and inserts 'running'", async () => {
    const { acquireBudget } = await import("../src/budget");
    const r = await acquireBudget({
      db: conn.db,
      kind: "discovery",
      model: "claude-haiku-4-5-20251001",
      estimatedCostUsd: 0.1,
      dailyCapUsd: 25,
    });
    expect(r.admitted).toBe(true);
    const rows = (await conn.sql`SELECT status FROM agent_runs WHERE id = ${r.runId}`) as Array<{
      status: string;
    }>;
    expect(rows[0]?.status).toBe("running");
  }, 10_000);

  test("solo acquireBudget over cap inserts 'skipped_budget' and reports admitted=false", async () => {
    await conn.sql`
      INSERT INTO agent_runs (kind, status, model, cost_usd, started_at, ended_at)
      VALUES ('discovery', 'success', 'claude-haiku-4-5-20251001', '24.99', now(), now())
    `;
    const { acquireBudget } = await import("../src/budget");
    const r = await acquireBudget({
      db: conn.db,
      kind: "discovery",
      model: "claude-haiku-4-5-20251001",
      estimatedCostUsd: 0.05,
      dailyCapUsd: 25,
    });
    expect(r.admitted).toBe(false);
    const rows = (await conn.sql`SELECT status FROM agent_runs WHERE id = ${r.runId}`) as Array<{
      status: string;
    }>;
    expect(rows[0]?.status).toBe("skipped_budget");
  }, 10_000);
});
