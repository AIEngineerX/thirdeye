// Stable test fixtures for Helius integration tests.
// Override via THIRDEYE_TEST_WALLET env var if a different wallet is preferred.
//
// Default chosen for richness — the prior fixture (BLwT…) was too quiet
// (type:unknown, 404 funded-by, empty balances) to exercise the real
// pipeline. This one has:
// - identity 200 with SNS domain (tests domain enrichment path)
// - balances 200 with ~100 token rows + ~$34k usd at probe time (tests the
//   flat-balances parser shipped in efc050c — the bug that hid behind the
//   old fixture's empty response)
// - funded-by 200 with a known funder + timestamp (tests funding-chain
//   trace beyond the trivial 0-hop case)
// - real tx history (tests txPattern/avgGapSec/swapOnly heuristics)
// Verified live 2026-05-06; if the wallet ever goes inactive, override
// via THIRDEYE_TEST_WALLET to a comparable rich-history wallet.
export const FIXTURE_WALLET =
  process.env.THIRDEYE_TEST_WALLET ?? "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1";

export const FIXTURE_INVALID_ADDRESS = "not-a-real-addr";
