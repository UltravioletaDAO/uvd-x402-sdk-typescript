# Changelog

All notable changes to `uvd-x402-sdk` are documented here, starting at v2.47.0.
For earlier versions see the git history (each release commit carries its
version in the subject, e.g. `feat(stats): ... (v2.46.0)`).

## [2.70.0] - 2026-08-23

### Added

- **`prepareRelayedFeedback()` + `submitRelayedFeedback()`: ratings the CHAIN
  attributes to the rater, not to the facilitator.**

  The ERC-8004 Reputation Registry records `msg.sender` as the author and the
  deployed implementation has no delegation path -- no
  `giveFeedbackWithSignature`, no ERC-2771 forwarder. So every rating relayed
  through `submitFeedback()` is a rating authored by the FACILITATOR. That is
  not a theoretical concern: 87,2% of the reputation on Base (1.384 of 1.587
  feedbacks) is attributed to one wallet, and the same wallet can revoke any of
  it.

  EIP-7702 closes it without touching the registry: the rater delegates their
  own EOA to a `FeedbackDelegate` and the transaction is sent TO THE RATER'S
  ADDRESS, so the registry sees the rater while the facilitator still pays the
  gas. `prepare` hands back the digest, deadline, single-use nonce and -- when
  the account is not delegated yet -- the account nonce for the EIP-7702
  authorization. `submit` relays it.

  The feedback parameters are repeated on `submit` on purpose: the facilitator
  rebuilds the registry calldata from them and requires the rater's signature to
  cover exactly that. It does not relay calldata it was handed.

- **`RELAYED_FEEDBACK_NETWORKS` + `supportsRelayedFeedback()`** so a caller can
  route without paying a round trip for a 400. Nine networks: the eight mainnets
  Execution Market deployed a delegate on (base, ethereum, polygon, arbitrum,
  optimism, celo, bsc, monad) plus base-sepolia. It is a routing hint -- the
  facilitator re-checks the delegate on-chain on every request.

  `avalanche` is absent and is not waiting to join: its C-Chain rejects the
  transaction type itself (`-32000 transaction type not supported`), so there is
  nothing to deploy against. Anchor the rating on a chain that supports
  EIP-7702; the payment stays where it was made.

### Deprecated

- **`submitFeedback()`** where a delegate exists. It still works and is not
  going away without notice -- it is the only route available where no delegate
  is deployed -- but on those nine networks it writes the facilitator's address
  into somebody else's reputation.

Requires facilitator v1.93.0 or later for the mainnet networks; base-sepolia has
served this rail since v1.74.0.

## [2.67.0] - 2026-08-20

### Fixed

- **`settle()` reported success whenever the HTTP call succeeded.** The returned
  object carried the literal `success: true`, so the facilitator's own verdict
  was never read — even though the line above it already consulted
  `result.success` for a warning.

  "The request arrived" is not "the money moved", and the gap is not
  hypothetical: a transfer that mines and then REVERTS is answered with HTTP 200
  and `success: false` (x402-rs `src/chain/evm.rs:1343`, serialised through
  `StatusCode::OK`). Every consumer written as `result.success === true` was
  therefore reading a constant, so a reverted payment was booked as settled and
  the reconciliation paths built to catch exactly that could never fire.

  Now `success: result.success === true`. A response with no `success` field is
  treated as **not** successful: a facilitator that does not say it worked has
  not said it worked.

  Found while adopting DX402 in MeshRelay, where `settle_status: 'settle_failed'`
  turned out to be unreachable in two services.

### Added

- **`errorReason`, `payer` and `proofOfPayment` on `SettleResponse`.** `settle()`
  rebuilt its return value field by field and dropped everything else the
  facilitator sent.

  `proofOfPayment` is the consequential one: `anchorEvidence` documents it as
  *"the only thing that reaches `verified: true`"*, the facilitator returns it
  when the ERC-8004 extension asks for one, and this client threw it away. A
  seller using the SDK end to end could therefore only ever produce
  **provisional** anchors — which a gate-verified anchor can supersede. Read in
  both `camelCase` and `snake_case`.

  `errorReason` is what separates a reverted transfer from a rejected
  authorization without parsing prose. It is distinct from `error`: `error` is
  this client failing to ask, `errorReason` is the facilitator answering no.

## [2.53.0] - 2026-08-09

### Added

