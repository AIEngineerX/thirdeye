import { acquireBudget, finalizeBudget, resolveModel, type runAgentLoop } from "@thirdeye/agent";
import type { ToolContext } from "@thirdeye/agent";
import { type DbClient, agentRuns } from "@thirdeye/db";
import { eq, sql } from "drizzle-orm";
import type { TgMessage } from "./telegram";

// Hard-coded constants — see spec for rationale on why these aren't env vars.
const ESTIMATED_COST_PER_RUN_USD = 0.05;
const MAX_REPLY_CHARS = 4090;
const TRUNCATION_SUFFIX = "…[truncated]";

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
  // 1. Chat-lock
  if (msg.chat.id !== ctx.allowedChatId) {
    console.log(`[tg-bot] ignored msg from chat=${msg.chat.id} user=${msg.from?.id ?? "?"}`);
    return;
  }

  // 2. Text-only
  if (!msg.text) return;

  // 3. Dedup (handles Railway redeploy replay — see spec H4)
  if (await isDuplicate(ctx.db, msg.message_id)) {
    console.log(`[tg-bot] skipping replayed update msg_id=${msg.message_id}`);
    return;
  }

  // 4. Typing indicator (best-effort)
  try {
    await ctx.sendChatAction(msg.chat.id);
  } catch (e) {
    console.warn("[tg-bot] sendChatAction failed (non-fatal)", e);
  }

  // 5. Budget gate
  const model = resolveModel("cheap");
  const budget = await acquireBudget({
    db: ctx.db,
    kind: "tg_query",
    model,
    estimatedCostUsd: ESTIMATED_COST_PER_RUN_USD,
    dailyCapUsd: ctx.dailyCapUsd,
    metadata: {
      telegram_msg_id: msg.message_id,
      telegram_user_id: msg.from?.id,
      prompt: msg.text.slice(0, 200),
    },
  });

  if (!budget.admitted) {
    try {
      await ctx.sendMessage(msg.chat.id, "Daily cost cap reached. Resets at UTC midnight.");
    } catch (e) {
      console.error("[tg-bot] sendMessage (cap) failed", e);
    }
    return;
  }

  // 6. Agent run
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

    // 7. Format + send
    const body =
      result.finalText.length > 0
        ? result.finalText
        : `(agent produced no text — see agent_runs id=${budget.runId})`;
    const reply =
      body.length > MAX_REPLY_CHARS ? body.slice(0, MAX_REPLY_CHARS) + TRUNCATION_SUFFIX : body;

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
        })
        .where(eq(agentRuns.id, budget.runId));
    } catch (finalizeErr) {
      console.error("[tg-bot] finalize-on-error failed", finalizeErr);
    }
    try {
      await ctx.sendMessage(msg.chat.id, "⚠️ Something went wrong. Check logs.");
    } catch (sendErr) {
      console.error("[tg-bot] sendMessage (error reply) failed", sendErr);
    }
  }
}
