import { beforeEach, describe, expect, test } from "bun:test";
import { createByokStore } from "./byok";

interface MemStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  data: Map<string, string>;
}

function memStorage(): MemStorage {
  const data = new Map<string, string>();
  return {
    data,
    getItem(k) {
      return data.get(k) ?? null;
    },
    setItem(k, v) {
      data.set(k, v);
    },
    removeItem(k) {
      data.delete(k);
    },
  };
}

describe("byok store", () => {
  let storage: MemStorage;
  beforeEach(() => {
    storage = memStorage();
  });

  test("snapshot starts empty", () => {
    const s = createByokStore(storage);
    expect(s.snapshot()).toEqual({ helius: null });
  });

  test("set + get round-trip", () => {
    const s = createByokStore(storage);
    s.set("helius", "hel-xyz");
    expect(s.get("helius")).toBe("hel-xyz");
    expect(s.snapshot()).toEqual({ helius: "hel-xyz" });
  });

  test("set trims whitespace; empty string clears", () => {
    const s = createByokStore(storage);
    s.set("helius", "  hel-xyz  ");
    expect(s.get("helius")).toBe("hel-xyz");
    s.set("helius", "   ");
    expect(s.get("helius")).toBeNull();
  });

  test("clear removes the stored key", () => {
    const s = createByokStore(storage);
    s.set("helius", "h");
    s.clear("helius");
    expect(s.snapshot()).toEqual({ helius: null });
  });

  test("subscribe fires on set/clear", () => {
    const s = createByokStore(storage);
    const seen: { helius: string | null }[] = [];
    const unsubscribe = s.subscribe((snap) => seen.push(snap));

    s.set("helius", "h1");
    s.clear("helius");
    unsubscribe();
    s.set("helius", "ignored-after-unsubscribe");

    expect(seen).toEqual([{ helius: "h1" }, { helius: null }]);
  });

  test("emit() triggers subscribers without state change (cross-tab bridge path)", () => {
    const s = createByokStore(storage);
    const calls: number[] = [];
    s.subscribe(() => calls.push(1));

    // Simulate another tab writing to the underlying storage and the
    // browser `storage` event firing on this tab.
    storage.setItem("thirdeye.byok.helius", "external");
    expect(calls.length).toBe(0); // no notify yet
    s.emit();
    expect(calls.length).toBe(1);
    expect(s.get("helius")).toBe("external");
  });

  test("null storage returns a no-op store", () => {
    const s = createByokStore(null);
    s.set("helius", "ignored");
    expect(s.snapshot()).toEqual({ helius: null });
  });

  test("uses prefixed keys to avoid collisions with other localStorage entries", () => {
    const s = createByokStore(storage);
    s.set("helius", "hel-xyz");
    expect(storage.data.has("thirdeye.byok.helius")).toBe(true);
    expect(storage.data.has("helius")).toBe(false);
  });
});
