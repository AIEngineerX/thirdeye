import { type DbClient, createDb } from "@thirdeye/db";
import type { Sql } from "postgres";
import { _resetIntelBus, initIntelBus } from "../src/lib/intel-bus";

export interface TestDb {
  db: DbClient;
  sql: Sql;
  cleanup: () => Promise<void>;
}

export async function setupTestDb(): Promise<TestDb> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required for tests");

  const { db, sql } = createDb(url);

  await sql.unsafe(`
    TRUNCATE auth_tokens, wallet_checks, wallets, token_scans, funders, intel_aggregates, intel_events RESTART IDENTITY CASCADE;
  `);

  await initIntelBus(sql);

  return {
    db,
    sql,
    cleanup: async () => {
      await _resetIntelBus();
      await sql.end();
    },
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor: predicate never satisfied within timeout");
}
