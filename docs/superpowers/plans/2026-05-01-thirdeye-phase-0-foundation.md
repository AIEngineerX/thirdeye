# ThirdEye — Phase 0: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boot a Bun + Hono monorepo with Postgres, Drizzle migrations applied, anonymous-session-token auth working end-to-end, and a `docker compose up` self-host story. Working software, testable, deployable.

**Architecture:** Bun-workspace monorepo (`apps/api`, `packages/db`, `packages/shared`). Hono serves `POST /api/db/auth` issuing random base64url tokens persisted in `auth_tokens`. Middleware validates `X-Auth-Token` on protected routes. Drizzle-generated SQL migrations applied to a real Postgres via `bun run migrate`. Tests run with `bun:test` against an actual Postgres container (no mocks).

**Tech Stack:** Bun 1.2.x, Hono ^4.6, Drizzle ORM ^0.39, drizzle-kit ^0.31, postgres-js ^3.4, Postgres 16, Biome ^1.9 (lint+format), Docker Compose, GitHub Actions, TypeScript strict.

**Spec reference:** `docs/superpowers/specs/2026-05-01-thirdeye-design.md` — §5 stack, §7 auth model, §9 data model, §15 deployment.

**Corrections applied from gap analysis (2026-05-02):** single-root tsconfig with paths instead of project references; `@types/bun` (not `bun-types`); CORS `allowHeaders`/`allowMethods` for `X-Auth-Token` + `X-User-Helius-Key`; `bigserial` `mode: "number"` (BigInt isn't JSON-serializable); idiomatic `export default { port, fetch }` Bun pattern; `app.onError`/`app.notFound`; `.dockerignore`, `.gitattributes`, `.env` copy step; bumped Drizzle to current; `bun --hot` for dev; Biome formatter; CONTRIBUTING.md stub.

---

## File Structure

```
thirdeye/
├── package.json                       # NEW — Bun workspaces root, scripts
├── bun.lock                           # NEW — generated (text format, Bun 1.2+)
├── tsconfig.json                      # NEW — single root tsconfig with path aliases
├── biome.json                         # NEW — lint + format config
├── docker-compose.yml                 # NEW — app + postgres
├── .env.example                       # NEW
├── .editorconfig                      # NEW
├── .gitattributes                     # NEW — line endings (LF everywhere except .bat)
├── .dockerignore                      # NEW — keep build context clean
├── CONTRIBUTING.md                    # NEW — OSS contributor stub
├── .github/
│   └── workflows/
│       └── ci.yml                     # NEW — lint, typecheck, migrate, test
├── apps/
│   └── api/
│       ├── package.json               # NEW
│       ├── tsconfig.json              # NEW (extends root, no composite)
│       ├── Dockerfile                 # NEW — multi-stage Bun 1.2 build
│       ├── src/
│       │   ├── index.ts               # NEW — Hono app, error handlers, idiomatic Bun export
│       │   ├── env.ts                 # NEW — env var validation
│       │   ├── routes/
│       │   │   └── auth.ts            # NEW — POST /api/db/auth
│       │   ├── middleware/
│       │   │   └── auth.ts            # NEW — X-Auth-Token validator
│       │   └── lib/
│       │       └── tokens.ts          # NEW — generateToken()
│       └── tests/
│           ├── setup.ts               # NEW — test DB bootstrap
│           ├── tokens.test.ts         # NEW
│           ├── auth.test.ts           # NEW
│           └── middleware-auth.test.ts # NEW
└── packages/
    ├── shared/
    │   ├── package.json               # NEW
    │   ├── tsconfig.json              # NEW
    │   └── src/
    │       └── index.ts               # NEW — barrel; will grow
    └── db/
        ├── package.json               # NEW
        ├── tsconfig.json              # NEW
        ├── drizzle.config.ts          # NEW
        ├── scripts/
        │   └── migrate.ts             # NEW — apply migrations (location-independent)
        ├── src/
        │   ├── index.ts               # NEW — client + db handle
        │   └── schema.ts              # NEW — all 6 tables (spec §9)
        └── drizzle/                   # GENERATED — sql migrations
```

Each file has one responsibility. Bun workspaces resolve `@thirdeye/*` package imports at runtime via `package.json`; TypeScript resolves them at compile time via the root `tsconfig.json` `paths` map.

---

## Task 1: Root Bun monorepo + single-tsconfig + line endings

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.editorconfig`
- Create: `.gitattributes`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "thirdeye",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "typecheck": "bun --bun tsc --noEmit -p tsconfig.json",
    "test": "bun test",
    "dev": "bun --hot run apps/api/src/index.ts",
    "migrate": "bun run packages/db/scripts/migrate.ts",
    "lint": "biome check .",
    "format": "biome format --write ."
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/bun": "latest",
    "@biomejs/biome": "^1.9.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json` (single root, path aliases — no project references)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["@types/bun"],
    "baseUrl": ".",
    "paths": {
      "@thirdeye/*": ["packages/*/src", "apps/*/src"]
    }
  },
  "include": [
    "apps/**/src/**/*",
    "apps/**/tests/**/*",
    "packages/**/src/**/*",
    "packages/**/scripts/**/*",
    "packages/**/drizzle.config.ts"
  ]
}
```

- [ ] **Step 3: Write `.editorconfig`**

```
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 4: Write `.gitattributes`**

