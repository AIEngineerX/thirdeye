---
title: ThirdEye Telegram Bot — Design (rev2)
date: 2026-05-12
status: Draft rev2 — incorporates findings from /review-spec
license: MIT
---

# ThirdEye Telegram Bot

> Reactive Telegram bot exposing ThirdEye's forensics tools to the operator via natural-language chat. Embedded in the existing `apps/api` process; reuses the Phase 6b agent loop end-to-end.

## Revision history

**rev2 (2026-05-12)** — addresses /review-spec findings (4 blockers, 7 high). Drops 2 unnecessary env vars (hard-coded constants), merges the bot loop into the api process (one Railway service instead of two), corrects env var names (`AGENT_DAILY_COST_USD_CAP` not `AGENT_DAILY_CAP_USD`), corrects token-cap default (200k not 100k), rewrites cost model to account for cold-cache and unsummarized `scanToken` output, adds message-ID deduplication to prevent redeploy double-charging, adds 409-storm circuit breaker for Railway blue-green overlap, adds startup cleanup for orphan `running` rows, switches test strategy to the existing `recordedAnthropicClient` replay harness per CLAUDE.md "no mocking" rule.

## Goal

A Telegram bot the operator (single user) DMs to investigate Solana wallets, scan tokens, expand clusters, and query the intel cache. Natural-language input dispatches through `@thirdeye/agent`'s existing `runAgentLoop`, same six-tool registry that `@thirdeye/mcp-server` exposes to Claude Desktop. The bot lives inside the existing `apps/api` process, started after Hono + graphile-worker boot. Deployed to Railway as a single service.

This is **sub-phase 6b.6** — a transport-layer companion to 6b.5. Neither contains forensic logic. 6b.6 differs from 6b.5 in three ways:

1. Hosted (Railway) rather than local-only (stdio)
2. Always-on, mobile-accessible
3. Single-user lock by chat ID (no auth framework needed)

## Non-goals (v1)

- **Multi-user / public bot.** Single chat ID lock; everyone else silently ignored.
- **Proactive notifications.** No watchlist events, no discovery picks, no anomaly alerts. Deferred until 6c/6d land; then 6c.5 adds intel-bus → TG push.
- **Conversational memory across messages.** Each message is a fresh agent run, no thread context.
- **Inline keyboards / buttons / commands.** Pure text-in, text-out.
- **MarkdownV2 / HTML formatting.** Plain text replies; truncate at 4090 chars.
- **Image or chart attachments.** Future feature; v1 returns JSON-summary text.
- **TG webhooks.** Long-polling only (outbound HTTPS, no public route needed).
- **Standalone bot process.** Bot embeds in the api process; no separate Railway service, no `bin.ts`.

## Architecture

### Single-service topology

The api process gains one more startup hook. Existing services unchanged:

```
┌────────────────────┐         ┌──────────────────────────────────────┐
│  Telegram          │◄────────┤  Railway service: api                │
│  (operator DM)     │ HTTPS   │   apps/api/src/index.ts              │
│                    │ long-   │   ├─ Hono HTTP listener (existing)   │
└────────────────────┘ poll    │   ├─ graphile-worker cron (existing) │
                               │   └─ startBot() from @thirdeye/tg-bot│
                               └──────┬───────────────────┬───────────┘
                                      │                   │
                              @thirdeye/agent       @thirdeye/db
                                      │                   │
                              ┌───────▼─────┐      ┌──────▼──────────┐
                              │  Anthropic  │      │  Railway        │
                              │  API        │      │  Postgres       │
                              └─────────────┘      │  (add-on)       │
                                                   └─────────────────┘
```

Bot startup gates on `TG_BOT_TOKEN` being set. If unset (e.g., local dev without bot config), `startBot()` logs `[tg-bot] disabled — TG_BOT_TOKEN unset` and returns immediately. The api still serves; nothing breaks.

### Package layout

