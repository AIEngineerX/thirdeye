// Outbound deep-link to an external trading interface — ThirdEye never signs.
// v1 ships ONE verified platform (gmgn, stable token URL); others are listed
// but disabled so a wrong template is never a silent 404.
export interface QuickBuyPlatform {
  id: string;
  label: string;
  supported: boolean;
}

export const QUICK_BUY_PLATFORMS: QuickBuyPlatform[] = [
  { id: "gmgn", label: "GMGN", supported: true },
  { id: "axiom", label: "Axiom", supported: false },
  { id: "trojan", label: "Trojan", supported: false },
  { id: "bullx", label: "BullX", supported: false },
  { id: "photon", label: "Photon", supported: false },
];

const TEMPLATES: Record<string, (mint: string) => string> = {
  gmgn: (mint) => `https://gmgn.ai/sol/token/${mint}`,
};

/** Resolve a deep-link, or null when the platform isn't verified yet. */
export function buildQuickBuyUrl(platform: string, mint: string): string | null {
  const t = TEMPLATES[platform];
  return t ? t(mint) : null;
}

export const DEFAULT_QUICK_BUY = "gmgn";
