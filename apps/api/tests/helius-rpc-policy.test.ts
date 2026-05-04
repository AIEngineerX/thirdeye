import { describe, expect, test } from "bun:test";
import { validateRpcEnvelope, RPC_DENY_LIST } from "@thirdeye/helius";

describe("validateRpcEnvelope", () => {
  test("accepts well-formed envelope", () => {
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

  test("rejects denied method (sendTransaction)", () => {
    const r = validateRpcEnvelope({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [],
    });
    expect(r.kind).toBe("forbidden");
    if (r.kind === "forbidden") expect(r.method).toBe("sendTransaction");
  });

  test("rejects denied method (simulateTransaction)", () => {
    const r = validateRpcEnvelope({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [],
    });
    expect(r.kind).toBe("forbidden");
  });

  test("rejects denied method (requestAirdrop)", () => {
    const r = validateRpcEnvelope({
      jsonrpc: "2.0",
      id: 1,
      method: "requestAirdrop",
      params: [],
    });
    expect(r.kind).toBe("forbidden");
  });

  test("DENY_LIST is non-empty and exact", () => {
    expect(RPC_DENY_LIST.has("sendTransaction")).toBe(true);
    expect(RPC_DENY_LIST.has("simulateTransaction")).toBe(true);
    expect(RPC_DENY_LIST.has("requestAirdrop")).toBe(true);
    expect(RPC_DENY_LIST.has("getTransaction")).toBe(false);
    expect(RPC_DENY_LIST.has("getBalance")).toBe(false);
  });
});
