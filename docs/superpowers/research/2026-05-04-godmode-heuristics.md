# GODMODE — Heuristic Extraction & UI Audit

Source: `V:\godmode\public\index.html` (5,192 lines, 324 KB single-file SPA). MIT-licensed; logic is copy-eligible. All line refs are to that file.

---

## Part A — Heuristics

### 1. Risk score formula (lines 3826–3858)

Score is a sum of integer weights, capped at 100. **There is no normalization, no float math, no decay** — just additive flags.

```js
let riskScore = 0;
if (flags && flags.length) flags.forEach(f => {
    if (f.level === 'red') { riskScore += 20; autoTags.push(...); }
    else if (f.level === 'yellow') riskScore += 8;
});
if (tokenConns.targetInCluster) { riskScore += 35; autoTags.push('BUNDLED'); }
else if (tokenConns.clusters?.length > 0) riskScore += 5;
if (!fundedBy?.funder && balances?.totalUsdValue > 100) riskScore += 5;
identity.tags.forEach(t => {
    if (tl.includes('scam'|'hack'|'exploit')) riskScore += 30;
    if (tl.includes('phishing'|'fraud')) riskScore += 25;
});
if (connections?.co_bundled?.length > 0) riskScore += 15;
riskScore = Math.min(100, riskScore);
```

| Signal | Weight |
|---|---|
| Each red behavioral flag | +20 |
| Each yellow behavioral flag | +8 |
| Wallet itself in a bundle cluster (`targetInCluster`) | **+35** |
| Token has bundle clusters but target not in one | +5 |
| Active wallet (>$100) with no funder data | +5 |
| Identity tag contains scam/hack/exploit | +30 |
| Identity tag contains phishing/fraud | +25 |
| DB shows co-bundled wallets | +15 |

### 2. Risk-level thresholds (line 3858)

```js
const riskLevel = riskScore >= 60 ? 'CRITICAL'
                : riskScore >= 40 ? 'HIGH'
                : riskScore >= 20 ? 'MEDIUM'
                : riskScore >= 5  ? 'LOW' : 'CLEAN';
```

Color bands (`#ff2222 / #ff6644 / #ffaa44 / #88aa44 / #44cc66`) reuse the same cutoffs.

### 3. Wallet verdict / type classification (lines 3886–3914)

Verdict is **separate** from risk score — it's a cascade `if/else` on behavioral booleans. **First match wins.**

```js
if (isBundled && (coBundledCnt > 0 || sendBackFunder))           walletType = 'BUNDLER';
else if (isBundled)                                              walletType = 'BUNDLE WALLET';
else if (uniqueOutAddrs2 && !funderIsExchange)                   walletType = 'FUND DISTRIBUTOR';
else if (rapidFire && swapOnly)                                  walletType = 'SNIPER BOT';
else if (rapidFire && manyTokens)                                walletType = 'MEV / SNIPER BOT';
else if (swapOnly && manyTokens)                                 walletType = 'TRADING BOT';
else if (tokenCnt <= 2 && totalUsd > 10000)                      walletType = 'WHALE';
else if (walletAge !== null && walletAge < 7 && !hasIdentity)    walletType = 'FRESH WALLET';
else if (swapCnt > 5 && xferCnt <= 2)                            walletType = 'TRADER';
else if (hasIdentity && riskScore < 20)                          walletType = 'KNOWN ENTITY';
else if (riskScore < 5)                                          walletType = 'CLEAN';
else                                                             walletType = 'UNCLASSIFIED';
```

### 4. Behavioral flags (lines 3534–3582)

Flags are derived from up to 200 parsed enhanced-tx + up to 1000 raw signatures.

| Flag | Condition | Level |
|---|---|---|
| `DISTRIBUTES TO N WALLETS` | `cpSorted.filter(c => c.outSol > 0.001).length >= 10` | red |
| `RECEIVES FROM N WALLETS` | unique inbound counterparties ≥ 10 | yellow |
| `SINGLE COUNTERPARTY DOMINANCE` | top CP ≥ 40% of all tx | yellow |
| `RAPID-FIRE ACTIVITY` | avg gap between tx < 60 s (≥10 sigs) | red |
| `HIGH FREQUENCY` | avg gap < 300 s | yellow |
| `SWAP-ONLY WALLET` | swapCount > 5 AND transferCount === 0 | yellow |
| `USES N DEXes` | dexCount ≥ 3 | blue (info) |
| `N UNIQUE TOKENS` | tokenCount ≥ 15 | yellow |
| `ACCUMULATION PATTERN` | totalInSol > 1 AND totalInSol > 3× outSol | blue |
| `SENDS BACK TO FUNDER` | funder appears as outbound CP | red |
| `N BI-DIRECTIONAL LINKS` | ≥ 3 CPs with both in & out | yellow |

