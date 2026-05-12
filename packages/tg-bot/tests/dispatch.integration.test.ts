import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createDb } from "@thirdeye/db";
import { dispatch } from "../src/dispatch";
import { cleanupOrphanRuns } from "../src/start";
import type { TgMessage } from "../src/telegram";

const DATABASE_URL = process.env.DATABASE_URL;
const HAVE_DB = Boolean(DATABASE_URL);
const d = HAVE_DB ? describe : describe.skip;

if (!HAVE_DB) {
  console.log("[skip] DATABASE_URL not set — tg-bot dispatch tests skipped");
}

// Lightweight in-process stub of the Anthropic-call surface. The real
// recorded-replay harness lives in packages/agent/tests/replay.ts and is
// fixture-driven; for the dispatch tests we only need to assert that
// runAgentLoop was invoked with the right kind/metadata, so we inject a
// fake at the boundary and assert against it.
type RunAgentLoopFn = typeof import("@thirdeye/agent").runAgentLoop;
type SendMessageFn = (chatId: number, text: string) => Promise<void>;
type SendChatActionFn = (chatId: number) => Promise<void>;

d("dispatch (integration)", () => {
  let conn: ReturnType<typeof createDb>;
  const sent: Array<{ chatId: number; text: string }> = [];
  const typing: number[] = [];

  const sendMessageStub: SendMessageFn = async (chatId, text) => {
    sent.push({ chatId, text });
  };
  const sendChatActionStub: SendChatActionFn = async (chatId) => {
    typing.push(chatId);
  };

  beforeAll(() => {
    conn = createDb(DATABASE_URL!);
  });

  afterAll(async () => {
    await conn.sql.end();
  });

  beforeEach(async () => {
    await conn.sql`TRUNCATE agent_runs RESTART IDENTITY CASCADE`;
    sent.length = 0;
    typing.length = 0;
  });

  const ctx = (overrides: Partial<Parameters<typeof dispatch>[1]> = {}) => ({
    db: conn.db,
    allowedChatId: 12345,
    serverHeliusKey: undefined,
    smartMoneyMinSol: 50,
    dailyCapUsd: 25,
    maxToolCalls: 20,
    maxInputTokens: 200000,
    sendMessage: sendMessageStub,
    sendChatAction: sendChatActionStub,
    runAgentLoop: (async () => ({
      status: "success" as const,
      finalText: "test reply",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costUsd: 0.001,
      toolCallsMade: 0,
    })) as unknown as RunAgentLoopFn,
    ...overrides,
  });

  const msg = (overrides: Partial<TgMessage> = {}): TgMessage => ({
    message_id: 1,
    chat: { id: 12345 },
    text: "check this wallet",
    from: { id: 99, username: "op" },
    ...overrides,
  });

  test("drops messages from non-allowlisted chats", async () => {
    await dispatch(msg({ chat: { id: 99999 } }), ctx());
    expect(sent.length).toBe(0);
    expect(typing.length).toBe(0);
    const runs = await conn.sql`SELECT count(*)::int AS n FROM agent_runs`;
    expect(runs[0]!.n).toBe(0);
  });

  test("dedups by telegram_msg_id when the same update is replayed", async () => {
    await conn.sql`
      INSERT INTO agent_runs (kind, status, model, metadata, ended_at)
      VALUES ('tg_query', 'success', 'claude-haiku-4-5-20251001', '{"telegram_msg_id": 42}'::jsonb, now())
    `;
    await dispatch(msg({ message_id: 42 }), ctx());
    expect(sent.length).toBe(0);
    expect(typing.length).toBe(0);
  });

  test("does NOT dedup when prior row is status=failed (retries after crash)", async () => {
    // Boot cleanup or mid-run crash leaves a 'failed' row. A subsequent
    // replay of the same update should re-run because the user never got
    // a real answer.
    await conn.sql`
      INSERT INTO agent_runs (kind, status, model, metadata, error_message, ended_at)
      VALUES ('tg_query', 'failed', 'claude-haiku-4-5-20251001', '{"telegram_msg_id": 500}'::jsonb, 'process_crash_or_redeploy', now())
    `;
    await dispatch(msg({ message_id: 500, text: "retry this" }), ctx());
    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toBe("test reply");
    // Total of 2 rows for msg_id=500 now: the prior failed, plus the new success
    const rows = await conn.sql<{ status: string }[]>`
      SELECT status FROM agent_runs WHERE metadata->>'telegram_msg_id' = '500' ORDER BY id
    `;
    expect(rows.length).toBe(2);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[1]!.status).toBe("success");
  });

  test("admits + runs agent, writes agent_runs row with kind=tg_query", async () => {
    await dispatch(
      msg({ message_id: 100, text: "check VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1" }),
      ctx(),
    );
    expect(sent.length).toBe(1);
    expect(sent[0]!.chatId).toBe(12345);
    expect(sent[0]!.text).toBe("test reply");
    expect(typing.length).toBe(1);
    const runs = await conn.sql<
      { kind: string; status: string; metadata: { telegram_msg_id: number } }[]
    >`SELECT kind, status, metadata FROM agent_runs`;
    expect(runs.length).toBe(1);
    expect(runs[0]!.kind).toBe("tg_query");
    expect(runs[0]!.status).toBe("success");
    expect(runs[0]!.metadata.telegram_msg_id).toBe(100);
  });

  test("surfaces budget-denied as a 'cap reached' reply", async () => {
    await conn.sql`
      INSERT INTO agent_runs (kind, status, model, cost_usd, ended_at)
      VALUES ('discovery', 'success', 'claude-haiku-4-5-20251001', 24.99, now())
    `;
    await dispatch(msg({ message_id: 200 }), ctx({ dailyCapUsd: 25 }));
    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toMatch(/cap reached|daily cap/i);
    const skipped =
      await conn.sql`SELECT count(*)::int AS n FROM agent_runs WHERE status = 'skipped_budget'`;
    expect(skipped[0]!.n).toBe(1);
  });

  test("writes failed status when agent throws", async () => {
    const throwingLoop = (async () => {
      throw new Error("boom");
    }) as unknown as RunAgentLoopFn;
    await dispatch(msg({ message_id: 300 }), ctx({ runAgentLoop: throwingLoop }));
    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toMatch(/went wrong|error/i);
    const runs = await conn.sql<{ status: string; error_message: string | null }[]>`
      SELECT status, error_message FROM agent_runs WHERE metadata->>'telegram_msg_id' = '300'
    `;
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.error_message).toContain("boom");
  });

  test("truncates oversized replies within Telegram's 4096-char limit", async () => {
    const big = "x".repeat(5000);
    const bigReplyLoop = (async () => ({
      status: "success" as const,
      finalText: big,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costUsd: 0.001,
      toolCallsMade: 0,
    })) as unknown as RunAgentLoopFn;
    await dispatch(msg({ message_id: 400 }), ctx({ runAgentLoop: bigReplyLoop }));
    expect(sent.length).toBe(1);
    expect(sent[0]!.text.length).toBeLessThanOrEqual(4096);
    expect(sent[0]!.text.endsWith("…[truncated]")).toBe(true);
  });
});

