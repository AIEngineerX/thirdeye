// Curated seed list of known Solana entity addresses.
// Sourced from public block-explorer label DBs (Solscan, SolanaFM) as of 2026-05.
// Conservative — we only include addresses verified by ≥ 2 explorers.

export const EXCHANGE_HOT_WALLETS: ReadonlySet<string> = new Set([
  // Binance
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S",
  // Coinbase
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS",
  "GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE",
  "FxteHmLwG9nk1eL4pjNve3Eub2goGkkz6g6TbvdmW46a",
  // Kraken
  "FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5",
  // OKX
  "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD",
  "6QJzieMYfp7yr3EdrePaQoG3Ghxs2wM98xSLRu8Xh56U",
  // Bybit
  "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2",
  "42brAgAVNzMBP7aaktPvAmBSPEkehnFQejiZc53EkpFq",
  // Gate.io
  "u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w",
  // KuCoin
  "BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6",
  // Crypto.com
  "6Y5o5p3Rf78uhYGmyYjHsQNd6gcGCXk8Yi7y7ihYM2dV",
  // MEXC
  "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",
]);

// Launchpad fee/router accounts that fan out funding to launched-token wallets.
// Sibling presence here is NOT a sybil signal — it just means "both wallets bought
// from the same launchpad". Excluded from cluster detection.
export const LAUNCHPAD_FUNDERS: ReadonlySet<string> = new Set([
  // Pump.fun
  "GTHj9YqAVGcLR6vDrHk8b5ie8NPN8eUXKMuAqFyU2yK",
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg",
  // Moonshot
  "MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG",
  // LetsBonk
  "BonKa1xTskbMfsa8QJSAR5EdrqW8TkPg1pTpyhYnQQDb",
]);

// Reserved for Phase 3 (Scan Token).
export const CEX_PROGRAM_IDS: ReadonlySet<string> = new Set([]);

export function isExchangeAddress(addr: string | null | undefined): boolean {
  return addr ? EXCHANGE_HOT_WALLETS.has(addr) : false;
}

export function isLaunchpadFunder(addr: string | null | undefined): boolean {
  return addr ? LAUNCHPAD_FUNDERS.has(addr) : false;
}

// Funding chain stops on exchange OR launchpad funder.
export function isTerminalFunder(addr: string | null | undefined): boolean {
  return isExchangeAddress(addr) || isLaunchpadFunder(addr);
}
