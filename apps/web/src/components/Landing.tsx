"use client";

import { KbdInput } from "@/components/KbdInput";
import { isValidSolanaAddress } from "@/lib/format";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Mode = "wallet" | "token";

interface LandingProps {
  initialMode?: Mode;
}

export function Landing({ initialMode = "wallet" }: LandingProps) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setError("paste a Solana address or mint to investigate");
      return;
    }
    if (!isValidSolanaAddress(trimmed)) {
      setError("not a valid Solana base58 address — must be 32-44 chars, no 0/O/I/l");
      return;
    }
    setError(null);
    const dest = mode === "wallet" ? `/wallet/${trimmed}` : `/token/${trimmed}`;
    router.push(dest);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col px-6 py-20">
      <header className="mb-12">
        <h1 className="font-sans text-5xl font-semibold tracking-tight text-primary">
          Inspect a wallet or token
        </h1>
      </header>

      <section className="border border-border-emphasis bg-card">
        <header className="flex items-center border-b border-border-subtle px-4 py-3">
          <span className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary">
            ▸ subject
          </span>
          <div className="ml-auto flex items-center gap-px border border-border-subtle">
            <ModeButton active={mode === "wallet"} onClick={() => setMode("wallet")}>
              wallet
            </ModeButton>
            <ModeButton active={mode === "token"} onClick={() => setMode("token")}>
              token
            </ModeButton>
          </div>
        </header>

        <div className="space-y-3 px-4 py-5">
          <KbdInput
            value={value}
            onChange={(v: string) => {
              setValue(v);
              if (error) setError(null);
            }}
            onSubmit={submit}
            placeholder={
              mode === "wallet" ? "Bxyz9… (paste wallet address)" : "Mn8r… (paste mint address)"
            }
            autoFocus
            aria-label={mode === "wallet" ? "wallet address" : "mint address"}
          />

          {error ? (
            <p role="alert" className="font-mono text-2xs uppercase tracking-[0.16em] text-high">
              ▸ {error}
            </p>
          ) : (
            <p className="font-mono text-2xs uppercase tracking-[0.16em] text-tertiary">
              ▸ press enter to load. byok keys in
              <a href="/settings" className="ml-1 text-accent hover:underline">
                /settings
              </a>
              .
            </p>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-border-subtle px-4 py-3">
          <a
            href="/intel"
            className="font-mono text-2xs uppercase tracking-[0.22em] text-tertiary hover:text-accent"
          >
            recent activity →
          </a>
          <button
            type="button"
            onClick={submit}
            className="border border-accent bg-accent-bg px-4 py-1.5 font-mono text-2xs uppercase tracking-[0.22em] text-accent transition-colors hover:bg-accent/20"
          >
            investigate →
          </button>
        </footer>
      </section>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "px-3 py-1 font-mono text-2xs uppercase tracking-[0.22em] transition-colors",
        active
          ? "bg-accent-bg text-accent"
          : "bg-card text-tertiary hover:bg-card-hover hover:text-primary",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
