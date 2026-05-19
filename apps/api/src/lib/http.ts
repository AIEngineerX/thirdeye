import type { SSEStreamingApi } from "hono/streaming";

export function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  // Bug-L5: parseInt stops at the first non-numeric character — so "1e10"
  // would parse as 1, then clamp to min=1 instead of producing the
  // expected too-large value. Use Math.trunc(Number(...)) which respects
  // the whole string and returns NaN on garbage suffixes.
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const n = Math.trunc(parsed);
  return Math.max(min, Math.min(max, n));
}

export function toIso(t: Date | string): string {
  return t instanceof Date ? t.toISOString() : new Date(t).toISOString();
}

export async function sendSseEvent<T extends { event: string; data: unknown }>(
  stream: SSEStreamingApi,
  evt: T,
): Promise<void> {
  await stream.writeSSE({ event: evt.event, data: JSON.stringify(evt.data) });
}
