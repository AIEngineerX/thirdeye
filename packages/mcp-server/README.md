# @thirdeye/mcp-server

Model Context Protocol server exposing ThirdEye's Solana wallet & token forensics tools to any MCP client (Claude Desktop, Cursor, custom agents).

Six tools, all hitting the same backend that powers ThirdEye's HTTP API:

| Tool | Purpose |
|---|---|
| `checkWallet` | Forensic profile of a single wallet — funding chain, cluster, tags, score, verdict |
| `scanToken` | Holder-distribution analysis on an SPL mint — bundles, sybil rings, LP/locked % |
| `getClusterSiblings` | Wallets that share a target's first funder (cohort expansion) |
| `getFunderClusters` | Top funders by fan-out (suspicious funding hubs) |
| `getHotTokens` | Top tokens by 24h market-cap velocity |
| `getWatchlist` | All distinct watched wallet addresses across sessions |

## Prerequisites

A running ThirdEye stack on the same machine:

```bash
git clone https://github.com/AIEngineerX/thirdeye
cd thirdeye
cp .env.example .env
# edit .env: set HELIUS_API_KEY
docker compose up -d postgres
bun run migrate
```

## Claude Desktop config

Edit `claude_desktop_config.json` (location: macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "thirdeye": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/thirdeye/packages/mcp-server/src/bin.ts"],
      "env": {
        "DATABASE_URL": "postgres://thirdeye:thirdeye@localhost:5432/thirdeye",
        "HELIUS_API_KEY": "your-helius-key-here",
        "SMART_MONEY_MIN_SOL": "50"
      }
    }
  }
}
```

Restart Claude Desktop. The tools become available — try: *"Use checkWallet to investigate VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1."*

## Required env

| Var | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection (same DB your ThirdEye stack uses) |
| `HELIUS_API_KEY` | for `checkWallet`/`scanToken` | undefined | If unset, those two tools fail; the four DB-only tools still work |
| `SMART_MONEY_MIN_SOL` | no | 50 | Threshold for the `SMART_MONEY` tag |

## v1.1 roadmap (not in this release)

- HTTP/SSE transport — call this server remotely (not just stdio)
- npm publish — `npx @thirdeye/mcp-server` instead of cloning the repo
- Gateway mode — proxy to a hosted ThirdEye instance instead of requiring local Postgres + Helius

## License

MIT (same as the parent ThirdEye repo)
