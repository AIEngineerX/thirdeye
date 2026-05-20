import type { DbClient } from "@thirdeye/db";
import { DexScreenerSource, type PriceSource } from "@thirdeye/prices";
import { type Runner, run } from "graphile-worker";
import type { Sql } from "postgres";
import { initIntelBus } from "../lib/intel-bus";
import { cleanupTables } from "./cleanup-tables";
import { enrichWallet } from "./enrich-wallet";
import { refreshAggregates } from "./refresh-aggregates";
import { refreshTokens } from "./tokens-refresh";

export interface RunnerOptions {
  connectionString: string;
  db: DbClient;
  sql: Sql;
  serverHeliusKey: string | undefined;
  smartMoneyMinSol: number;
  // Optional override — production injects DexScreenerSource. Tests can
  // wire a fake source without touching the network.
  priceSource?: PriceSource;
}

const CRONTAB = `
* * * * * refresh-aggregates ?fill=1m
* * * * * tokens-refresh ?fill=1m
0 * * * * enrich-wallet ?fill=1h
*/15 * * * * cleanup-tables ?fill=15m
`.trim();

export async function startWorker(opts: RunnerOptions): Promise<Runner> {
  await initIntelBus(opts.sql);

  const priceSource = opts.priceSource ?? new DexScreenerSource();

  return run({
    connectionString: opts.connectionString,
    concurrency: 4,
    pollInterval: 1000,
    taskList: {
      "refresh-aggregates": async () => {
        await refreshAggregates(opts.db);
      },
      "tokens-refresh": async () => {
        await refreshTokens(opts.db, { source: priceSource });
      },
      "enrich-wallet": async () => {
        await enrichWallet(opts.db, {
          serverKey: opts.serverHeliusKey,
          smartMoneyMinSol: opts.smartMoneyMinSol,
        });
      },
      "cleanup-tables": async () => {
        const stats = await cleanupTables(opts.db);
        if (stats.ssesTicketsDeleted > 0 || stats.authIssueRateBucketsDeleted > 0) {
          console.log(
            `[cleanup-tables] sse_tickets=${stats.ssesTicketsDeleted} auth_issue=${stats.authIssueRateBucketsDeleted}`,
          );
        }
      },
    },
    crontab: CRONTAB,
  });
}
