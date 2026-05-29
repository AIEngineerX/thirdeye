/**
 * SSE (Server-Sent Events) consumer over `fetch` + `ReadableStream`.
 *
 * Why not EventSource: the browser's EventSource constructor doesn't expose
 * header customization, so we couldn't attach `X-Auth-Token` /
 * `X-User-Helius-Key` to the request. Using `fetch`
 * instead lets the same auth + BYOK headers ride every request, and clean
 * cancellation works via AbortController.
 *
 * The intel-feed endpoint uses a one-time ticket flow (the ticket goes in the
 * URL query string, no headers required) precisely because EventSource was
 * its original consumer. We now use fetch+ReadableStream uniformly across
 * wallet, token, and feed streams — the ticket flow still works.
 *
 * Wire format (Hono `streamSSE`):
 *
 *   event: <name>\n
 *   data: <json>\n
 *   \n              (blank line terminates frame)
 *
 * Multi-line `data:` is joined with `\n`. Comments (lines starting with `:`)
 * are ignored. CRLF line endings are accepted in addition to LF.
 */

export interface SseFrame<T = unknown> {
  event: string;
  data: T;
}

export class SseError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "SseError";
    this.status = status;
  }
}

/**
 * Parse SSE frames from a text stream. Holds a persistent buffer across
 * chunks so frames split mid-line still resolve. `TextDecoderStream` handles
 * UTF-8 codepoint boundaries internally so we don't need to.
 */
export async function* parseSseFrames(
  textStream: ReadableStream<string>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame, void> {
  const reader = textStream.getReader();
  let buffer = "";

  // Normalize CRLF to LF inside our buffer so the frame terminator is
  // always exactly "\n\n". Don't mutate chunks in place — append normalized
  // text to the accumulator.
  const append = (chunk: string): void => {
    // Replace each "\r\n" with "\n", and stray "\r" with "\n" (defensive
    // against bare CR which some intermediaries can produce).
    buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  };

  const drainOnce = (): SseFrame | undefined => {
    const sepIdx = buffer.indexOf("\n\n");
    if (sepIdx === -1) return undefined;
    const raw = buffer.slice(0, sepIdx);
    buffer = buffer.slice(sepIdx + 2);
    return decodeFrame(raw);
  };

  const onAbort = () => {
    // Cancel the underlying reader so the producer side tears down too.
    void reader.cancel(new DOMException("aborted", "AbortError"));
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (signal?.aborted) return;
      if (done) {
        // Some producers flush a final frame without a trailing blank line.
        // Try once more if anything is left.
        const tail = buffer.trim();
        if (tail.length > 0) {
          const f = decodeFrame(tail);
          if (f) yield f;
        }
        return;
      }
      if (value) append(value);
      while (true) {
        const frame = drainOnce();
        if (!frame) break;
        yield frame;
      }
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/**
 * Decode one SSE frame (text between blank-line separators) into a
 * {event, data} pair. Returns undefined when the frame contains only
 * comments or no recognizable fields.
 */
function decodeFrame(raw: string): SseFrame | undefined {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // comment per spec

    const colonIdx = line.indexOf(":");
    let field: string;
    let value: string;
    if (colonIdx === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      if (value.startsWith(" ")) value = value.slice(1); // strip exactly one leading space
    }

    if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
    // id, retry: ignored — we don't implement resume; the api doesn't
    // emit ids anyway, so Last-Event-ID would be inert even if we sent it.
  }

  if (dataLines.length === 0) {
    // A frame with no data lines but an event name is technically valid
    // SSE but our api never emits this — treat as nothing useful.
    return undefined;
  }

  const dataText = dataLines.join("\n");
  let data: unknown;
  // JSON.parse can throw on malformed payloads. The api emits well-formed
  // JSON in every documented event; a parse failure here is a server bug
  // we want surfaced, not swallowed.
  try {
    data = JSON.parse(dataText);
  } catch {
    // Non-JSON data lines (e.g. heartbeats) — pass the raw text through.
    data = dataText;
  }
  return { event, data };
}

/**
 * Open a fetch-backed SSE connection and yield frames until the server
 * closes the response or `signal` is aborted.
 *
 * The caller supplies the `fetchImpl` so api wiring (auth headers, BYOK)
 * happens through the shared `apiClient.fetch`. Throws `SseError` on
 * non-2xx responses or when the body is missing.
 */
export async function* sseFetch(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
  path: string,
  signal: AbortSignal,
): AsyncGenerator<SseFrame, void> {
  const resp = await fetchImpl(path, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    signal,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new SseError(
      `sse request failed (${resp.status}): ${body.length > 0 ? body.slice(0, 200) : resp.statusText}`,
      resp.status,
    );
  }
  if (!resp.body) {
    throw new SseError("sse response has no body");
  }

  const textStream = resp.body.pipeThrough(new TextDecoderStream("utf-8"));
  yield* parseSseFrames(textStream, signal);
}

/**
 * Two-step ticket flow for the `/intel/feed` endpoint.
 *
 * 1. POST `/api/db/intel/feed/ticket` with auth header → `{ticket, expiresAt}`
 * 2. GET `/api/db/intel/feed?ticket=<short-lived>` to stream
 *
 * The ticket lives 30s and is consumed on first use, so even if the URL is
 * logged the leaked value is already expired by the time anyone reads it.
 */
export interface SseTicketResponse {
  ticket: string;
  expiresAt: string;
}

export async function* sseFetchViaTicket(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
  ticketPath: string,
  feedPath: string,
  signal: AbortSignal,
): AsyncGenerator<SseFrame, void> {
  const ticketResp = await fetchImpl(ticketPath, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    signal,
  });
  if (!ticketResp.ok) {
    const body = await ticketResp.text().catch(() => "");
    throw new SseError(
      `ticket request failed (${ticketResp.status}): ${body.slice(0, 200)}`,
      ticketResp.status,
    );
  }
  const ticketBody = (await ticketResp.json()) as SseTicketResponse;
  const sep = feedPath.includes("?") ? "&" : "?";
  const feedUrl = `${feedPath}${sep}ticket=${encodeURIComponent(ticketBody.ticket)}`;

  // The feed endpoint authenticates via the ticket query param alone — no
  // auth header needed. Use the raw fetch impl so apiClient.fetch's header
  // injection doesn't matter; the server ignores headers on this route.
  yield* sseFetch(fetchImpl, feedUrl, signal);
}
