# @thirdeye/tg-bot

Single-user Telegram bot that exposes ThirdEye's six forensics tools (`checkWallet`, `scanToken`, `getClusterSiblings`, `getFunderClusters`, `getHotTokens`, `getWatchlist`) via natural-language chat. Embedded in the existing `apps/api` process; no separate service to deploy.

## Setup

### 1. Create the bot

In Telegram, message [@BotFather](https://t.me/BotFather):

```
/newbot
```

Pick a name and a username. BotFather replies with an HTTP API token of the form `1234567890:ABCDEF...`. That's `TG_BOT_TOKEN`.

### 2. Get your chat ID

In Telegram, message [@userinfobot](https://t.me/userinfobot). It replies with your numeric ID (e.g. `987654321`). That's `TG_ALLOWED_CHAT_ID` — the bot will silently ignore every other chat.

### 3. Send `/start` to your bot

Open the bot in Telegram (search the username from step 1) and send `/start`. This registers your chat so the bot can reply. The `/start` command itself produces no response in v1 — the bot only responds to natural-language questions.

### 4. Set the env vars

For local dev, add to `.env`:

```bash
TG_BOT_TOKEN=1234567890:ABCDEFghijklmnop...
TG_ALLOWED_CHAT_ID=987654321
```

For Railway, add the same two vars to the service's env config.

Both must be set — the bot self-disables (`startBot()` returns immediately) when either is missing. The api still serves normally.

### 5. Run

```bash
bun run dev   # local
```

Or deploy to Railway with the existing `bun run apps/api/src/index.ts` start command — no extra service.

You should see `[tg-bot] connected as @<your_bot_username>` in the logs. Send "check VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1" to the bot and you should get a forensic profile back within ~5-15 seconds.

## Cost

Per-message Anthropic spend: ~$0.007-$0.040 with Haiku 4.5 + prompt caching. See spec §"Cost model" for the cold-cache vs warm-cache breakdown.

Daily spend is gated by `AGENT_DAILY_COST_USD_CAP` (shared with cron workers). The bot reserves `$0.05` per turn pre-flight, finalized to real cost post-run.

## What gets ignored

- Messages from any chat that isn't `TG_ALLOWED_CHAT_ID` — silently dropped, logged once
- Non-text updates (stickers, photos, voice) — silently dropped
- Edited messages — silently dropped (the original was already answered)
- Replayed updates after restart — deduped by `agent_runs.metadata->>'telegram_msg_id'` (failed prior runs are NOT deduped, so a crashed-and-retried message gets a real answer)

## v1.1 roadmap

- Push notifications when 6c discovery / 6d anomaly fire
- Conversational memory across turns + `/new` command
- `summarizeTokenScanForLLM` helper to drop the per-message cost ceiling
- Image/chart attachments for cluster CoV histograms
- Inline keyboard quick-actions on `checkWallet` replies

## License

MIT (same as the parent ThirdEye repo).
