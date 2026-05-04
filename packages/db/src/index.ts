import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(url: string): { db: DbClient; sql: postgres.Sql } {
  const sql = postgres(url, { max: 10, idle_timeout: 20 });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
