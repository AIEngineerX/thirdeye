"use client";

import { fmtMoneyCompact, fmtPct } from "@/lib/format";

export interface MarketPanelData {
  priceUsd: number | null;
  mcUsd: number | null;
  mc24hPct: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: "clean" | "high" }) {
  const valueClass =
    tone === "clean" ? "text-clean" : tone === "high" ? "text-high" : "text-primary";

  return (
    <div className="border border-border-subtle bg-card px-3 py-2">
      <div className="font-mono text-2xs uppercase tracking-[0.15em] text-tertiary">{label}</div>
      <div className={`mt-1 font-mono text-sm tabular ${valueClass}`}>{value}</div>
    </div>
  );
}

export function MarketPanel({ data }: { data: MarketPanelData | null }) {
  if (!data) {
    return (
      <div className="grid grid-cols-2 gap-px bg-border-subtle md:grid-cols-5">
        {["price", "market cap", "24h %", "liquidity", "fdv"].map((label) => (
          <Cell key={label} label={label} value="—" />
        ))}
      </div>
    );
  }

  const pct24hTone =
    data.mc24hPct === null
      ? undefined
      : data.mc24hPct >= 0
        ? ("clean" as const)
        : ("high" as const);

  return (
    <div className="grid grid-cols-2 gap-px bg-border-subtle md:grid-cols-5">
      <Cell
        label="price"
        value={
          data.priceUsd === null
            ? "—"
            : `$${data.priceUsd < 0.001 ? data.priceUsd.toExponential(2) : data.priceUsd.toPrecision(4)}`
        }
      />
      <Cell label="market cap" value={fmtMoneyCompact(data.mcUsd)} />
      <Cell label="24h %" value={fmtPct(data.mc24hPct, 1)} tone={pct24hTone} />
      <Cell label="liquidity" value={fmtMoneyCompact(data.liquidityUsd)} />
      <Cell label="fdv" value={fmtMoneyCompact(data.fdvUsd)} />
    </div>
  );
}
