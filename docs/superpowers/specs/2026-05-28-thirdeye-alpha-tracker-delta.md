# ThirdEye — Alpha-Tracker Spec Delta: Signal Outcomes, Curated Universe, Live Dashboard

**Date:** 2026-05-28
**Status:** Approved design — pending implementation plan
**Type:** Spec delta. Layers on the smart-money-feed work (`docs/superpowers/plans/2026-05-25-smart-money-feed.md`) and the existing `tracked_wallets` / `smart_trades` tables. Does **not** replace them.

This delta is the source of truth for the signal-outcome layer, the curated wallet universe, the dashboard bundle, and the UI rework. Where it diverges from the base design spec (`2026-05-01-thirdeye-design.md`), this document wins for the surfaces it covers.

---

## 1. Goal

ThirdEye already detects **confluence** — two or more curated "smart-money" wallets buying the same token inside a time window — and prints it to a live feed. But that confluence is **ephemeral**: a row scrolls past and is gone. The leading alpha-terminal product class (Cielo / GMGN / Bullx) treats each confluence as a **tracked bet with a measured outcome**: snapshot the market cap when the signal fires, then follow it — current MC, all-time-high MC, the multiple it reached, and whether it "hit." Those outcomes then score both the individual wallets and the feed as a whole.

This delta adds that outcome layer. The result is a feed you can trust because every past signal has a recorded result, a leaderboard ranked on real hit-rate, and a homepage that opens on live alpha instead of an empty search box.

ThirdEye keeps the edge the product class lacks: an **independence / trust gate**. A "2-wallet signal" that is really one actor funding two wallets never becomes a scored signal here — it is logged and suppressed. Forensics (cluster, funding-chain, sybil detection) is no longer the headline; it is the quality filter underneath the alpha.

## 2. Scope

**In scope (this delta):**
1. Signal-outcome tracking — a `signals` table, call/safe snapshots, a worker that follows MC and records hits.
2. Curated wallet universe — a `candidate_wallets` pool seeded from a public fomo.family leaderboard snapshot (~17k wallets) plus the Solana Tracker PnL leaderboard; manual promotion to `tracked_wallets`.
3. Dashboard bundle API — a single cached `GET /api/db/dashboard` payload, with live deltas over the existing intel SSE stream.
4. UI rework — homepage becomes a live dashboard; new signal card; a `/leaderboard` page; a site-wide copy de-cruft pass.

**Out of scope (follow-ups, noted not built):**
- Telegram channel-call ingestion and a channel leaderboard.
- Polymarket / sports smart-money.
- Copy-trade / quick-buy / any signing path — ThirdEye stays read-only.
- Force-directed bubble map (still deferred).

## 3. Architecture decisions

### 3A. Signals are stored, not computed on read
A signal is created when an **independent** confluence fires; the call snapshot is captured immediately and the row is then mutated as price moves.

*Rejected:* computing outcomes on read by joining `smart_trades` to OHLCV. It cannot persist the conservative "safe replay" base, and leaderboard aggregation becomes expensive. → **Dedicated `signals` table.**

### 3B. Outcome / market-cap tracking runs on the free price source, not Solana Tracker credits
Solana Tracker's free tier is 10,000 requests/month at 1 req/s — far too little to poll every open signal's market cap. The repo already has a free DexScreener price source (`@thirdeye/prices`) feeding the `tokens` cache via the `tokens-refresh` worker. The signal-outcome worker reuses it at zero credit cost.

**Solana Tracker credits are spent only on:**
- the wallet-quality snapshot taken once when a wallet is promoted (1 call per wallet), and
- throttled leaderboard (hourly) and trending (every 10 min) refreshes.

Estimated ST usage stays well inside the free 10k/mo. → **DexScreener for outcome MC; ST for quality + leaderboard/trending only.**

### 3C. Dashboard is one cached bundle plus SSE deltas
A single `GET /api/db/dashboard` returns `{ stats, live_signals[], trending[], top_traders[] }` from Postgres behind a ~15-second in-process cache. The existing intel SSE stream pushes `smartmoney:signal` and `smartmoney:outcome` deltas so the page stays live without re-polling the bundle.

