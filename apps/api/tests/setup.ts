import { type DbClient, createDb } from "@thirdeye/db";
import type { Sql } from "postgres";

export interface TestDb {
  db: DbClient;
  sql: Sql;
  cleanup: () => Promise<void>;
}

/**
 * Connects to the running Postgres (must be `docker compose up -d postgres`)
 * and TRUNCATEs all writeable tables so each test starts from a clean slate.
 * We do not mock the DB — integration tests use the real one (CLAUDE.md rule).
 */
export async function setupTestDb(): Promise<TestDb> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required for tests");

  const { db, sql } = createDb(url);

  await sql.unsafe(`
    TRUNCATE auth_tokens, wallet_checks, wallets, token_scans, funders, intel_aggregates, intel_events RESTART IDENTITY CASCADE;
  `);

  return {
    db,
    sql,
    cleanup: async () => {
      await sql.end();
    },
  };
}
