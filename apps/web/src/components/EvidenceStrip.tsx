"use client";

import { shortAddr } from "@/lib/format";
import { useState } from "react";

interface EvidenceStripProps {
  address: string;
  label: string;
  kind: "wallet" | "mint";
  meta?: string;
}

export function EvidenceStrip({ address, label, kind, meta }: EvidenceStripProps) {
  const [copied, setCopied] = useState(false);
  const explorerPath = kind === "wallet" ? "account" : "token";

  return (
    <section className="border border-border-subtle bg-card font-mono">
      <div className="grid gap-3 px-4 py-3 md:grid-cols-[8rem_1fr_auto] md:items-center">
        <div>
          <div className="text-2xs uppercase tracking-[0.18em] text-tertiary">{label}</div>
          {meta ? (
            <div className="mt-1 text-2xs uppercase tracking-[0.14em] text-secondary">{meta}</div>
          ) : null}
        </div>
        <div className="min-w-0">
          <div className="break-all text-sm tabular text-primary">{address}</div>
          <div className="mt-1 text-2xs uppercase tracking-[0.14em] text-tertiary">
            {shortAddr(address, 8, 8)}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(address);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              } catch {
                /* Clipboard is unavailable in insecure contexts. */
              }
            }}
            className="border border-border-emphasis px-3 py-1.5 text-2xs uppercase tracking-[0.18em] text-accent transition-colors hover:bg-accent-bg active:translate-y-px"
          >
            {copied ? "copied" : "copy"}
          </button>
          <a
            href={`https://solscan.io/${explorerPath}/${address}`}
            target="_blank"
            rel="noreferrer"
            className="border border-border-emphasis px-3 py-1.5 text-2xs uppercase tracking-[0.18em] text-secondary transition-colors hover:bg-accent-bg hover:text-accent active:translate-y-px"
          >
            solscan
          </a>
        </div>
      </div>
    </section>
  );
}
