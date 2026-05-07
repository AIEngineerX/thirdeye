// Override via THIRDEYE_TEST_WALLET env var; default chosen for rich on-chain history.
export const FIXTURE_WALLET =
  process.env.THIRDEYE_TEST_WALLET ?? "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1";

export const FIXTURE_INVALID_ADDRESS = "not-a-real-addr";
