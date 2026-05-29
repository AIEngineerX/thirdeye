"use client";

import { DEFAULT_QUICK_BUY, buildQuickBuyUrl } from "@/lib/quick-buy";
import { useState } from "react";

const BTN =
  "border border-border-emphasis px-2 py-1 font-mono text-2xs uppercase tracking-[0.18em] text-secondary transition-colors hover:bg-accent-bg hover:text-accent active:translate-y-px";

export function ActionRow({ address, kind }: { address: string; kind: "wallet" | "mint" }) {
  const [copied, setCopied] = useState(false);
  const explorer = kind === "wallet" ? "account" : "token";
  const quickBuy = kind === "mint" ? buildQuickBuyUrl(DEFAULT_QUICK_BUY, address) : null;
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
