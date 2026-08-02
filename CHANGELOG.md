# Changelog

All notable changes to `uvd-x402-sdk` are documented here, starting at v2.47.0.
For earlier versions see the git history (each release commit carries its
version in the subject, e.g. `feat(stats): ... (v2.46.0)`).

## [2.47.0] - Unreleased

### Added

- **ERC-8128 signed HTTP requests** (`src/erc8128.ts`): `signRequest`,
  `signRequestWithWallet`, `signRequestWithSigner`, `fetchNonce`, and the
  auto-signing `createSignedFetch` wrapper. Wire format pinned by the F3-1
  golden vectors (`src/erc8128.vectors.json`, byte-equality tests):
  `alg="eip191"` always emitted, keyid always lowercase
  (`erc8128:{chainId}:{address}`), params in the order
  `created;expires;nonce;keyid;alg`, `Content-Digest` sha-256 for bodies.
  `buildSignatureBase` / `buildSignatureParams` are exported so external
  signers can reproduce the exact signed bytes.
- **Escrow pre-auth builder** (`src/escrow-preauth.ts`): `buildEscrowPreAuth`
  signs the sign-on-assignment EIP-3009 `ReceiveWithAuthorization` that locks
  a bounty in the x402r AuthCaptureEscrow and packs it as the raw-JSON
  `X-Payment-Auth` wrapper for the facilitator's `/settle`. The nonce is
  `AuthCaptureEscrow.getHash(paymentInfo)` (payer-zeroed raw keccak — it
  commits to the receiver, exported as `computeEscrowNonce`). Fail-loud
  validation: incomplete network config, unknown tier, bounty above the
  on-chain deposit limit, or `maxFeeBps` below the operator's 1300 bps all
  throw before signing. Byte-parity with the Python SDK
  (`em_plugin_sdk.escrow_signing`) and Execution Market's dashboard/mobile
  suites is pinned by shared golden vectors
  (`src/escrow-preauth.vectors.json`).

### Fixed

- **`FacilitatorClient.settle` discarded the settle transaction hash**: the
  client read `transactionHash` / `transaction_hash`, but the facilitator
  emits the field as `transaction`, so `txHash` came back `undefined` on
  every successful settle. Now all three spellings are read (`transaction`
  first, as the canonical one) and a success response with no hash under any
  spelling logs a warning instead of failing silently.

### CI

- GitHub Actions pinned by commit SHA (`checkout`, `setup-node`) against
  npm supply-chain campaigns. Publishing still uses a long-lived `NPM_TOKEN`
  on purpose — migrating to trusted publishing requires linking the package
  to this repo/workflow from npmjs.com first (documented inline in the
  workflow).
