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

async function main(): Promise<void> {
  const databaseUrl = required("DATABASE_URL");
  const heliusKey = process.env.HELIUS_API_KEY;
  const smartMoneyMinSol = Number(process.env.SMART_MONEY_MIN_SOL ?? "50");

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
  process.stderr.write(`${PKG_NAME}: fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
