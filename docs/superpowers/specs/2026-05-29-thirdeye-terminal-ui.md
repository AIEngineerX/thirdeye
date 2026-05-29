# ThirdEye Terminal UI — Design Spec

**Date:** 2026-05-29
**Status:** Approved design — pending implementation plan
**Type:** Frontend design spec. Closes the visual/usability gap with the alpha-terminal product class (Cielo / GMGN / Axiom / BullX). Builds on the current `apps/web` dashboard (signal cards, trending, top-traders, `/leaderboard`, `/intel`) and the in-progress detail-page work (wallet PnL endpoint + `/wallet` and `/token` overhauls + `EvidenceStrip`).

This spec governs the web UI surfaces it names. It does not change the read-only product boundary or the backend signal/universe/dashboard contracts already shipped.

---

## 1. Goal

ThirdEye has the strongest analysis in the category (independence/sybil trust gate, funding-chain forensics, outcome-scored signals) but lacks the table-stakes that make terminals feel complete: **price charts, token/wallet imagery, one-click actionability, and dense, sortable detail surfaces.** This push adds those across the dashboard, token page, wallet page, and leaderboard/trending — on the existing OKLCH-navy + amber + IBM Plex visual system — so the product reads as a pro terminal, not an analyst's read-out.

## 2. Scope & boundaries

**In scope:** a shared visual foundation (actions, avatars, chips, sortable table), charts (token candlesticks + wallet cumulative-PnL), and UI rework of four surfaces (dashboard, token detail, wallet detail, leaderboard/trending).

**Boundaries:**
- **Read-only preserved.** Quick-Buy is an **outbound deep-link** to an external trading bot (Axiom/Trojan/GMGN/BullX/Photon) with the mint pre-filled — ThirdEye never holds a key, signs, or executes. Same model the category uses.
- **Provenance.** No competitor product name in committed code/docs beyond the already-cited Cielo/GMGN/Axiom/BullX product-class references.
- **Builds on WIP.** The `/wallet` and `/token` pages, `layout.tsx`, `TagList.tsx`, `pnl-types.ts`, and `apps/api/src/routes/wallet/pnl.ts` have in-progress local edits; this work extends them in place.
- **No Telegram/alerts** in this push (explicitly deferred).

## 3. Shared visual foundation (built first; everything consumes it)

- **`ActionRow`** — generalizes the existing `EvidenceStrip` actions into a reusable control: `copy · Solscan · DexScreener · GMGN · [Quick-Buy ▾]`. Quick-Buy resolves a configurable deep-link template per platform; the chosen platform is stored client-side in `/settings` (localStorage, the `lib/byok` factory pattern). Rendered on signal cards, token/wallet headers, and every trending/leaderboard/position row.
- **`TokenAvatar` / `WalletAvatar`** — `<img>` with a monogram fallback (first char of symbol/handle). Needs:
  - `tokens.image_url` column (migration 0013) populated by the existing `tokens-refresh` worker from DexScreener's token image field.
  - trader pfp from the fomo/ST identity (`candidate_wallets`/`tracked_wallets` already carry handle/identity; fomo identity includes `profile_picture_url`).
- **`Chip`** — one component for trust (`indep` mint / `⚠ co-funded` crimson), `HIT`, severity (CLEAN/LOW/HIGH), and `rugged`. Replaces the ad-hoc spans.
- **`DataTable`** — dense, hairline, tabular, **sortable** headers; used by leaderboard, trending, and the wallet positions table.

## 4. Charts

- **Library:** TradingView **Lightweight Charts** (small, dependency-light, supports candlesticks + line/area + series markers). Added to `apps/web`.
- **`PriceChart`** (token) — candlesticks from OHLCV. New data path:
  - Solana Tracker `tokenChart(mint)` client method → `GET /chart/{mint}` (note: ST returns the candle key misspelled as `oclhv`; the client normalizes it to `ohlcv`).
  - New cached route `GET /api/token/:mint/ohlcv` (in-process TTL cache, ~60s) so the chart never calls ST per render and respects the free-tier budget.
  - **Markers:** the signal's `call_mc`/`detected_at` and tracked-wallet buy points (`smart_trades` for the mint) overlaid on the series.
- **`PnlChart`** (wallet) — cumulative area line built from the WIP `performance.days` series (`pnl-types.ts`). No new data.

## 5. Surfaces

```
DASHBOARD signal card            TOKEN /token/[mint]              WALLET /wallet/[addr]
┌──────────────────────────┐    ┌── [img] $SYMBOL  name ───────┐ ┌── [pfp] addr  ActionRow ─┐
│[img] $KNICKS ●●●x3 indep  │    │ ActionRow · price MC vol liq │ │ PnL real/unreal/total    │
│ call$75k→ath$277k 3.6xHIT │    │ ┌── PriceChart (candles) ──┐ │ │ win% · ROI · 7d/30d      │
│ ▁▂▃▅▇  22m  [buy▾][↗]     │    │ │  ●call  ▲buys            │ │ │ ┌── PnlChart (cum) ───┐  │
└──────────────────────────┘    │ └──────────────────────────┘ │ │ └─────────────────────┘  │
FilterBar: trust·minWallets      │ Security: mint/freeze/LP/top10│ │ Positions (sortable)     │
 ·age·minMC; avatars+actions on  │ /bundle% · Live trades        │ │ Trades · Forensics ▸     │
 trending + top-traders rows     │ Forensics ▸ collapsible       │ │                          │
                                 └───────────────────────────────┘ └──────────────────────────┘
LEADERBOARD: sortable DataTable — rank · [pfp] trader · wins/signals · winrate · PnL 7d/30d · vol · ActionRow
```

