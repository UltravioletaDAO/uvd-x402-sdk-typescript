# Changelog

All notable changes to `uvd-x402-sdk` are documented here, starting at v2.47.0.
For earlier versions see the git history (each release commit carries its
version in the subject, e.g. `feat(stats): ... (v2.46.0)`).

## [2.79.0] - 2026-09-04

### Fixed

- **The top-level `x402Version` now names the ENVELOPE, not the payer.**
  `buildVerifyRequest` / `buildSettleRequest` copied
  `paymentHeader.x402Version` into the top level of the **v1** envelope, so a
  buyer who declared `2` -- legal, and what this SDK's own 402 invites as soon
  as it advertises CAIP-2 -- produced a body saying `2` around a
  `paymentRequirements`, which is the v1 shape.

  It was served correctly then and still is: the facilitator's envelope enum is
  untagged and matches on shape. But the facilitator already reads that marker
  for one thing -- picking the hint in its `400`:

  > `This body declares \`x402Version: 2\`. x402 v2 is a JSON object with
  > \`paymentPayload\`, \`resource\` and \`accepted\`...`

  So the first time such a body failed for an unrelated reason, the diagnosis
  sent the integrator to fix the wrong shape. Being sent to the fields when the
  wrapper is what is wrong is the inversion that cost two teams a day.

  The payer's own marker is untouched: it stays in `paymentPayload.x402Version`,
  where it describes the payment rather than the envelope carrying it.

  Found by the Python SDK's cross-SDK comparison (0.74.0): it was the **only**
  body difference left between the two SDKs on the same wire.

- **`'auto'` no longer throws on a v2 payload — the very shape it exists to
  route.** `resolveEnvelopeVersion` read only `paymentHeader.network`. A v1
  header carries one at the top level; a **v2 payload carries none at all**
  (`PaymentPayloadV2` has no top-level network — v2 moved the chain id into
  `accepted`). So on a real v2 payload the default threw

      TypeError: Cannot read properties of undefined (reading 'includes')

  before deciding anything. It now reads the network wherever the payload keeps
  it — top level, else `accepted.network` — and treats a missing one as "no
  CAIP-2 evidence" rather than as a crash. The parameter widens to
  `X402Header | PaymentPayloadV2`, which is what it actually receives.

  Measured in runtime against 2.78.0 by MeshRelay, whose turnstile and multibrain
  pin `x402Version` explicitly to work around it: our own default was the one
  option nobody could use.

- **A network with no CAIP-2 form now refuses the v2 envelope instead of
  emitting a body the facilitator rejects.** `toPaymentRequirementsV2` returned
  `network: 'xrpl-mainnet'` inside a v2 body: `chainToCAIP2` answers with the
  name unchanged for a chain it does not know, and XRPL maps to *itself* on
  purpose -- its v1 string IS its network id. A plain name inside a v2 body is a
  measured `400`, and the doc comment three lines above said so. It now throws,
  naming the network and the escape (`x402Version: 1`), which the facilitator's
  `data did not match any variant of untagged enum` does not.

  Only reachable by **pinning** version 2 on such a network; `auto` leaves them
  on v1, where they work. Found by phase 6 of the cross-language conformance
  run, below.

### Changed

- **`resolveEnvelopeVersion`'s measured table was out of date and is corrected.**
  It published three rows as a hard `400` (`unknown variant \`eip155:8453\``),
  measured 2026-09-03, and built the rule's justification on them: "every CAIP-2
  combination is already a 400, so upgrading them cannot regress anyone". The
  facilitator has since taught the v1 envelope to read CAIP-2. Re-measured
  2026-09-04 against production: all five rows are understood.

  The rule is unchanged — still CAIP-2, still ignoring the marker — but the
  comment now carries the three reasons that actually hold it up, and the note
  that with a fabricated signature the HTTP status discriminates nothing
  (`invalid_request_body` vs `contract_call_failed` is what does). No behaviour
  change.

