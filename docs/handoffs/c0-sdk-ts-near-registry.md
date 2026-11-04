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


Final registry coverage: 217 tests. Mutation results: **92/92 killed**, no timeout
kills and no surviving/invalid mutants (91 in the complete second pass, then M92
for the final config-u8 boundary). Initial survivors M21/M43/M50/M51/M58/M60 were
closed with explicit regressions; none was removed from the inventory. Typed
summary validation checks operator presence and type separately. The full suite,
build, lint, package smoke test and 512 existing TS/Python conformance checks were
run with Node 20; final counts and the pre-CI table are in the PR.

`git merge-tree` against open Nano PR #65 (shared package.json) completed without
conflicts. No other open SDK PR overlaps. Secret scanning of branch history and
the three-dot diff passed. No subagents were used, per the specific assignment.

### Mutation inventory

| ID | Guard | Result |
|---|---|---|
| M01 | URI maximum | KILLED |
| M02 | URI scheme first character | KILLED |
| M03 | URI scheme alphabet | KILLED |
| M04 | URI nonempty suffix | KILLED |
| M05 | URI printable bytes | KILLED |
| M06 | metadata minimum | KILLED |
| M07 | metadata byte maximum | KILLED |
| M08 | metadata ASCII controls | KILLED |
| M09 | metadata Unicode scalar | KILLED |
| M10 | tag minimum | KILLED |
| M11 | tag maximum | KILLED |
| M12 | tag alphabet | KILLED |
| M13 | payment minimum | KILLED |
| M14 | payment maximum | KILLED |
| M15 | payment alphabet | KILLED |
| M16 | hash exact size | KILLED |
| M17 | hash alphabet/case | KILLED |
| M18 | score integer | KILLED |
| M19 | score minimum | KILLED |
| M20 | score maximum | KILLED |
| M21 | network allowlist | KILLED |
| M22 | receiver allowlist | KILLED |
| M23 | escrow allowlist | KILLED |
| M24 | signer account | KILLED |
| M25 | extra args | KILLED |
| M26 | agent URI call | KILLED |
| M27 | metadata call | KILLED |
| M28 | payment ID call | KILLED |
| M29 | score call | KILLED |
| M30 | tag1 call | KILLED |
| M31 | tag2 call | KILLED |
| M32 | feedback URI call | KILLED |
| M33 | feedback hash call | KILLED |
| M34 | exact revoke deposit | KILLED |
| M35 | update positive deposit | KILLED |
| M36 | minimum storage/feedback deposit | KILLED |
| M37 | minimum feedback gas | KILLED |
| M38 | minimum other gas | KILLED |
| M39 | maximum gas | KILLED |
| M40 | signing receiver | KILLED |
| M41 | one action | KILLED |
| M42 | action type | KILLED |
| M43 | method allowlist | KILLED |
| M44 | monetary descriptor fields | KILLED |
| M45 | args object | KILLED |
| M46 | positive nonce | KILLED |
| M47 | block hash length | KILLED |
| M48 | public key length | KILLED |
| M49 | signature check | KILLED |
| M50 | RPC HTTP status | KILLED |
| M51 | RPC envelope | KILLED |
| M52 | view shape | KILLED |
| M53 | decimal integer strings | KILLED |
| M54 | u32 number type | KILLED |
| M55 | u32 range | KILLED |
| M56 | operator maximum | KILLED |
| M57 | operator Unicode scalar | KILLED |
| M58 | nullable shape | KILLED |
| M59 | required fields | KILLED |
| M60 | optional fields | KILLED |
| M61 | average maximum | KILLED |
| M62 | pagination u32 | KILLED |
| M63 | feedback id input | KILLED |
| M64 | operator input | KILLED |
| M65 | global summary shape | KILLED |
| M66 | operator summary shape | KILLED |
| M67 | event standard | KILLED |
| M68 | event version | KILLED |
| M69 | event fields | KILLED |
| M70 | outcome rejection allowlist | KILLED |
| M71 | outcome rejection ambiguity | KILLED |
| M72 | summary input shape | KILLED |
| M73 | summary escrow filter | KILLED |
| M74 | summary operator filter | KILLED |
| M75 | summary revoked filter | KILLED |
| M76 | safe display scheme | KILLED |
| M77 | call_function response | KILLED |
| M78 | byte minimum | KILLED |
| M79 | byte maximum | KILLED |
| M80 | byte integer | KILLED |
| M81 | view array all rows | KILLED |
| M82 | event all rows | KILLED |
| M83 | event array input | KILLED |
| M84 | event prefix | KILLED |
| M85 | event name allowlist | KILLED |
| M86 | event array data | KILLED |
| M87 | base64 alphabet | KILLED |
| M88 | view account argument | KILLED |
| M89 | view rater account | KILLED |
| M90 | boolean field | KILLED |
| M91 | role field | KILLED |
| M92 | config u8 max_score | KILLED |
