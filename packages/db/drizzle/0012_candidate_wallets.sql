-- Dormant candidate pool: wallets we MIGHT track, from the fomo seed corpus and
-- the Solana Tracker leaderboard. NEVER webhook-subscribed (only promoted
-- wallets in tracked_wallets are). `promoted` flips true when a candidate is
-- copied into tracked_wallets. Behavior columns are computed from the seed
-- corpus at import; src_* are the candidate's reported quality at capture time.
CREATE TABLE IF NOT EXISTS candidate_wallets (
  address        text PRIMARY KEY,
  handle         text,
  display_name   text,
  twitter_handle text,
  source         text NOT NULL,
  src_pnl_7d     numeric,
  src_pnl_all    numeric,
  src_win_rate   numeric,
  src_rank       integer,
  buys_observed  integer NOT NULL DEFAULT 0,
  early_buys     integer NOT NULL DEFAULT 0,
  early_rate     numeric,
  tokens_traded  integer NOT NULL DEFAULT 0,
  promoted       boolean NOT NULL DEFAULT false,
  imported_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candidate_wallets_rank_idx
  ON candidate_wallets (promoted, early_rate DESC NULLS LAST, src_pnl_all DESC NULLS LAST);
