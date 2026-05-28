# Operations

Rollback procedures, monitoring posture, and the pre-deploy checklist.

## Health endpoint

```bash
curl http://localhost:3001/health
# → {"ok":true,"db":"ok"}     (200)
# → {"ok":false,"db":"unreachable"}  (503 when Postgres is down)
```

Wire to your platform's uptime monitor — Railway healthchecks, UptimeRobot, Pingdom, etc. Alert on 5xx.

---

## Rollback

The codebase commits atomically (one phase = one or more discrete commits with passing tests on each).

**Code rollback:** `git revert <sha>` for an individual commit, or `git revert <oldest>..<newest>` for a range. Push, redeploy.

**Schema rollback:** Drizzle generates forward-only migrations. To roll back a phase's schema, run the inverse SQL manually:

| Phase | Forward (in `packages/db/drizzle/`) | Manual reverse |
|---|---|---|
| 6f signal engine | `0011_signals.sql` | `DROP TABLE signals; ALTER TABLE tracked_wallets DROP COLUMN signal_winrate, DROP COLUMN signal_wins, DROP COLUMN signal_signals;` |
| 6f smart-money feed | `0010_smart_money_feed.sql` | `DROP TABLE smart_trades; DROP TABLE tracked_wallets;` |
| 6b.6 hardening | `0009_tg_msg_id_dedup.sql` | `DROP INDEX agent_runs_tg_msg_id_dedup_uidx;` |
| 6b.6 hardening | `0008_sse_tickets.sql` | `DROP TABLE sse_tickets;` |
| 6b.6 hardening | `0007_auth_issue_rate_buckets.sql` | `DROP TABLE auth_issue_rate_buckets;` |
| 6b.6 hardening | `0006_agent_runs_cache_creation.sql` | `ALTER TABLE agent_runs DROP COLUMN cache_creation_tokens;` |
| 6b | `0005_agent_runs.sql` | `DROP TABLE agent_runs;` |
| 6a | `0004_tokens.sql` | `DROP TABLE tokens;` |
| 6.0 | `0003_intel_events.sql` | `DROP TABLE intel_events;` |
| 5e | `0002_helius_webhooks.sql` | `DROP TABLE helius_webhooks; DROP TABLE watch_events; DROP TABLE watches;` |
| 5d | `0001_smart_money_pnl.sql` | `ALTER TABLE wallets DROP COLUMN realized_pnl_sol;` |
| 0–4 | `0000_clever_justin_hammer.sql` | Drop the schema and re-bootstrap. |

After manual SQL, delete the corresponding row from `drizzle.__drizzle_migrations` so a future `bun run migrate` doesn't think the migration is still applied.

**Container rollback:**

```bash
docker compose down
git checkout <good-sha>
docker compose up -d --build
```

Postgres data persists in the named volume (`thirdeye-pg-data`).

---

## What's already wired

| Surface | What you get |
|---|---|
| `/health` | DB ping (200/503). Liveness probe target. |
| HTTP request log | `hono/logger` middleware emits path + status + latency to stdout. |
| Proxy response headers | `X-ThirdEye-Cache: HIT\|MISS` + `X-ThirdEye-Proxy-Duration-Ms` on every Helius proxy response. |
| `agent_runs` audit table | Per-run `cost_usd`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `cache_creation_tokens`, status, model. Full Anthropic-cost reconstruction. |
| `auth_tokens.rate_bucket` | jsonb per-token + per-token-BYOK counters under `PUBLIC_INSTANCE_MODE`. Readable as a time-series for abuse detection. |
| Error logging | `console.error`/`console.warn` at every catch site — rate-limit hits, scanner failures, watch sync failures, intel-bus malformed payloads, Helius upstream errors, signals-refresh price-fetch / per-row / attribution failures. |
| `signals-refresh` worker log | Per-tick `[signals-refresh] selected=… updated=… closed=… errored=…` line, emitted only when signals close or errors occur (quiet on idle ticks). |

---

## Operator deploy checklist

Gaps you must fill **before** putting public traffic on the box.

