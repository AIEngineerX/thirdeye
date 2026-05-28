# Candidate seed

Dev-only. Seeds `candidate_wallets` (source `fomo_seed`) from a local
fomo.family tracked-trader corpus SQLite — per-wallet buy count, early-entry
rate (share of buys under a low market-cap threshold), and distinct tokens,
enriched with the directory's PnL/handle. Candidates are dormant until promoted.

```bash
docker compose up -d postgres
bun run scripts/seed/fomo-candidates.ts <path-to>/corpus.sqlite   # default earlyMc $100k
```