```
* text=auto eol=lf
*.sh text eol=lf
*.bat text eol=crlf
*.lockb binary
```

- [ ] **Step 5: Verify `bun install` works**

Run: `bun install`
Expected: creates `bun.lockb`, no errors. `node_modules/typescript`, `node_modules/@types/bun`, `node_modules/@biomejs/biome` all exist.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .editorconfig .gitattributes bun.lock
git commit -m "chore: monorepo — initialize bun workspaces with strict typescript and biome"
```

---

## Task 2: `packages/shared` scaffold

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`

- [ ] **Step 1: Write `packages/shared/package.json`**

```json
{
  "name": "@thirdeye/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

- [ ] **Step 2: Write `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write `packages/shared/src/index.ts`**

```typescript
// Reserved for shared types and constants. Populated in later phases:
//   - Helius response types (Phase 1)
//   - LP/lock program addresses (Phase 3)
//   - Tag enum, verdict thresholds (Phase 2)
export const PACKAGE_NAME = "@thirdeye/shared" as const;
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "chore: shared — add empty workspace package for shared types"
```

---

## Task 3: `packages/db` schema (all 6 tables from spec §9)

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema.ts`
- Create: `packages/db/src/index.ts`

- [ ] **Step 1: Write `packages/db/package.json`** (Drizzle on current versions)

```json
{
  "name": "@thirdeye/db",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./schema": "./src/schema.ts"
  },
  "dependencies": {
    "drizzle-orm": "^0.39.0",
    "postgres": "^3.4.0"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31.0"
  }
}
```

- [ ] **Step 2: Write `packages/db/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "include": ["src/**/*", "scripts/**/*", "drizzle.config.ts"]
}
```

- [ ] **Step 3: Write `packages/db/drizzle.config.ts`**

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://thirdeye:thirdeye@localhost:5432/thirdeye",
  },
});
```

