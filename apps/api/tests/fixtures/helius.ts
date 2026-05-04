// Stable test fixtures for Helius integration tests.
// Override via THIRDEYE_TEST_WALLET env var if a different stable wallet is preferred.

export const FIXTURE_WALLET =
  process.env.THIRDEYE_TEST_WALLET ?? "BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNNz";

export const FIXTURE_INVALID_ADDRESS = "not-a-real-addr";
