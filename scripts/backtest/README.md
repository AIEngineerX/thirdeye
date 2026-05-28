# Signal-engine backtest

Calibrates the confluence window + hit multiplier against a captured
fomo.family tracked-trader buy corpus. Dev-only; reads a local snapshot,
writes nothing to the product.

## 1. Export the corpus to normalized JSONL

The corpus lives in a local SQLite snapshot (table `fomo_wallet_buys`).
Export the buys ThirdEye cares about into `data/backtest/buys.jsonl`
(one JSON object per line). Run this once from a shell with `bun`:

```bash
mkdir -p data/backtest
bun run scripts/backtest/replay.ts --export "<path-to>/corpus.sqlite" > data/backtest/buys.jsonl
```

`--export` mode reads the SQLite directly via `bun:sqlite` and emits
`{ wallet, mint, symbol, side, mcUsd, blockTimeMs }` for every `side='buy'`
row with a non-null `block_time`.

## 2. Run the calibration grid

```bash
bun run scripts/backtest/replay.ts data/backtest/buys.jsonl
```

Prints, for each (windowMin, hitMultiplier): signals fired, hit count,
hit-rate, median + max multiplier. Pick the defaults that balance signal
volume against hit-rate and set them as `CONFLUENCE_WINDOW_MIN`
(apps/api/src/routes/helius-webhook/index.ts) and `SIGNAL_HIT_MULTIPLIER`
(apps/api/src/env.ts) in Phase 1.
