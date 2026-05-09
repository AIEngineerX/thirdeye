import { agentRuns, type DbClient } from "@thirdeye/db";
import { eq, sql } from "drizzle-orm";
import type { LoopResult } from "./loop";
import type { AgentRunKind } from "./types";

export interface AcquireBudgetOptions {
  db: DbClient;
  kind: AgentRunKind;
  model: string;
  estimatedCostUsd: number;
  dailyCapUsd: number;
  metadata?: Record<string, unknown>;
}

export interface AcquireBudgetResult {
  runId: number;
  admitted: boolean;
}

// One global advisory-lock key for the daily-budget gate. hashtext()
// turns the string into a bigint Postgres can lock on. Held for the
// duration of the calling transaction; released on COMMIT/ROLLBACK.
const LOCK_KEY = "agent_daily_budget";

export async function acquireBudget(opts: AcquireBudgetOptions): Promise<AcquireBudgetResult> {
  return await opts.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`);

    // Sum today's spend (UTC day window). Includes 'running' rows so a
    // race between two concurrent acquires sees the other's reservation.
    const sumResult = await tx.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(cost_usd::numeric), 0)::text AS total
      FROM agent_runs
      WHERE started_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
        AND status IN ('success', 'failed', 'capped', 'running')
    `);
    const totalStr = sumResult[0]?.total ?? "0";
    const total = Number(totalStr);
    const wouldBe = total + opts.estimatedCostUsd;

    if (wouldBe > opts.dailyCapUsd) {
      const inserted = await tx
        .insert(agentRuns)
        .values({
          kind: opts.kind,
          status: "skipped_budget",
          model: opts.model,
          metadata: opts.metadata ?? {},
          endedAt: new Date(),
        })
        .returning({ id: agentRuns.id });
      const row = inserted[0];
      if (!row) throw new Error("insert returning produced no row");
      return { runId: row.id, admitted: false };
    }

    const inserted = await tx
      .insert(agentRuns)
      .values({
        kind: opts.kind,
        status: "running",
        model: opts.model,
        metadata: opts.metadata ?? {},
      })
      .returning({ id: agentRuns.id });
    const row = inserted[0];
    if (!row) throw new Error("insert returning produced no row");
    return { runId: row.id, admitted: true };
  });
}

export interface FinalizeBudgetOptions extends LoopResult {
  errorMessage?: string | null;
}

export async function finalizeBudget(
  db: DbClient,
  runId: number,
  result: FinalizeBudgetOptions,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      status: result.status === "success" ? "success" : result.status === "capped" ? "capped" : "failed",
      toolCallsMade: result.toolCallsMade,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cacheReadTokens + result.usage.cacheCreationTokens,
      costUsd: String(result.costUsd),
      endedAt: new Date(),
      errorMessage: result.errorMessage ?? null,
    })
    .where(eq(agentRuns.id, runId));
}
