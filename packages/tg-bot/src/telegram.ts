// Telegram Bot API client — minimal surface for the bot's needs.
// Documentation: https://core.telegram.org/bots/api
//
// Each function POSTs JSON to https://api.telegram.org/bot<token>/<method>
// and throws TelegramError on non-200 responses. 429 responses are honored
// (Telegram returns retry_after in the body) — single retry, no recursion.

const BASE = "https://api.telegram.org";

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  from?: { id: number; username?: string };
}

export class TelegramError extends Error {
  constructor(
    public code: number,
    public description: string,
    public retryAfter?: number,
  ) {
    super(`telegram ${code}: ${description}`);
    this.name = "TelegramError";
  }
}

export function isTelegramError(e: unknown): e is TelegramError {
  return e instanceof TelegramError;
}

async function call<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const url = `${BASE}/bot${token}/${method}`;
  const doFetch = () =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  let res = await doFetch();
  if (res.status === 429) {
    const errBody = (await res.json().catch(() => ({}))) as {
      parameters?: { retry_after?: number };
      description?: string;
    };
    const retryAfter = errBody.parameters?.retry_after ?? 1;
    await Bun.sleep(retryAfter * 1000);
    res = await doFetch();
  }
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
    error_code?: number;
    parameters?: { retry_after?: number };
  };
  if (!res.ok || json.ok !== true) {
    throw new TelegramError(
      json.error_code ?? res.status,
      json.description ?? `HTTP ${res.status}`,
      json.parameters?.retry_after,
    );
  }
  return json.result as T;
}

export async function getUpdates(
  token: string,
  offset: number,
  timeoutSec: number,
): Promise<TgUpdate[]> {
  return await call<TgUpdate[]>(token, "getUpdates", {
    offset,
    timeout: timeoutSec,
  });
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  opts: { disableWebPagePreview?: boolean } = {},
): Promise<void> {
  await call(token, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: opts.disableWebPagePreview ?? true,
  });
}

export async function sendChatAction(
  token: string,
  chatId: number,
  action: "typing",
): Promise<void> {
  await call(token, "sendChatAction", {
    chat_id: chatId,
    action,
  });
}

export async function getMe(token: string): Promise<{ id: number; username: string }> {
  return await call<{ id: number; username: string }>(token, "getMe", {});
}
