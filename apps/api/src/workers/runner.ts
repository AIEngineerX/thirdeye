import type { DbClient } from "@thirdeye/db";
import { DexScreenerSource, type PriceSource } from "@thirdeye/prices";
import { SolanaTrackerClient } from "@thirdeye/solanatracker";
import { type Runner, run } from "graphile-worker";
import type { Sql } from "postgres";
import { signalHitMultiplier } from "../env";
import { initIntelBus } from "../lib/intel-bus";
import { syncLeaderboardCandidates } from "../lib/wallet-universe";
import { cleanupTables } from "./cleanup-tables";
import { enrichWallet } from "./enrich-wallet";
import { refreshAggregates } from "./refresh-aggregates";
import { refreshSignals } from "./signals-refresh";
import { refreshTokens } from "./tokens-refresh";

export interface RunnerOptions {
  connectionString: string;
  db: DbClient;
  sql: Sql;
  serverHeliusKey: string | undefined;
  serverSolanaTrackerKey: string | undefined;
  smartMoneyMinSol: number;
  // Optional override — production injects DexScreenerSource. Tests can
  // wire a fake source without touching the network.
  priceSource?: PriceSource;
}

const CRONTAB = `
* * * * * refresh-aggregates ?fill=1m
* * * * * tokens-refresh ?fill=1m
* * * * * signals-refresh ?fill=1m
0 * * * * enrich-wallet ?fill=1h
0 * * * * candidate-sync ?fill=1h
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
      "signals-refresh": async () => {
        const stats = await refreshSignals(opts.db, {
          source: priceSource,
          hitMultiplier: signalHitMultiplier(),
          closeAfterHours: 48,
        });
        // Quiet on idle ticks; surface activity (closes) and failures so the
        // worker's behaviour is observable in logs, matching cleanup-tables.
        if (stats.closed > 0 || stats.errored > 0) {
          console.log(
            `[signals-refresh] selected=${stats.selected} updated=${stats.updated} closed=${stats.closed} errored=${stats.errored}`,
          );
        }
      },
      "candidate-sync": async () => {
        if (!opts.serverSolanaTrackerKey) return;
        const n = await syncLeaderboardCandidates(
          opts.db,
          new SolanaTrackerClient({ apiKey: opts.serverSolanaTrackerKey }),
        );
        if (n > 0) console.log(`[candidate-sync] upserted ${n} leaderboard candidates`);
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