*Rejected:* a 15-second materialized-view refresh — extra infra for no benefit at single-user scale. → **Bundle route + short cache + SSE deltas.**

## 4. Data model

```
signals                              -- one row per promoted independent confluence
  id              bigserial PK
  mint            text not null
  symbol          text
  wallet_count    int  not null
  wallets         text[] not null    -- the independent cohort that triggered it
  trust           text not null      -- 'independent' | 'co_funded'
  shared_funder   text               -- set when trust='co_funded'
  -- call snapshot (captured at detection):
  call_mc         numeric
  call_price      numeric
  first_buy_at    timestamptz not null
  detected_at     timestamptz not null
  -- conservative "safe replay" (snapshot ~3 min after first buy):
  safe_promoted_at timestamptz
  safe_call_mc     numeric
  -- live outcome (worker-updated):
  current_mc       numeric
  ath_mc           numeric
  ath_multiplier   numeric           -- ath_mc / call_mc
  safe_ath_multiplier numeric        -- ath_mc / safe_call_mc
  is_hit           boolean not null default false
  safe_is_hit      boolean not null default false
  peak_at          timestamptz
  status           text not null default 'open'   -- 'open' | 'closed'
  created_at       timestamptz not null default now()

  indexes:
    (status, detected_at desc)            -- worker scan of open signals + feed order
    (mint)
    partial UNIQUE (mint) WHERE status='open'   -- at most one open signal per mint
```

`co_funded` audit rows are inserted with `status='closed'` (they are never price-tracked), so they are excluded from both the refresh worker's `status='open'` scan and the partial-unique index above — no collision with the live independent signal for the same mint.

```text

candidate_wallets                    -- the fomo seed + ST leaderboard pool (NOT webhook-subscribed)
  address         text PK
  handle          text
  display_name    text
  twitter_handle  text
  src_pnl_7d      numeric
  src_pnl_all     numeric
  src_win_rate    numeric
  src_rank        int
  source          text not null      -- 'fomo_seed' | 'st_leaderboard'
  promoted        boolean not null default false
  imported_at     timestamptz not null default now()

tracked_wallets   (existing — extend)
  + signal_signals  int not null default 0   -- signals this wallet participated in
  + signal_wins     int not null default 0   -- of those, how many hit
  + signal_winrate  numeric                  -- signal_wins / signal_signals
```

**Hit threshold:** `is_hit` ← `ath_mc ≥ 2 × call_mc` (configurable via env, default `2.0`). `safe_is_hit` uses `safe_call_mc`. The `safe_*` figures are the conservative numbers shown by default in the UI.

Two leaderboards fall out of this model:
- **Outcome-scored** — wallets ranked by `signal_winrate` (and hit count), derived from our own signals.
- **ST-PnL** — the universe ranked by Solana Tracker realized PnL / win-rate (the quality snapshot).

## 5. Signal engine & data flow

Everything below the first three lines already exists; the new work is the `signals` upsert, the trust gate's promotion branch, and the refresh worker.

```
Helius webhook (tracked-wallet swap)
  → parseTrade → persistTrade(smart_trades)            [exists, dedups on (signature, wallet)]
  → detectBuyConfluence(mint, windowMin)               [exists]
  → if confluence.count >= 2:
        areCoFunded(confluence.wallets)                [exists]
        ├─ co_funded   → insert signals row trust='co_funded' (audit only; no promote)
        │                 emit smartmoney:confluence (suppressed=true)
        └─ independent → upsert signals row trust='independent'
                          snapshot call_mc / call_price from tokens cache (DexScreener)
                          emit smartmoney:signal (SSE)

signals-refresh worker  (graphile-worker crontab, every 1 min)
  for each signal where status='open':
     refresh mint MC via DexScreener price source (free)
     if age >= 3 min and safe_call_mc is null:  set safe_promoted_at, safe_call_mc = current MC
     set current_mc; if current_mc > ath_mc: bump ath_mc, ath_multiplier, safe_ath_multiplier, peak_at
     if ath_multiplier >= HIT_THRESHOLD: set is_hit (and safe_is_hit from safe base)
     on any change: emit smartmoney:outcome delta (SSE)
     if age >= 48h: set status='closed'
  after closing: recompute participating wallets' signal_signals / signal_wins / signal_winrate
```

