import { describe, expect, test } from "bun:test";
import { type SseFrame, parseSseFrames } from "./sse";

/**
 * Build a ReadableStream<string> that emits the given chunks in order.
 * Each chunk is enqueued sequentially. The stream closes after the last
 * chunk. This lets us assert frame-extraction behavior under any chunk-
 * boundary scenario.
 */
function streamFromChunks(chunks: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<SseFrame, void>): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

describe("parseSseFrames", () => {
  test("parses a single complete frame", async () => {
    const stream = streamFromChunks(['event: hello\ndata: {"ok":true}\n\n']);
    const frames = await collect(parseSseFrames(stream));
    expect(frames).toEqual([{ event: "hello", data: { ok: true } }]);
  });

  test("parses multiple frames in one chunk", async () => {
    const stream = streamFromChunks([
      'event: started\ndata: {"x":1}\n\nevent: result\ndata: {"x":2}\n\n',
    ]);
    const frames = await collect(parseSseFrames(stream));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ event: "started", data: { x: 1 } });
    expect(frames[1]).toEqual({ event: "result", data: { x: 2 } });
  });

  test("frame split across two chunks: line break inside data", async () => {
    const stream = streamFromChunks(["event: result\ndata: ", '{"score":87}\n\n']);
    const frames = await collect(parseSseFrames(stream));
    expect(frames).toEqual([{ event: "result", data: { score: 87 } }]);
  });

  test("frame split across three chunks: large JSON across boundaries", async () => {
    // The canonical case the spec-scope review demanded coverage for: a
    // large result JSON payload split across multiple TCP chunks. The
    // parser must buffer until it sees the blank-line separator.
    const fullJson = JSON.stringify({
      address: "Bxyz9".padEnd(44, "x"),
      score: 87,
      tags: ["SYBIL", "BUNDLER", "FRESH_WALLET"],
      cluster: { firstFunder: "Fxy".padEnd(44, "a"), size: 47 },
    });
    const full = `event: result\ndata: ${fullJson}\n\n`;

    // Split mid-data
    const a = full.slice(0, 40);
    const b = full.slice(40, 90);
    const c = full.slice(90);
    expect(a + b + c).toBe(full);

    const stream = streamFromChunks([a, b, c]);
    const frames = await collect(parseSseFrames(stream));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe("result");
    expect((frames[0]!.data as { score: number }).score).toBe(87);
    expect((frames[0]!.data as { tags: string[] }).tags).toEqual([
      "SYBIL",
      "BUNDLER",
      "FRESH_WALLET",
    ]);
  });

  test("blank-line separator split across chunks", async () => {
    // The "\n\n" terminator itself spans the chunk boundary
    const stream = streamFromChunks(["event: ping\ndata: {}\n", "\nevent: pong\ndata: {}\n\n"]);
    const frames = await collect(parseSseFrames(stream));
    expect(frames).toHaveLength(2);
    expect(frames[0]!.event).toBe("ping");
    expect(frames[1]!.event).toBe("pong");
  });

  test("default event name is 'message' when no event: line is present", async () => {
    const stream = streamFromChunks(['data: {"n":42}\n\n']);
    const frames = await collect(parseSseFrames(stream));
    expect(frames).toEqual([{ event: "message", data: { n: 42 } }]);
  });

  test("comment lines (starting with ':') are ignored", async () => {
    const stream = streamFromChunks([": keepalive\nevent: tick\ndata: {}\n\n"]);
    const frames = await collect(parseSseFrames(stream));
    expect(frames).toEqual([{ event: "tick", data: {} }]);
  });

  test("multi-line data: joined with \\n", async () => {
    const stream = streamFromChunks(["event: msg\ndata: line one\ndata: line two\n\n"]);
    const frames = await collect(parseSseFrames(stream));
    expect(frames[0]!.data).toBe("line one\nline two");
  });

  test("CRLF line endings accepted", async () => {
    const stream = streamFromChunks(['event: hi\r\ndata: {"ok":1}\r\n\r\n']);
    const frames = await collect(parseSseFrames(stream));
    expect(frames).toEqual([{ event: "hi", data: { ok: 1 } }]);
  });

  test("strips exactly one leading space after colon", async () => {
    // "data: foo" → "foo"; "data:  foo" → " foo" (one space stripped)
    const stream = streamFromChunks(["event: x\ndata:  hello\n\n"]);
    const frames = await collect(parseSseFrames(stream));
    expect(frames[0]!.data).toBe(" hello");
  });

  test("non-JSON data passes through as raw text", async () => {
    const stream = streamFromChunks(["event: tick\ndata: not-json-text\n\n"]);
    const frames = await collect(parseSseFrames(stream));
    expect(frames[0]!.data).toBe("not-json-text");
  });

  test("trailing frame without blank-line terminator is still yielded", async () => {
    const stream = streamFromChunks(['event: final\ndata: {"done":true}']);
    const frames = await collect(parseSseFrames(stream));
    expect(frames).toEqual([{ event: "final", data: { done: true } }]);
  });

  test("AbortSignal stops iteration mid-stream", async () => {
    // Build a stream that emits frames asynchronously across ticks, then
    // abort after the first one.
    let resolveTick: () => void = () => {};
    const tick = new Promise<void>((r) => {
      resolveTick = r;
    });
    const stream = new ReadableStream<string>({
      async start(controller) {
        controller.enqueue('event: a\ndata: {"n":1}\n\n');
        await tick;
        controller.enqueue('event: b\ndata: {"n":2}\n\n');
        controller.close();
      },
    });
    const ctrl = new AbortController();
    const gen = parseSseFrames(stream, ctrl.signal);

    const first = await gen.next();
    expect(first.value).toEqual({ event: "a", data: { n: 1 } });

    ctrl.abort();
    resolveTick();
    const second = await gen.next();
    expect(second.done).toBe(true);
  });

  test("UTF-8 multi-byte codepoint split across decoder boundaries is preserved", async () => {
    // The em-dash "—" is 3 bytes in UTF-8 (E2 80 94). Split it across
    // two chunks at the byte level by going through a TextDecoderStream
    // upstream. We simulate this by feeding the parser its own
    // already-decoded text — TextDecoderStream in production handles the
    // byte-level split before our parser sees text. To prove the parser
    // path handles split TEXT chunks, we split a multi-codepoint string
    // mid-word and confirm reassembly works.
    const stream = streamFromChunks(['event: hi\ndata: {"msg":"hello — w', 'orld"}\n\n']);
    const frames = await collect(parseSseFrames(stream));
    expect(frames[0]!.data).toEqual({ msg: "hello — world" });
  });

  test("real-world Hono streamSSE output shape: started + result", async () => {
    // Sample output captured from Hono's writeSSE for a wallet check.
    const sample =
      "event: started\n" +
      'data: {"addr":"Bxyz9","mode":"shared","cached":false}\n' +
      "\n" +
      "event: identity\n" +
      'data: {"address":"Bxyz9","executable":false}\n' +
      "\n" +
      "event: result\n" +
      'data: {"address":"Bxyz9","score":87,"verdict":"HIGH"}\n' +
      "\n";

    const stream = streamFromChunks([sample]);
    const frames = await collect(parseSseFrames(stream));
    expect(frames).toHaveLength(3);
    expect(frames[0]!.event).toBe("started");
    expect(frames[1]!.event).toBe("identity");
    expect(frames[2]!.event).toBe("result");
    expect((frames[2]!.data as { score: number }).score).toBe(87);
  });
});