- **`asyncTransport` on `registerAgent`.** Execution Market migrated to async
  registration, and 2.52.0 made that a breaking change at the call site:
  `registerAgent` returns `RegisterAgentResponse` (with `agentId`),
  `registerAgentAsync` returns `RegisterJobResponse` (without one yet).

  `registerAgent(request, { asyncTransport: true })` changes the transport, not
  the contract: it starts with `Prefer: respond-async`, polls, and returns the
  same `RegisterAgentResponse`. Caller code is unchanged and gains immunity to
  proxy timeouts, because each request is short instead of one held open for the
  whole mint.

- **`RegistrationPendingError`, carrying `jobId` as a field.** What makes the
  above safe rather than merely convenient. A timeout is not a failure — the mint
  may still land — and a caller who cannot reach the job id without parsing a
  string will re-register instead. That is the sequence that once produced five
  duplicate mints. For the same reason the timeout throws rather than resolving
  `success: false`.

## [2.52.1] - 2026-08-09

### Fixed

- **A 409 from `registerAgent` no longer discards the facilitator body.** The
  in-flight lock answers a synchronous register with 409 and a structured
  `RegisterAgentResponse` carrying the agent id and tx of the run ALREADY
  underway, plus a "poll GET /register/status/{jobId}" hint. That was flattened
  into `Facilitator error: 409 - <text>`, leaving the caller with a bare failure
  — precisely the shape that invites a retry, and retrying a mint is how
  duplicate agents get created. The parsed body is returned instead, with
  `success` forced to `false` so a 4xx can never claim otherwise. A 400 now
  surfaces the facilitator's own message; a non-JSON error still degrades to the
  flattened string.

## [2.52.0] - 2026-08-08

### Added

- **Async registration: `registerAgentAsync`, `getRegisterStatus`,
  `waitForRegistration`.** The facilitator has offered this since v1.48.0 and no
  SDK exposed it.

  A synchronous register waits on a mint receipt, which on a congested chain
  outlives client and proxy timeouts. The timed-out call is genuinely ambiguous —
  the mint may well have landed — and retrying it is how five duplicate agents
  once got minted. The async flow hands back a job id instead of a guess.

  `waitForRegistration` rejects on timeout rather than resolving the last
  non-terminal status, so "still pending" is never read as "did not happen", and
  the message says to keep polling rather than re-register.

- **`RegisterJobResponse` / `RegisterJobStatus` / `isRegisterJobTerminal`.**
  `mint_confirmed` already carries an `agentId` but is not terminal.

## [2.51.0] - 2026-08-08

### Added

- **`Erc8004LookupError`, thrown by `getIdentityByOwner` with the status as a
  field.** The facilitator answers 404 for "this address owns no agent" and 503
  for "I could not find out". `notFound` and `retryable` separate them.

  This matters on a registration path: a caller that reads a 503 as absence
  mints a second agent for an owner who already has one, burning gas and leaving
  an orphan. The method used to throw a bare `Error` with the status
  interpolated into the message, so telling the two apart meant parsing a string.

- **Solana support in `getIdentityByOwner`.** Facilitator v1.72.0 answers the
  route for SVM; before that it was EVM-only and returned 400. No SDK shape
  change was needed — verified against the live mainnet response.

## [2.50.0] - 2026-08-07

### Added

- **`score` on `FeedbackParams`.** On Solana the ATOM Engine ignores an unscored
  feedback: it is written to the agent, but contributes nothing to reputation and
  the program reports `had_impact=false`. Not retroactive — reputation stays at
  zero however much unscored feedback accumulates. The facilitator could not send
  it either until v1.70.3, so nobody's Solana reputation was ever being scored.

- **`AtomStats`, exposed on `ReputationResponse.atomStats`.** The facilitator has
  returned this for Solana since v1.70.2; the SDK had no type for it. The engine
  measures quality through EMA scores, so there are no positive/negative tallies:
  the fields are `trustTier`, `qualityScore`, `loyaltyScore`, `confidence`,
  `riskScore`, `diversityRatio`, `min/max/lastScore`, `feedbackCount` and
  `lastFeedbackSlot`.

- **`originalFeedback` on `revokeFeedback`.** Solana revocations need the SEAL
  hash of the feedback being revoked. Pass the original content and the
  facilitator derives it; computing it yourself means reimplementing the
  program's keccak256 layout exactly. `sealHash` still works and wins.

- **`numMinted` and `collection` on `IdentityTotalSupplyResponse`.** On Solana
  the counts come from the Metaplex Core collection, not the registry, which
  keeps no counter: `totalSupply` is the collection's current size (net of
  burns), `numMinted` its all-time count.

