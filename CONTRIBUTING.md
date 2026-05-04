# Contributing to ThirdEye

ThirdEye is open source under the MIT license. PRs welcome.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2
- Docker + Docker Compose
- A free [Helius](https://helius.dev) API key (only required from Phase 1 onward — Phase 0 has none of the proxy code yet)

## Local development

```bash
git clone https://github.com/AIEngineerX/thirdeye
cd thirdeye
cp .env.example .env
bun install
docker compose up -d postgres
bun run migrate
bun run dev
```

The API is now at `http://localhost:3001`.

## Before opening a PR

```bash
bun run lint        # biome check
bun run typecheck   # tsc --noEmit
bun test            # bun:test against real Postgres (must be running)
```

CI runs the same four commands; PRs that fail any will be blocked.

## Architecture

- Design spec: [`docs/superpowers/specs/2026-05-01-thirdeye-design.md`](docs/superpowers/specs/2026-05-01-thirdeye-design.md)
- Phase plans: [`docs/superpowers/plans/`](docs/superpowers/plans/)
- Stack: Bun + Hono + Drizzle + Postgres + graphile-worker (Phase 2+) + Next.js (Phase 5+)

## Code style

Biome handles formatting and most lint rules. Don't bikeshed — `bun run format` settles disputes.

## Commit messages

`<type>: <area> — <one-line summary>` where `<type>` ∈ `feat | fix | chore | docs | test | ci`. Example: `feat: scan — add LP/lock holder filter`.
