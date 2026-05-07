import type { DbClient } from "@thirdeye/db";
import { type Runner, run } from "graphile-worker";
import type { Sql } from "postgres";
import { initIntelBus } from "../lib/intel-bus";
import { enrichWallet } from "./enrich-wallet";
import { refreshAggregates } from "./refresh-aggregates";

export interface RunnerOptions {
  connectionString: string;
  db: DbClient;
  sql: Sql;
  serverHeliusKey: string | undefined;
  smartMoneyMinSol: number;
}

const CRONTAB = `
* * * * * refresh-aggregates ?fill=1m
0 * * * * enrich-wallet ?fill=1h
`.trim();

export async function startWorker(opts: RunnerOptions): Promise<Runner> {
  await initIntelBus(opts.sql);

  return run({
    connectionString: opts.connectionString,
    concurrency: 4,
    pollInterval: 1000,
    taskList: {
      "refresh-aggregates": async () => {
        await refreshAggregates(opts.db);
      },
      "enrich-wallet": async () => {
        await enrichWallet(opts.db, {
          serverKey: opts.serverHeliusKey,
          smartMoneyMinSol: opts.smartMoneyMinSol,
        });
      },
    },
    crontab: CRONTAB,
  });
}
