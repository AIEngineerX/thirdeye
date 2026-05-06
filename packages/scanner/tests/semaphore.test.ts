import { describe, expect, test } from "bun:test";
import { Semaphore } from "../src/semaphore";

describe("Semaphore", () => {
  test("rejects capacity < 1", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
  });

  test("never exceeds capacity under burst", async () => {
    const sem = new Semaphore(3);
    let inFlight = 0;
    let peak = 0;
    const work = async () => {
      const release = await sem.acquire();
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      release();
    };
    await Promise.all(Array.from({ length: 30 }, () => work()));
    expect(peak).toBeLessThanOrEqual(3);
    expect(inFlight).toBe(0);
  });

  test("run() releases on success", async () => {
    const sem = new Semaphore(1);
    const out = await sem.run(async () => 42);
    expect(out).toBe(42);
    // Slot is free if next acquire resolves promptly.
    const release = await sem.acquire();
    release();
  });

  test("run() releases on throw", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const release = await sem.acquire();
    release();
  });

  test("FIFO order under contention", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const release1 = await sem.acquire();
    const p2 = sem.acquire().then((r) => {
      order.push(2);
      r();
    });
    const p3 = sem.acquire().then((r) => {
      order.push(3);
      r();
    });
    const p4 = sem.acquire().then((r) => {
      order.push(4);
      r();
    });
    release1();
    await Promise.all([p2, p3, p4]);
    expect(order).toEqual([2, 3, 4]);
  });
});