- **`immutable` on `IdentityMetadataResponse`.**

### Fixed

- **`IdentityMetadataResponse.valueHex` never existed on the wire.** The
  facilitator sends the hex value as `value`. The field was typed as `valueHex`,
  so it read `undefined` at runtime for every metadata lookup ever made. Renamed
  to `value`.

## [2.49.0] - 2026-08-06

### Added

- **`uvd-x402-sdk/erc8128` — one signer and one verifier for the whole fleet.**
  ERC-8128 signing was copy-pasted across four projects and verification
  existed only as two independent server implementations that had never been
  compared. They had diverged: one rejected the canonical `alg="eip191"`
  parameter every current signer emits, and the two disagreed on how
  `@authority` is derived. This module is the single implementation both
  languages now share, published to npm and PyPI from the same conformance
  vectors.

  - `signRequest` / `verifyRequest`, plus the pure primitives underneath
    (`parseSignatureInput`, `buildSignatureBase`, `canonicalAuthority`).
  - `NonceStore` is pluggable, so a server-issued single-use store and the
    client-chosen first-use model are both expressible.
  - `POLICY_PRESETS` (`meshrelay-strict`, `em-lenient`, `canonical-strict`)
    carry the nonce ordering with them, so adopting a posture cannot silently
    flip it. `canonical-strict` pins the chain — a preset named "strict" that
    accepts any chain is not strict.
  - The verifier never re-serialises `@signature-params`: it takes the
    parameter substring verbatim from the header, so a parameter added to the
    wire tomorrow verifies through the same byte path instead of 401-ing.
  - `@authority` normalisation (lowercase, scheme's default port dropped)
    applies only where the scheme is known. The **configured** policy authority
    is validated but never re-normalised — guessing a scheme for it silently
    breaks `https` on `:80` and `http` on `:443`.
  - Conformance vectors ship **inside** the package and are byte-identical to
    the Python ones; a cross-language test signs in each runtime and verifies in
    the other, and fails loudly rather than skipping when one is absent.

### Fixed

- **A rejected verification no longer reports a `wallet`.** The Python verifier
  returned the address the client wrote into its keyid on the failure path,
  where nothing had checked it against the recovered signer — attacker-supplied
  input in a field named `wallet`, one forgotten `if (!result.ok)` away from
  being treated as an authenticated principal. Both languages now return no
  wallet on any rejection.

## [2.48.0] - 2026-08-03

### Added

- **Token metadata in the EVM payload** (`includeTokenMetadata`): an EIP-3009
  authorization is signed against a token contract, but the encoded payload
  only carried `{signature, authorization}` — a EURC payment and a USDC payment
  on the same chain produced indistinguishable headers, so a resource accepting
  several stablecoins could not rebuild `paymentRequirements` (`asset` +
  the `extra` EIP-712 domain) and the facilitator could not settle. Opt in via
  `EVMProvider.encodePaymentHeader(payload, chain, version, {includeTokenMetadata: true})`
  or `new X402Client({includeTokenMetadata: true})` and the payload carries
  `token: {address, symbol, decimals, eip712:{name, version}}`. Off by default:
  every existing header stays byte-identical. Unknown token addresses throw
  rather than emitting a guess. New `getTokenByAddress` / `buildTokenMetadata`
  resolve an address back to its registry entry.
- **BSC** in the chain registry, `enabled: false` on purpose — Binance-Peg USDC
  does not implement ERC-3009 `transferWithAuthorization`, so the exact scheme
  cannot settle it. The entry exists so its **18 decimals** are on record;
  assuming the usual 6 mis-prices a payment by 12 orders of magnitude.

### Fixed

- **`X402Client.createPayment` always charged USDC**, silently ignoring
  `paymentInfo.tokenType` — it read `chain.usdc` for the EIP-712 domain, the
  decimals and the payload's `token` field, so asking for EURC signed a USDC
  authorization. It now resolves the token through `getTokenConfig`, matching
  what `EVMProvider.signPayment` already did, and throws when the token is not
  supported on the chain.
- **`btoa()` cannot encode the payload of a USDT payment**: the EIP-712 domain
  name of USDT on Optimism, Arbitrum and Monad is `USD₮0` (U+20AE), and
  `btoa()` throws on any code point above 255. Every header the SDK emits now
  goes through a UTF-8 safe encoder (`encodeBase64Json`), and
  `decodeX402Header` reverses it. Byte-identical to the old output for ASCII
  input, so no existing header changes.

## [2.47.0] - 2026-07-31

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
