# @thirdeye/web

ThirdEye's web dashboard. Five pages, Next 15 + React 19 + Tailwind 3.4, no shadcn — ten hand-rolled components in a forensics-terminal aesthetic.

## Pages

| Route | What it does |
|---|---|
| `/` | Landing. Single input + wallet/token toggle. Submit routes to the detail page. |
| `/wallet/[addr]` | Check Wallet — SSE stream from `/api/wallet/:addr/check`. Renders score, verdict, tags, sibling cluster, funding chain, tx pattern, realized PnL as events arrive. **Force re-scan** button aborts the in-flight stream then re-opens with `?force=true`. |
| `/token/[mint]` | Scan Token — SSE stream from `/api/token/:mint/scan`. Renders metadata, top holders, LP/locked %, funding-progress bar, clusters with member counts + supply %. Same force-rescan pattern. |
| `/intel` | Live intel feed. Two-step ticket flow (POST `/feed/ticket` → GET `/feed?ticket=...`). Reverse-chronological tail of 200 events with pause / reconnect / clear controls and per-kind counts. |
| `/settings` | BYOK keys. Helius + Anthropic, masked with show/hide toggle, save to `localStorage`, cross-tab sync via `storage` event. Helius **test connection** button hits `/api/helius-rpc getHealth` (1 credit, cached 5min). |

## Run it

```bash
# From the repo root, with the api already running on :3001
cd apps/web
bun run dev    # → http://localhost:3000
```

Next.js dev rewrites `/api/*` → `http://localhost:3001/api/*` so the browser sees same-origin requests (no CORS preflight). Set `NEXT_PUBLIC_API_BASE_URL` to override (e.g. `http://staging.thirdeye.example`).

```bash
bun run build  # production build
bun run start  # serve the production build on :3000
bun test       # 48 unit tests (byok, auth, api, sse parser, format)
```

## Architecture

### Auth + BYOK + fetch

Three layered libs under `src/lib/`:

- **`byok.ts`** — `localStorage` wrapper for Helius + Anthropic keys. Cross-tab `storage` event bridge so two open tabs sync. Factory takes a `MinimalStorage` so unit tests use an in-memory shim.
- **`auth.ts`** — anonymous session token. `POST /api/db/auth` issues a token + 7-day expiry; we cache in `sessionStorage` and refresh within 60s of expiry. Concurrent callers during cold-start share one in-flight POST.
- **`api.ts`** — `fetch` wrapper that threads `X-Auth-Token` + (optional) `X-User-Helius-Key` + `X-User-Anthropic-Key` on every request. On 401, invalidates the cached token and retries exactly once.

All three are dependency-injection style — the factories accept `{storage, fetchImpl, ...}` so tests run without a DOM.

### SSE consumer

`src/lib/sse.ts` uses `fetch` + `ReadableStream` + a persistent-buffer frame parser. **Not `EventSource`** because the browser's EventSource constructor can't send custom headers (no way to add `X-Auth-Token`). The parser handles `\n\n` frame splits across chunks (the canonical "result event split across three TCP chunks" case is tested), CRLF, comments, multi-line `data:`, and abort signals. The intel feed uses a `sseFetchViaTicket` variant that POSTs for a short-lived ticket first.

### Reducers

Wallet + token detail pages fold the event stream into a single state object with an in-place `for` loop (not `reduce` + spread — that's O(n²) when re-running on every render). Memoized via `useMemo` keyed on the events array length.

### Aesthetic

Forensics-terminal — IBM Plex Mono for data (addresses, scores, percentages, timestamps), IBM Plex Sans for chrome. Deep navy ground (`oklch(0.14 0.012 270)`), amber brand accent (`oklch(0.78 0.16 70)`), crimson severity, mint clean. 2px-max border radius. Hairline borders. The full 32-44 char address rendered as a grid of bordered cells (one cell per character, first 4 + last 4 in amber, middle dimmed) is the visual anchor of every detail page.

Tag colors are differentiated so a wallet with multiple flags is readable at a glance:

| Tag | Color | Reasoning |
|---|---|---|
| `SMART_MONEY` | mint | Rare positive signal |
| `BUNDLER` | amber | Active manipulation, brand-color spotlight |
| `SYBIL` | crimson | Most severe — multi-account fraud |
| `FRESH_WALLET` | slate | Caution, not crime |

## Build details

- **`apps/web/tsconfig.json` overrides the root tsconfig** in two ways. It sets `exactOptionalPropertyTypes: false` (the root has it on; React 19 / shadcn-style prop types don't survive the stricter check) and `types: []` (the root injects `@types/bun` globals like Bun's `fetch.preconnect` which conflict with browser DOM types).
- **Test files are excluded from apps/web's tsc** because `bun:test` isn't in the type roots; the tests run via `bun test` directly which resolves them at runtime.
- **No `@types/node` in this package** — when it was pinned, two `@types/node` versions coexisted in the workspace (apps/web's 22.x and bun-types' 25.x) which broke ChildProcess types in API integration tests. Dropping it lets bun-types' dep win.

## Component inventory

```
src/components/
├── AddressBanner.tsx    # 44-cell base58 grid (visual anchor)
├── AuthBanner.tsx       # Root-level retry banner on auth failure
├── ClusterPanel.tsx     # Cluster summary + funding chain hops
├── KbdInput.tsx         # Mono input with cursor blink on focus
├── Landing.tsx          # Single input + wallet/token toggle
├── MetricStamp.tsx      # Left-rail label/value rows
├── SeverityBadge.tsx    # [ HIGH ] bracketed badge with severity color
├── StatusBar.tsx        # Persistent bottom bar (api health, session TTL)
├── TagList.tsx          # Per-tag colored badges
└── Ticker.tsx           # Top scrolling event preview during SSE streams
```

## License

MIT (same as the parent ThirdEye repo).
