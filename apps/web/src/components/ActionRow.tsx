"use client";

import { DEFAULT_QUICK_BUY, buildQuickBuyUrl } from "@/lib/quick-buy";
import { useState } from "react";

const BTN =
  "border border-border-emphasis px-2 py-1 font-mono text-2xs uppercase tracking-[0.18em] text-secondary transition-colors hover:bg-accent-bg hover:text-accent active:translate-y-px";

export function ActionRow({
  address,
  kind,
  variant = "full",
}: {
  address: string;
  kind: "wallet" | "mint";
  variant?: "full" | "extras";
}) {
  const [copied, setCopied] = useState(false);
  const explorer = kind === "wallet" ? "account" : "token";
  const quickBuy = kind === "mint" ? buildQuickBuyUrl(DEFAULT_QUICK_BUY, address) : null;

  // "extras" variant: only render the actions not already shown by EvidenceStrip
  // (EvidenceStrip provides copy + solscan). For wallets there are no extras; for
  // mints the extras are dexscreener and quick-buy.
  if (variant === "extras") {
    if (kind === "wallet") return null;
    // mint extras only
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <a
          className={BTN}
          href={`https://dexscreener.com/solana/${address}`}
          target="_blank"
          rel="noreferrer"
        >
          dexscreener
        </a>
        {quickBuy ? (
          <a
            className="border border-accent bg-accent-bg px-2 py-1 font-mono text-2xs uppercase tracking-[0.18em] text-accent transition-colors hover:bg-accent/20 active:translate-y-px"
            href={quickBuy}
            target="_blank"
            rel="noreferrer"
          >
            buy ▾
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        className={`${BTN} text-accent`}
        onClick={async () => {
          await navigator.clipboard.writeText(address).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? "copied" : "copy"}
      </button>
      <a
        className={BTN}
        href={`https://solscan.io/${explorer}/${address}`}
        target="_blank"
        rel="noreferrer"
      >
        solscan
      </a>
      {kind === "mint" ? (
        <a
          className={BTN}
          href={`https://dexscreener.com/solana/${address}`}
          target="_blank"
          rel="noreferrer"
        >
          dexscreener
        </a>
      ) : null}
      {quickBuy ? (
        <a
          className="border border-accent bg-accent-bg px-2 py-1 font-mono text-2xs uppercase tracking-[0.18em] text-accent transition-colors hover:bg-accent/20 active:translate-y-px"
          href={quickBuy}
          target="_blank"
          rel="noreferrer"
        >
          buy ▾
        </a>
      ) : null}
    </div>
  );
}
