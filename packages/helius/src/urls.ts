export interface RestUrlInput {
  path: string;
  apiKey: string;
  query?: Record<string, string> | undefined;
}

export function composeRestUrl({ path, apiKey, query }: RestUrlInput): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const params = new URLSearchParams();
  params.set("api-key", apiKey);
  if (query) {
    for (const k of Object.keys(query).sort()) {
      const v = query[k];
      if (v !== undefined) params.set(k, v);
    }
  }
  return `https://api.helius.xyz${normalizedPath}?${params.toString()}`;
}

export function composeRpcUrl(apiKey: string): string {
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}
