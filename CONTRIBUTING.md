# Contributing to ThirdEye

ThirdEye is open source under the MIT license. PRs welcome.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2
- Docker + Docker Compose
- A free [Helius API key](https://dashboard.helius.dev/api-keys) — required for any proxy / scanner / wallet / token route. Routes that don't touch Helius (`/health`, `/api/db/auth`, `/api/db/intel/*`) work without one.

## Local development

```bash
git clone https://github.com/AIEngineerX/thirdeye
cd thirdeye
cp .env.example .env                   # set HELIUS_API_KEY=...
bun install

docker compose up -d postgres          # database only (api runs locally with hot reload)
bun run migrate

bun run dev                            # terminal 1: api on :3001
cd apps/web && bun run dev             # terminal 2: web on :3000
```

The API listens on `http://localhost:3001`. The web dashboard at `http://localhost:3000` proxies `/api/*` via Next rewrites — no CORS preflight fires in dev.

For an end-user run (everything in containers), see [`README.md`'s quickstart](README.md#quickstart) — Option A. **Don't run both Option A and Option B at once**; you'll get a port-3001 collision.

## Before opening a PR

```bash
bun run lint            # biome check (root + apps/web)
bun run typecheck       # runs both api and web typecheck
bun run typecheck:api   # just the bun + node side
bun run typecheck:web   # just apps/web (Next + React)
bun test                # bun:test against real Postgres (must be running)
```

CI runs the same commands; PRs that fail any will be blocked.

## Architecture

- Canonical design spec: [`docs/superpowers/specs/2026-05-01-thirdeye-design.md`](docs/superpowers/specs/2026-05-01-thirdeye-design.md). Per-phase specs sit alongside it.
- Stack: Bun + Hono + Drizzle + Postgres 16 + graphile-worker + Next 15 + React 19 + Tailwind 3.4 (web dashboard, Phase 6f-min).

When implementation diverges from a spec, either update the spec or change the implementation in the same PR — no silent drift.

## Project conventions

- **Tests are real.** No mocks of Helius or Postgres. Integration tests run against a live Postgres (the dev compose service is enough); Helius integration tests skip cleanly when `HELIUS_API_KEY` is unset and hit real Helius when it is. Mocked tests prove nothing.
- **No defensive code.** Don't add try/catch, fallbacks, or null-checks for conditions that can't happen. Validate at system boundaries (HTTP input, external APIs); trust internal call sites.
- **No stubs / TODOs.** Production code paths ship complete. If a feature isn't ready, don't half-merge it.
- **Helius credits cost money.** Respect the per-scan (10) and per-process (50) concurrency caps in `packages/scanner/src/semaphore.ts`.
- **BYOK is transparent.** `X-User-Helius-Key` overrides `HELIUS_API_KEY` at the proxy boundary; downstream code never branches on which key is in use.
- **Self-host vs hosted is one env var.** `PUBLIC_INSTANCE_MODE=true` enables app-level rate limiting; everything else is identical.

## Code style

Biome handles formatting and most lint rules. Don't bikeshed — `bun run format` settles disputes.

## Commit messages

`<type>: <area> — <one-line summary>` where `<type>` ∈ `feat | fix | chore | docs | test | ci`. Example: `feat: scan — add LP/lock holder filter`.
