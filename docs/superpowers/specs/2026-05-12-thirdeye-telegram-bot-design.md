---
title: ThirdEye Telegram Bot — Design
date: 2026-05-12
status: Draft
license: MIT
---

# ThirdEye Telegram Bot

> Reactive Telegram bot exposing ThirdEye's forensics tools to the operator via natural-language chat, backed by the Phase 6b agent loop.

## Goal

A Telegram bot the operator (single user) can DM to investigate Solana wallets, scan tokens, expand clusters, and query the intel cache. Natural-language input is dispatched through `@thirdeye/agent`'s existing `runAgentLoop`, using the same six-tool registry that `@thirdeye/mcp-server` (Phase 6b.5) exposes to Claude Desktop. The bot runs as an always-on Railway service so daily-driver use is possible without keeping a laptop online.

This is **sub-phase 6b.6** — a transport-layer companion to 6b.5. Both are thin wrappers over the agent engine shipped in 6b; neither contains forensic logic. 6b.6 differs from 6b.5 in three ways:

1. Hosted (Railway) rather than local-only (stdio)
2. Push-capable transport (the bot can send unsolicited messages once 6c/6d ship; v1 is reactive only)
3. Single-user lock by chat ID (no auth framework needed)

## Non-goals (v1)

- **Multi-user / public bot.** Single chat ID lock; everyone else is silently ignored.
- **Proactive notifications.** No watchlist events, no discovery picks, no anomaly alerts. Deferred until 6c/6d land; then 6c.5 adds intel-bus → TG push.
- **Conversational memory across messages.** Each message is a fresh agent run, no thread context.
- **Inline keyboards / buttons / commands.** Pure text-in, text-out.
- **MarkdownV2 / HTML formatting.** Plain text replies; truncate at 4090 chars rather than chunk-and-paginate.
- **Image or chart attachments.** Future feature; v1 returns JSON-summary text.
- **TG webhooks.** Long-polling only (outbound HTTPS, no public route needed).

## Architecture

### Service topology

Three Railway services share one Postgres:

```
┌────────────────────┐         ┌──────────────────────────────────┐
│  Telegram          │◄────────┤  Railway service: tg-bot         │
│  (operator DM)     │ HTTPS   │   packages/tg-bot/src/bin.ts     │
│                    │ long-   │   Bun process, outbound only     │
└────────────────────┘ poll    └──────┬──────────────┬────────────┘
                                      │              │
                              @thirdeye/agent   @thirdeye/db
                                      │              │
                              ┌───────▼─────┐  ┌────▼────────────┐
                              │  Anthropic  │  │  Railway        │
                              │  API        │  │  Postgres       │
                              └─────────────┘  │  (shared with   │
                                               │   api service)  │
                                               └─────────────────┘
                                      ▲
                                      │ same DB
                              ┌───────┴──────────┐
                              │  Railway service:│
                              │  api (Hono)      │
                              │  apps/api        │
                              └──────────────────┘
```

The `api` service stays unchanged from current main. The `tg-bot` service is new. Both share `DATABASE_URL` (Railway Postgres add-on) and `ANTHROPIC_API_KEY` / `HELIUS_API_KEY` (Railway env, encrypted at rest).

### Package layout

New workspace package, sibling to `packages/mcp-server/`:

```
packages/tg-bot/
├── package.json                    # deps: @thirdeye/agent, @thirdeye/db
├── tsconfig.json                   # extends root
├── README.md                       # Railway + BotFather setup
├── src/
│   ├── index.ts                    # public exports
│   ├── telegram.ts                 # ~50 LOC: typed fetch wrappers for 4 Bot API endpoints
│   ├── dispatch.ts                 # ~70 LOC: one inbound msg → agent run → reply
│   ├── loop.ts                     # ~40 LOC: getUpdates poll loop + offset state
│   └── bin.ts                      # ~40 LOC: Railway entry, env, graceful shutdown
└── tests/
    └── dispatch.test.ts            # in-process: fake message → assert handler does the right thing
```