d("cleanupOrphanRuns (integration)", () => {
  let conn: ReturnType<typeof createDb>;

  beforeAll(() => {
    conn = createDb(DATABASE_URL!);
  });

  afterAll(async () => {
    await conn.sql.end();
  });

  beforeEach(async () => {
    await conn.sql`TRUNCATE agent_runs RESTART IDENTITY CASCADE`;
  });

  test("flips 'running' rows older than 1h to 'failed' with process_crash_or_redeploy", async () => {
    await conn.sql`
      INSERT INTO agent_runs (kind, status, model, started_at, ended_at)
      VALUES ('tg_query', 'running', 'claude-haiku-4-5-20251001', now() - interval '2 hours', NULL),
             ('discovery', 'running', 'claude-haiku-4-5-20251001', now() - interval '30 minutes', NULL),
             ('tg_query', 'success', 'claude-haiku-4-5-20251001', now() - interval '2 hours', now() - interval '2 hours')
    `;

    await cleanupOrphanRuns(conn.sql);

    const rows = await conn.sql<{ kind: string; status: string; error_message: string | null }[]>`
      SELECT kind, status, error_message FROM agent_runs ORDER BY id
    `;
    expect(rows.length).toBe(3);
    // First (tg_query, 2h old, running) → flipped
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error_message).toBe("process_crash_or_redeploy");
    // Second (discovery, 30min old, running) → unchanged
    expect(rows[1]!.status).toBe("running");
    expect(rows[1]!.error_message).toBe(null);
    // Third (already success) → unchanged
    expect(rows[2]!.status).toBe("success");
  });
});
