import { type DbClient, createDb } from "@thirdeye/db";
import type { Sql } from "postgres";
import { _resetIntelBus, initIntelBus } from "../src/lib/intel-bus";

export interface TestDb {
  db: DbClient;
  sql: Sql;
  cleanup: () => Promise<void>;
}

/**
 * Connects to the running Postgres (must be `docker compose up -d postgres`)
 * and TRUNCATEs all writeable tables so each test starts from a clean slate.
 * We do not mock the DB — integration tests use the real one (CLAUDE.md rule).
 *
 * Also initializes the intel-bus LISTEN connection so route handlers that call
 * publish() work correctly. Tests that need bus isolation (intel-bus.test.ts,
 * intel-bus-overflow.test.ts, intel-feed.integration.test.ts) manage the bus
 * themselves via _resetIntelBus / initIntelBus in their beforeEach/afterEach.
 */
export async function setupTestDb(): Promise<TestDb> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required for tests");

  const { db, sql } = createDb(url);

  await sql.unsafe(`
    TRUNCATE auth_tokens, wallet_checks, wallets, token_scans, funders, intel_aggregates, intel_events RESTART IDENTITY CASCADE;
  `);

  // Ensure bus is initialized for this test file. If another test file already
  // initialized it (module-level await in index.ts) this is a no-op. If a
  // prior test file's afterEach reset it, this re-establishes the connection.
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
