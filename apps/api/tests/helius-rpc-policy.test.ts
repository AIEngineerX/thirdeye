import { describe, expect, test } from "bun:test";
import { RPC_ALLOW_LIST, validateRpcEnvelope } from "@thirdeye/helius";

describe("validateRpcEnvelope", () => {
  test("accepts well-formed envelope with allowlisted method", () => {
    const r = validateRpcEnvelope({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: ["sig"],
    });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.method).toBe("getTransaction");
  });

  test("rejects missing method", () => {
    const r = validateRpcEnvelope({ jsonrpc: "2.0", id: 1, params: [] });
    expect(r.kind).toBe("invalid");
  });

  test("rejects non-string method", () => {
    const r = validateRpcEnvelope({
      jsonrpc: "2.0",
      id: 1,
      method: 5,
      params: [],
    });
    expect(r.kind).toBe("invalid");
  });

  test("rejects bad jsonrpc version", () => {
    const r = validateRpcEnvelope({
      jsonrpc: "1.0",
      id: 1,
      method: "getBalance",
      params: [],
    });
    expect(r.kind).toBe("invalid");
  });

  test("rejects non-array params", () => {
    const r = validateRpcEnvelope({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: { not: "an array" },
    });
    expect(r.kind).toBe("invalid");
  });

  test("rejects null body", () => {
    const r = validateRpcEnvelope(null);
    expect(r.kind).toBe("invalid");
  });

  test("rejects batched RPC (array body) with explicit reason", () => {
    const r = validateRpcEnvelope([
      { jsonrpc: "2.0", id: 1, method: "getBalance", params: [] },
      { jsonrpc: "2.0", id: 2, method: "getBalance", params: [] },
    ]);
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.reason).toMatch(/batched|array/i);
  });

  test("rejects mutating method sendTransaction (not on allowlist)", () => {
    const r = validateRpcEnvelope({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [],
    });
    expect(r.kind).toBe("forbidden");
    if (r.kind === "forbidden") expect(r.method).toBe("sendTransaction");
  });

  test("rejects mutating method simulateTransaction", () => {
    const r = validateRpcEnvelope({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [],
    });
    expect(r.kind).toBe("forbidden");
  });

  test("rejects mutating method requestAirdrop", () => {
    const r = validateRpcEnvelope({
      jsonrpc: "2.0",
      id: 1,
      method: "requestAirdrop",
      params: [],
    });
    expect(r.kind).toBe("forbidden");
  });

  test("rejects sendRawTransaction (the canonical signed-tx submission) — H6", () => {
    // This is the actual method wallets/programs use to submit signed
    // transactions. The old denylist missed it; the allowlist blocks it
    // by default because it's not enumerated.
    const r = validateRpcEnvelope({
      jsonrpc: "2.0",
      id: 1,
      method: "sendRawTransaction",
      params: ["base64-encoded-tx"],
    });
    expect(r.kind).toBe("forbidden");
  });

  test("rejects unknown methods by default (allowlist semantics)", () => {
    const r = validateRpcEnvelope({
      jsonrpc: "2.0",
      id: 1,
      method: "futureUnreleasedMethod",
      params: [],
    });
    expect(r.kind).toBe("forbidden");
  });

  test("allowlist contains essential read methods", () => {
    expect(RPC_ALLOW_LIST.has("getBalance")).toBe(true);
    expect(RPC_ALLOW_LIST.has("getTransaction")).toBe(true);
    expect(RPC_ALLOW_LIST.has("getHealth")).toBe(true);
    expect(RPC_ALLOW_LIST.has("getAccountInfo")).toBe(true);
    expect(RPC_ALLOW_LIST.has("getAssetsByOwner")).toBe(true);
  });

  test("allowlist excludes all known mutating methods", () => {
    expect(RPC_ALLOW_LIST.has("sendTransaction")).toBe(false);
    expect(RPC_ALLOW_LIST.has("sendRawTransaction")).toBe(false);
    expect(RPC_ALLOW_LIST.has("simulateTransaction")).toBe(false);
    expect(RPC_ALLOW_LIST.has("requestAirdrop")).toBe(false);
  });
});
