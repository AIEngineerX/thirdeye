// Dev-only signal-engine backtest. Two modes:
//   --export <sqlite>   read a local corpus SQLite, emit normalized JSONL to stdout
//   <jsonl>             replay the JSONL and print a (window x multiplier) grid
//
// Ships nothing to prod. No network calls. Uses the SAME pure math the live
// worker uses (computeOutcome + walletsInWindow) so calibration matches runtime.

import { Database } from "bun:sqlite";
import { type BuyEvent, computeOutcome, walletsInWindow } from "@thirdeye/scanner";

interface CorpusBuy {
  wallet: string;
  mint: string;
  symbol: string | null;
  side: string;
  mcUsd: number | null;
  blockTimeMs: number;
}

function exportFromSqlite(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .query(
      `SELECT wallet_address AS wallet, token_address AS mint, token_symbol AS symbol,
              side, market_cap_usd AS mcUsd, block_time AS blockTime
       FROM fomo_wallet_buys
       WHERE side = 'buy' AND block_time IS NOT NULL`,
    )
    .all() as Array<{
    wallet: string;
    mint: string;
    symbol: string | null;
    side: string;
    mcUsd: number | null;
    blockTime: string;
  }>;
  for (const r of rows) {
    const blockTimeMs = Date.parse(r.blockTime);
    if (Number.isNaN(blockTimeMs)) continue;
    const out: CorpusBuy = {
      wallet: r.wallet,
      mint: r.mint,
      symbol: r.symbol,
      side: r.side,
      mcUsd: r.mcUsd,
      blockTimeMs,
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
  }
  db.close();
}

async function loadJsonl(path: string): Promise<CorpusBuy[]> {
  const text = await Bun.file(path).text();
  const out: CorpusBuy[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) out.push(JSON.parse(t) as CorpusBuy);
  }
  return out;
}

interface GridCell {
  windowMin: number;
  hitMultiplier: number;
  signals: number;
  hits: number;
  multipliers: number[];
}

function replay(buys: CorpusBuy[], windows: number[], multipliers: number[]): GridCell[] {
  // Group buys by mint, sorted by time.
  const byMint = new Map<string, CorpusBuy[]>();
  for (const b of buys) {
    const arr = byMint.get(b.mint);
    if (arr) arr.push(b);
    else byMint.set(b.mint, [b]);
  }
  for (const arr of byMint.values()) arr.sort((a, b) => a.blockTimeMs - b.blockTimeMs);

  const cells: GridCell[] = [];
  for (const windowMin of windows) {
    for (const hitMultiplier of multipliers) {
      const cell: GridCell = { windowMin, hitMultiplier, signals: 0, hits: 0, multipliers: [] };
      for (const [, evs] of byMint) {
        // Detection: the first buy at which >=2 distinct wallets fall inside
        // the trailing window. One signal per mint per replay (mirrors the
        // open-signal-per-mint uniqueness of the live engine).
        let detectedAt: number | null = null;
        let callMc: number | null = null;
        const events: BuyEvent[] = evs.map((e) => ({
          wallet: e.wallet,
          tradedAtMs: e.blockTimeMs,
        }));
        for (let i = 0; i < evs.length; i++) {
          const asOf = evs[i]!.blockTimeMs;
          if (walletsInWindow(events, asOf, windowMin).length >= 2) {
            detectedAt = asOf;
            callMc = evs[i]!.mcUsd;
            break;
          }
        }
        if (detectedAt === null) continue;
        // ATH proxy: highest observed market cap among this mint's buys from
        // detection onward.
        let athMc: number | null = null;
        for (const e of evs) {
          if (e.blockTimeMs >= detectedAt && e.mcUsd !== null) {
            athMc = athMc === null ? e.mcUsd : Math.max(athMc, e.mcUsd);
          }
        }
        const r = computeOutcome({
          callMc,
          safeCallMc: callMc,
          currentMc: athMc,
          priorAthMc: null,
          hitMultiplier,
        });
        cell.signals++;
        if (r.isHit) cell.hits++;
        if (r.athMultiplier !== null) cell.multipliers.push(r.athMultiplier);
      }
      cells.push(cell);
    }
  }
  return cells;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--export") {
    const path = args[1];
    if (!path) throw new Error("usage: replay.ts --export <sqlite-path>");
    exportFromSqlite(path);
    return;
  }
  const jsonl = args[0];
  if (!jsonl) throw new Error("usage: replay.ts <buys.jsonl>  |  replay.ts --export <sqlite>");
  const buys = await loadJsonl(jsonl);
  const cells = replay(buys, [10, 15, 30, 60], [2, 3, 5]);
  console.log(`corpus: ${buys.length} buys\n`);
  console.log("window  mult  signals  hits  hit%   medianX  maxX");
  for (const c of cells) {
    const hitPct = c.signals ? ((100 * c.hits) / c.signals).toFixed(1) : "0.0";
    const maxX = c.multipliers.length ? Math.max(...c.multipliers).toFixed(1) : "0.0";
    console.log(
      `${String(c.windowMin).padStart(5)}m  ${String(c.hitMultiplier).padStart(3)}x  ` +
        `${String(c.signals).padStart(7)}  ${String(c.hits).padStart(4)}  ` +
        `${hitPct.padStart(5)}  ${median(c.multipliers).toFixed(2).padStart(7)}  ${maxX.padStart(6)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
