#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDb } from "@thirdeye/db";
import { createServer } from "./server";

const PKG_NAME = "@thirdeye/mcp-server";
const PKG_VERSION = "0.0.0";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`${PKG_NAME}: missing required env var: ${name}\n`);
    process.exit(2);
  }
  return v;
}

function intStrict(name: string, raw: string): number {
  const trimmed = raw.trim();
  if (!/^-?[0-9]+$/.test(trimmed)) {
    process.stderr.write(`${PKG_NAME}: ${name} is not a valid integer: "${raw}"\n`);
    process.exit(2);
  }
  return Number(trimmed);
}

async function main(): Promise<void> {
  const databaseUrl = required("DATABASE_URL");
  const heliusKey = process.env.HELIUS_API_KEY?.trim() || undefined;
  // F4: was Number() which silently produced NaN for malformed values,
  // making the SMART_MONEY tag's threshold comparison always false.
  const smartMoneyMinSol = process.env.SMART_MONEY_MIN_SOL
    ? intStrict("SMART_MONEY_MIN_SOL", process.env.SMART_MONEY_MIN_SOL)
    : 50;

  if (!heliusKey) {
    process.stderr.write(
      `${PKG_NAME}: HELIUS_API_KEY not set — checkWallet and scanToken will fail. Set it in your environment or claude_desktop_config to use those tools.\n`,
    );
  }

  const { db, sql } = createDb(databaseUrl);

  const server = createServer({
    name: PKG_NAME,
    version: PKG_VERSION,
    ctx: { db, serverHeliusKey: heliusKey, smartMoneyMinSol },
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stdin close = parent (Claude Desktop) exited; tear down the DB pool
  // so we don't leave open connections.
  process.stdin.on("close", async () => {
    try {
      await sql.end();
    } finally {
      process.exit(0);
    }
  });
}

main().catch((e) => {
  // F3: e.stack includes absolute file paths that leak repo layout when
  // logs are aggregated. e.message is enough for an operator looking at
  // the immediate failure.
  process.stderr.write(`${PKG_NAME}: fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