**Correctness guarantees, by construction:**
- *No same-block inflation* — the `safe_*` base re-snapshots MC ~3 min after first buy, after same-block snipe prices have normalized.
- *No double-count* — `smart_trades` dedups on `(signature, wallet)`; confluence counts distinct wallets.
- *No sybil signals* — co-funded cohorts are logged but never promoted or scored.

## 6. Curated wallet universe

- **One-time seed import.** A script ingests a fomo.family wallet-leaderboard snapshot (~17k wallets: handle, display name, twitter, pnl_7d/all, win_rate, rank) into `candidate_wallets` with `source='fomo_seed'`. This pool is reference/candidate data only — the PnL figures are a point-in-time snapshot and are **never displayed as live**.
- **Live candidates.** A throttled job pulls the Solana Tracker PnL leaderboard (`/v2/pnl/leaderboard/top`) into `candidate_wallets` with `source='st_leaderboard'`.
- **Promotion.** The dashboard surfaces a "Suggested wallets" panel ranking candidates by snapshot PnL. Promoting a candidate:
  1. calls Solana Tracker for a fresh quality snapshot (win-rate, realized PnL, ROI, tokens-traded),
  2. inserts/updates `tracked_wallets` with that snapshot and `source`,
  3. adds the address to the Helius webhook address set (`watches/sync` union), and
  4. sets `candidate_wallets.promoted = true`.
- **Cost guard.** Only promoted wallets are webhook-subscribed and parsed into `smart_trades`. The ~17k candidate pool is dormant data — we never subscribe the whole set (Helius wallet-count caps + credit cost).

## 7. Dashboard bundle API

`GET /api/db/dashboard` (auth via existing `X-Auth-Token`), in-process LRU cached ~15s:

```jsonc
{
  "generated_at": "<iso>",
  "stats": { "total_signals", "hits", "hit_rate", "avg_multiplier",
             "best_multiplier", "best_multiplier_symbol", "open_signals" },
  "live_signals": [ /* recent + open signals, newest first, with call/ath/multiplier/is_hit/trust */ ],
  "trending":     [ /* tokens by recent volume/price-change from the tokens cache + ST trending */ ],
  "top_traders":  [ /* outcome-scored: address, label, signal_wins/signal_signals, winrate, src_pnl */ ]
}
```

Live updates ride the existing intel SSE stream. New event variants on the `IntelEvent` union:
- `smartmoney:signal` — a new independent signal was promoted.
- `smartmoney:outcome` — an open signal's `current_mc` / `ath_multiplier` / `is_hit` changed.

The web client paints from the bundle on load, then patches signal rows from SSE deltas.

## 8. UI rework & de-cruft (full pass)

**Aesthetic is unchanged** — the existing OKLCH deep-navy + amber system, IBM Plex Mono/Sans, hairline borders, 2px-max radius, tabular numerals. "No generic UI" means dense, data-forward, terminal-grade: wallet-count dots, trust chips, inline multipliers, CSS sparklines, wallet-class glyphs — not rounded gradient SaaS cards.

**Homepage → live dashboard.** Replace the search-box landing with:
- a top command bar; `⌘K` focuses the wallet/mint search (search is demoted, not removed),
- a stats strip (`SIGNALS · HIT-RATE · AVG · BEST · OPEN`),
- a two-column grid: **Live Signals** (left) and **Trending + Top Traders** (right).

```
┌─ THIRDEYE ─────────────────────────[ ⌘K  wallet / mint ]─┐
│ SIGNALS 142 · HIT 38% · AVG 2.4x · BEST 11x · OPEN 12    │
├───────────────────────────────┬──────────────────────────┤
│ ▸ LIVE SIGNALS                │ ▸ TRENDING               │
│ ┌───────────────────────────┐ │  BOYS   +14%  $180k      │
│ │ KNICKS  ●●● x3 indep       │ │  POPCAT +9%   $2.1m      │
│ │ call $75k → ath $277k 3.6x │ │ ▸ TOP TRADERS (signals)  │
│ │ ▁▂▃▅▇ HIT          22m ago │ │  INCOME  9/11  82% · +$… │
│ └───────────────────────────┘ │  ...                     │
│ WIF  ●● x2 indep  1.1x  open  │                          │
└───────────────────────────────┴──────────────────────────┘
```

