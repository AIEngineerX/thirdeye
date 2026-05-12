import { type DispatchContext, dispatch } from "./dispatch";
import { getUpdates, isTelegramError } from "./telegram";

const POLL_TIMEOUT_SEC = 30;
const MAX_BACKOFF_MS = 60_000;
const CONSECUTIVE_409_LIMIT = 5;
const CONFLICT_COOLDOWN_MS = 500;

export interface LoopOptions {
  token: string;
  ctx: DispatchContext;
  signal?: AbortSignal;
}

export async function loop(opts: LoopOptions): Promise<void> {
  let offset = 0;
  let consecutiveFailures = 0;
  let consecutive409s = 0;

  while (!opts.signal?.aborted) {
    try {
      const updates = await getUpdates(opts.token, offset, POLL_TIMEOUT_SEC);
      consecutiveFailures = 0;
      consecutive409s = 0;

      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message?.text) {
          await dispatch(u.message, opts.ctx).catch((e) => {
            console.error("[tg-bot] handler crashed", e);
          });
        }
        // Non-text and edited_message updates are intentionally dropped.
      }
    } catch (e) {
      if (isTelegramError(e) && e.code === 409) {
        consecutive409s++;
        if (consecutive409s >= CONSECUTIVE_409_LIMIT) {
          console.error(
            `[tg-bot] ${CONSECUTIVE_409_LIMIT} consecutive 409 conflicts — another poller holds the token (likely Railway blue-green overlap). Exiting so the platform restarts cleanly.`,
          );
          process.exit(1);
        }
        // 409 is self-healing once the competing poller exits. Use a short
        // fixed cooldown rather than the exponential curve so the new
        // container picks up promptly after blue-green handoff settles.
        console.warn(
          `[tg-bot] 409 conflict (${consecutive409s} consecutive), sleeping ${CONFLICT_COOLDOWN_MS}ms`,
        );
        await Bun.sleep(CONFLICT_COOLDOWN_MS);
        continue;
      }
      consecutiveFailures++;
      const backoff = Math.min(MAX_BACKOFF_MS, 500 * 2 ** consecutiveFailures);
      console.error(
        `[tg-bot] getUpdates failed (${consecutiveFailures} consecutive), sleeping ${backoff}ms`,
        e,
      );
      await Bun.sleep(backoff);
    }
  }
}
