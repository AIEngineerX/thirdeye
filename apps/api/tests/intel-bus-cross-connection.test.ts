import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";
import { type IntelEvent, _resetIntelBus, initIntelBus, subscribe } from "../src/lib/intel-bus";
import { waitFor } from "./setup";

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn("[intel-bus-cross-connection] DATABASE_URL unset, skipping");
}

let sqlPublisher: Sql;
let sqlListener: Sql;

beforeAll(async () => {
  if (!url) return;
  await _resetIntelBus(); // guard against dirty state from prior test files
  sqlPublisher = postgres(url, { max: 2 });
  sqlListener = postgres(url, { max: 2 });
});

afterAll(async () => {
  if (!url) return;
  await _resetIntelBus();
  await sqlPublisher.end();
  await sqlListener.end();
});

describe.skipIf(!url)("intel-bus cross-connection delivery", () => {
  test("event published on one connection is received on another", async () => {
    // The bus module uses one shared sqlRef, so we initialize it with the
    // listener side. To simulate a separate process publishing, we directly
    // call sql.notify on the publisher connection (bypassing the bus module).
    await initIntelBus(sqlListener);

    const seen: IntelEvent[] = [];
    subscribe((e) => seen.push(e));

    // Simulate cross-process publish: skip the bus module entirely on the
    // publisher side, hit Postgres directly.
    const wire = {
      event: "scan:complete",
      data: {
        id: 99,
        mint: "CROSS_PROC_MINT",
        symbol: "XPM",
        risk: 75,
        sybilFlag: false,
      },
    };
    await sqlPublisher.notify("intel_bus", JSON.stringify(wire));

    await waitFor(() => seen.length === 1);

    expect(seen[0]!.event).toBe("scan:complete");
    const data = seen[0]!.data as { mint: string };
    expect(data.mint).toBe("CROSS_PROC_MINT");
  });
});