**Sniper detection is purely flag-composition** — no first-tx-vs-mint-time math, no LP-snipe detection, no Jito-tip checks. RAPID-FIRE+SWAP-ONLY ⇒ `SNIPER BOT`. Lazy but cheap.

**Whale detection is a one-liner** (line 3902): `tokenCnt <= 2 && totalUsd > 10000` — concentration + size, no holdings-decile, no PnL.

### 5. Bundler clustering algorithm — token CA scan (lines 4392–4516)

The actual bundle-detection pipeline. **No time-window grouping at all** — clustering is purely "same first-funder = same bundle":

```js
allHolders.sort((a,b) => b.amount - a.amount);
const holdersToScan = allHolders.slice(0, _ts.tokenHolders);   // top N (default 100/200)
// For each holder: getSignaturesForAddress(limit:50) → take OLDEST sig
// Batch parseTransactions(100/req) → extract first inbound nativeTransfer.fromUserAccount
//                                    fallback: tx.feePayer if !== owner
funderMap[owner] = { funder, amount };

// Group:
deepResults.forEach(r => {
    const f = funderMap[r.owner];
    if (f?.funder) clusters[f.funder].wallets.push({...});
});
const suspiciousClusters = clusterList.filter(c =>
    c.wallets.length >= 2 && !isKnownExchange(c.funderName, c.funderType, c.funderCategory)
);
```

**Cluster rule: `≥ 2 holders + same non-exchange funder = bundle.`** Concurrency 8/12/15 with 80/60/40 ms delay (line 4425).

`bundlePct = sum(suspiciousCluster supply) / totalHeld * 100` (line 4517).

### 6. Funding-chain trace (lines 3060–3076)

```js
let currentFunder = fundedBy.funder;
for (let lvl = 0; lvl < _s.walletFchain; lvl++) {
    const fb = await API.fundedBy(currentFunder).catch(() => null);
    if (!fb || !fb.funder || fb.funder === currentFunder) break;
    fundingChain.push({...});
    currentFunder = fb.funder;
}
```

**Depth = `walletFchain` setting: 1 hop in shared mode, 2 in BYOK** (`DEFAULTS_SHARED/CUSTOM`, line 2394). Stops on null, self-loop, or depth limit. **No CEX-detection short-circuit** — they happily walk into a Binance hot wallet. README says "multi-level" but in shared mode it's literally 1 hop.

### 7. Token holders fanout (token CA scan)

`getTokenAccounts` paginated 100/page until short page. Top N taken: shared 100 / custom 200 (with 5 / 10 page caps at line 2394). Per-holder `getSignaturesForAddress(limit:50)` → oldest sig → batched `parseTransactions(100/req)` to extract funder. `cluster_id` is just the funder address (object key in `clusters{}` at line 4483); no surrogate ID assigned.

### 8. Magic numbers (single source of truth)

```js
// line 2394 — scan settings
DEFAULTS_SHARED = { walletPages: 1, walletSigs: 250, walletFchain: 1, walletMiniscan: 30, tokenHolders: 100, tokenPages: 5 }
DEFAULTS_CUSTOM = { walletPages: 5, walletSigs: 1000, walletFchain: 2, walletMiniscan: 50, tokenHolders: 200, tokenPages: 10 }
```

| Constant | Value | Where |
|---|---|---|
| Cluster size to flag | ≥ 2 wallets | 4511, 3220 |
| Bundle severity warn / hot | bundlePct > 1 / > 5 | 4584 |
| Cooldown between rescans | **15 min** | 2945, 4283 (`15 * 60 * 1000`) |
| SOL transfer dust filter | < 0.001 SOL ignored | 3491, 3537 |
| Min sigs for tempo analysis | 10 | 3551 |
| Rapid-fire / high-freq cutoffs | 60 s / 300 s avg | 3554–3555 |
| Distributor / collector flag | ≥ 10 unique counterparties | 3538, 3542 |
| Single-CP dominance | ≥ 40% activity | 3545 |
| Many-tokens flag | ≥ 15 unique mints | 3567 |
| Dex variety flag | ≥ 3 DEXes | 3563 |
| Whale criteria | tokenCnt ≤ 2 AND $10k+ | 3902 |
| Fresh wallet criteria | < 7 days, no identity | 3904 |
| Trader criteria | swap > 5 AND transfer ≤ 2 | 3906 |
| Stablecoin/blue-chip skip set | USDC, USDT, SOL, WSOL, WETH, WBTC, PYUSD, DAI, BUSD, USDS, FDUSD, TUSD, RAY, JUP, JITOSOL, MSOL, BSOL, BONK | 3081 |
| Known-exchange list | binance, coinbase, kraken, okx, bybit, kucoin, gate, mexc, bitget, htx, crypto.com, gemini, bitstamp, upbit, robinhood, **phantom, backpack** | 4679 |