- **`VerifyRequest.x402Version` and `SettleRequest.x402Version` are typed `1`,
  not `X402Version`.** These interfaces *are* the v1 envelope
  (`VerifyRequestV2` is the other one), so a `2` there was always an
  uninhabitable value -- and typing it `1 | 2` is what let the payer's marker be
  copied in. If you were building one of these by hand from a `1 | 2` variable,
  write `1`, or call `buildVerifyRequestForVersion` and let it choose.

### Added

- **Phase 6 of the cross-language conformance run (`npm run test:xlang`): the
  request envelope.** The run that exists to keep the two SDKs from diverging
  passed with 266 checks while never mentioning the envelope in any of its three
  files -- and the envelope is where they actually diverged. Both SDKs now
  choose and build the `/verify` and `/settle` bodies for 12 wires, and the
  driver compares the chosen version and both bodies key for key, plus a shape
  rule of its own so that two SDKs agreeing on a self-contradictory body still
  fails. 266 -> 333 checks.

  Requires the Python SDK at **0.74.0+** (`uvd_x402_sdk.envelope`); an older
  checkout fails with the fix named rather than skipping.

## [2.78.0] - 2026-09-03

### Added

- **`FacilitatorClient` picks the payment envelope instead of always sending
  v1.** The v2 builders have been in this file since v2.44.0
  (`buildVerifyRequestV2` / `buildSettleRequestV2`, shape verified against
  production on 2026-07-29 and re-verified on 2026-09-03 — still exactly what it
  accepts). Nothing could reach them: `verify()` and `settle()`
  called the v1 builder unconditionally, and those two methods are what
  `createPaymentMiddleware`, `createHonoMiddleware`, `verifyAndSettle` and every
  seller integration go through. So the SDK could *describe* v2 and could not
  *speak* it, and each consumer had to hand-port the v2 body. MeshRelay was
  copying it out of its own Turnstile service when this was written; that is the
  signal the defect was ours, not theirs.

  This is not a corner case, because **this SDK advertises v2 on its own**:
  `createHonoMiddleware` calls `resolveAdvertisedVersion`, which returns 2 as
  soon as there are two accepts or any accept carries a CAIP-2 id, and the 402
  then goes out saying `x402Version: 2` with `network: eip155:8453`. A buyer who
  did exactly what that 402 said got a `400` back. The seller's own paywall was
  unpayable and neither side could see why: the facilitator's envelope enum is
  untagged, so the refusal is `data did not match any variant of untagged enum
  VerifyRequestEnvelope`, which names no field.

  The SDK's own suite had this pinned as correct —
  `src/backend/index.test.ts` asserted the verify body carried
  `paymentRequirements.network === 'eip155:1'`. Measured against production on
  2026-09-03, that exact body is a `400`. A stubbed `fetch` never noticed.

- **`resolveEnvelopeVersion`, `buildVerifyRequestForVersion`,
  `buildSettleRequestForVersion`, `toResourceInfoV2`, `toPaymentRequirementsV2`.**
  The conversion from the v1-shaped `PaymentRequirements` every part of this SDK
  already builds into v2's `{resource, accepted}` pair. This is what "the
  consumer writes no code" means in practice: they keep passing the
  `PaymentRequirements` they have.

  Three renames do the damage, and the facilitator reports none of them by name:
  `maxAmountRequired` becomes `amount`; `network` must be CAIP-2; and
  `resource`/`description`/`mimeType` move out into a `resource` OBJECT — all
  three keys required, a bare URL string is a `400`. `extra` is carried through,
  because that is where the EIP-712 domain lives for tokens the facilitator does
  not know by address (EURC, the bridged USDCs); dropping it makes them
  unpayable.

### Changed

