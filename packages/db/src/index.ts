export type { Sql } from "postgres";

import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

// Helper for callers that need to accept either a top-level DbClient or a
// transaction handle from db.transaction(async (tx) => ...). Drizzle's
// PgTransaction is structurally compatible with DbClient for query methods
// (select/insert/update/delete/execute) but lacks the $client property.
export type DbExecutor =
  | DbClient
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

export function createDb(url: string): { db: DbClient; sql: postgres.Sql } {
  const sql = postgres(url, { max: 10, idle_timeout: 20 });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
