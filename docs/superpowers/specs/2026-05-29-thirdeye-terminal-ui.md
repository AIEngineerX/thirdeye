# ThirdEye Terminal UI — Design Spec

**Date:** 2026-05-29 (revised same day after `/review-spec` — trimmed scope: imagery/pfp/volume cut, charts hardened, visual tokens pinned)
**Status:** Approved design — pending implementation plan
**Type:** Frontend design spec. Closes the visual/usability gap with the alpha-terminal product class (Cielo / GMGN / Axiom / BullX). Builds on the current `apps/web` dashboard (signal cards, trending, top-traders, `/leaderboard`, `/intel`) and the in-progress detail-page work (wallet PnL endpoint + `/wallet` and `/token` overhauls + `EvidenceStrip`).

This spec governs the web UI surfaces it names. It does not change the read-only product boundary or the backend signal/universe/dashboard contracts already shipped.

---

## 1. Goal

ThirdEye has the strongest analysis in the category (independence/sybil trust gate, funding-chain forensics, outcome-scored signals) but lacks the table-stakes that make terminals feel complete: **price charts, one-click actionability, and dense, sortable detail surfaces.** This push adds those across the dashboard, token page, wallet page, and leaderboard/trending — on the existing OKLCH-navy + amber + IBM Plex visual system — so the product reads as a pro terminal, not an analyst's read-out.

## 2. Scope & boundaries

**In scope:** a shared visual foundation (actions, chips, sortable table), charts (token candlesticks + wallet cumulative-PnL), and UI rework of four surfaces.