- **`FacilitatorClientOptions.x402Version`** — `1`, `2` or `'auto'`
  (default). The version is chosen, never imposed: a pin is honoured even when
  it contradicts the wire.

  **`'auto'` keys off CAIP-2, NOT off `paymentHeader.x402Version`**, and that is
  a measured decision, not a stylistic one. The facilitator matches on SHAPE and
  ignores the version marker. Measured against
  `https://facilitator.ultravioletadao.xyz/verify` on 2026-09-03
  (facilitator 2.10.0), v1 envelope:

  | payload network | requirements network | today |
  |---|---|---|
  | `base` | `base` | **200** |
  | `base`, header marker says `x402Version: 2` | `base` | **200** |
  | `eip155:8453` | `base` | 400 |
  | `base` | `eip155:8453` | 400 |
  | `eip155:8453` | `eip155:8453` | 400 (`unknown variant \`eip155:8453\``) |

  A header that merely *declares* version 2 while carrying plain names is being
  served correctly today, so upgrading it on the strength of the marker would
  change a call that works. Every CAIP-2 combination is already a hard `400`, so
  switching those to v2 cannot regress anyone — it can only turn a failure into
  a payment. That is the whole safety argument for making this a minor rather
  than a major: **no request that succeeds today changes shape.**

  XRPL stays on v1 by the same rule and correctly so — `xrpl-mainnet` has no
  CAIP-2 form, its v1 string is its network id.

- `buildVerifyRequest` / `buildSettleRequest` are untouched and still emit v1
  with their exact existing return types. Widening them to a union would have
  broken every TypeScript consumer for no gain; the version-aware builders are
  additive instead.

## [2.76.0] - 2026-08-31

### Fixed

- **A `503` from the facilitator was reported as a rejected payment, which makes
  the buyer pay twice.** `402` and `503` say opposite things: `402` is "the
  payment was REFUSED, sign a new authorization", `503` is "no verdict was
  reached, resend the SAME credential". Every facilitator edge in this SDK
  flattened both into `success: false` plus an English sentence — so a caller
  could not tell them apart, and the correct-looking reaction to the sentence
  ("ask the buyer to sign again") charges them a second time for money that was
  never refused. The first authorization stays perfectly spendable.

  This is not hypothetical. Between 2026-08-29 and 2026-08-31 the facilitator's
  `min_capacity` went 1 -> 2 and autoscaled to 3, and refusing rather than
  forwarding turned the EVM writer lease into a permanent two-in-three failure
  rate: **582 settle-path and 132 ERC-8004 rejections in a single six-hour
  window**, every one of them a `503` with a valid signature behind it.

  Every response type now carries `status`, `reason`, `retryable`,
  `retryAfterSeconds` and `safeToReplay`: `VerifyResponse`, `SettleResponse`,
  `verifyAndSettle`, `FeedbackResponse`, `RegisterAgentResponse`,
  `AdvancedTransactionResult`. `Erc8004LookupError` exposes the same as getters
  and its `retryable` now covers `429`/`502`/`504` alongside `503`.

- **`refundViaFacilitator` had no non-2xx branch at all.** It called
  `response.json()` straight through, so a `503` body parsed cleanly,
  `result.success` came back `undefined`, and a refund the facilitator never
  attempted was reported as failed — an escrow declared lost while every token
  was still in it. It now reports the refusal and, like `releaseViaFacilitator`,
  names the status when the body carries no reason.

- **The claim that only the payer can recover an expired escrow is false, and it
  is in this repo three times.** `AuthCaptureEscrow.partialVoid` is
  `onlySender(paymentInfo.operator)` — the operator is the **facilitator** — it
  sends the tokens **to the payer**, and it **never reads
  `authorizationExpiry`**. `reclaim` is the payer-only, post-expiry path, which
  is why the facilitator does not expose it — not the only exit. So a release
  that reverted with `AfterAuthorizationExpiry` is recoverable through
  `refundViaFacilitator` with no gas and no payer, and the belief that it was
  not is why stuck escrows were written off. Corrected in `buildPaymentInfo`, in
  `escrow-release-window.test.ts`, and documented in the README with the
  `queryEscrowState` -> `capturableAmount` recipe.

### Added

