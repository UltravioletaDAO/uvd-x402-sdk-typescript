# Handoff: c0-sdk-ts-near-registry

Base: origin/main f19902b (2.110.0). Release: 2.111.0. Branch:
`0xultravioleta/c0-sdk-ts-near-registry`. Interface reference: `registry-v1.md`,
registry v1 ABI at 651fa341. The external reference checkout was read only.

## Delivered API

`src/providers/near/registry.ts`, exported by the existing `/near` entry point:
registered targets, four wallet-selector builders, normal Ed25519 transaction
signing, nine injectable RPC views with complete response checks, typed outcome
codes, four strict NEP-297 events, exact reputation aggregation and display helpers.
`escrow.ts`, `events.ts` and `encoding.ts` are unchanged; the new module reuses the
existing signer interface, account/integer validation and Borsh primitives.
See `docs/near-registry.md` for usage, EM flow and the trust model.

Builders perform the checks possible without chain state. Duplicate registration,
missing identity, pending/duplicate feedback and actual storage cost remain contract
checks. Update uses the register deposit floor conservatively. FullAccess permission,
next nonce and recent block hash are caller responsibilities; the signer has no RPC.
No transaction was submitted, and no contract or package was deployed/published.

## Shared vector inputs

`src/providers/near/vectors/near-registry.json` contains compact args JSON, UTF-8 hex,
deposit/gas strings, normal SignedTransaction Borsh base64 for register and
feedback, and the four exact contract event strings with parsed envelopes.

- Network `near:mainnet`, receiver `registry.arras-escrow.near`, signer `payer.near`.
- Public deterministic Ed25519 seed: 32 bytes of `0x01`; public key derived from it.
- Nonce `1`; block hash: base58 encoding of 32 bytes of `0x02`.
- Register: `agent_uri=https://agente.example/card.json`, metadata absent, default gas/deposit.
- Feedback: escrow `v1.arras-escrow.near`, payment ID `11111111111111111111111111111111`,
  score 90, tag1 `quality`, tag2 `successRate`, URI `https://agente.example/f/1.json`,
  hash `ab` repeated 32 times, default gas/deposit.
- Revoke: same escrow and payment ID, 30 TGas and exactly one yoctoNEAR.

These are the dispatched inputs, without substitutions. Regenerate after a build
with `node scripts/xlang/generate-near-registry-vectors.mjs`; use `--check` to assert
no drift. Tests independently decode the Borsh transaction and verify signatures
with Node Crypto. Cross-checking these new registry vectors against the parallel
Python worker remains the coordinating session's task; the Python worker was not
modified.

## Verification and auto-refutation

Baseline Node 20.20.2/Python 3.11.4: 92 suites, 3638 tests passed, 75 skipped.
The first baseline attempt found a better-sqlite3 ABI mismatch; rebuilding that
dependency for Node 20 resolved it before implementation. OWS native tests are
skipped on unsupported Windows by the existing suite; Linux CI requires them.

The registry suite exercises exact URI/UTF-8/tag/payment/hash/score/deposit/gas
boundaries, uppercase/whitespace/null/Unicode cases, all builders and signing
revalidation, response shapes, events, outcomes and bigint summaries. The mutation
inventory is executable in `scripts/mutate-near-registry.mjs`: clean committed tree,
one edit at a time, 120-second timeout per process, git checkout restoration after
each edit. Final mutation and CI results are recorded in the PR verification table.
