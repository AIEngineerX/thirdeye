// One-shot probe — does setting process.env after import propagate to
// the route handler's heliusWebhookAuth() reader?
import { app } from "../apps/api/src/index";

process.env.HELIUS_WEBHOOK_AUTH = "test-secret-abc";
console.log(
  "[debug] set HELIUS_WEBHOOK_AUTH; process.env value =",
  process.env.HELIUS_WEBHOOK_AUTH,
);

const r = await app.request("/api/helius-webhook", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "test-secret-abc" },
  body: JSON.stringify([]),
});
console.log("[debug] response status:", r.status);
console.log("[debug] response body:", await r.text());
process.exit(0);
