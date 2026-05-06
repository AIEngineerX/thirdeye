import { describe, expect, test } from "bun:test";
import { type IntelEvent, publish, subscribe, subscriberCount } from "../src/lib/intel-bus";

describe("intel-bus", () => {
  test("publish delivers to subscribers", () => {
    const seen: IntelEvent[] = [];
    const unsub = subscribe((e) => seen.push(e));
    publish({ event: "check:start", data: { address: "abc" } });
    publish({
      event: "check:complete",
      data: { address: "abc", score: 42, verdict: "CLEAN" },
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.event).toBe("check:start");
    expect(seen[1]!.event).toBe("check:complete");
    unsub();
  });

  test("unsubscribe stops delivery", () => {
    const seen: IntelEvent[] = [];
    const unsub = subscribe((e) => seen.push(e));
    publish({ event: "scan:start", data: { mint: "M", symbol: null } });
    unsub();
    publish({ event: "scan:start", data: { mint: "N", symbol: null } });
    expect(seen).toHaveLength(1);
  });

  test("multiple subscribers all receive", () => {
    const a: IntelEvent[] = [];
    const b: IntelEvent[] = [];
    const unsubA = subscribe((e) => a.push(e));
    const unsubB = subscribe((e) => b.push(e));
    publish({ event: "check:start", data: { address: "x" } });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    unsubA();
    unsubB();
  });

  test("handler that throws does not break sibling delivery", () => {
    const seen: IntelEvent[] = [];
    const unsubBad = subscribe(() => {
      throw new Error("bad handler");
    });
    const unsubGood = subscribe((e) => seen.push(e));
    publish({ event: "check:start", data: { address: "x" } });
    expect(seen).toHaveLength(1);
    unsubBad();
    unsubGood();
  });

  test("subscriberCount tracks add/remove", () => {
    const before = subscriberCount();
    const u1 = subscribe(() => {});
    const u2 = subscribe(() => {});
    expect(subscriberCount()).toBe(before + 2);
    u1();
    expect(subscriberCount()).toBe(before + 1);
    u2();
    expect(subscriberCount()).toBe(before);
  });
});
