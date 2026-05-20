import { acquireBudget, finalizeBudget, resolveModel, type runAgentLoop } from "@thirdeye/agent";
import type { ToolContext } from "@thirdeye/agent";
import { type DbClient, agentRuns } from "@thirdeye/db";
import { eq, sql } from "drizzle-orm";
import type { TgMessage } from "./telegram";
import { sanitizePromptForStorage, truncateUtf16Safe } from "./text";

// Hard-coded constants — see spec for rationale on why these aren't env vars.
const ESTIMATED_COST_PER_RUN_USD = 0.05;
const TRUNCATION_SUFFIX = "…[truncated]";
// 4096 is Telegram's hard limit for sendMessage text. Compute the slice
// budget so reply.length === MAX_REPLY_CHARS + TRUNCATION_SUFFIX.length
// never exceeds the limit.
const MAX_REPLY_CHARS = 4096 - TRUNCATION_SUFFIX.length;

const SYSTEM_PROMPT = `You are ThirdEye, a Solana wallet and token forensics assistant. The operator chats with you over Telegram.

You have six tools: checkWallet, scanToken, getClusterSiblings, getFunderClusters, getHotTokens, getWatchlist. Pick the right one(s) for the operator's question. Don't ask for confirmation — just call the tool when you have enough info.

Reply with concise findings. Lead with the verdict (CLEAN/LOW/MEDIUM/HIGH or the key number). Then the supporting facts (cluster size, funding root, top tags). Skip preamble like "I'll check that for you" — go straight to results.

If the operator gives you a string that's not obviously an address (32-44 base58 chars) or a mint, ask them to clarify in one short sentence.

Keep replies under 600 words. The operator is on mobile.`;

export interface DispatchContext {
  db: DbClient;
  allowedChatId: number;
  serverHeliusKey: string | undefined;
  smartMoneyMinSol: number;
  dailyCapUsd: number;
  maxToolCalls: number;
  maxInputTokens: number;
  // Injected for tests; production wires the real implementations.
  sendMessage: (chatId: number, text: string) => Promise<void>;
  sendChatAction: (chatId: number) => Promise<void>;
  runAgentLoop: typeof runAgentLoop;
}

// Postgres reports unique-violation errors with SQLSTATE 23505. postgres.js
// surfaces this on the error object's `code` field.
function isPgUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "23505"
  );
}

async function isDuplicate(db: DbClient, messageId: number): Promise<boolean> {
  // Skip replays of messages we've already handled to completion. Rows
  // with status='failed' are NOT considered handled — the user didn't
  // get a real answer, so a replay should re-run. 'running' is included
  // to suppress racing duplicates within a single run.
  const rows = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM agent_runs
      WHERE (metadata->>'telegram_msg_id')::int = ${messageId}
        AND status IN ('success', 'capped', 'skipped_budget', 'running')
    ) AS exists
  `);
  return rows[0]?.exists === true;
}

export async function dispatch(msg: TgMessage, ctx: DispatchContext): Promise<void> {
  if (msg.chat.id !== ctx.allowedChatId) {
    console.log(`[tg-bot] ignored msg from chat=${msg.chat.id} user=${msg.from?.id ?? "?"}`);
    return;
  }

  if (!msg.text) return;

  // Dedup handles Railway redeploy replay — see spec H4.
  if (await isDuplicate(ctx.db, msg.message_id)) {
    console.log(`[tg-bot] skipping replayed update msg_id=${msg.message_id}`);
    return;
  }

  try {
    await ctx.sendChatAction(msg.chat.id);
  } catch (e) {
    console.warn("[tg-bot] sendChatAction failed (non-fatal)", e);
  }

  // acquireBudget INSERTs the running row; if a concurrent dispatch with the
  // same telegram_msg_id beat us through the dedup check, the partial-unique
  // index (migration 0009) makes this INSERT fail with a unique-violation.
  // Catch and treat as "already handled" — the other dispatch will reply.
  const model = resolveModel("cheap");
  let budget: Awaited<ReturnType<typeof acquireBudget>>;
  try {
    budget = await acquireBudget({
      db: ctx.db,
      kind: "tg_query",
      model,
      estimatedCostUsd: ESTIMATED_COST_PER_RUN_USD,
      dailyCapUsd: ctx.dailyCapUsd,
      metadata: {
        telegram_msg_id: msg.message_id,
        telegram_user_id: msg.from?.id,
        // M5: sanitize control/bidi/zero-width chars before persisting.
        // A future Phase 6c worker re-injecting these prompts into agent
        // context would otherwise carry adversarial control sequences across
        // a trust boundary (semantic prompt injection).
        prompt: sanitizePromptForStorage(truncateUtf16Safe(msg.text, 200)),
      },
    });
  } catch (e) {
    // Postgres unique_violation = "23505". Closes the audit/bug-scan L4
    // dedup race where two concurrent dispatches could both pass the
    // EXISTS check before either INSERT committed.
    if (isPgUniqueViolation(e)) {
      console.log(`[tg-bot] dedup race lost — msg_id=${msg.message_id} already running`);
      return;
    }
    throw e;
  }

  if (!budget.admitted) {
    try {
      await ctx.sendMessage(msg.chat.id, "Daily cost cap reached. Resets at UTC midnight.");
    } catch (e) {
      console.error("[tg-bot] sendMessage (cap) failed", e);
    }
    return;
  }

  try {
    const result = await ctx.runAgentLoop({
      kind: "tg_query",
      systemPrompt: SYSTEM_PROMPT,
      initialUserMessage: msg.text,
      modelTier: "cheap",
      serverHeliusKey: ctx.serverHeliusKey,
      toolContext: {
        db: ctx.db,
        serverHeliusKey: ctx.serverHeliusKey,
        smartMoneyMinSol: ctx.smartMoneyMinSol,
      } satisfies ToolContext,
      maxToolCalls: ctx.maxToolCalls,
      maxInputTokens: ctx.maxInputTokens,
    });

    await finalizeBudget(ctx.db, budget.runId, result);

    const body =
      result.finalText.length > 0 ? result.finalText : `(no text — agent_run ${budget.runId})`;
    const reply =
      body.length > MAX_REPLY_CHARS
        ? truncateUtf16Safe(body, MAX_REPLY_CHARS) + TRUNCATION_SUFFIX
        : body;

    try {
      await ctx.sendMessage(msg.chat.id, reply);
    } catch (e) {
      console.error("[tg-bot] sendMessage (reply) failed", e);
    }
  } catch (e) {
    const errMessage = e instanceof Error ? e.message : String(e);
    console.error("[tg-bot] dispatch handler threw", e);
    // Best-effort finalize so the running row doesn't leak.
    try {
      await ctx.db
        .update(agentRuns)
        .set({
          status: "failed",
          errorMessage: errMessage,
          endedAt: new Date(),
          costUsd: "0",
        })
        .where(eq(agentRuns.id, budget.runId));
    } catch (finalizeErr) {
      console.error("[tg-bot] finalize-on-error failed", finalizeErr);
    }
    try {
      await ctx.sendMessage(msg.chat.id, "Run failed — see server logs.");
    } catch (sendErr) {
      console.error("[tg-bot] sendMessage (error reply) failed", sendErr);
    }
  }
}
