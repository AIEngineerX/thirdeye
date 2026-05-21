"use client";

import { AuthError, getAuthClient } from "@/lib/auth";
import { useCallback, useEffect, useState } from "react";

export type AuthStatus = "loading" | "ready" | "error";

export interface UseAuthResult {
  status: AuthStatus;
  token: string | null;
  error: Error | null;
  retry: () => void;
}

/**
 * Bootstrap the session token on mount. Components rendered inside the root
 * layout depend on this firing before they make authenticated calls. Re-uses
 * the cached singleton AuthClient so multiple components mounting in parallel
 * share one in-flight POST /auth request.
 */
export function useAuth(): UseAuthResult {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the explicit re-fire trigger.
  useEffect(() => {
    let active = true;
    const client = getAuthClient();

    setStatus("loading");
    setError(null);

    const onSuccess = (t: string) => {
      if (!active) return;
      setToken(t);
      setStatus("ready");
    };

    const onFailure = (e: unknown) => {
      if (!active) return;
      setError(toError(e));
      setStatus("error");
    };

    client.getOrIssueToken().then(onSuccess, onFailure);

    return () => {
      active = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    getAuthClient().invalidate();
    setAttempt((n) => n + 1);
  }, []);

  return { status, token, error, retry };
}

function toError(e: unknown): Error {
  if (e instanceof AuthError) return e;
  if (e instanceof Error) return e;
  return new Error(typeof e === "string" ? e : "auth failed");
}
