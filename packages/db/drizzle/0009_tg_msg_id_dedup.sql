-- Closes the tg-bot dedup race (audit L4 / bug-scan L4 / status snapshot).
-- Two concurrent Telegram updates with the same telegram_msg_id could both
-- pass the EXISTS dedup check before either INSERT committed, racing into
-- double agent runs. A partial unique index over
-- (metadata->>'telegram_msg_id') excluding 'failed' rows makes the second
-- INSERT fail at the DB level — dispatch can catch the unique-violation
-- and treat it as "already handled" without a second agent run.
--
-- 'failed' rows are excluded so a previously-crashed run can be retried
-- (matches the existing semantic in dispatch.ts isDuplicate).
CREATE UNIQUE INDEX "agent_runs_tg_msg_id_dedup_uidx"
  ON "agent_runs" ((metadata->>'telegram_msg_id'))
  WHERE status != 'failed' AND metadata->>'telegram_msg_id' IS NOT NULL;