**Explicitly cut after review (not "missing" — deliberately out):** token/wallet **imagery** (avatars/pfp — identity is symbol/handle/short-address text), **token volume** (the tokens cache doesn't store it and price/MC/liquidity/24h% suffice), and any **persistent OHLCV cache** (single-user personal scale; a short in-process cache is adequate). These were "blockers" only because they implied data sources that don't exist; cutting the features removes the work.

**Boundaries:**
- **Read-only preserved.** Quick-Buy is an **outbound deep-link** to an external trading interface with the mint pre-filled — ThirdEye never holds a key, signs, or executes.
- **Provenance.** No competitor product name in committed code/docs beyond the already-cited Cielo/GMGN/Axiom/BullX product-class references.
- **Builds on committed WIP.** The `/wallet`, `/token`, `layout.tsx`, `TagList.tsx`, `pnl-types.ts`, and `apps/api/src/routes/wallet/pnl.ts` edits are committed as a single **baseline commit** before this work starts (Phase 0); each later phase extends a green tree.
- **No Telegram/alerts** in this push (deferred).

## 3. Shared visual foundation (built first; everything consumes it)

- **`ActionRow`** — generalizes the existing `EvidenceStrip` actions into a reusable control: `copy · Solscan · DexScreener · [Quick-Buy ▾]`. Reuses `EvidenceStrip`'s exact interaction tokens (`hover:bg-accent-bg hover:text-accent active:translate-y-px transition-colors`; Quick-Buy open-state `bg-accent-bg border-accent`); **no ring, no shadow**. Quick-Buy resolves a deep-link from a **pure URL-builder function** (`buildQuickBuyUrl(platform, mint)`); v1 ships **one verified platform** (default `gmgn` → `https://gmgn.ai/sol/token/<mint>`), others rendered disabled/"soon". Platform choice stored in `/settings` (the `lib/byok` localStorage factory pattern). Rendered on signal cards, token/wallet headers, and trending/leaderboard rows.
- **`Chip`** — one component for trust (`indep` mint / `⚠ co-funded` crimson), `HIT`, severity (CLEAN/LOW/HIGH), `rugged`. **Geometry pinned:** zero border-radius, 1px border in the severity color at /60, severity-color background at /10 — same treatment as the existing `TagList` tones. No `rounded-full`, no heavy fill.
- **`DataTable`** — dense, hairline, tabular, **sortable**. Header row `border-b border-border-emphasis` (not a `bg-card` fill); active sort column label in `text-accent` with a single `▴`/`▾` suffix in `text-accent`; unsorted columns show no indicator. No dual-arrow icons, no Heroicons. Used by leaderboard, trending, and the wallet positions table.

**No avatar components** — identity is rendered as `$SYMBOL` / `@handle` / `shortAddr(address)` text, consistent with the existing `AddressBanner`/`EvidenceStrip` vocabulary.

## 4. Charts

- **Library:** TradingView **Lightweight Charts**, **lazy-loaded** (`dynamic(() => import('…'), { ssr: false })`) so the initial paint isn't blocked.
- **`PriceChart`** (token) — candlesticks from OHLCV.
  - **Data path:** a new `SolanaTrackerClient.tokenChart(mint)` → `GET /chart/{mint}` (ST returns the candle key misspelled `oclhv`; the client normalizes to `ohlcv`). **Prerequisite (Phase 0):** capture a real `/chart` response and pin it as a fixture before building the method; a live integration test skips when `SOLANATRACKER_API_KEY` is unset (the existing ST/Helius skip pattern). OHLCV types live in `@thirdeye/solanatracker`; `apps/web` consumes a small `lib/ohlcv-types.ts` mirror (the `pnl-types.ts` precedent).
  - **Route:** `GET /api/db/tokens/:mint/ohlcv` (added to the existing tokens router, which is mounted under `/api/db` with `requireAuth` but **not** the Helius `scanTokenLimit` — `/api/token` carries the scan limiter, `/api/db/tokens` does not). A cheap cached read, not a scan. A **60s in-process TTL cache** in front — adequate for a single-user personal instance on the ST free tier; persistent caching is out of scope (revisit only if hosted multi-user).
  - **Theme (pinned, so it isn't a default TradingView embed):** `upColor` = `--severity-clean` (mint), `downColor` = `--severity-high` (crimson), wicks same at 60%, `borderVisible: false`, grid `--border-subtle`, background `--bg-base`, **no watermark**. Container `h-[260px]` desktop / `h-[200px]` mobile — the chart is the page anchor, not a full-bleed hero.
  - **Markers (time-anchored — resolves the MC/price-axis mismatch):** Lightweight Charts `setMarkers` attaches to a **time + above/below-bar position**, never a price Y-coordinate, so **no `call_mc`→price conversion is needed.** The signal's call point → an **amber `aboveBar` arrow** at `detected_at`/`first_buy_at` labeled with the multiple; tracked-wallet buys (`smart_trades` for the mint) → **mint `belowBar` dots** at each `traded_at`. Tokens with no/sparse candles render the empty chart frame, never a crash.
- **`PnlChart`** (wallet) — cumulative area from the WIP `performance.days` series (`pnl-types.ts`); no new data. Must handle three states (mirror the existing WIP SVG guards): **no data** (`< 2 days` → empty frame), **all-zero** (held-only wallet → flat baseline with a label, not an arbitrary line), and a real series.

## 5. Surfaces

```
DASHBOARD signal card            TOKEN /token/[mint]              WALLET /wallet/[addr]
┌──────────────────────────┐    ┌── $SYMBOL  name  ActionRow ──┐ ┌── addr  ActionRow ───────┐
│ $KNICKS ●●●x3 indep       │    │ Market: price MC 24h% liq    │ │ PnL real/unreal/total    │
│ call$75k→ath$277k 3.6xHIT │    │ ┌── PriceChart (candles) ──┐ │ │ win% · ROI · 7d/30d      │
│ ▁▂▃▅▇  22m  [buy▾][↗]     │    │ │  ▲call  •buys (time)     │ │ │ ┌── PnlChart (cum) ───┐  │
└──────────────────────────┘    │ └──────────────────────────┘ │ │ └─────────────────────┘  │
FilterBar: trust·minWallets      │ Security: LP-lock·top10·     │ │ Positions (sortable)     │
 ·age·minMC; ActionRow on        │ cluster%·sybil · Live trades │ │ Trades · Forensics ▸     │
 trending + top-traders rows     │ Forensics ▸ collapsible       │ │                          │
                                 └───────────────────────────────┘ └──────────────────────────┘
LEADERBOARD: sortable DataTable — rank · trader · wins/signals · winrate · PnL 7d/30d · ActionRow
```

### 5.1 Dashboard (`Dashboard.tsx`, `SignalCard.tsx`)
Add `ActionRow` + `Chip` to signal cards; add `ActionRow` + richer columns to the trending and top-traders panels (no avatars, no volume). Add a `FilterBar` that filters `live_signals` client-side: trust = independent only, min wallet count, max age, min call-MC. **FilterBar chrome pinned:** toggle filters render as `border border-border-emphasis px-2 py-1 font-mono text-2xs uppercase text-tertiary` buttons, active → `border-accent text-accent bg-accent-bg`; numeric inputs use `KbdInput` (`w-20`). **No Radix Select / combobox.** Quick-Buy on every token row.

### 5.2 Token page (`/token/[mint]` — on the WIP)
`PriceChart` (time-anchored call/buy markers) as the visual anchor; a `MarketPanel` (price / MC / 24h% / liquidity / FDV from the tokens cache — **no volume**); a `SecurityPanel` that *presents the data the scan actually produces* as a terminal risk panel — **LP-lock %, top-10 concentration, cluster/`bundle %` (scan cluster `totalPct`), `sybilFlag`**. Mint/freeze authority and per-holder SNIPER share are **not** in the scan result and are **out of scope** (a later authority-probe can add them). Live trades for the mint come from `smart_trades`; the full forensics scan (clusters/funding/sybil) is demoted to a `▸ Forensics` collapsible. `MarketPanel`/`SecurityPanel` run `grid-cols-2` at ≥lg, stacked below md. Header uses the extended `EvidenceStrip`/`ActionRow`.

### 5.3 Wallet page (`/wallet/[addr]` — on the WIP)
Keep + polish the WIP PnL header (realized/unrealized/total, win-rate, ROI, counts); add `PnlChart` (cumulative from `performance.days`, with the three states above); render `positions` as a sortable `DataTable` (token, realized/unrealized, ROI, current value, `rugged` chip) and `trades` as a history list; demote the forensics check (funding/cluster/sybil/tags/score) to a `▸ Forensics` collapsible. Header `ActionRow` (copy · Solscan · DexScreener).

### 5.4 Leaderboard + trending
Replace the fixed tables with the sortable `DataTable`; richer columns (PnL 7d/30d from `top_traders`; no avatars, no volume). `ActionRow` per row.

## 6. Data dependencies (trimmed)

| Need | Source | New surface |
|---|---|---|
| Token OHLCV (candles) | Solana Tracker `/chart/{mint}` | `tokenChart()` client method (against a captured fixture) + `GET /api/db/tokens/:mint/ohlcv` (existing tokens router under `/api/db` — `requireAuth`, **no** scan limiter, 60s in-process cache) + `apps/web` `lib/ohlcv-types.ts` mirror |
| Quick-Buy deep-links | static per-platform URL templates (1 verified) | pure `buildQuickBuyUrl()` fn + `/settings` platform pick (localStorage) |

Everything else the surfaces render already exists: `signals`, `tokens` cache (price/MC/mc_24h_pct/liquidity), `tracked_wallets`/`candidate_wallets`, the wallet-PnL endpoint, `smart_trades`, and the token-scan result. **No migration is required** (images/volume/pfp cut). The only per-request external call is the cached `/ohlcv`.

## 7. Phasing (drives the implementation plan)

0. **Baseline (entry condition)** — commit the in-progress detail-page work as one baseline commit; capture a real ST `/chart` response + fixture; confirm `bun run typecheck` + `apps/web` build are green.
1. **Foundation** — `ActionRow` (+ extend `EvidenceStrip`), `Chip`, `DataTable`, `buildQuickBuyUrl()` + `/settings` platform pick. (No migration.)
2. **Charts** — Lightweight Charts (lazy), `tokenChart()` + `/ohlcv` route + `ohlcv-types` mirror, `PriceChart` (time-anchored markers) + `PnlChart` (3 states).
3. **Dashboard** — `ActionRow`/`Chip`/`FilterBar` on cards + trending + top-traders.
4. **Token page** — `PriceChart` + `MarketPanel` + `SecurityPanel` (real scan data) + live trades + forensics collapse.
5. **Wallet page** — `PnlChart` + sortable positions/trades, on the WIP.
6. **Leaderboard + trending depth** — sortable `DataTable` + columns.

## 8. Risks & unknowns

1. **ST `/chart` shape** — undocumented, misspelled `oclhv` key. Mitigation: capture a real response + fixture and build/test `tokenChart()` against it in Phase 0/2, with a skip-when-no-key live test.
2. **Marker placement** — resolved by using Lightweight Charts' time-anchored `setMarkers` (call point at `detected_at`, buys at `traded_at`); no price-axis conversion. Sparse/empty candle data renders an empty frame.
3. **WIP baseline** — committed as a single commit first (Phase 0); each later phase reads the current file and re-runs `bun typecheck` so a broken intermediate state surfaces immediately.
4. **Chart bundle size** (~35–61KB gzip) — lazy-loaded via `dynamic(…, { ssr:false })`.
5. **Quick-Buy template breakage** — one verified platform via a pure builder fn; unsupported platforms are disabled in the UI, not silent 404s.

## 9. Testing

- **Pure-function unit test** for `buildQuickBuyUrl()` (verified template) and any sort/format helpers added for `DataTable`.
- **`tokenChart()`** — live integration test that skips without the key (existing pattern).
- **Charts, panels, FilterBar** — DOM-imperative / visual; verified by **running the app** (the dashboard was already browser-verified this way), checking each surface renders with no console errors against real + empty data. No heavy snapshot-test suite for a single-user tool.

## 10. Out of scope (follow-ups)

Token/wallet imagery, trader pfps, token volume, persistent OHLCV cache, mint/freeze authority + SNIPER-share in the security panel, Telegram/Discord alerts, discovery feeds (new-pair / bonding-curve stage), social/Twitter integration, multi-chain, widget-layout customization, native execution.