### 9. Helius call patterns (lines 2429–2493, 4130–4143)

- **No client-side cache** — no TanStack Query, no SWR, no in-memory `Map`. Every nav re-fetches. Only persistence is server DB (`/api/db/*`) and a 15-min server-side rescan cooldown.
- **No retry** — `fetchJSON` / `postJSON` throw on `!ok`; only fallback is `.catch(() => null)` at call sites.
- **Batching:** `batch-identity` 100 addr/req, `parseTransactions` 100 sig/req, `getTokenAccounts` 100 acc/page.
- **Rate limiting:** `rateLimited(tasks, concurrency, delayMs)` worker pool. Token scan uses 8/12/15 workers with 80/60/40 ms delay scaling by holder count. Wallet mini-scan uses 6 or 12 workers / 80 or 50 ms.
- **BYOK:** custom key from `localStorage` rewrites URL to `https://api.helius.xyz/...?api-key=...` and `https://mainnet.helius-rpc.com/?api-key=...`, bypassing nginx.

These are well below ThirdEye's spec §8.2 caps (10 in-flight per scan, 50 per process) — we can be more aggressive than they are.

---

## Part B — UI Audit

### 10. Polish level

**Production-ready prototype.** Live at godmode.fun, fully bilingual EN/RU/FR/ES (3,500+ i18n strings), URL routing, OG images, cooldown UX, version history, mobile-responsive (`clamp()` typography everywhere). But it's a single 5,192-line HTML file with inline styles for half the verdict UI — there is no design system. Polished, but not engineered.

### 11. Pages / views (lines 943–1170)

Five SPA "screens", toggled by class:

- `#intro-screen` — fullscreen "GODMODE" door-press button (lines 58–119)
- `#main-menu` — Minecraft-style button stack: Check Wallet / Check Token CA / Settings / How it Works / Language / Sound / Quit (line 963)
- `#wallet-screen` — `/wallet-checker[/<addr>]` (line 985)
- `#suspicious-screen` — `/token[/<mint>]` (line 1002)
- `#settings-screen` — `/settings` (line 1021); BYOK input + scan-depth sliders
- `#howitworks-screen` — static help (line 947)

Routes resolved by regex on `window.location.pathname` (line 4771).

### 12. Visual style

**Minecraft / pixel-art / retro arcade.** Verbatim:

- Font: `'Press Start 2P'` from Google Fonts, monospace fallback (line 33). Used everywhere, including body copy. **Painful to read at length.**
- Bg: `#0a0a0a`. Theme color `#000000`. Cursor disabled site-wide (`cursor: none !important`) and replaced with a custom pixel SVG cursor (line 47).
- Palette: red `#ff2222 / #ff4444 / #ff6644 / #cc0000`, purple `#bb88dd / rgba(150,100,200,*)`, blue `#4488ff`, gold `#ffaa44`, green `#44cc66 / #66ff88`. No CSS custom properties — every color hardcoded inline.
- Buttons (`.mc-btn`): faux-3D bevels via `border-top: 3px solid #aaa; border-bottom: 3px solid #1a1a1a;` plus repeating-linear-gradient noise overlays. Branded as Minecraft buttons, complete with hover-blue tint.
- CRT scanline overlay on intro (`repeating-linear-gradient` at 2px) + red grid (lines 64–73). Particle field for ambience (line 119).
- Density: extreme. Font sizes go down to `clamp(4px, 0.8vw, 6px)` — yes, 4px text on small screens (line 3945).
- Logo: voxel "HARADRIM GODMODE" PNG, blue/red/3D-rendered (`HaradrimGodMode.png`, `godmodeog.png`).

### 13. Notable UI primitives

