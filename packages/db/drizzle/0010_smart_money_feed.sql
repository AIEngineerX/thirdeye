-- Curated smart-money watchlist. Distinct from `watches` (session-scoped,
-- generic): this is the personal list of wallets we trust, with a quality
-- snapshot captured from Solana Tracker at add time. `source` records how the
-- wallet entered the list ('manual' now; 'leaderboard' in Milestone 2).
CREATE TABLE IF NOT EXISTS tracked_wallets (
  address          text PRIMARY KEY,
  label            text,
  source           text NOT NULL DEFAULT 'manual',
  win_rate         numeric,
  realized_pnl_usd numeric,
  roi              numeric,
  tokens_traded    integer,
  identity         jsonb,
  pnl_synced_at    timestamptz,
  added_at         timestamptz NOT NULL DEFAULT now()
);

-- Normalized swap rows parsed from tracked wallets' Helius enhanced events at
-- ingest time. Enables clean SQL confluence queries and a feed history that
-- survives restarts. One row per (signature, wallet).
CREATE TABLE IF NOT EXISTS smart_trades (
  id          bigserial PRIMARY KEY,
  wallet      text NOT NULL,
  mint        text NOT NULL,
  symbol      text,
  side        text NOT NULL,            -- 'buy' | 'sell'
  sol_amount  numeric,
  usd_value   numeric,
  token_amount numeric,
  program     text,
  signature   text NOT NULL,
  traded_at   timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT smart_trades_sig_wallet_uniq UNIQUE (signature, wallet)
);

CREATE INDEX IF NOT EXISTS smart_trades_mint_side_time_idx
  ON smart_trades (mint, side, traded_at DESC);

CREATE INDEX IF NOT EXISTS smart_trades_traded_at_idx
  ON smart_trades (traded_at DESC);
