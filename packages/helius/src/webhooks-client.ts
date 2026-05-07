// Phase 5e: thin wrapper over Helius's webhook management API. Distinct
// base URL from wallet-api / DAS:
//   wallet-api: api.helius.xyz/v1/...
//   DAS:        mainnet.helius-rpc.com/?
//   webhooks:   api-mainnet.helius-rpc.com/v0/webhooks
//
// Lives in @thirdeye/helius (not @thirdeye/scanner) because it's pure
// Helius infra — no scanner-domain logic. The route handlers in apps/api
// orchestrate it against our own DB state.

const WEBHOOK_BASE = "https://api-mainnet.helius-rpc.com/v0/webhooks";

export interface HeliusWebhook {
  webhookID: string;
  webhookURL: string;
  webhookType: string;
  accountAddresses: string[];
  transactionTypes: string[];
  authHeader?: string;
  active?: boolean;
}

export interface CreateWebhookOptions {
  apiKey: string;
  webhookURL: string;
  accountAddresses: string[];
  authHeader: string;
  // transactionTypes omitted ⇒ Helius sends all types. We filter client-side
  // via the SSE feed's intel-bus consumer; keeps the system flexible.
}

export interface UpdateWebhookOptions {
  apiKey: string;
  webhookID: string;
  accountAddresses: string[];
  // We don't change webhookURL or authHeader on update — those are set at
  // create time and only mutated by explicit ops calls (manual rotation).
}

async function jsonOrThrow<T>(res: Response, op: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Helius webhook ${op} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  if (text.length === 0) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Helius webhook ${op} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

export async function createWebhook(opts: CreateWebhookOptions): Promise<HeliusWebhook> {
  const res = await fetch(`${WEBHOOK_BASE}?api-key=${opts.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      webhookURL: opts.webhookURL,
      webhookType: "enhanced",
      accountAddresses: opts.accountAddresses,
      transactionTypes: [],
      authHeader: opts.authHeader,
    }),
  });
  return jsonOrThrow<HeliusWebhook>(res, "create");
}

export async function getWebhook(apiKey: string, webhookID: string): Promise<HeliusWebhook | null> {
  const res = await fetch(`${WEBHOOK_BASE}/${webhookID}?api-key=${apiKey}`);
  if (res.status === 404) return null;
  return jsonOrThrow<HeliusWebhook>(res, "get");
}

export async function updateWebhook(opts: UpdateWebhookOptions): Promise<HeliusWebhook> {
  const res = await fetch(`${WEBHOOK_BASE}/${opts.webhookID}?api-key=${opts.apiKey}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountAddresses: opts.accountAddresses }),
  });
  return jsonOrThrow<HeliusWebhook>(res, "update");
}

export async function deleteWebhook(apiKey: string, webhookID: string): Promise<void> {
  const res = await fetch(`${WEBHOOK_BASE}/${webhookID}?api-key=${apiKey}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Helius webhook delete failed: ${res.status}`);
  }
}

// ── Inbound payload shape (a SUBSET of fields we actually use) ──────────────
// Helius sends an array of these. Documented at
// https://www.helius.dev/docs/api-reference/webhooks#webhook-payload-enhanced
// Defensive about extra fields; only declares what we read.
export interface HeliusInboundEvent {
  signature: string;
  type?: string;
  source?: string;
  description?: string;
  fee?: number;
  feePayer?: string;
  slot?: number;
  timestamp?: number;
  tokenTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    tokenAmount?: number;
    mint?: string;
  }>;
  accountData?: Array<{
    account?: string;
    nativeBalanceChange?: number;
  }>;
}