New workspace package, sibling to `packages/mcp-server/`, but **exports a library function** rather than a binary:

```
packages/tg-bot/
├── package.json                    # deps: @thirdeye/agent, @thirdeye/db (no third-party deps)
├── tsconfig.json                   # extends root
├── README.md                       # BotFather setup + chat-ID lookup + env vars
├── src/
│   ├── index.ts                    # public exports: startBot, types
│   ├── telegram.ts                 # ~60 LOC: typed fetch wrappers for 4 Bot API endpoints
│   ├── dispatch.ts                 # ~90 LOC: chat-lock → dedup → budget → agent → format → send
│   ├── loop.ts                     # ~60 LOC: getUpdates poll + backoff + 409 circuit breaker + offset state
│   └── start.ts                    # ~50 LOC: orchestrates loop + signal handling + dedup table + orphan cleanup
└── tests/
    └── dispatch.integration.test.ts  # real Postgres, recordedAnthropicClient fixture, stubbed telegram client
```

**Total bot code: ~260 LOC.** Zero third-party dependencies (Telegram Bot API is hit via Bun's built-in `fetch`). No `bin.ts`. No `loop.test.ts` as a separate file — backoff and offset behavior covered as part of the integration test.

### Why no Telegram framework

grammY / Telegraf / node-telegram-bot-api each provide:

- Middleware pattern (we use one handler, don't need it)
- Sessions / scenes (no conversational state in v1, don't need it)
- Inline keyboards / payments / polls (out of scope)
- Type definitions for the Bot API (we hand-roll the four shapes we use; ~25 LOC)
- Reconnect-on-transient-failure (~5 LOC of try/catch + backoff)

For a single-handler reactive bot, the entire framework value reduces to ~30 LOC of reconnect logic and types. We pay that in `telegram.ts` + `loop.ts` directly and avoid the dependency surface, lock-file pressure, and "read the framework docs to understand the bot" cost.

## Data model deltas

### Extend `AgentRunKind` (TypeScript only)

Today: `'discovery' | 'anomaly' | 'morning_brief' | 'cluster_expand'` in `packages/agent/src/types.ts:3`.

Add: `'tg_query'`.

**This must be the first commit** — every other file that references `kind: 'tg_query'` is a compile-time error until the union is patched. `bun run typecheck` will hard-fail otherwise.

`agent_runs.kind` is a `text` column, not a Postgres enum, so no SQL migration. **The inline comment in `packages/db/src/schema.ts` that enumerates `kind` values must also be updated** in the same commit — silent doc drift otherwise.

### No other schema changes

The bot reads what the tools read. No new tables. The dedup-by-telegram-msg-id check (described below) uses an existing column: `agent_runs.metadata` (jsonb) holds `{ telegram_msg_id: number }` per row and the check is `EXISTS (SELECT 1 FROM agent_runs WHERE metadata->>'telegram_msg_id' = $1)`. No index needed at single-user volume (sub-100 rows/day).

## Inbound message flow

```
operator sends "check VJSDW6..."
        │
        ▼
1. getUpdates returns the new message
2. chat-lock: if msg.chat.id !== TG_ALLOWED_CHAT_ID → drop silently, log
3. dedup: if agent_runs has a row with metadata.telegram_msg_id = msg.message_id
   → drop silently, log "skipping replayed update"
   (prevents double-charging on Railway redeploys, since Telegram retains
    updates ~24h and the in-memory offset starts at 0 each boot)
4. sendChatAction(typing) — UX during the 5-15s agent run; wrapped with
   retry-on-429 like sendMessage
5. acquireBudget({
     kind: 'tg_query',
     model: resolveModel('cheap'),
     estimatedCostUsd: ESTIMATED_COST_PER_RUN_USD,  // const = 0.05
     dailyCapUsd: env.AGENT_DAILY_COST_USD_CAP,     // existing env var, default 25
     metadata: {
       telegram_msg_id: msg.message_id,
       telegram_user_id: msg.from?.id,
       prompt: msg.text.slice(0, 200)
     }
   })
   │
   ├─ admitted=false → sendMessage("Daily cost cap reached. Resets at UTC midnight.")
   │                   (skipped_budget row already inserted by acquireBudget; no
   │                    finalizeBudget call needed — that's only for admitted runs)
   │                   return
   │
   ▼
6. result: LoopResult = await runAgentLoop({
     kind: 'tg_query',
     systemPrompt: SYSTEM_PROMPT,                  // const, not env-overridable
     initialUserMessage: msg.text,
     modelTier: 'cheap',
     toolContext: { db, serverHeliusKey: env.HELIUS_API_KEY, smartMoneyMinSol: env.SMART_MONEY_MIN_SOL },
     maxToolCalls: env.AGENT_MAX_TOOL_CALLS_PER_RUN,           // existing, default 20
     maxInputTokens: env.AGENT_MAX_INPUT_TOKENS_PER_RUN        // existing, default 200000
   })
7. await finalizeBudget(db, runId, result)
   // result is LoopResult: { status, finalText: string, usage, costUsd, toolCallsMade }
   // finalText is string (never null) per loop.ts contract
8. format reply:
       reply = result.finalText.length > 0
         ? result.finalText
         : `(agent produced no text — see agent_runs id=${runId})`
       if reply.length > 4090: reply = reply.slice(0, 4090) + '…[truncated]'
9. sendMessage(chatId, reply, { disable_web_page_preview: true })
```

On any thrown exception inside the handler: `sendMessage(chatId, "⚠️ Something went wrong. Check logs.")`, `console.error(e)`, **best-effort `finalizeBudget` with `errorMessage`**, never crash the outer poll loop. Best-effort because the agent run may have already finalized; the wrapping `try/catch` checks whether `runId` was admitted and the row is still `running` before updating.

## System prompt

Hard-coded constant in `packages/tg-bot/src/dispatch.ts`:

```ts
const SYSTEM_PROMPT = `You are ThirdEye, a Solana wallet and token forensics assistant. The operator
chats with you over Telegram.

You have six tools: checkWallet, scanToken, getClusterSiblings, getFunderClusters,
getHotTokens, getWatchlist. Pick the right one(s) for the operator's question.
Don't ask for confirmation — just call the tool when you have enough info.

Reply with concise findings. Lead with the verdict (CLEAN/LOW/MEDIUM/HIGH or the
key number). Then the supporting facts (cluster size, funding root, top tags).
Skip preamble like "I'll check that for you" — go straight to results.

If the operator gives you a string that's not obviously an address (32-44 base58
chars) or a mint, ask them to clarify in one short sentence.

Keep replies under 600 words. The operator is on mobile.`;
```

Not env-overridable. If the prompt needs tuning, edit the const and redeploy — same effort as setting an env var on Railway and triggering a redeploy.

## Environment variables

Exactly two new env vars; everything else is reuse.

| Var | Required | Default | Existing or new |
|---|---|---|---|
| `TG_BOT_TOKEN` | yes when bot enabled | — | **New.** From BotFather. Format `<bot_id>:<hash>`. If unset, `startBot()` returns immediately. |
| `TG_ALLOWED_CHAT_ID` | yes when bot enabled | — | **New.** Operator's numeric Telegram chat ID. Single value; bot ignores everyone else. |
| `DATABASE_URL` | yes | — | Existing |
| `ANTHROPIC_API_KEY` | yes | — | Existing |
| `HELIUS_API_KEY` | yes | — | Existing |
| `AGENT_DAILY_COST_USD_CAP` | no | 25.00 | Existing (`apps/api/src/env.ts:37`, `.env.example:76`) |
| `AGENT_MAX_TOOL_CALLS_PER_RUN` | no | 20 | Existing (`.env.example:80`) |
| `AGENT_MAX_INPUT_TOKENS_PER_RUN` | no | 200000 | Existing (`.env.example:81`) |
| `AGENT_CHEAP_MODEL` | no | claude-haiku-4-5-20251001 | Existing |
| `SMART_MONEY_MIN_SOL` | no | 50 | Existing |

**Dropped from rev1:**
- `AGENT_ESTIMATED_COST_PER_RUN_USD` — hard-coded as `const ESTIMATED_COST_PER_RUN_USD = 0.05` in `dispatch.ts`. Not a thing operators need to tune.
- `TG_BOT_SYSTEM_PROMPT` — hard-coded const, see above.

No `X-User-Helius-Key` / `X-User-Anthropic-Key` BYOK headers — TG doesn't pass HTTP headers and the bot is single-user.

## Telegram API surface

`packages/tg-bot/src/telegram.ts` is the only place Telegram's HTTP API is touched. Four functions, four fetch calls:

```ts
export interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: TgMessage; }
export interface TgMessage { message_id: number; chat: { id: number }; text?: string; from?: { id: number; username?: string }; }

export async function getUpdates(token: string, offset: number, timeoutSec: number): Promise<TgUpdate[]>
export async function sendMessage(token: string, chatId: number, text: string, opts?: { disableWebPagePreview?: boolean }): Promise<void>
export async function sendChatAction(token: string, chatId: number, action: 'typing'): Promise<void>
export async function getMe(token: string): Promise<{ id: number; username: string }>
```

Each function:
- POSTs to `https://api.telegram.org/bot${token}/<method>` with a JSON body
- Throws a typed error on non-200 responses (TelegramError with `code`, `description`, `retry_after?`)
- Honors `retry_after` on 429 by sleeping then retrying once (single retry, no recursion)

`sendChatAction` uses the same retry wrapper as `sendMessage` (the rev1 spec missed this — `sendChatAction` 429 would have surfaced as an uncaught throw).

**Non-text and edited messages:** the poll loop only dispatches `update.message?.text` to the handler. Other update types (`edited_message`, stickers, photos, voice, `/start` commands which arrive as text and are treated identically) are silently dropped at the loop level. `edited_message` is **not** re-processed — by the time the operator edits a question the agent already answered the original, and re-running would charge again with no clear value. Document this in the README.

## Poll loop with 409 circuit breaker

`packages/tg-bot/src/loop.ts`:

```ts
let offset = 0;
let consecutiveFailures = 0;
let consecutive409s = 0;

while (!stopping) {
  try {
    const updates = await getUpdates(token, offset, 30);
    consecutiveFailures = 0;
    consecutive409s = 0;
    for (const u of updates) {
      offset = u.update_id + 1;
      if (u.message?.text) {
        await dispatch(u.message, ctx).catch((e) => {
          console.error('[tg-bot] handler crashed', e);
        });
      }
    }
  } catch (e) {
    if (isTelegramError(e) && e.code === 409) {
      consecutive409s++;
      if (consecutive409s >= 5) {
        console.error('[tg-bot] 5 consecutive 409 conflicts — another poller holds the token. Exiting so Railway restarts cleanly.');
        process.exit(1);
      }
    }
    consecutiveFailures++;
    const backoff = Math.min(60_000, 500 * 2 ** consecutiveFailures);
    console.error(`[tg-bot] getUpdates failed (${consecutiveFailures} consecutive), sleeping ${backoff}ms`, e);
    await Bun.sleep(backoff);
  }
}
```

**Why 409 exit:** Railway's blue-green deploy briefly runs old + new containers. Both poll, both get 409 (only one process can long-poll a token at a time), both back off independently. Without a circuit breaker the old container retries every 500ms-60s until it receives SIGTERM. Exiting on 5 consecutive 409s converts the ambiguous state into a self-healing sequence: old container exits, new container's next poll succeeds.

Offset is **in-memory only**. The dedup-by-`telegram_msg_id` check at dispatch level handles redeploy replay correctly without persisting offset.

## Embedded startup

`packages/tg-bot/src/start.ts` exports the single entry point the api process calls:

```ts
export interface StartBotOptions {
  db: DbClient;
  sql: Sql;
  env: Env;  // typed from apps/api/src/env.ts
}

export async function startBot(opts: StartBotOptions): Promise<void> {
  if (!opts.env.TG_BOT_TOKEN || !opts.env.TG_ALLOWED_CHAT_ID) {
    console.log('[tg-bot] disabled — TG_BOT_TOKEN or TG_ALLOWED_CHAT_ID unset');
    return;
  }

  // Recover from process crashes: any 'running' row older than 1h is stranded.
  await opts.sql`
    UPDATE agent_runs
    SET status = 'failed', error_message = 'process_crash_or_redeploy', ended_at = now()
    WHERE status = 'running' AND started_at < now() - interval '1 hour'
  `;

  // Optional sanity check; non-fatal if Telegram is briefly down at boot.
  try {
    const me = await getMe(opts.env.TG_BOT_TOKEN);
    console.log(`[tg-bot] connected as @${me.username}`);
  } catch (e) {
    console.warn('[tg-bot] getMe failed at boot — will retry in loop', e);
  }

  // Fire and forget; the loop awaits internally.
  loop({
    token: opts.env.TG_BOT_TOKEN,
    allowedChatId: opts.env.TG_ALLOWED_CHAT_ID,
    dispatchCtx: { db: opts.db, env: opts.env },
  }).catch((e) => {
    console.error('[tg-bot] loop crashed at top level — bot is offline', e);
  });
}
```

`apps/api/src/index.ts` adds one line after Hono and graphile-worker are running:

```ts
import { startBot } from '@thirdeye/tg-bot';
// ...existing api boot...
await startBot({ db, sql, env });
```

No new env validation step in `apps/api/src/env.ts` beyond adding the two new TG vars as `z.string().optional()`. The bot self-disables when they're missing — that's the env contract.

## Cost model

**Anthropic spend per message (Haiku 4.5 with prompt caching):**

Two scenarios separated because cache-creation cost is real and frequent.

**Cold cache (first turn in any 5-min window, e.g. after redeploy or idle period):**

| Component | Per-turn estimate |
|---|---|
| System prompt + 6 tool schemas (cache-write, ~2000 tok @ $1.25/MTok) | $0.0025 |
| User message (your text, ~50 tokens uncached) | $0.00005 |
| Tool call sequence (1-3 calls, ~300 output tok @ $5/MTok) | $0.0015 |
| Tool result re-ingestion (varies a lot — see below) | $0.001-$0.030 |
| Final reply generation (~300 output tok) | $0.0015 |
| **Total per cold-cache message** | **~$0.007-$0.040** |

**Warm cache (turn 2+ within 5 min):**

| Component | Per-turn estimate |
|---|---|
| Cached prefix (cache-read @ $0.10/MTok) | $0.0002 |
| User + tool calls + final reply | $0.003-$0.030 |
| **Total per warm-cache message** | **~$0.003-$0.030** |

**Why the wide tool-result range:** `checkWallet` is summarized via `summarizeWalletForLLM` to ~500 tokens. `scanToken` is **not summarized** — it returns the raw `TokenScanResult` (~3000-8000 JSON tokens for a typical 200-holder mint). A two-call conversation that hits `scanToken` lands at the top end.

**Reservation accuracy:** `ESTIMATED_COST_PER_RUN_USD = 0.05` is sized for the heaviest realistic single-turn message (scanToken-heavy cold-cache turn). For lighter turns the reservation overcounts daily spend within the gate's check, but the post-run `finalizeBudget` overwrites with real cost so the daily SUM stays accurate. The trade is "may deny a few queries late in a heavy day" vs. "overshoot the cap." Trade favors denial.

**Daily-spend envelope:** assuming 50 messages/day with realistic mix:
- Conservative: 50 × $0.010 = $0.50/day (~$15/month)
- Realistic: 50 × $0.020 = $1.00/day (~$30/month)
- Heavy scanToken use: 50 × $0.040 = $2.00/day (~$60/month)

The `AGENT_DAILY_COST_USD_CAP=$25` is shared with cron workers. Once 6c discovery and 6d anomaly ship, the bot's effective share is the residual ~$10-17/day, not the full $25.

**Helius credits per message:** `checkWallet` is ~10-15 calls, `scanToken` is ~50-200 calls, the four DB-only tools are zero. Roughly aligned with the existing per-scan envelope; same paid-Helius tier handles it.

**Railway hosting:** One service (api with embedded bot) plus Postgres add-on. At minimal sizing: **$10-18/mo all-in**, varies with Postgres RAM. Going to one service instead of two saves ~$10/mo vs. the rev1 plan.

## Error handling

| Failure mode | Behavior |
|---|---|
| Wrong chat ID | Silently drop; log `[tg-bot] ignored msg from chat=X user=Y` (detects token leaks) |
| Replayed update (telegram_msg_id seen before) | Silently drop; log `[tg-bot] skipping replayed update msg_id=X` |
| `getUpdates` returns 5xx / network error | Exponential backoff 500ms → 60s, keep polling |
| `getUpdates` returns 409 (another poller active) | Backoff once, log warning. After 5 consecutive 409s → `process.exit(1)`. Railway restarts; old container has drained by then |
| Agent loop throws | `sendMessage` apology, best-effort `finalizeBudget` with `errorMessage`, continue polling |
| Budget gate denies | `sendMessage` "Daily cap reached..."; `acquireBudget` already wrote `skipped_budget` row |
| `sendMessage` itself fails | Log + drop the reply, continue. Operator's question is preserved in `agent_runs.metadata` |
| DB pool exhausted / Postgres down mid-flight | Surfaces as agent loop throw; same path. Orphan `running` rows recovered by the boot-time cleanup query |
| Telegram rate-limited (429 with `retry_after`) | Honor `retry_after`, retry once. Applies to `sendMessage` AND `sendChatAction` |
| Non-text update (sticker, photo, voice) | Silently drop at loop level |
| Edited message | Silently drop. The original was already answered; re-charging Anthropic for an edit isn't worth it |
| Forwarded message | Pass through if chat-lock passes (chat.id is the operator's, regardless of original sender) |

The bot never crashes the outer loop except for the deliberate `process.exit(1)` on 5x 409 (Railway restart-on-crash is then load-bearing, intentionally).

## Tests

`packages/tg-bot/tests/dispatch.integration.test.ts` — real Postgres + recorded fixture, no mocks:

```ts
import { recordedAnthropicClient } from '@thirdeye/agent/tests/replay';

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const d = HAVE_DB ? describe : describe.skip;

d('dispatch (integration)', () => {
  // Telegram side is stubbed via injection at the telegram.ts boundary.
  // The agent side uses recordedAnthropicClient with a real captured fixture.
  // Postgres is real, truncated between tests.

  test('drops messages from non-allowlisted chats');
  test('dedups by telegram_msg_id when the same update is replayed');
  test('admits + runs agent, writes agent_runs row with kind=tg_query');
  test('surfaces budget-denied as a "cap reached" reply');
  test('writes failed status when agent throws');
  test('truncates oversized replies at 4090 chars');
  test('boot-time cleanup query flips orphan running rows to failed');
});
```

**Why this approach:** CLAUDE.md is explicit ("No mocking in tests. Integration tests against real running code only. Mocked tests prove nothing."). The `recordedAnthropicClient` pattern at `packages/agent/tests/replay.ts:19` exists for exactly this — captures real Anthropic responses to JSON fixtures and replays them. Fixture for the dispatch test is a single-turn reply with no tool calls (smallest possible fixture). Telegram is stubbed at the transport boundary, not mocked deep inside the loop — the system under test is dispatch, not the Bot API's wire format.

Skip rule: `describe.skip` when `DATABASE_URL` unset, so PRs from forks pass without secrets. Matches the budget integration test's pattern.

No separate `loop.test.ts`. The integration test exercises the loop path through dispatch; backoff curve and 409 circuit breaker can be unit-tested inside dispatch.test if needed, but they're 5-line behaviors that aren't worth their own file.

## File-by-file summary

| File | LOC | Purpose |
|---|---|---|
| `packages/tg-bot/package.json` | 12 | Workspace pkg, two workspace deps, no third-party deps |
| `packages/tg-bot/tsconfig.json` | 4 | Extends root |
| `packages/tg-bot/README.md` | ~80 | BotFather setup, Railway env vars, chat-ID lookup how-to |
| `packages/tg-bot/src/index.ts` | ~10 | Re-exports `startBot`, types |
| `packages/tg-bot/src/telegram.ts` | ~60 | 4 fetch wrappers + inline types + retry-on-429 wrapper |
| `packages/tg-bot/src/dispatch.ts` | ~90 | Chat-lock → dedup → budget → agent → format → send |
| `packages/tg-bot/src/loop.ts` | ~60 | Long-poll + backoff + 409 circuit breaker + offset state |
| `packages/tg-bot/src/start.ts` | ~50 | startBot() entry: env gate, orphan cleanup, getMe sanity, loop |
| `packages/tg-bot/tests/dispatch.integration.test.ts` | ~150 | 7 test cases via recordedAnthropicClient + real Postgres |
| **Total** | **~516** | of which ~344 LOC is production code |

Modifications outside the package:

| File | Change |
|---|---|
| `packages/agent/src/types.ts` | Add `'tg_query'` to the `AgentRunKind` union (**commit #1**) |
| `packages/db/src/schema.ts` | Update the inline comment enumerating `agent_runs.kind` values (same commit as types.ts) |
| `apps/api/src/env.ts` | Add `TG_BOT_TOKEN` and `TG_ALLOWED_CHAT_ID` as `z.string().optional()` |
| `apps/api/src/index.ts` | One line: `await startBot({ db, sql, env })` after Hono + graphile-worker boot |
| `apps/api/package.json` | Add `@thirdeye/tg-bot` as a workspace dep |
| `.env.example` | Add the 2 new env vars with explanatory comments |
| `README.md` | Sub-phase row 6b.6; "Use from Telegram" section pointing at `packages/tg-bot/README.md` |
| `docs/superpowers/specs/2026-05-07-thirdeye-phase-6-design.md` | §5 sub-phase table gains 6b.6 row |
| `CLAUDE.md` (local-only, gitignored) | Phase 6b.6 context block |

**No `docker-compose.yml` change.** The bot embeds in the existing `app` service.

## Sub-phase rollout

Single PR. Six atomic commits matching the implementation plan's task groups:

1. `chore: agent — add tg_query AgentRunKind` (types + schema comment, prerequisite for everything else; passes typecheck)
2. `chore: tg-bot — scaffold @thirdeye/tg-bot package` (package.json, tsconfig, empty exports)
3. `feat: tg-bot — telegram.ts (4 Bot API wrappers + retry)` (testable in isolation)
4. `feat: tg-bot — dispatch with chat-lock, dedup, budget, agent, format, send` (integration test passes)
5. `feat: tg-bot — loop with 409 circuit breaker + startBot() embedding into api` (api boots with bot enabled)
6. `docs: tg-bot — README + .env.example + spec table updates`

**Estimate: 4-5 days** of solo work. Up from rev1's 2-3d because:
- Railway monorepo deploy is new for this codebase (half-day for `railway.json` + nixpacks Bun + env var plumbing)
- Dedup table integration + boot cleanup add a half-day over the original "in-memory offset" plan
- Test rewrite to use replay harness adds a half-day vs. mocked tests

## v1.1 roadmap (deferred)

- **Push notifications.** Subscribe to intel-bus via Postgres LISTEN/NOTIFY, throttle events, format and send. Requires 6c (discovery) and/or 6d (anomaly) to ship first.
- **Conversational memory.** Thread last N message pairs into `initialUserMessage`. Add a `/new` command to start a fresh thread.
- **`summarizeTokenScanForLLM` helper.** Apply summarization to `scanToken` output the way `checkWallet` does. Drops the per-message cost ceiling from ~$0.04 to ~$0.02 and benefits Phase 6c/6d callers too. ~30 LOC, parallel to existing `summarizeWalletForLLM`.
- **MarkdownV2 / link previews.** Format `solscan.io` and `birdeye.so` URLs nicely.
- **Image / chart attachments.** Render histograms (cluster CoV, holder distribution) and `sendPhoto`.
- **Inline keyboard quick-actions.** "Watch this wallet" / "Expand cluster" buttons under a `checkWallet` reply.
- **Multi-user.** Drop the chat-ID lock, add per-user BYOK Helius/Anthropic keys via a `/setkey` flow.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Token leak in Railway env | Medium | Single-user lock means a leaked token only lets attackers hit the bot's `getUpdates` (replies still gated by chat-ID). Worst case: DoS on the bot, not data exfiltration |
| Runaway Anthropic spend | Low | Shared `AGENT_DAILY_COST_USD_CAP` gate via advisory lock. Bot can't bypass it |
| Helius credit exhaustion | Low | No daily cap on Helius credits, but heavy scanToken use on >5 mints/day is already in the spend envelope. Worst case: pause queries until next billing cycle |
| Railway outage | Low | Bot is offline. Operator falls back to MCP server in Claude Desktop or the local API. No data loss — `agent_runs` accumulate in the same DB |
| Telegram API change | Low | Four endpoints we hit are the most stable in the Bot API. Hand-rolled wrappers fail fast and loud, not silently |
| Tool-result token underestimate (scanToken raw JSON) | Medium | Reservation set to $0.05 (heaviest realistic single-turn). `summarizeTokenScanForLLM` helper is the v1.1 fix that drops this risk to zero |
| Concurrent api + tg-bot DB pool contention | Low | One process = one pool. Hono and the bot loop share. Postgres pool max is sized in `apps/api/src/lib/db.ts`; no change needed |

## Open questions deferred to implementation

1. Railway monorepo deployment: one `railway.json` at repo root, or per-service config? **Verify at implementation time.** This is part of the 4-5d estimate.
2. Whether the operator's wallet summary output is too verbose for mobile-screen reading. **Validate against real usage in week 1.** Track as follow-up, not a v1 blocker.
3. Whether the dedup-by-msg-id query needs an index. **Skip in v1.** At sub-100 rows/day the `agent_runs.metadata` jsonb scan is fine; add a GIN index if it ever becomes a bottleneck.

## Self-review notes

- **Placeholder scan:** No TBDs, no "implement later" comments. All env var names verified against actual codebase. All function signatures verified against actual code.
- **Internal consistency:** Architecture diagram, file layout, env table, and cost model all reference the same component names. `tg_query` kind added in one place (`packages/agent/src/types.ts`) and referenced consistently downstream. Test plan uses the existing replay harness, not a new mocking framework.
- **Scope check:** Single-PR-sized. ~344 LOC production code, ~150 LOC tests, no schema migration, no new third-party deps. Comparable to 6b.5.
- **Ambiguity check:** "Reactive only" = no proactive sends. "Single-user" = chat-ID lock on inbound. "Cheap model" tier resolves to `claude-haiku-4-5-20251001` via existing `resolveModel`. "Dedup" = `agent_runs.metadata->>'telegram_msg_id'` exists check, no new table.
- **Drift-against-codebase:** all env var names cross-referenced against `apps/api/src/env.ts` and `.env.example`. All function signatures cross-referenced against `packages/agent/src/{loop,budget,types,models}.ts`.

Spec ready for re-review.