Total bot code: ~200 LOC. Zero new third-party dependencies (Telegram Bot API is hit via Bun's built-in `fetch`).

### Why no Telegram framework

grammY / Telegraf / node-telegram-bot-api each provide:

- Middleware pattern (we use one handler, don't need it)
- Sessions / scenes (no conversational state in v1, don't need it)
- Inline keyboards / payments / polls (out of scope)
- Type definitions for the Bot API (we hand-roll the four shapes we use; ~25 LOC)
- Reconnect-on-transient-failure (~5 LOC of try/catch + backoff)

For a single-handler reactive bot, the entire framework value reduces to ~30 LOC of reconnect logic and types. We pay that in `telegram.ts` + `loop.ts` directly and avoid the dependency surface, lock-file pressure, and "read the framework docs to understand the bot" cost.

## Data model deltas

### Extend `agent_runs.kind`

Today: `'discovery' | 'anomaly' | 'morning_brief' | 'cluster_expand'`.

Add: `'tg_query'`.

Implementation: the `kind` column is `text` (not a Postgres enum type), so this is a pure TypeScript change. Update `AgentRunKind` in `packages/agent/src/types.ts`. No SQL migration needed.

Every bot turn writes one `agent_runs` row with `kind='tg_query'`, populated with the user's prompt in `metadata`, the model used, token counts, cost, status. The existing audit trail covers TG queries without any new infrastructure.

### No other schema changes

The bot reads what the tools read (`wallets`, `tokens`, `watches`, `funders`, etc.). No new tables.

## Inbound message flow

```
operator sends "check VJSDW6..."
        │
        ▼
1. getUpdates returns the new message
2. chat-lock: if msg.chat.id !== TG_ALLOWED_CHAT_ID → drop silently, log "ignored"
3. sendChatAction(typing) — UX during the 5-15s agent run
4. acquireBudget({
     kind: 'tg_query',
     model: resolveModel('cheap'),
     estimatedCostUsd: env.AGENT_ESTIMATED_COST_PER_RUN_USD,  // default 0.02
     dailyCapUsd: env.AGENT_DAILY_CAP_USD,
     metadata: { telegram_msg_id, prompt: msg.text.slice(0, 200) }
   })
   │
   ├─ admitted=false → sendMessage("Daily cost cap reached. Resets at UTC midnight.")
   │                   finalizeBudget(...)  // marks skipped_budget
   │                   return
   │
   ▼
5. runAgentLoop({
     kind: 'tg_query',
     systemPrompt: SYSTEM_PROMPT,
     initialUserMessage: msg.text,
     modelTier: 'cheap',
     toolContext: { db, serverHeliusKey: env.HELIUS_API_KEY, smartMoneyMinSol: 50 },
     maxToolCalls: env.AGENT_MAX_TOOL_CALLS_PER_RUN,           // 20 default
     maxInputTokens: env.AGENT_MAX_INPUT_TOKENS_PER_RUN        // 100k default
   })
6. finalizeBudget(db, runId, result)  // writes real cost, status, tokens
7. format reply:
       reply = result.finalText
       if reply.length > 4090: reply = reply.slice(0, 4090) + '…[truncated]'
       if reply.length === 0:  reply = "(agent produced no text — see agent_runs id="+runId+")"
8. sendMessage(chatId, reply, { disable_web_page_preview: true })
```

On any thrown exception inside the handler: `sendMessage(chatId, "⚠️ Something went wrong. Check logs.")`, `console.error(e)`, `finalizeBudget` with `errorMessage`, **never crash the outer poll loop**.

## System prompt

```
You are ThirdEye, a Solana wallet and token forensics assistant. The operator
chats with you over Telegram.

You have six tools: checkWallet, scanToken, getClusterSiblings, getFunderClusters,
getHotTokens, getWatchlist. Pick the right one(s) for the operator's question.
Don't ask for confirmation — just call the tool when you have enough info.

Reply with concise findings. Lead with the verdict (CLEAN/LOW/MEDIUM/HIGH or the
key number). Then the supporting facts (cluster size, funding root, top tags).
Skip preamble like "I'll check that for you" — go straight to results.

If the operator gives you a string that's not obviously an address (32-44 base58
chars) or a mint, ask them to clarify in one short sentence.

Keep replies under 600 words. The operator is on mobile.
```

Lives as a constant in `packages/tg-bot/src/dispatch.ts`. Tunable via env var if it changes often: `TG_BOT_SYSTEM_PROMPT` (read at boot, falls back to the const).

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `TG_BOT_TOKEN` | yes | — | From BotFather. Format `<bot_id>:<hash>`. |
| `TG_ALLOWED_CHAT_ID` | yes | — | Operator's numeric Telegram chat ID. Single value; bot ignores everyone else. |
| `DATABASE_URL` | yes | — | Shared with `api` service via Railway Postgres add-on. |
| `ANTHROPIC_API_KEY` | yes | — | Same key the `api` service uses. |
| `HELIUS_API_KEY` | yes | — | Same key the `api` service uses. |
| `AGENT_DAILY_CAP_USD` | no | 25.00 | Shared with cron workers; the bot's spend counts against the same gate. |
| `AGENT_ESTIMATED_COST_PER_RUN_USD` | no | 0.02 | Pre-flight reservation per bot turn. |
| `AGENT_MAX_TOOL_CALLS_PER_RUN` | no | 20 | Per-message cap on tool invocations. |
| `AGENT_MAX_INPUT_TOKENS_PER_RUN` | no | 100000 | Per-message cap on cumulative input tokens. |
| `AGENT_CHEAP_MODEL` | no | claude-haiku-4-5-20251001 | Optional override for the cheap tier. |
| `SMART_MONEY_MIN_SOL` | no | 50 | Forwarded into `ToolContext`. |
| `TG_BOT_SYSTEM_PROMPT` | no | (inlined) | Override the system prompt without a redeploy. |

No `X-User-Helius-Key` / `X-User-Anthropic-Key` BYOK headers — TG doesn't pass HTTP headers and the bot is single-user. The Railway env vars are the only key source.

## Telegram API surface

`packages/tg-bot/src/telegram.ts` is the only place Telegram's HTTP API is touched. Four functions, four fetch calls:

```ts
export interface TgUpdate { update_id: number; message?: TgMessage; }
export interface TgMessage { message_id: number; chat: { id: number }; text?: string; from?: { id: number; username?: string }; }

export async function getUpdates(token: string, offset: number, timeoutSec: number): Promise<TgUpdate[]>
export async function sendMessage(token: string, chatId: number, text: string, opts?: { disableWebPagePreview?: boolean }): Promise<void>
export async function sendChatAction(token: string, chatId: number, action: 'typing'): Promise<void>
export async function getMe(token: string): Promise<{ id: number; username: string }>
```

Each is a `fetch` call to `https://api.telegram.org/bot${token}/<method>` with a JSON body and a structured-error throw on non-200 responses.

## Poll loop

`packages/tg-bot/src/loop.ts` owns the offset state and the long-poll. Pseudocode:

```ts
let offset = 0;
let consecutiveFailures = 0;

while (!stopping) {
  try {
    const updates = await getUpdates(token, offset, 30);   // 30s long-poll
    consecutiveFailures = 0;
    for (const u of updates) {
      offset = u.update_id + 1;
      if (u.message?.text) {
        await dispatch(u.message, ctx).catch((e) => {
          console.error('[tg-bot] handler crashed', e);
        });
      }
    }
  } catch (e) {
    consecutiveFailures++;
    const backoff = Math.min(60_000, 500 * 2 ** consecutiveFailures);
    console.error(`[tg-bot] getUpdates failed (${consecutiveFailures} consecutive), sleeping ${backoff}ms`, e);
    await Bun.sleep(backoff);
  }
}
```

Offset is **in-memory only**. On restart the bot may re-process the most recent few messages (Telegram retains updates for ~24h). Persistent offset is a v1.1 nice-to-have; for a single-user bot the worst case is "Claude answers your last question twice after a deploy" — acceptable.

## Deployment (Railway)

Three services from one repo, one git push:

| Service | Start command | Notes |
|---|---|---|
| `api` | `bun run apps/api/src/index.ts` | unchanged from local |
| `tg-bot` | `bun run packages/tg-bot/src/bin.ts` | new |
| Postgres | (managed add-on) | shared `DATABASE_URL` |

Railway config (one file per service, or a top-level `railway.json` if Railway supports monorepo service config — verify at implementation time). Both Bun services run with `nixpacks` Bun detection or an explicit `Dockerfile` if needed.

`api` and `tg-bot` deploy independently — pushing a TG-only change doesn't restart the API.

### Cold start

`tg-bot/src/bin.ts`:

```ts
1. Read required env (fail fast with non-zero exit if missing TG_BOT_TOKEN / TG_ALLOWED_CHAT_ID / DATABASE_URL / ANTHROPIC_API_KEY / HELIUS_API_KEY).
2. createDb(DATABASE_URL).
3. Optional: getMe() sanity check; log bot username; non-fatal if it fails.
4. await loop({ token, allowedChatId, dispatchCtx: { db, ... } }).
5. process.on('SIGTERM' | 'SIGINT', async () => { stopping = true; await sql.end(); process.exit(0); }).
```

Railway sends SIGTERM on redeploys; the bot finishes its current `getUpdates` cycle, drains the pool, exits.

## Cost model

**Anthropic spend per message (Haiku 4.5 with prompt caching):**

| Component | Per-turn estimate |
|---|---|
| System prompt + tool schemas (cached after first hit) | ~$0.00001 cache read |
| User message (your text, ~50 tokens) | negligible |
| Tool call sequence (1-3 calls typical) | $0.001-$0.005 model output |
| Tool result summaries fed back to model | $0.001-$0.01 (varies with result size) |
| Final reply generation | $0.001-$0.003 |
| **Total per message** | **~$0.003-$0.02** |

100 messages/day = $0.30-$2.00/day = $9-$60/month. Daily cap at `$25` is 5-10x that ceiling, plenty of headroom. The advisory-lock gate denies further runs if you actually approach the cap.

**Helius credits per message:** depends on which tool the agent picks. `checkWallet` is ~10-15 calls per scan, `scanToken` is ~50-200 calls, the four DB-only tools are zero. Roughly aligned with the existing per-scan envelope; same paid-Helius tier handles it.

**Railway:** ~$5/mo base + ~$5-10/mo for Postgres + minor egress. Budget $15/mo all-in.

## Error handling

| Failure mode | Behavior |
|---|---|
| Wrong chat ID | Silently drop; log `[tg-bot] ignored msg from chat=X user=Y` (helps detect if your token leaks) |
| `getUpdates` returns 5xx / network error | Exponential backoff (500ms → 60s ceiling), keep polling |
| `getUpdates` returns 409 (another bot poller active) | Same backoff; log warning. Indicates two processes sharing the token — operational bug, not in-scope to handle |
| Agent loop throws | `sendMessage` apology, `finalizeBudget` with errorMessage, continue polling |
| Budget gate denies (`admitted=false`) | `sendMessage` "Daily cap reached..." |
| `sendMessage` itself fails | Log, drop the reply, continue. The user's question is in `agent_runs.metadata` — recoverable if needed |
| DB pool exhausted | Surfaces as agent loop throw; same path |
| Postgres LISTEN/NOTIFY (intel-bus) not subscribed | N/A — v1 is reactive, doesn't subscribe |
| Telegram rate-limited (429 with `retry_after`) | Honor `retry_after` from response body, then retry the send |

The bot never crashes the outer loop. Railway restart-on-crash exists but shouldn't be load-bearing.

## Tests

`packages/tg-bot/tests/dispatch.test.ts` — in-process integration test against a real Postgres:

```ts
test("dispatch drops messages from non-allowlisted chats");
test("dispatch admits + runs agent for the allowed chat");
test("dispatch surfaces budget-denied as a 'cap reached' reply");
test("dispatch returns a fallback reply when agent throws");
test("dispatch truncates oversized replies at 4090 chars");
```

Uses a fake `runAgentLoop` injected via dependency parameter (mirrors the existing replay pattern in `packages/agent/tests/replay.ts` — recorded JSON fixtures rather than hand-rolled mocks; the inputs/outputs to `dispatch` are simple enough that fixtures are tiny).

Telegram HTTP calls (`sendMessage`, `sendChatAction`) are stubbed at the `telegram.ts` boundary via an injected `client` object. Single integration test — no Telegram mocking framework, no MSW.

`packages/tg-bot/tests/loop.test.ts` — small unit test for the backoff curve and offset advancement, using a stub `getUpdates`.

Skip rules match the existing pattern (`describe.skip` when `DATABASE_URL` unset, so PRs from forks pass without secrets).

## File-by-file summary

| File | LOC | Purpose |
|---|---|---|
| `packages/tg-bot/package.json` | 12 | Workspace pkg, two workspace deps, no third-party deps |
| `packages/tg-bot/tsconfig.json` | 4 | Extends root |
| `packages/tg-bot/README.md` | ~80 | BotFather setup, Railway env vars, chat-ID lookup how-to |
| `packages/tg-bot/src/index.ts` | ~10 | Re-exports `dispatch`, `loop`, types |
| `packages/tg-bot/src/telegram.ts` | ~60 | 4 fetch wrappers + inline types |
| `packages/tg-bot/src/dispatch.ts` | ~80 | Chat-lock → budget → agent → format → send |
| `packages/tg-bot/src/loop.ts` | ~50 | Long-poll + backoff + offset state |
| `packages/tg-bot/src/bin.ts` | ~50 | Env validation, DB init, signal handling, loop start |
| `packages/tg-bot/tests/dispatch.test.ts` | ~120 | 5 dispatch test cases |
| `packages/tg-bot/tests/loop.test.ts` | ~50 | Backoff + offset test |
| **Total** | **~516** | of which ~316 LOC is production code |

Modifications outside the package:

| File | Change |
|---|---|
| `packages/agent/src/types.ts` | Add `'tg_query'` to the `AgentRunKind` union |
| `README.md` | Sub-phase row 6b.6; "Use from Telegram" section pointing at `packages/tg-bot/README.md` |
| `docs/superpowers/specs/2026-05-07-thirdeye-phase-6-design.md` | §5 sub-phase table gains 6b.6 row |
| `CLAUDE.md` (local-only, gitignored) | Phase 6b.6 context block |
| `.env.example` | Add the 3 new env vars with explanatory comments |

## Sub-phase rollout

Single PR. Five atomic commits matching the implementation plan's task groups (scaffold, telegram client, dispatch with tests, loop+bin, README+spec+sub-phase table).

**Estimate: 2-3 days** of solo work, same envelope as 6b.5.

## v1.1 roadmap (deferred)

- **Push notifications.** Subscribe to intel-bus via Postgres LISTEN/NOTIFY, throttle events, format and send. Requires 6c (discovery) and/or 6d (anomaly) to ship first so there's something to push.
- **Conversational memory.** Thread the last N message pairs into `initialUserMessage`. Add a "fresh thread" command (`/new`).
- **Persistent offset.** Store `tg_bot_state.last_update_id` in a small table; avoids replay-on-restart edge case.
- **MarkdownV2 / link previews.** Format `solscan.io` and `birdeye.so` URLs nicely.
- **Image / chart attachments.** Render small histograms (cluster CoV, holder distribution) and `sendPhoto`.
- **Inline keyboard quick-actions.** "Watch this wallet" / "Expand cluster" buttons under a `checkWallet` reply.
- **Multi-user.** Drop the chat-ID lock, add per-user BYOK Helius/Anthropic keys via a `/setkey` flow.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Token leak in Railway env | Medium | Single-user lock means a leaked token only lets attackers hit your bot's `getUpdates` (which they can't anyway because the chat-ID lock filters their messages). Worst case is denial-of-service on your bot, not data exfiltration |
| Runaway Anthropic spend (looped tool calls) | Low | `AGENT_DAILY_CAP_USD` advisory-lock gate is shared with cron workers — bot can't bypass it |
| Helius credit exhaustion | Low | Same daily cap doesn't exist for Helius, but agent-driven scanToken on >5 mints/day is already in your spend envelope. Worst case: pause queries until next billing cycle. Not catastrophic |
| Railway outage | Low | Bot is offline. You revert to the MCP server in Claude Desktop or the local API. No data loss — agent_runs accumulate in the same DB |
| Telegram API change | Low | Four endpoints we hit are the most stable in the Bot API. Hand-rolled wrappers fail fast and loud (typed throws), not silently |

## Open questions deferred to implementation

1. Railway monorepo deployment: one `railway.json` at repo root, or per-service config? Verify when wiring CI.
2. Whether to set `disable_notification: true` on the chat-lock-rejection logger (currently logs only, doesn't reply). Default is "log only" — keep silent.
3. Whether the agent's `summarizeWalletForLLM` output is too verbose for mobile-screen reading. Validate against real usage in the first week; revise the system prompt or extend `summarizeWalletForLLM` if so. Track as a follow-up, not a v1 blocker.

## Self-review notes

- **Placeholder scan:** No TBDs, no "implement later." Every component named has a purpose.
- **Internal consistency:** Architecture diagram, file layout, env table, and cost model all reference the same component names. `tg_query` kind added in one place (`packages/agent/src/types.ts`) and referenced consistently downstream.
- **Scope check:** Single-PR-sized. ~316 LOC production code, ~170 LOC tests, no schema migration, no new third-party deps. Comparable to 6b.5 (which shipped in ~250 LOC).
- **Ambiguity check:** "Reactive only" defined as "no proactive sends" — explicit. "Single-user" defined as "chat-ID lock on inbound" — explicit. "Cheap model" tier resolves to `claude-haiku-4-5-20251001` via existing `resolveModel`.

Spec ready for review.
