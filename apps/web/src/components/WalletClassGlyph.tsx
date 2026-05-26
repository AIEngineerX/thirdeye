import type { Tag } from "@/lib/api-types";
import type { ReactNode } from "react";

type GlyphVariant =
  | "bundle"
  | "tight-bundle"
  | "new"
  | "smart"
  | "sniper"
  | "whale"
  | "exchange"
  | "distributor"
  | "default";

interface WalletClassGlyphProps {
  variant: GlyphVariant;
  size?: number;
  className?: string;
}

export function tagLabel(tag: string): string {
  switch (tag) {
    case "SYBIL":
      return "Bundle";
    case "BUNDLER":
      return "Bundled buyer";
    case "BUNDLER_TIGHT":
      return "Tight bundle";
    case "FRESH_WALLET":
      return "New wallet";
    case "FUND_DISTRIBUTOR":
      return "Funder fanout";
    case "SMART_MONEY":
      return "Smart money";
    case "SNIPER":
      return "Sniper";
    case "WHALE":
      return "Whale";
    case "EXCHANGE":
      return "Exchange";
    case "KOL":
      return "KOL";
    default:
      return tag.replace(/_/g, " ").toLowerCase();
  }
}

export function tagGlyphVariant(tag: string): GlyphVariant {
  switch (tag as Tag) {
    case "SYBIL":
      return "bundle";
    case "BUNDLER":
      return "bundle";
    case "BUNDLER_TIGHT":
      return "tight-bundle";
    case "FRESH_WALLET":
      return "new";
    case "FUND_DISTRIBUTOR":
      return "distributor";
    case "SMART_MONEY":
      return "smart";
    case "SNIPER":
      return "sniper";
    case "WHALE":
      return "whale";
    case "EXCHANGE":
      return "exchange";
    default:
      return "default";
  }
}

export function WalletClassGlyph({ variant, size = 14, className = "" }: WalletClassGlyphProps) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={`shrink-0 ${className}`}
    >
      {pathForVariant(variant)}
    </svg>
  );
}

function pathForVariant(variant: GlyphVariant): ReactNode {
  const stroke = "currentColor";
  const strokeWidth = 1.4;
  switch (variant) {
    case "bundle":
      return (
        <>
          <circle cx="5" cy="5" r="2.2" stroke={stroke} strokeWidth={strokeWidth} />
          <circle cx="11" cy="5" r="2.2" stroke={stroke} strokeWidth={strokeWidth} />
          <circle cx="8" cy="11" r="2.2" stroke={stroke} strokeWidth={strokeWidth} />
          <path
            d="M6.8 5h2.4M6 6.8l1.1 2M10 6.8l-1.1 2"
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
        </>
      );
    case "tight-bundle":
      return (
        <>
          <path
            d="M3.5 5.2h9M3.5 10.8h9M5.2 3.5v9M10.8 3.5v9"
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
          <rect x="3.5" y="3.5" width="9" height="9" stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
    case "new":
      return (
        <>
          <path d="M8 2.5v11M2.5 8h11" stroke={stroke} strokeWidth={strokeWidth} />
          <circle cx="8" cy="8" r="4.8" stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
    case "smart":
      return (
        <>
          <path d="M2.5 9.3 6.2 13l7.3-10" stroke={stroke} strokeWidth={strokeWidth} />
          <path d="M3 4.5h5" stroke={stroke} strokeWidth={strokeWidth} opacity="0.55" />
        </>
      );
    case "sniper":
      return (
        <>
          <circle cx="8" cy="8" r="4.7" stroke={stroke} strokeWidth={strokeWidth} />
          <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" stroke={stroke} strokeWidth={strokeWidth} />
          <circle cx="8" cy="8" r="1.3" fill="currentColor" />
        </>
      );
    case "whale":
      return (
        <>
          <path
            d="M2.5 9.5c1.5 2.2 4 3.1 6.6 2.4 2.8-.7 4.4-2.8 4.4-5.4-1.8 1.1-3.6 1.3-5.3.4-2.2-1.1-4.1-.5-5.7 2.6Z"
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
          <path d="M11.5 5.2 14 3.5M11.8 6.3l2.7.7" stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
    case "exchange":
      return (
        <>
          <path
            d="M3 5.5h10M4.5 3h7L13 5.5H3L4.5 3ZM4 5.5v7M7 5.5v7M10 5.5v7M12 5.5v7M2.5 12.5h11"
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
        </>
      );
    case "distributor":
      return (
        <>
          <circle cx="8" cy="4" r="1.8" stroke={stroke} strokeWidth={strokeWidth} />
          <circle cx="4" cy="12" r="1.8" stroke={stroke} strokeWidth={strokeWidth} />
          <circle cx="12" cy="12" r="1.8" stroke={stroke} strokeWidth={strokeWidth} />
          <path d="M7.2 5.7 4.8 10.3M8.8 5.7l2.4 4.6" stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
    default:
      return <path d="M3 3h10v10H3z" stroke={stroke} strokeWidth={strokeWidth} />;
  }
}
