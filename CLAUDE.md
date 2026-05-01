# ThirdEye

Open-source Solana wallet & token forensics — bundle/sybil detection, funding-chain tracing, cluster analysis.

## Identity — CRITICAL

This repo uses the `github-aiengx` identity. Local git is already configured to:

- Git name: `AIEngineerX`
- Git email: `195990077+AIEngineerX@users.noreply.github.com`

**Never** commit with `griffrog88@gmail.com` or any GriffinAtlas identity. Verify with `git config --local user.email` before any commit.

## Canonical reference

The design spec is the source of truth for architecture, data model, API contract, and module behavior:

**`docs/superpowers/specs/2026-05-01-thirdeye-design.md`**

Re-read it before any architectural decision. If implementation diverges from spec, either update the spec or change the implementation — never let them silently drift.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Bun |
| API framework | Hono |
| Frontend | Next.js 16 (App Router) |
| ORM | Drizzle |
| DB | Postgres 16 |
| Job queue | graphile-worker (Postgres-backed, no Redis) |
| Realtime | SSE |
| Solana RPC | Helius (REST + JSON-RPC) |
| License | MIT |

## Workflow

- Run tests before committing (when test suite exists). Never commit untested code.
- No stubs, placeholders, TODOs, or "implement later" comments in production code paths.
- No mocking of Helius or Postgres in tests — integration tests against real running services only. Mocked tests prove nothing.
- No defensive programming for conditions that can't happen. Validate at system boundaries only.
- Less code is better code. Delete what adds noise, keep what adds value.
- Helius credits cost real money — respect the concurrency caps from spec §8.2 (10 in-flight per scan, 50 per process).
- BYOK header `X-User-Helius-Key` overrides `HELIUS_API_KEY` env var. Code never branches on which is used.
- `PUBLIC_INSTANCE_MODE` env var is the only difference between hosted and self-host modes.

## Commit style

`feat:` `fix:` `chore:` `docs:` `test:` prefix with em dash separator:

```
feat: cluster — implement funder-fanout endpoint
fix: scan — handle Helius v1/balances long-tail token cutoff
docs: spec — clarify SYBIL flag aggregation
```

## Scope

**v1 modules**: Check Wallet · Scan Token · Intel Analytics (with heatmap)

**v2 deferrals**: AI Assistant · Bad Actors DB · KOLs Spotted feed

**v3 deferrals**: Federation / cross-instance sync

## Working directory note

The local working directory is `V:\Ghost Wallet Tracker` for historical reasons (early brainstorming used "Ghost Wallet Tracker" as a placeholder name). The product is **ThirdEye** — repo, package names, public branding all use `thirdeye`. Don't rename the directory unless explicitly requested.