- **Risk dot + bar:** thin colored bar (3px tall) filled to `${score}%` width with verdict label + score in same color (line 3938). Reusable.
- **Cluster cards** (`.cluster-card`, line 597): bordered box, header has FUNDER + wallet count, body lists wallets with `address · tokens-shared · supply%`. Pulsing red `serial-badge` for `tokens_involved > 1` (line 889, animation `serialPulse`).
- **Auto-classification verdict block** (line 3930) — typeIcon + label + risk level + score, micro risk bar, top-5 findings bullets, footer stats line. Genuinely good info-density. **Worth copying the layout.**
- **Cooldown bar** with live countdown timer (line 4329, `setInterval` updating display and width).
- **Scan version history popup** (line 4148) with "LATEST" badge.
- **Inline copy-to-clipboard** via `navigator.clipboard.writeText(...);this.textContent='COPIED'` (line 1175). Crude but works.
- **`moreLink()` modal** (referenced ~10 places) — generic "show all" expander for tabular data.
- **No graph viz at all.** Cluster relationships are list-rendered, not drawn. README's "cluster graphs" claim is overselling.
- **No share/embed buttons.** OG images generated server-side, but no in-app "share this scan" CTA.

### 14. Copy vs. redesign recommendation

**Copy outright (algorithms only):**
- Funder-grouping bundle clustering (§5) — clean, cheap, works.
- Risk-flag set (§4) — solid baseline. ThirdEye should add LP-snipe-window and Jito-tip detection on top.
- The 13-pattern verdict cascade (§3) — labels are good UX even if logic is naive.
- BYOK URL-rewrite pattern.
- Per-task `rateLimited(tasks, conc, delay)` worker pool with conc-by-batch-size scaling.

**Do not copy (numbers worth tightening):**
- Risk weights are integer-arbitrary; some are wildly inverted (a co-bundled DB hit = 15, but being IN a cluster = 35; a `scam` tag = 30 only — should be ≥ 60). Recalibrate before shipping.
- 1-hop funding chain in shared mode is below README's promise. ThirdEye should default to 3 hops with CEX-stop short-circuit.
- "Phantom, Backpack" in the exchange-allowlist is wrong — those are wallet apps that fund nothing (line 4679). Remove.
- No client-side cache wastes user credits on every renav. ThirdEye should use TanStack Query with `staleTime: 60s` for identity/balance and `staleTime: 5min` for parsed tx.

**Redesign for ThirdEye:**
- Drop Press Start 2P + voxel logo + cursor takeover. Keep terminal aesthetic but use a proper monospace (JetBrains Mono / IBM Plex Mono) at humane sizes (12–14px). Their UI is MID for any session > 90 seconds.
- No design tokens / CSS vars — entire color palette is repeated as hex literals across 5,000 lines. ThirdEye's Tailwind+shadcn should give us systematic theming for free.
- Add an actual cluster graph (D3 force layout or react-flow) — it's the marquee feature and they list-render it.
- Build `Share` / `Permalink` / `Export JSON` as first-class.

### 15. Screenshots

**None of the actual app UI in the repo.** `public/HaradrimGodMode.png` and `public/godmodeog.png` are both the voxel logo on black. README has zero embedded screenshots. To see real UI we'd need to visit godmode.fun.

---

## TL;DR

- Risk score is a 9-rule integer sum capped at 100 (lines 3826–3858); thresholds 60/40/20/5 → CRITICAL/HIGH/MEDIUM/LOW/CLEAN. Verdict label is a separate first-match cascade (BUNDLER, SNIPER BOT, WHALE, TRADER, etc.) on behavioral booleans, not on the score.
- Bundle clustering = "top N holders grouped by oldest-tx funder; ≥ 2 wallets per non-exchange funder = cluster". No time-window logic, no surrogate cluster_id — funder address IS the key. Top 100/200 holders only.
- Funding chain trace is 1 hop (shared) / 2 hops (BYOK). README's "multi-level" oversells; we should default to 3+ hops with CEX-stop short-circuit.
- Sniper detection is RAPID-FIRE (<60s avg gap) + SWAP-ONLY — no mint-time proximity, no LP-snipe window, no Jito-tip. Whale = ≤2 tokens + $10k+. Both crude; easy wins for ThirdEye.
- UI is production-ready Minecraft-pixel cosplay (Press Start 2P everywhere, voxel logo, custom pixel cursor). Algorithms worth copying; visual design is a hard pass — keep terminal vibe, drop the 4–7px text and arcade chrome.
