import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";

export interface CachedResponse {
  status: number;
  body: unknown;
}

export interface CacheKeyInput {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string> | undefined;
  body?: unknown;
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function composeCacheKey(input: CacheKeyInput): string {
  const queryStr = input.query ? canonical(input.query) : "";
  const bodyStr = input.body !== undefined ? canonical(input.body) : "";
  const raw = `${input.method}|${input.path}|${queryStr}|${bodyStr}`;
  return createHash("sha256").update(raw).digest("hex");
}

let cacheInstance: LRUCache<string, CachedResponse> | null = null;

export function getCache(): LRUCache<string, CachedResponse> {
  if (!cacheInstance) {
    cacheInstance = new LRUCache<string, CachedResponse>({
      max: 50_000,
      ttl: 5 * 60 * 1000,
      ttlAutopurge: true,
      updateAgeOnGet: false,
    });
  }
  return cacheInstance;
}