- [ ] **Step 4: Write `packages/db/src/schema.ts`** (`bigserial` uses `mode: "number"` so JSON.stringify doesn't choke on BigInt)

```typescript
import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  numeric,
  boolean,
  bigserial,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Anonymous session tokens — spec §7, §9
export const authTokens = pgTable("auth_tokens", {
  token: text("token").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true })
    .notNull()
    .default(sql`now() + interval '7 days'`),
  rateBucket: jsonb("rate_bucket").notNull().default(sql`'{}'::jsonb`),
});

// Wallets — cached profiles, spec §9
export const wallets = pgTable(
  "wallets",
  {
    address: text("address").primaryKey(),
    firstFunder: text("first_funder"),
    fundedAt: timestamp("funded_at", { withTimezone: true }),
    solBalance: numeric("sol_balance"),
    usdValue: numeric("usd_value"),
    txCount: integer("tx_count"),
    ageDays: integer("age_days"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    lastChecked: timestamp("last_checked", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firstFunderIdx: index("wallets_first_funder_idx").on(t.firstFunder),
    tagsIdx: index("wallets_tags_idx").using("gin", t.tags),
  }),
);

// Wallet checks — history of /wallet-check writes, spec §9
// `id` mode: "number" — JS number is safe to 2^53, far beyond any realistic count.
// `mode: "bigint"` would return native BigInt which is NOT JSON-serializable
// and would throw inside Hono's c.json().
export const walletChecks = pgTable(
  "wallet_checks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    address: text("address")
      .notNull()
      .references(() => wallets.address),
    score: integer("score").notNull(),
    verdict: text("verdict").notNull(), // CLEAN | LOW | MEDIUM | HIGH
    payload: jsonb("payload").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    addressIdx: index("wallet_checks_address_idx").on(t.address, t.checkedAt.desc()),
  }),
);

// Token scans — history of /scan writes, spec §9
export const tokenScans = pgTable(
  "token_scans",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    mint: text("mint").notNull(),
    symbol: text("symbol"),
    name: text("name"),
    launchpad: text("launchpad"),
    totalHolders: integer("total_holders"),
    scannedHolders: integer("scanned_holders"),
    clusterCount: integer("cluster_count"),
    clusteredPct: numeric("clustered_pct"),
    lpPct: numeric("lp_pct"),
    lockedPct: numeric("locked_pct"),
    riskPct: numeric("risk_pct"),
    sybilFlag: boolean("sybil_flag").notNull().default(false),
    verdict: text("verdict"), // CLEAN | LOW_RISK | HIGH_RISK
    payload: jsonb("payload").notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    mintIdx: index("token_scans_mint_idx").on(t.mint, t.scannedAt.desc()),
  }),
);

// Funders — denormalized for fast funder-fanout queries, spec §9
export const funders = pgTable(
  "funders",
  {
    address: text("address").primaryKey(),
    fanoutCount: integer("fanout_count").notNull().default(0),
    clusterCount: integer("cluster_count").notNull().default(0),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fanoutIdx: index("funders_fanout_idx").on(t.fanoutCount.desc()),
  }),
);

// Aggregates — refreshed every 30s by cron, spec §9
export const intelAggregates = pgTable("intel_aggregates", {
  key: text("key").primaryKey(), // '24h_pulse' | 'all_time' | 'risk_dist' | 'heatmap'
  payload: jsonb("payload").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 5: Write `packages/db/src/index.ts`**

```typescript
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
```

- [ ] **Step 6: Install deps**

Run: `bun install`
Expected: `drizzle-orm@^0.39`, `postgres@^3.4`, `drizzle-kit@^0.31` resolve.

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/db bun.lock
git commit -m "chore: db — add drizzle schema for all six tables (spec §9)"
```

(`bun.lock` changes whenever deps are added — always include it in the same commit so CI's `--frozen-lockfile` stays consistent.)

---

## Task 4: Postgres via docker-compose + `.env` setup

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

- [ ] **Step 1: Write `docker-compose.yml`** (Postgres only for now; app service added in Task 11)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: thirdeye-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: thirdeye
      POSTGRES_PASSWORD: thirdeye
      POSTGRES_DB: thirdeye
    ports:
      - "5432:5432"
    volumes:
      - thirdeye-pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U thirdeye -d thirdeye"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  thirdeye-pg-data:
```

- [ ] **Step 2: Write `.env.example`**

```
# Postgres connection — used by API server and migrations
DATABASE_URL=postgres://thirdeye:thirdeye@localhost:5432/thirdeye

# Helius API key (Phase 1) — required for real Helius proxying
# HELIUS_API_KEY=

# Public instance mode — when true, anonymous-token rate limits are enforced (spec §16)
PUBLIC_INSTANCE_MODE=false

# API listen port
PORT=3001

# CORS allowed origin (web app dev URL)
CORS_ORIGIN=http://localhost:3000
```

- [ ] **Step 3: Copy to local `.env`**

Run: `cp .env.example .env`
(`.env` is in `.gitignore`; never committed.)

- [ ] **Step 4: Bring up Postgres**

Run: `docker compose up -d postgres`
Wait for healthy: `docker compose ps postgres` shows `(healthy)`.

- [ ] **Step 5: Verify connection**

Run: `docker compose exec postgres psql -U thirdeye -d thirdeye -c "SELECT version();"`
Expected: version output, no error.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "chore: docker — add postgres service and env example"
```

---

## Task 5: Drizzle migration generation + apply script (location-independent)

**Files:**
- Create: `packages/db/scripts/migrate.ts`

- [ ] **Step 1: Write `packages/db/scripts/migrate.ts`** (uses `import.meta.url` so it runs from any cwd)

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// Resolve `../drizzle` relative to this script — works from any cwd
const migrationsFolder = new URL("../drizzle", import.meta.url).pathname;

const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

await migrate(db, { migrationsFolder });
console.log("migrations applied");
await sql.end();
```

- [ ] **Step 2: Generate the initial migration**

Run from repo root: `bunx drizzle-kit generate --config=packages/db/drizzle.config.ts`
Expected: a new SQL file appears at `packages/db/drizzle/0000_<adjective>_<noun>.sql` containing 6 `CREATE TABLE` statements + indexes.

- [ ] **Step 3: Apply the migration**

Run: `bun run migrate`
Expected: prints `migrations applied`, exits 0.

- [ ] **Step 4: Verify tables exist**

Run: `docker compose exec postgres psql -U thirdeye -d thirdeye -c "\dt"`
Expected: 6 rows (the 6 ThirdEye tables in the `public` schema):
```
auth_tokens
funders
intel_aggregates
token_scans
wallet_checks
wallets
```

(Drizzle's `__drizzle_migrations` lives in a separate `drizzle` schema. To see it: `\dt drizzle.*` or `SELECT count(*) FROM drizzle.__drizzle_migrations`.)

- [ ] **Step 5: Verify indexes**

Run: `docker compose exec postgres psql -U thirdeye -d thirdeye -c "\di"`
Expected includes: `wallets_first_funder_idx`, `wallets_tags_idx`, `wallet_checks_address_idx`, `token_scans_mint_idx`, `funders_fanout_idx`.

- [ ] **Step 6: Commit (including generated migration)**

```bash
git add packages/db/scripts packages/db/drizzle
git commit -m "feat: db — generate and apply initial schema migration"
```

---

## Task 6: `apps/api` Hono skeleton — idiomatic Bun, CORS allowHeaders, error handlers

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/env.ts`
- Create: `apps/api/src/index.ts`

- [ ] **Step 1: Write `apps/api/package.json`**

```json
{
  "name": "@thirdeye/api",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "dev": "bun --hot run src/index.ts",
    "start": "bun run src/index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@thirdeye/db": "workspace:*",
    "@thirdeye/shared": "workspace:*",
    "hono": "^4.6.0",
    "drizzle-orm": "^0.39.0",
    "postgres": "^3.4.0"
  }
}
```

- [ ] **Step 2: Write `apps/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Write `apps/api/src/env.ts`**

```typescript
function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  PORT: Number(optional("PORT", "3001")),
  CORS_ORIGIN: optional("CORS_ORIGIN", "http://localhost:3000"),
  PUBLIC_INSTANCE_MODE: optional("PUBLIC_INSTANCE_MODE", "false") === "true",
} as const;
```

- [ ] **Step 4: Write `apps/api/src/index.ts`** — idiomatic `export default { port, fetch }`, CORS allows custom headers, `onError` + `notFound` for JSON consistency

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createDb, type DbClient } from "@thirdeye/db";
import { env } from "./env";

const { db } = createDb(env.DATABASE_URL);

type Variables = { db: DbClient };

const app = new Hono<{ Variables: Variables }>();

app.use("*", logger());

app.use(
  "*",
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
    allowHeaders: ["Content-Type", "X-Auth-Token", "X-User-Helius-Key"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.use("*", async (c, next) => {
  c.set("db", db);
  await next();
});

app.onError((err, c) => {
  console.error("[unhandled]", err);
  return c.json({ error: "internal_error" }, 500);
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.get("/", (c) => c.text("ThirdEye API"));
app.get("/health", (c) => c.json({ ok: true }));

console.log(`thirdeye api ready on :${env.PORT}`);

export default { port: env.PORT, fetch: app.fetch };
export { app, db };
```

- [ ] **Step 5: Install deps**

Run: `bun install`
Expected: `hono` resolves into `node_modules`.

- [ ] **Step 6: Boot the server**

Run: `bun run dev`
Expected: prints `thirdeye api ready on :3001`. Process stays running.

- [ ] **Step 7: Probe in another terminal**

Run: `curl -s http://localhost:3001/health`
Expected: `{"ok":true}`

Run: `curl -s http://localhost:3001/`
Expected: `ThirdEye API`

Run: `curl -s -i -X OPTIONS http://localhost:3001/api/db/auth -H "Origin: http://localhost:3000" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: x-auth-token,content-type"`
Expected: HTTP 204 with `access-control-allow-headers: Content-Type, X-Auth-Token, X-User-Helius-Key` in response.

Stop the server (Ctrl-C in its terminal).

- [ ] **Step 8: Commit**

```bash
git add apps/api bun.lock
git commit -m "feat: api — hono skeleton with cors, error handlers, and idiomatic bun export"
```

(`bun.lock` changed because Hono and friends were added — commit it together.)

---

## Task 7: Token generation library (TDD)

**Files:**
- Create: `apps/api/src/lib/tokens.ts`
- Create: `apps/api/tests/tokens.test.ts`

- [ ] **Step 1: Write the failing test `apps/api/tests/tokens.test.ts`**

```typescript
import { describe, expect, test } from "bun:test";
import { generateToken, EXPIRES_IN_DAYS } from "../src/lib/tokens";

describe("generateToken", () => {
  test("returns a base64url string of length 43", () => {
    const { token } = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("expiresAt is roughly now + 7 days", () => {
    const before = Date.now();
    const { expiresAt } = generateToken();
    const after = Date.now();

    const expectedMin = before + EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000 - 1000;
    const expectedMax = after + EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000 + 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  test("two consecutive calls produce different tokens", () => {
    const a = generateToken().token;
    const b = generateToken().token;
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test tests/tokens.test.ts`
Expected: 3 failures with "Cannot find module '../src/lib/tokens'".

- [ ] **Step 3: Implement `apps/api/src/lib/tokens.ts`**

```typescript
export const EXPIRES_IN_DAYS = 7;

const TOKEN_BYTES = 32; // 32 bytes → 43 base64url chars

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export function generateToken(): IssuedToken {
  const buf = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(buf);
  const token = base64url(buf);
  const expiresAt = new Date(Date.now() + EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000);
  return { token, expiresAt };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test tests/tokens.test.ts`
Expected: `3 pass / 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/tokens.ts apps/api/tests/tokens.test.ts
git commit -m "feat: auth — generate base64url session tokens with 7-day expiry"
```

---

## Task 8: Test setup helper (real Postgres, no mocks)

**Files:**
- Create: `apps/api/tests/setup.ts`

- [ ] **Step 1: Write `apps/api/tests/setup.ts`**

```typescript
import { createDb, type DbClient } from "@thirdeye/db";
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
    TRUNCATE auth_tokens, wallet_checks, wallets, token_scans, funders, intel_aggregates RESTART IDENTITY CASCADE;
  `);

  return {
    db,
    sql,
    cleanup: async () => {
      await sql.end();
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/tests/setup.ts
git commit -m "test: setup — real-postgres bootstrap helper for integration tests"
```

---

## Task 9: Auth route — `POST /api/db/auth` (TDD)

**Files:**
- Create: `apps/api/src/routes/auth.ts`
- Create: `apps/api/tests/auth.test.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Write the failing test `apps/api/tests/auth.test.ts`**

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { app } from "../src/index";
import { setupTestDb, type TestDb } from "./setup";
import { authTokens } from "@thirdeye/db";
import { eq } from "drizzle-orm";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.sql.unsafe("TRUNCATE auth_tokens RESTART IDENTITY CASCADE;");
});

