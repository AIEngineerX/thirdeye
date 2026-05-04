import { describe, expect, test } from "bun:test";
import { composeRestUrl, composeRpcUrl } from "@thirdeye/helius";

describe("composeRestUrl", () => {
  test("strips leading slash and uses api.helius.xyz host", () => {
    const u = composeRestUrl({ path: "/v1/wallet/abc/identity", apiKey: "K" });
    expect(u).toBe("https://api.helius.xyz/v1/wallet/abc/identity?api-key=K");
  });

  test("appends sorted query params after api-key", () => {
    const u = composeRestUrl({
      path: "/v1/wallet/abc/balances",
      apiKey: "K",
      query: { showNative: "true", limit: "100" },
    });
    expect(u).toBe(
      "https://api.helius.xyz/v1/wallet/abc/balances?api-key=K&limit=100&showNative=true",
    );
  });

  test("encodes query values", () => {
    const u = composeRestUrl({
      path: "/v0/addresses/abc/transactions",
      apiKey: "K",
      query: { type: "TOKEN TRANSFER" },
    });
    expect(u).toContain("type=TOKEN+TRANSFER");
  });

  test("adds leading slash if missing", () => {
    const u = composeRestUrl({ path: "v1/wallet/abc/identity", apiKey: "K" });
    expect(u).toBe("https://api.helius.xyz/v1/wallet/abc/identity?api-key=K");
  });
});

describe("composeRpcUrl", () => {
  test("uses mainnet.helius-rpc.com host", () => {
    expect(composeRpcUrl("K")).toBe("https://mainnet.helius-rpc.com/?api-key=K");
  });
});
