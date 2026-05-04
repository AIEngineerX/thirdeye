import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// Resolve `../drizzle` relative to this script — works from any cwd
const scriptDir = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(scriptDir, "..", "drizzle");

const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

try {
  await migrate(db, { migrationsFolder });
  console.log("migrations applied");
} finally {
  await sql.end();
}
