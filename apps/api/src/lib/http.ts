import type { SSEStreamingApi } from "hono/streaming";

export function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
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
