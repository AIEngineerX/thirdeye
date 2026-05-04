export interface RestUrlInput {
  path: string;
  apiKey: string;
  query?: Record<string, string>;
}

export function composeRestUrl({ path, apiKey, query }: RestUrlInput): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const params = new URLSearchParams();
  params.set("api-key", apiKey);
  if (query) {
    const keys = Object.keys(query).sort();
    for (const k of keys) {
      const v = query[k];
      if (v !== undefined) params.set(k, v);
    }
  }
  return `https://api.helius.xyz${normalizedPath}?${params.toString()}`;
}

export function composeRpcUrl(apiKey: string): string {
  const params = new URLSearchParams({ "api-key": apiKey });
  return `https://mainnet.helius-rpc.com/?${params.toString()}`;
}
