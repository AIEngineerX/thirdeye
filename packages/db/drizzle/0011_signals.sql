-- A signal is a promoted, independent buy-confluence we now track to an outcome.
-- `wallets` is jsonb (not text[]) on purpose: postgres.js + Bun mis-binds raw
-- text[] params under this stack, so every array we persist goes through jsonb
-- (same decision as smart_trades).
CREATE TABLE IF NOT EXISTS signals (
  id                  bigserial PRIMARY KEY,
  mint                text NOT NULL,
  symbol              text,
  wallet_count        integer NOT NULL,
  wallets             jsonb NOT NULL,
  trust               text NOT NULL,            -- 'independent' | 'co_funded'
  shared_funder       text,
  call_mc             numeric,
  call_price          numeric,
  first_buy_at        timestamptz NOT NULL,
  detected_at         timestamptz NOT NULL DEFAULT now(),
  safe_promoted_at    timestamptz,
  safe_call_mc        numeric,
  current_mc          numeric,
  ath_mc              numeric,
  ath_multiplier      numeric,
  safe_ath_multiplier numeric,
  is_hit              boolean NOT NULL DEFAULT false,
  safe_is_hit         boolean NOT NULL DEFAULT false,
  peak_at             timestamptz,
  status              text NOT NULL DEFAULT 'open',  -- 'open' | 'closed'
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Worker scan of open signals + feed ordering.
CREATE INDEX IF NOT EXISTS signals_status_detected_idx ON signals (status, detected_at DESC);
CREATE INDEX IF NOT EXISTS signals_mint_idx ON signals (mint);
-- At most one OPEN signal per mint. co_funded audit rows are inserted closed,
-- so they never collide here and the worker's status='open' scan skips them.
CREATE UNIQUE INDEX IF NOT EXISTS signals_open_mint_uniq ON signals (mint) WHERE status = 'open';

-- Outcome attribution back onto the wallets that triggered signals.
ALTER TABLE tracked_wallets ADD COLUMN IF NOT EXISTS signal_signals integer NOT NULL DEFAULT 0;
ALTER TABLE tracked_wallets ADD COLUMN IF NOT EXISTS signal_wins    integer NOT NULL DEFAULT 0;
ALTER TABLE tracked_wallets ADD COLUMN IF NOT EXISTS signal_winrate numeric;
