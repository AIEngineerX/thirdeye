// Phase 6a — generic price feed contract. Birdeye / Jupiter
// implementations are documented escape hatches; v1 ships DexScreener
// only because it requires no API key, covers Solana SPL exhaustively,
// and surfaces the fields the spec requires (priceUsd, fdv, h24 change,
// pair liquidity).

export interface PriceQuote {
  mint: string;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  // Market cap in USD. DexScreener returns FDV (fully-diluted) as the
  // primary cap field; for Solana SPL, FDV ≈ MC for fully-emitted tokens
  // and is the conservative choice for half-emitted ones. We store it as
  // mc_usd in the spec's data model; clients reading the column should
  // treat it as "FDV-or-MC depending on emission schedule".
  mcUsd: number | null;
  // 24h percent change in price. The spec column is named mc_24h_pct
  // for legacy reasons; price-pct and mc-pct are equivalent for a token
  // with constant supply over the window, which holds for nearly all SPL
  // tokens at the timescales discovery cares about.
  mc24hPct: number | null;
  liquidityUsd: number | null;
}

export interface PriceSource {
  // Returns one quote per mint that the upstream knew about. Mints the
  // upstream doesn't recognize are silently omitted — the caller
  // distinguishes "not refreshed yet" from "doesn't exist" by inspecting
  // the returned set vs the requested set.
  fetch(mints: string[]): Promise<PriceQuote[]>;
  readonly name: string;
}

export class PriceSourceError extends Error {
  constructor(
    public readonly source: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PriceSourceError";
  }
}
