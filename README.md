# ThirdEye

> *The eye that sees what the other two cannot.*

Open-source Solana wallet & token forensics — bundle/sybil detection, funding-chain tracing, cluster analysis.

**Status: design phase.** See [the design spec](docs/superpowers/specs/2026-05-01-thirdeye-design.md) for the full architecture.

## What it does

Three forensic tools sharing one intelligence database:

1. **Check Wallet** — paste a wallet, see its funding chain, behavioral tags, and clustered relatives.
2. **Scan Token** — paste a mint, get holder distribution clustered by first funder. Surfaces bundles, sybils, LP/lock breakdown.
3. **Intel Analytics** — network-wide rollup: 24h pulse, all-time totals, risk distribution, live activity feed, heatmap.

## How the cluster detection works

Every wallet has a *first funder* — the wallet that first sent it SOL. Group token holders by their first funder, and you find the bundles, the sybil rings, the insider clusters. ThirdEye does this for any token in seconds, with results cached and shared across the network.

## Stack

Bun · Hono · Drizzle · Postgres · graphile-worker · Next.js 16 · Helius RPC

Self-host with `docker compose up` (two services: `app` + `postgres`). Use the public instance for free with rate limits, or paste your own Helius key in Settings to bypass them.

## License

MIT