### 5.1 Dashboard (`Dashboard.tsx`, `SignalCard.tsx`)
Add `TokenAvatar` + `ActionRow` to signal cards; add avatars + `ActionRow` + richer columns to the trending and top-traders panels. Add a `FilterBar` (trust = independent only, min wallet count, max age, min call-MC) that filters `live_signals` client-side. Quick-Buy on every token row.

### 5.2 Token page (`/token/[mint]` — on the WIP)
`PriceChart` (with call/buy markers) as the visual anchor; a `MarketPanel` (price / MC / 24h vol / liquidity / FDV from the tokens cache); a `SecurityPanel` that *presents* the existing scan result as a terminal-style risk panel — LP-lock %, top-10 concentration, cluster/`bundle %` (from the scan's cluster `totalPct`), `sybilFlag`, and `SNIPER`-tagged holder share. Mint/freeze authority is surfaced **only if** the scan's metadata step already exposes the token authorities; otherwise it is omitted rather than faked (a follow-up can add an authority probe). Live trades for the mint come from `smart_trades`; the full forensics scan (clusters/funding/sybil) demoted to a `▸ Forensics` collapsible. Header uses the extended `EvidenceStrip`/`ActionRow`.

### 5.3 Wallet page (`/wallet/[addr]` — on the WIP)
Keep the WIP PnL header (realized/unrealized/total, win-rate, ROI, counts) and polish it; add `PnlChart` (cumulative from `performance.days`); render `positions` as a sortable `DataTable` (token, realized/unrealized, ROI, current value, `rugged` chip) and `trades` as a history list; demote the forensics check (funding chain / cluster / sybil / tags / score) to a `▸ Forensics` collapsible below. Header `ActionRow` (copy · Solscan · DexScreener · GMGN).

### 5.4 Leaderboard + trending
Replace fixed tables with the sortable `DataTable`; add avatars and richer columns (PnL 7d/30d, volume/liquidity). `ActionRow` per row.

## 6. Data dependencies (new backend work)

| Need | Source | New surface |
|---|---|---|
| Token OHLCV (candles) | Solana Tracker `/chart/{mint}` | `tokenChart()` client method + `GET /api/token/:mint/ohlcv` (60s cache) |
| Token image | DexScreener (already fetched by `tokens-refresh`) | `tokens.image_url` (migration 0013) + worker stores it; surfaced in dashboard bundle + token route |
| Trader pfp | fomo/ST identity (already stored) | surfaced in `/leaderboard` + top-traders |
| Quick-Buy deep-links | static per-platform URL templates | `/settings` platform pick (localStorage) |

All chart/market data is cached server-side or sourced from the free tokens cache; no per-render ST/Helius calls. Quick-Buy is a client-side link, no backend.

## 7. Phasing (drives the implementation plan)

1. **Foundation** — `ActionRow` (+ extend `EvidenceStrip`), `TokenAvatar`/`WalletAvatar`, `Chip`, `DataTable`, `tokens.image_url` migration + worker, Quick-Buy settings.
2. **Charts** — Lightweight Charts dep, `PriceChart` + `PnlChart`, ST `tokenChart()` + `/ohlcv` route.
3. **Dashboard** — avatars/actions/filters on cards + trending + top-traders.
4. **Token page** — chart + market/security panels + live trades + forensics collapse.
5. **Wallet page** — PnL chart + sortable positions/trades, on the WIP.
6. **Leaderboard + trending depth** — sortable `DataTable` + columns + avatars.

## 8. Risks & unknowns

1. **ST `/chart` shape** — the OHLCV response uses a misspelled `oclhv` key and an undocumented candle schema; the `tokenChart()` method must be built against a real captured response (the key is set), with a live integration test that skips when unset.
2. **Token-image coverage** — DexScreener doesn't return an image for every mint; `TokenAvatar` must fall back to a monogram, never a broken `<img>`.
3. **WIP integration** — the `/wallet` and `/token` pages are mid-refactor; each phase reads the current file fresh and extends it, committing the combined state. If a WIP file is in a broken intermediate state, stop and surface it before layering on.
4. **Chart bundle size** — Lightweight Charts is ~45KB gzipped; acceptable, but lazy-load the chart components so the dashboard's initial paint isn't blocked.
5. **Quick-Buy link correctness** — deep-link templates differ per platform and change; keep them in one small config map so a broken template is a one-line fix, and default to a platform whose mint-deep-link format is verified.

## 9. Out of scope (follow-ups)

Telegram/Discord alerts, discovery feeds (new-pair / bonding-curve stage), social/Twitter integration, multi-chain, widget-layout customization, native execution.
