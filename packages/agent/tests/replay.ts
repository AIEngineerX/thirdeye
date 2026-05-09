import { readFileSync } from "node:fs";
import type { CallModelOptions, CallModelResult } from "../src/client";

interface RecordedTurn {
  expectedToolUseNames?: string[];
  result: CallModelResult;
}

interface RecordedFixture {
  turns: RecordedTurn[];
}

export interface ReplayClient {
  client: (opts: CallModelOptions) => Promise<CallModelResult>;
  callsMade: () => number;
  reset: () => void;
}

export function recordedAnthropicClient(fixturePath: string): ReplayClient {
  const fixture: RecordedFixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  let cursor = 0;

  return {
    client: async (_opts) => {
      if (cursor >= fixture.turns.length) {
        throw new Error(`replay fixture exhausted at turn ${cursor}`);
      }
      const turn = fixture.turns[cursor];
      if (!turn) throw new Error(`replay fixture turn ${cursor} missing`);
      cursor++;
      return turn.result;
    },
    callsMade: () => cursor,
    reset: () => {
      cursor = 0;
    },
  };
}