- **`upload`: bring your own storage for DX402 anchors.** The facilitator has
  accepted two anchor shapes since v0.1 — `sealed` (the ciphertext rides in the
  request and it hosts the blob) and `pointer` (the seller stored it and sends
  only the locator). Both SDKs implemented only the first, so an integrator
  could not use their own storage at all and their body had to fit inside an
  anchor request.

  `upload` is a **callable, not a precomputed pointer**, for the same reason
  `sign` is one: the SDK must seal first — the buyer has to be able to decrypt —
  and only then is there anything to upload.

  ```ts
  await anchorEvidence(body, {
    ...opts,
    upload: async (sealed) => {        // the SEALED bytes, never the plaintext
      await myBucket.put(key, sealed);
      return `s3+https://cdn.example.com/${key}`;
    },
  });
  ```

  The request then carries only the pointer, so the request-size bound does not
  apply to the body. Three properties are load-bearing:

  - **Sealing still happens.** The buyer decrypts with the key they paid with.
  - **The signature covers YOUR pointer.** The facilitator verifies against
    `req.pointer` when present and `""` when absent, so `anchorEvidence` signs
    the pointer it sent. Signing `""` next to a real pointer throws nothing and
    leaves the anchor permanently *provisional* — the state anyone can supersede.
    `sellerDigestFor` takes the pointer as an optional fifth argument.
  - **A failed upload is a skip, never a failed sale.** A throw or an empty
    pointer yields `skipped: 'anchor_failed'` with `stage: 'upload'`.

  `backend` is inferred from the pointer scheme (`ipfs://`, `ar://`, otherwise
  `s3`) and can be set explicitly.

- **Bounded, opt-out automatic retry.** A refusal the facilitator *proved* it did
  not execute is replayed with the identical request — no re-signing, ever.
  `retries` (default 2 extra attempts, `0` disables) on `FacilitatorClient`,
  `Erc8004Client`, `AdvancedEscrowClient` and both middlewares.

  The five writer-lease reasons do **not** share retry semantics, which is the
  whole point of surfacing them:

  | `reason` | did the write run? | replayed? |
  |---|---|---|
  | `holder_unknown` | no | yes |
  | `forwarding_disabled` | no | yes |
  | `forwarded_but_not_writer` | no | yes |
  | `body_unreadable` | no | yes |
  | `forward_failed` | **maybe** | **never** |

  `forward_failed` is emitted *after* the write was handed to the lease holder,
  so it is a timeout wearing a status code. It is never replayed at any setting;
  resolve it by reading state (`getIdentityByOwner`, honouring its 404-vs-503
  distinction, or `getRegisterStatus`). Re-POSTing an ambiguous mint is what once
  created five duplicate agents.

- New exports: `readFacilitatorError`, `facilitatorFetch`,
  `isReplayableLeaseReason`, `isAmbiguousLeaseReason`, `parseRetryAfterSeconds`,
  `WRITER_LEASE_REASONS`, `REPLAYABLE_LEASE_REASONS`,
  `AMBIGUOUS_LEASE_REASONS`, `MAX_RETRY_AFTER_SECONDS`,
  `DEFAULT_RETRY_AFTER_SECONDS`, `DEFAULT_FACILITATOR_RETRIES`, and the types
  `FacilitatorErrorInfo`, `FacilitatorFailureFields`, `FacilitatorFetchOptions`,
  `WriterLeaseReason`.

### Changed — behaviour, not signatures

Nothing public was removed or renamed; every new field and option is optional.
Two behaviours did move, deliberately:

- **The middlewares answer `503` + `Retry-After` where they previously answered
  `402` (verify) or `500` (settle)** — but only when the facilitator reached no
  verdict. A genuine rejection is still `402`, and a genuine settlement failure
  is still `500`. A client that treated the old `402` as "sign again" was being
  told to double-charge.
- **`verify()` and `settle()` may now make up to two extra attempts**, adding
  latency on a facilitator that is refusing. `Retry-After` is honoured only up to
  `MAX_RETRY_AFTER_SECONDS` (15) — a misconfigured `Retry-After: 3600` would
  otherwise hang the caller for an hour inside a function documented as
  returning promptly. Pass `retries: 0` for the old timing.

