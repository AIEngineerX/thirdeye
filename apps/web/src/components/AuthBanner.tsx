"use client";

import { useAuth } from "@/hooks/useAuth";

export function AuthBanner() {
  const { status, error, retry } = useAuth();

  if (status === "ready" || status === "loading") return null;

  return (
    <div className="border-b border-high/40 bg-high/10 px-6 py-2">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <p className="font-mono text-2xs uppercase tracking-[0.18em] text-high">
          ▸ session auth failed
          {error ? <span className="ml-2 text-primary normal-case">— {error.message}</span> : null}
        </p>
        <button
          type="button"
          onClick={retry}
          className="border border-high/60 px-3 py-1 font-mono text-2xs uppercase tracking-[0.18em] text-high transition-colors hover:bg-high/20"
        >
          retry
        </button>
      </div>
    </div>
  );
}