**Signal card** (replaces the plain `<ul>` row in `SmartMoneyFeed`): symbol → token link; wallet-count dots + `indep` / `⚠ co-funded` trust chip; `call → ath  Nx` with a HIT badge in mint (clean) / crimson (severity); a CSS sparkline of MC over the signal's life; relative age.

**`/leaderboard` page:** a toggle between outcome-scored (`signal_winrate`) and ST-PnL views, with `WalletClassGlyph` markers per row.

**De-cruft sweep (site-wide):** remove forensics framing and filler copy, including but not limited to:
- "Solana wallet & token forensics" headline,
- "⌖ the eye that sees what the other two cannot,"
- "press enter or click investigate. byok keys configured in /settings,"
- "awaiting activity… run a scan to see events appear here."

Reframe to a terse alpha-terminal voice. Forensics (cluster / funding / sybil panels) stays but is demoted to a collapsible section on `/wallet/[addr]` and `/token/[mint]` — it is the quality filter, not the headline.

## 9. Constraints & edge cases

- **ST credit budget.** Quality snapshot 1/wallet; leaderboard hourly; trending every 10 min. All signal MC-tracking on free DexScreener. Stays inside ST free 10k/mo.
- **Helius wallet cap.** Only promoted wallets are subscribed; the candidate pool is never subscribed wholesale. Honors the spec §8.2 concurrency caps for any enrichment fan-out.
- **Illiquid / missing MC.** DexScreener returns null for dead tokens; the worker keeps the signal `open` with last-known MC, never throws, and closes it at the 48h TTL regardless.
- **Confluence window.** Reuses the existing window parameter; a wallet re-buying does not re-trigger (dedup + distinct-wallet count). An open signal for a mint is updated, not duplicated.
- **Co-funded audit.** Suppressed cohorts are stored (`trust='co_funded'`) so the difference between "what a naive tracker would have called" and "what we called" is auditable.
- **BYOK / instance mode.** Unchanged: `X-User-Helius-Key` overrides the env key with no code branch; `PUBLIC_INSTANCE_MODE` remains the only hosted/self-host difference.

## 10. Risks & unknowns

1. **ST client gaps.** `@thirdeye/solanatracker` currently exposes only wallet methods. Leaderboard, trending, and token-price/info methods must be added, each with a real-key integration test that skips cleanly when `SOLANATRACKER_API_KEY` is unset (mirrors the Helius skip pattern). *Low risk — documented endpoints, confirmed live on the free tier.*
2. **Call MC precision.** Market cap exactly at `first_buy_at` is not cheaply retrievable; we snapshot at *detection* (seconds later) and document it. The `safe_*` base is the conservative figure shown by default, so the headline number is never optimistic.
3. **Seed staleness.** The fomo snapshot PnL is a point-in-time capture; it is treated as candidate ranking only and re-verified via ST on promotion. No snapshot number is ever rendered as a live stat.
4. **Bundle ↔ SSE lag.** The cached bundle may trail a just-fired signal by ≤15s on initial paint; the SSE delta closes the gap. Acceptable for single-user use.

## 11. Relationship to existing docs

- **Builds on:** `docs/superpowers/plans/2026-05-25-smart-money-feed.md` (tracked wallets, smart_trades, confluence, co-funded trust filter — all reused here).
- **Advances:** the alpha-tracker pivot recorded in `STATUS.md` and the phase-7 plan — this delta is the outcome-tracking + dashboard layer those docs deferred.
- **Vendor:** Solana Tracker (free tier), Helius webhooks, DexScreener — no new external dependency.

## 12. Next step

Per repo workflow, run `/review-spec` on this document before implementation. After review, the implementation plan is produced via the writing-plans flow and executed task-by-task.
