import { runAgentLoop } from "@thirdeye/agent";
import type { DbClient } from "@thirdeye/db";
import type { Sql } from "@thirdeye/db";
import type { DispatchContext } from "./dispatch";
import { loop } from "./loop";
import { getMe, sendChatAction, sendMessage } from "./telegram";

export interface StartBotOptions {
  db: DbClient;
  sql: Sql;
  tgBotToken: string | undefined;
  tgAllowedChatId: number | undefined;
  serverHeliusKey: string | undefined;
  smartMoneyMinSol: number;
  dailyCapUsd: number;
  maxToolCalls: number;
  maxInputTokens: number;
}

export async function startBot(opts: StartBotOptions): Promise<void> {
  if (!opts.tgBotToken || !opts.tgAllowedChatId) {
    console.log("[tg-bot] disabled — TG_BOT_TOKEN or TG_ALLOWED_CHAT_ID unset");
    return;
  }
  const token = opts.tgBotToken;
  const allowedChatId = opts.tgAllowedChatId;

  // Recover from prior process crashes: any 'running' row older than 1h
  // is stranded. Without this, orphan rows permanently consume budget
  // quota (the SUM in acquireBudget includes status='running').
  await opts.sql`
    UPDATE agent_runs
    SET status = 'failed',
        error_message = 'process_crash_or_redeploy',
        ended_at = now()
    WHERE status = 'running' AND started_at < now() - interval '1 hour'
  `;

  // Sanity check; non-fatal if Telegram is briefly down at boot.
  try {
    const me = await getMe(token);
    console.log(`[tg-bot] connected as @${me.username}`);
  } catch (e) {
    console.warn("[tg-bot] getMe failed at boot — will retry in loop", e);
  }

  const ctx: DispatchContext = {
    db: opts.db,
    allowedChatId,
    serverHeliusKey: opts.serverHeliusKey,
    smartMoneyMinSol: opts.smartMoneyMinSol,
    dailyCapUsd: opts.dailyCapUsd,
    maxToolCalls: opts.maxToolCalls,
    maxInputTokens: opts.maxInputTokens,
    sendMessage: (chatId, text) => sendMessage(token, chatId, text),
    sendChatAction: (chatId) => sendChatAction(token, chatId, "typing"),
    runAgentLoop,
  };

  // Fire-and-forget; the loop awaits internally and only returns on abort
  // or fatal 409. Errors at this top level mean the bot is offline; the
  // api process keeps serving.
  loop({ token, ctx }).catch((e) => {
    console.error("[tg-bot] loop crashed at top level — bot is offline", e);
  });
}
