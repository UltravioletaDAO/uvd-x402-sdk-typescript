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
checks. Update accepts deposits from 1 yocto, defaults to REGISTER_DEPOSIT, and checks
E06 before E01/E02. FullAccess permission,
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
with Node Crypto. `node scripts/xlang/check-near-registry-parity.mjs` compares the
raw bytes against `tests/fixtures/near-registry.json` in `UVD_X402_PY_ROOT` (default:
the sibling Python checkout). CI runs both the derivation and parity checks without
skipping a missing or mismatched fixture. This round preserves the TS vector bytes.

## Verification and auto-refutation

Round 1 uses Node 20.20.2 and Python 3.11.4, matching CI. The initial base
`f19902b` run with `CI=true` passed 3585 tests and failed to load OWS and SQLite.
Rebuilding better-sqlite3 for Node 20 removed the SQLite failure; the base then
passed 3636 tests, with only the unsupported Windows OWS native library failing.
These baseline failures were recorded before comparing the final head.

The registry suite has 254 tests; the vector parity script adds four tests for
identical bytes, whitespace drift, CRLF drift and a missing sibling fixture.
The original 92 mutations are retained, with their targets adapted to the revised
deposit/gas code. M93-M97 cover the five refutator gaps; M98-M117 cover the new
ordering, emitter, async, SDK gas-error and parity guards. **117/117 killed** in a
complete run, with no survivors, invalid mutants or timeout kills. Each process has
a 120-second timeout and every edit is restored with git checkout; the tree was
clean before and after the run.

One independent adversarial subagent reviewed the diff and ran offline probes
against the built bundle: no new P1/P2 findings. The vector equality guard gained
negative tests and M117. URI case/whitespace/scheme prefixes, exact gas and deposit
bounds, null/malformed receipts, executor/network binding and panic-only callback
codes are covered. The final full-suite comparison, pre-CI table, build/package,
secret scan and GitHub CI results are recorded in the PR and local round delivery.

The existing 512 runtime conformance checks continue to use Python main. Registry
fixture parity uses a separate sparse checkout of Python PR #81's immutable fixture
commit `9e5c4d2772d980074771d09f58f670e11f2dcc9d`, avoiding a circular merge
dependency between the two open PRs. The 6784-byte TS fixture is unchanged; SHA256
`80eeb72f0ee5a4a933b8592f88387d6c4a1f2234a97b02a1f94969878294be38`.

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
| M93 | receiver network binding | KILLED |
| M94 | escrow network binding | KILLED |
| M95 | E19 is not a callback rejection | KILLED |
| M96 | display scheme exact delimiter | KILLED |
| M97 | config exact version | KILLED |
| M98 | update deposit before identity validation | KILLED |
| M99 | update has no register deposit floor | KILLED |
| M100 | zero gas SDK error | KILLED |
| M101 | maximum gas SDK error | KILLED |
| M102 | receipt array | KILLED |
| M103 | receipt object | KILLED |
| M104 | receipt outcome object | KILLED |
| M105 | receipt emitter allowlist | KILLED |
| M106 | receipt emitter network binding | KILLED |
| M107 | receipt network validation | KILLED |
| M108 | getAgent rejects asynchronously | KILLED |
| M109 | listAgents rejects asynchronously | KILLED |
| M110 | getFeedback rejects asynchronously | KILLED |
| M111 | getFeedbackForPayment rejects asynchronously | KILLED |
| M112 | listFeedback rejects asynchronously | KILLED |
| M113 | getSummary rejects asynchronously | KILLED |
| M114 | getSummaryByOperator rejects asynchronously | KILLED |
| M115 | isFeedbackPending rejects asynchronously | KILLED |
| M116 | update deposit check applies | KILLED |
| M117 | cross-repo vector byte equality | KILLED |
