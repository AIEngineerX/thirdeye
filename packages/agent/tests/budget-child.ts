// Spawned by budget.integration.test.ts to exercise concurrent acquireBudget.
// Reads label from argv, writes one JSON line { admitted, runId } to stdout, exits.
import { createDb } from "@thirdeye/db";
import { acquireBudget } from "../src/budget";

async function main(): Promise<void> {
  const label = process.argv[2] ?? "?";
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const { db, sql } = createDb(url);

  // Tiny stagger so both processes are guaranteed to race for the lock
  // simultaneously. Without it, the first arrival could commit before the
  // second even tries to acquire — making the lock untestable.
  const start = Date.now() + 100;
  while (Date.now() < start) {
    await new Promise((r) => setTimeout(r, 5));
  }

  try {
    const r = await acquireBudget({
      db,
      kind: "discovery",
      model: "claude-haiku-4-5-20251001",
      estimatedCostUsd: 0.05,
      dailyCapUsd: 5,
      metadata: { label },
    });
    console.log(JSON.stringify({ admitted: r.admitted, runId: r.runId }));
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