describe("POST /api/db/auth", () => {
  test("issues a token and persists it", async () => {
    const res = await app.request("/api/db/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: string };

    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const rows = await testDb.db
      .select()
      .from(authTokens)
      .where(eq(authTokens.token, body.token));
    expect(rows).toHaveLength(1);
  });

  test("two requests issue distinct tokens, both persisted", async () => {
    const r1 = await app.request("/api/db/auth", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    const r2 = await app.request("/api/db/auth", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    const t1 = ((await r1.json()) as { token: string }).token;
    const t2 = ((await r2.json()) as { token: string }).token;
    expect(t1).not.toBe(t2);

    const rows = await testDb.db.select().from(authTokens);
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test tests/auth.test.ts`
Expected: failures with 404 (route doesn't exist yet — handled by `notFound` returning JSON 404).

- [ ] **Step 3: Implement `apps/api/src/routes/auth.ts`**

```typescript
import { Hono } from "hono";
import { authTokens, type DbClient } from "@thirdeye/db";
import { generateToken } from "../lib/tokens";

export const authRoutes = new Hono<{ Variables: { db: DbClient } }>();

authRoutes.post("/auth", async (c) => {
  const db = c.get("db");
  const { token, expiresAt } = generateToken();

  await db.insert(authTokens).values({ token, expiresAt });

  return c.json({ token, expiresAt: expiresAt.toISOString() });
});
```

- [ ] **Step 4: Mount the route in `apps/api/src/index.ts`**

Add to imports (after the existing `import { env } from "./env";` line):
```typescript
import { authRoutes } from "./routes/auth";
```

Add immediately after the `app.get("/health", ...)` line:
```typescript
app.route("/api/db", authRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && bun test tests/auth.test.ts`
Expected: `2 pass / 0 fail`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/index.ts apps/api/tests/auth.test.ts
git commit -m "feat: auth — issue and persist anonymous session tokens at POST /api/db/auth"
```

---

## Task 10: Auth middleware — `X-Auth-Token` validator (TDD)

**Files:**
- Create: `apps/api/src/middleware/auth.ts`
- Create: `apps/api/tests/middleware-auth.test.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Write the failing test `apps/api/tests/middleware-auth.test.ts`**

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { app } from "../src/index";
import { setupTestDb, type TestDb } from "./setup";
import { authTokens } from "@thirdeye/db";
import { eq } from "drizzle-orm";

let testDb: TestDb;

beforeAll(async () => { testDb = await setupTestDb(); });
afterAll(async () => { await testDb.cleanup(); });
beforeEach(async () => {
  await testDb.sql.unsafe("TRUNCATE auth_tokens RESTART IDENTITY CASCADE;");
});

async function issueToken(): Promise<string> {
  const r = await app.request("/api/db/auth", {
    method: "POST", body: "{}", headers: { "Content-Type": "application/json" },
  });
  return ((await r.json()) as { token: string }).token;
}

describe("X-Auth-Token middleware", () => {
  test("missing header → 401", async () => {
    const r = await app.request("/api/db/protected-probe", { method: "GET" });
    expect(r.status).toBe(401);
  });

  test("invalid token → 401", async () => {
    const r = await app.request("/api/db/protected-probe", {
      method: "GET",
      headers: { "X-Auth-Token": "not-a-real-token" },
    });
    expect(r.status).toBe(401);
  });

  test("valid token → 200 and bumps last_used_at", async () => {
    const token = await issueToken();
    const before = await testDb.db.select().from(authTokens).where(eq(authTokens.token, token));
    const beforeUsed = before[0]!.lastUsedAt.getTime();

    await new Promise((r) => setTimeout(r, 100));

    const r = await app.request("/api/db/protected-probe", {
      method: "GET",
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);

    const after = await testDb.db.select().from(authTokens).where(eq(authTokens.token, token));
    const afterUsed = after[0]!.lastUsedAt.getTime();
    expect(afterUsed).toBeGreaterThan(beforeUsed);
  });

  test("expired token → 401", async () => {
    const token = await issueToken();
    await testDb.db
      .update(authTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authTokens.token, token));

    const r = await app.request("/api/db/protected-probe", {
      method: "GET",
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test tests/middleware-auth.test.ts`
Expected: 4 failures (route `/api/db/protected-probe` doesn't exist; middleware doesn't exist).

- [ ] **Step 3: Implement `apps/api/src/middleware/auth.ts`**

```typescript
import type { MiddlewareHandler } from "hono";
import { authTokens, type DbClient } from "@thirdeye/db";
import { eq } from "drizzle-orm";

export const requireAuth: MiddlewareHandler<{ Variables: { db: DbClient } }> = async (c, next) => {
  const token = c.req.header("X-Auth-Token");
  if (!token) return c.json({ error: "missing X-Auth-Token" }, 401);

  const db = c.get("db");
  const rows = await db.select().from(authTokens).where(eq(authTokens.token, token));
  const row = rows[0];
  if (!row) return c.json({ error: "invalid token" }, 401);
  if (row.expiresAt.getTime() <= Date.now()) {
    return c.json({ error: "token expired" }, 401);
  }

  await db
    .update(authTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(authTokens.token, token));

  await next();
};
```

- [ ] **Step 4: Mount middleware on `/api/db/*` (except `/auth`) and add probe in `apps/api/src/index.ts`**

Add to imports:
```typescript
import { requireAuth } from "./middleware/auth";
```

Replace the existing `app.route("/api/db", authRoutes);` line with:
```typescript
app.route("/api/db", authRoutes); // /auth is unauthenticated by design (it issues tokens)

const protectedDb = new Hono<{ Variables: Variables }>();
protectedDb.use("*", requireAuth);
protectedDb.get("/protected-probe", (c) => c.json({ ok: true }));

app.route("/api/db", protectedDb);
```

(The `protected-probe` route is a temporary smoke endpoint for Phase 0 tests. It will be replaced by real `/wallet/...` and `/scan/...` routes in subsequent phases.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && bun test tests/middleware-auth.test.ts`
Expected: `4 pass / 0 fail`.

- [ ] **Step 6: Run all tests together**

Run: `cd apps/api && bun test`
Expected: `9 pass / 0 fail` (3 token + 2 auth + 4 middleware).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/index.ts apps/api/tests/middleware-auth.test.ts
git commit -m "feat: auth — X-Auth-Token middleware with expiry check and last_used_at bump"
```

---

## Task 11: Dockerfile + `.dockerignore` + docker-compose `app` service

**Files:**
- Create: `apps/api/Dockerfile`
- Create: `.dockerignore`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Write `.dockerignore`** — keep build context lean and don't leak local research dirs

```
**/node_modules
**/dist
**/.next
**/.bun
.git
.github
.firecrawl
.superpowers
.tmp
.cache
.env
.env.*
!.env.example
*.log
coverage
.nyc_output
.idea
.vscode
```

- [ ] **Step 2: Write `apps/api/Dockerfile`** (multi-stage, Bun 1.2-slim base)

```dockerfile
FROM oven/bun:1.2-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lockb ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3001
CMD ["bun", "run", "apps/api/src/index.ts"]
```

- [ ] **Step 3: Modify `docker-compose.yml` — add `app` service**

Replace entire file with:

```yaml
services:
  app:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    container_name: thirdeye-app
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://thirdeye:thirdeye@postgres:5432/thirdeye
      PORT: 3001
      CORS_ORIGIN: ${CORS_ORIGIN:-http://localhost:3000}
      PUBLIC_INSTANCE_MODE: ${PUBLIC_INSTANCE_MODE:-false}
    ports:
      - "3001:3001"

  postgres:
    image: postgres:16-alpine
    container_name: thirdeye-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: thirdeye
      POSTGRES_PASSWORD: thirdeye
      POSTGRES_DB: thirdeye
    ports:
      - "5432:5432"
    volumes:
      - thirdeye-pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U thirdeye -d thirdeye"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  thirdeye-pg-data:
```

- [ ] **Step 4: Bring up the full stack**

Run: `docker compose up -d --build`
Wait ~30s for the build, then check: `docker compose ps`
Expected: `thirdeye-app` and `thirdeye-postgres` both `running`, postgres `(healthy)`.

- [ ] **Step 5: Run migrations against compose Postgres**

Run from host: `bun run migrate`
Expected: `migrations applied`.

- [ ] **Step 6: Probe the running container**

Run: `curl -s http://localhost:3001/health`
Expected: `{"ok":true}`

Run:
```bash
curl -s -X POST http://localhost:3001/api/db/auth -H "Content-Type: application/json" -d "{}"
```
Expected: JSON with `token` (43 chars, base64url) and `expiresAt` (ISO string).

- [ ] **Step 7: Stop the stack**

Run: `docker compose down`

- [ ] **Step 8: Commit**

```bash
git add apps/api/Dockerfile .dockerignore docker-compose.yml
git commit -m "feat: docker — multi-stage bun image, dockerignore, full app+postgres compose stack"
```

---

## Task 12: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: thirdeye
          POSTGRES_PASSWORD: thirdeye
          POSTGRES_DB: thirdeye
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U thirdeye -d thirdeye"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

    env:
      DATABASE_URL: postgres://thirdeye:thirdeye@localhost:5432/thirdeye

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install
        run: bun install --frozen-lockfile

      - name: Lint
        run: bun run lint

      - name: Typecheck
        run: bun run typecheck

      - name: Migrate
        run: bun run migrate

      - name: Test
        run: bun test
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: github actions — lint, typecheck, migrate, test on push and PR"
```

- [ ] **Step 3: Push and verify CI runs**

Run: `git push`
Expected: Push succeeds. Check Actions tab on https://github.com/AIEngineerX/thirdeye — workflow runs and passes (green check).

If the workflow fails, read the logs, fix the issue, push again. Do not skip this step.

---

## Task 13: Biome formatter + linter

**Files:**
- Create: `biome.json`

- [ ] **Step 1: Write `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": {
    "ignore": ["**/dist/**", "**/.next/**", "**/drizzle/**", "**/node_modules/**"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100,
    "lineEnding": "lf"
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": {
        "noNonNullAssertion": "off",
        "useImportType": "warn"
      }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "trailingCommas": "all",
      "semicolons": "always",
      "arrowParentheses": "always"
    }
  }
}
```

- [ ] **Step 2: Run formatter once across the repo**

Run: `bun run format`
Expected: any file outside the ignore list normalized to Biome's style. Diff should be small (we already write clean code).

- [ ] **Step 3: Run linter**

Run: `bun run lint`
Expected: zero errors. If Biome surfaces warnings on the existing code, fix them inline (they will be small things like preferring `import type`).

- [ ] **Step 4: Commit**

```bash
git add biome.json
git add -u  # any reformatted files from step 2
git commit -m "chore: biome — add lint+format config and run initial pass"
```

---

## Task 14: `CONTRIBUTING.md` + update `CLAUDE.md` with commands and logging note

**Files:**
- Create: `CONTRIBUTING.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write `CONTRIBUTING.md`**

```markdown
# Contributing to ThirdEye

ThirdEye is open source under the MIT license. PRs welcome.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2
- Docker + Docker Compose
- A free [Helius](https://helius.dev) API key (only required from Phase 1 onward — Phase 0 has none of the proxy code yet)

## Local development

```bash
git clone https://github.com/AIEngineerX/thirdeye
cd thirdeye
cp .env.example .env
bun install
docker compose up -d postgres
bun run migrate
bun run dev
```

The API is now at `http://localhost:3001`.

## Before opening a PR

```bash
bun run lint        # biome check
bun run typecheck   # tsc --noEmit
bun test            # bun:test against real Postgres (must be running)
```

CI runs the same four commands; PRs that fail any will be blocked.

## Architecture

- Design spec: [`docs/superpowers/specs/2026-05-01-thirdeye-design.md`](docs/superpowers/specs/2026-05-01-thirdeye-design.md)
- Phase plans: [`docs/superpowers/plans/`](docs/superpowers/plans/)
- Stack: Bun + Hono + Drizzle + Postgres + graphile-worker (Phase 2+) + Next.js (Phase 5+)

## Code style

Biome handles formatting and most lint rules. Don't bikeshed — `bun run format` settles disputes.

## Commit messages

`<type>: <area> — <one-line summary>` where `<type>` ∈ `feat | fix | chore | docs | test | ci`. Example: `feat: scan — add LP/lock holder filter`.
```

- [ ] **Step 2: Add "Local development" + "Logging" sections to `CLAUDE.md`**

Insert after the "Workflow" section, before "Commit style":

```markdown
## Local development

Prerequisites: Bun ≥ 1.2, Docker, Docker Compose.

```bash
# First time only
cp .env.example .env

# Start Postgres only (recommended for inner dev loop)
docker compose up -d postgres

# Apply migrations
bun run migrate

# Run API in hot-reload mode
bun run dev

# Run all tests (Postgres must be up)
bun test

# Lint + format
bun run lint
bun run format

# Typecheck the whole monorepo
bun run typecheck

# Full self-host stack (app + postgres in containers)
docker compose up -d --build
```

The API listens on `http://localhost:3001`. `POST /api/db/auth` issues an anonymous session token; subsequent `/api/db/*` calls require `X-Auth-Token` header.

## Logging

Phase 0 uses Hono's built-in `logger()` middleware for request logs and `console.log`/`console.error` for app-level events. Structured JSON logging via pino is a v2 enhancement — don't introduce a logger library before then.
```

- [ ] **Step 3: Commit**

```bash
git add CONTRIBUTING.md CLAUDE.md
git commit -m "docs: contributing + claude.md — local dev workflow and logging policy"
```

---

## Phase 0 acceptance criteria

After all 14 tasks are done, the following must all be true. Verify each one before declaring Phase 0 complete:

- [ ] `bun run lint` exits 0
- [ ] `bun run typecheck` exits 0
- [ ] `docker compose up -d postgres && bun run migrate` applies all 6 tables (verify with `psql … "\dt"`)
- [ ] `bun test` reports `9 pass / 0 fail` against a real Postgres
- [ ] `docker compose up -d --build` brings up app + postgres; `curl localhost:3001/health` returns `{"ok":true}`
- [ ] `curl -X POST localhost:3001/api/db/auth -H "Content-Type: application/json" -d "{}"` returns a token + expiresAt
- [ ] CORS preflight (`curl -i -X OPTIONS …` with `Access-Control-Request-Headers: x-auth-token`) returns 204 with `X-Auth-Token` listed in `access-control-allow-headers`
- [ ] GitHub Actions CI on `main` is green (lint + typecheck + migrate + test all pass)
- [ ] All commits authored by `AIEngineerX <195990077+AIEngineerX@users.noreply.github.com>` (verify with `git log --pretty=format:"%h %an <%ae>"`)

---

## What comes next (subsequent phase plans)

Each gets its own plan file written when we're ready to execute it.

| Phase | Plan filename (future) | Builds |
|---|---|---|
| **1** | `…-phase-1-helius-proxy.md` | `/api/helius/*` proxy with BYOK header support, server-side `HELIUS_API_KEY`, in-memory LRU cache, rate-limit middleware (per spec §16) |
| **2** | `…-phase-2-check-wallet.md` | Check Wallet pipeline (spec §8.1): `funded-by` → balances → enhanced-tx → behavioral classifier → cluster lookup → score → save. `POST /api/db/wallet-check`, `GET /api/db/wallet/:addr/*` endpoints. graphile-worker introduced for async pipeline. |
| **3** | `…-phase-3-scan-token.md` | Scan Token pipeline (spec §8.2): `getTokenHolders` → LP/lock filter (`packages/shared/programs.json`) → batched `funded-by` → cluster grouping → risk score → save. `POST /api/db/scan` + reads. |
| **4** | `…-phase-4-intel-sse.md` | Intel Analytics endpoints (spec §8.3): aggregates table populated by `refresh-aggregates` cron, heatmap data, SSE feed at `/api/db/intel/feed` with 15s heartbeat and `?token=` query auth. |
| **5** | `…-phase-5-frontend-shell.md` | `apps/web` Next.js 16 scaffold, layout shell, address input, design system primitives. **Visual direction must be locked first** (separate frontend visual spec, deferred per main spec §18). |
| **6** | `…-phase-6-frontend-wallet.md` | Wallet detail page consuming Phase 2 endpoints. |
| **7** | `…-phase-7-frontend-token.md` | Token scan page consuming Phase 3 endpoints. |
| **8** | `…-phase-8-frontend-intel.md` | Intel page (heatmap + live feed) consuming Phase 4 endpoints. |

Phases 1–4 are pure backend and can ship sequentially. Phase 5 has a hard dependency on the deferred frontend visual spec — we revisit visual direction (arcane / mystic / brutalist) before writing Phase 5.

---

## Self-review (post-write)

**Spec coverage check** (this plan covers Phase 0 only):

| Spec section | Covered by | Status |
|---|---|---|
| §5 Stack — Bun, Hono, Drizzle, Postgres, Biome | Tasks 1, 3, 6, 13 | ✅ |
| §7 Auth model — anonymous tokens, X-Auth-Token, 401 reauth | Tasks 7, 9, 10 | ✅ |
| §9 Data model — all 6 tables + indexes | Task 3, Task 5 | ✅ |
| §15 Deployment — `docker compose up`, single env var | Tasks 4, 11 | ✅ |
| §16 Rate limits | Phase 1 | Deferred (spec covered) |
| §6 Architecture — split worker mode | Phase 2 (when worker introduced) | Deferred |
| §8.1–8.3 Modules | Phases 2–4 | Deferred |
| §10 API contract (full) | Phases 1–4 | Phase 0 implements `/auth` only |
| §11 Cluster algorithm | Phase 3 | Deferred |
| §12 SSE | Phase 4 | Deferred |
| §13 Background jobs | Phase 2 introduces graphile-worker | Deferred |

All Phase 0 spec coverage accounted for. No placeholders, all code complete, types consistent (`DbClient`, `IssuedToken`, `authTokens`, `Variables` referenced identically across tasks). All gap-analysis fixes applied — see plan header for the change list.
