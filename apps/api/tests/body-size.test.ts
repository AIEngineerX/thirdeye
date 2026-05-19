import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { bodySizeLimit } from "../src/middleware/body-size";

function makeApp(maxBytes?: number) {
  const app = new Hono();
  app.use("*", bodySizeLimit(maxBytes));
  app.post("/probe", async (c) => {
    const body = await c.req.text();
    return c.json({ ok: true, len: body.length });
  });
  app.get("/probe", (c) => c.json({ ok: true }));
  return app;
}

describe("bodySizeLimit middleware", () => {
  test("admits POST under the limit", async () => {
    const app = makeApp(1024);
    const r = await app.request("/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "10" },
      body: "0123456789",
    });
    expect(r.status).toBe(200);
  });

  test("rejects POST over the limit with 413", async () => {
    const app = makeApp(100);
    const big = "x".repeat(200);
    const r = await app.request("/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "200" },
      body: big,
    });
    expect(r.status).toBe(413);
    const body = (await r.json()) as { error: string; maxBytes: number };
    expect(body.error).toBe("payload_too_large");
    expect(body.maxBytes).toBe(100);
  });

  test("ignores GET requests entirely", async () => {
    const app = makeApp(1);
    const r = await app.request("/probe");
    expect(r.status).toBe(200);
  });

  test("default cap is 64 KB", async () => {
    const app = makeApp();
    const exactly_under = "y".repeat(64 * 1024 - 1);
    const exactly_over = "y".repeat(64 * 1024 + 1);
    const r1 = await app.request("/probe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(exactly_under.length),
      },
      body: exactly_under,
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request("/probe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(exactly_over.length),
      },
      body: exactly_over,
    });
    expect(r2.status).toBe(413);
  });
});