## [2.72.0] - 2026-08-25

### Added

- **EIP-7702 delegated accounts: `src/erc7702.ts`.** Python has known since
  0.6x which signing dialect a delegated payer needs; TypeScript had nothing.
  That gap stopped being theoretical the moment the facilitator's rater-authored
  feedback rail went live: **an account that rates gets delegated to Execution
  Market's `FeedbackDelegate`**, and from then on it is a smart account for every
  future payment.

  Exports `delegateTarget`, `needsAccountWrap`, `resolveDelegation`,
  `isDelegated`, `rpcDelegationResolver`, `wrapSignature`, `replaySafeTypedData`,
  `SMA_WRAP_TARGETS`.

- **`buildEscrowPreAuth` takes an optional `delegationResolver`.** With one, it
  picks the signing dialect from the delegate TARGET:

  | payer | signature |
  |---|---|
  | plain EOA | ordinary EIP-712 |
  | delegated to an Alchemy SMA | replay-safe hash + account envelope |
  | delegated to `FeedbackDelegate` (or any plain-1271 delegate) | ordinary EIP-712 |
  | delegation UNKNOWN, resolver supplied | **throws** |

  Without a resolver the behaviour is unchanged, so this breaks nobody.

### Why it matters

"Delegated" is not one signature scheme, and both mistakes are silent until the
payment fails on-chain:

- Signing **raw** for an Alchemy SMA reverts `0x151d90fe`. Measured: 14 of 14
  delegated payers failed their escrow lock (2026-07-31).
- **Wrapping** for a delegate that validates plain ECDSA is just as
  unsettleable — and `FeedbackDelegate` is exactly that. Applying the wrap to
  "any delegated account" means *the act of rating breaks the rater's next
  payment*. Found by Karma Kadabra and fixed in the Python SDK 0.67.0; this is
  the TypeScript half.

An UNKNOWN delegation is **not** "not delegated". `resolveDelegation` returns
`null` for an unreadable chain and `buildEscrowPreAuth` refuses rather than
guessing: collapsing the two is how the original bug survived eight days.

Vectors in `erc7702.test.ts` are generated by the Python SDK, not by this port —
a port compared only against itself proves nothing.

## [2.71.0] - 2026-08-25

### Fixed

- **The signing instructions in 2.70.0 were wrong, and no wallet signature could
  ever have worked.**

  `prepareRelayedFeedback()` returns a `digest` that ALREADY carries the EIP-191
  envelope — the facilitator recovers against it as a prehash, adding nothing.
  This README and these docstrings told you to `signMessage(prep.digest)`.
  `signMessage` / `personal_sign` applies the envelope itself, so the value got
  wrapped **twice** and recovered an address that was not the rater.

  The failure is silent by construction: the signature is well-formed, the
  request is well-formed, and the facilitator answers `relay_bad_signature` —
  which reads like the rater signed the wrong content, not like the client
  wrapped it twice. Measured against production on 2026-08-25: signing the
  digest recovered `0x98C5…7c97` for a rater whose address was `0x0B35…DcA5`.

  Found by Karma Kadabra reading the code before emitting anything, and
  confirmed independently on our side. Every wallet surface across three
  projects had the same bug.

### Added

- **`signingPayload` on `PrepareRelayFeedbackResponse`** — the same hash with the
  envelope still off. This is what a wallet signs:

  | how you sign | what you sign |
  |---|---|
  | raw key (prehash) | `digest` |
  | wallet `personal_sign` | `signingPayload` |
  | ✗ `personal_sign(digest)` | recovers a stranger |

  `keccak256('\x19Ethereum Signed Message:\n32' || signingPayload) === digest`,
  so a client can check the two against each other rather than rebuilding the
  preimage from `data`.

  Served by the facilitator from **v1.95.0**. Older facilitators omit it and the
  field is `undefined` — fail loudly rather than falling back to signing
  `digest` through a wallet, which is the broken path.

Requires facilitator v1.95.0+ for `signingPayload`. Raw-key signers were never
affected and need no change.

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