| Gap | Mitigation |
|---|---|
| No structured JSON logging | Pipe stdout through a JSON formatter at the deploy layer (Railway, Datadog agent, vector.dev). Pino integration is a v2 enhancement. |
| No metrics endpoint | The `agent_runs` and `auth_tokens.rate_bucket` columns are the canonical sources — run scheduled SQL queries against them. Prometheus/OTEL exporters are a v2 enhancement. |
| No alerting on `/health` failures | Wire your platform's uptime monitor (UptimeRobot, Pingdom, Railway healthchecks) to `GET /health`. |
| No alerting on rate-limit-bypass anomalies | Watch for sustained `auth_issue_rate_limited` log lines or `*_byok` bucket spikes: `SELECT token, rate_bucket FROM auth_tokens WHERE (rate_bucket->>'scan_token_byok')::jsonb->>'count' > '100';` |
| No alerting on agent daily-cost overshoot | The cap itself is enforced via Postgres advisory lock so cost cannot exceed `AGENT_DAILY_COST_USD_CAP`. Add a daily SQL check: `SELECT SUM(cost_usd) FROM agent_runs WHERE started_at > now() - interval '1 day';` and alert at >80% of cap. |
| No reverse proxy in front of api | **REQUIRED** if you set `PUBLIC_INSTANCE_MODE=true`. The proxy must (a) set `X-Forwarded-For` with the real client IP AND (b) strip any client-supplied `X-Forwarded-For`. Without (b), the per-IP rate limit on `/api/db/auth` is bypassable by header spoofing. |
| Helius credits are real money | Respect the per-scan (10) and per-process (50) concurrency caps in `packages/scanner/src/semaphore.ts`. A runaway scan could burn hundreds of credits in seconds. |

---

## Cost monitoring (the agent paths)

The advisory-lock budget gate at `packages/agent/src/budget.ts` enforces `AGENT_DAILY_COST_USD_CAP` (default $25) inside a single Postgres transaction holding `pg_advisory_xact_lock(hashtext('agent_daily_budget'))`. Race-proof.

Per-run cost is stored alongside token counts so you can reconcile against Anthropic invoices:

```sql
SELECT
  date_trunc('day', started_at) AS day,
  kind,
  COUNT(*) AS runs,
  SUM(cost_usd)::numeric(10,4) AS total_usd,
  SUM(input_tokens) AS input_tokens,
  SUM(cached_input_tokens) AS cached_in,
  SUM(output_tokens) AS output_tokens
FROM agent_runs
WHERE status IN ('success','capped')
  AND started_at > now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
```

Status taxonomy: `running`, `success`, `failed`, `capped`, `skipped_budget`. A `skipped_budget` row means the daily cap pre-check failed; the agent never spent a token.

---

## When something goes wrong

| Symptom | First look |
|---|---|
| `/health` returns 503 | Postgres down — check `docker compose ps postgres`, `docker logs thirdeye-postgres`. |
| All requests return 401 | `auth_tokens` row expired (7d) or got revoked. The dashboard auto-reissues; raw curl needs a fresh `POST /api/db/auth`. |
| Helius proxy 429s in the log | Either rate limit hit, or upstream Helius rate limit. Inspect `auth_tokens.rate_bucket` for the calling token and Helius dashboard for upstream quota. |
| Wallet check stuck on `funding` event | Probably Helius parsed-tx fetch slow or rate-limited. Check `console.error` for `[scan ...] helius_error` lines. |
| Agent_runs row stuck at status='running' | Worker crashed mid-run. The `cleanup-tables` cron flips stale rows to `failed` after 1h. |
| Intel feed silent | Verify the SSE connection didn't get clobbered by a second tab — feed.ts enforces one connection per token. |
| Tg-bot doesn't respond | Check `[tg-bot] connected as @<bot>` in logs. Common causes: `TG_BOT_TOKEN` typo, message from non-allowed chat (silently dropped), unique-violation on dedup race (also silently dropped). |
| MCP server in Claude Desktop reports tool errors | Server-side `console.error` logs have the real error. The user-facing message is intentionally generic to avoid leaking DB/schema fragments to the LLM. |
