import type { DbClient } from "@thirdeye/db";
import { type Runner, run } from "graphile-worker";
import { enrichWallet } from "./enrich-wallet";
import { refreshAggregates } from "./refresh-aggregates";

export interface RunnerOptions {
  connectionString: string;
  db: DbClient;
  serverHeliusKey: string | undefined;
  smartMoneyMinSol: number;
}

// graphile-worker uses standard 5-field minute-precision cron — no seconds
// field. Spec §13 calls for refresh-aggregates "every 30s"; cron's resolution
// floor is 1 minute, so we run it every minute. The Intel SSE bus pushes
// scan/check events instantly, so the 60s vs 30s aggregate refresh delta is
// not user-visible. Sub-minute refresh is a v1.1 enhancement (would need a
// repeating task that re-enqueues itself with run_at = now() + 30s).
const CRONTAB = `
* * * * * refresh-aggregates ?fill=1m
0 * * * * enrich-wallet ?fill=1h
`.trim();

export async function startWorker(opts: RunnerOptions): Promise<Runner> {
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
