# NEAR ERC-8004 implementation handoff

Base: origin/main f15b4295a53a37a59da4e340c1b3ad2dc0aceab3 (2.111.0).
Release: 2.112.0. The existing Arras registry and EVM ERC-8004 modules are unchanged.

## Inventory and implementation

Reused `NearLocalSigner` and the existing account, exact integer, base58 and Borsh
primitives. The module follows the injectable JSON-RPC and receipt provenance
patterns, while supplying its own contract tables, schema checks, budget rules,
argument canonicalization and outcome correlation. The old registry's scores,
deposits, events and identifiers describe a different protocol and are not reused.

The new `erc8004.ts` and internal `erc8004-schema.ts` cover 16 transaction builders,
normal signed transactions, 30 view variants (including per-contract config and
version aliases), nine events and ten callback rejection codes. Prefixes and the
`NearErc8004Client` class avoid changing old imports. Full API and EM flows:
[NEAR ERC-8004 guide](../near-erc8004.md).

Every builder requires configuration. Quotes, storage byte cost and available
gas floors come from config; immutable SDK ceilings add 5% to recorded storage
budgets. Single-yocto calls are exact. Signing repeats validation before accessing
the signer. View responses are bounded by time, bytes and row count. Events bind
the selected network and the appropriate identity/reputation emitter; outcome
parsers additionally bind successful return values to transaction inputs/events.

## Shared recorded vectors

`near-erc8004.json` uses `format: near-erc8004-v1`, then `networks` in mainnet,
testnet order. Each network has `calls` and `transactions`, one object per case.
View cases preserve `args`, compact `args_json`, `args_hex` and decoded `result`.
Transaction cases preserve the full historical RPC result including receipts,
events and statuses. Variable query block metadata is excluded. JSON uses UTF-8,
two-space indentation and one trailing LF, without a BOM.

Both recorders independently fetched the same 20 views and six transactions.
The TS recorder's offline comparison with the companion Python fixture passed.
Size: 212059 bytes. SHA256:
`07e8a80665811afe9ad6c95bf9a811b3cd4b31cb81a9f7ec57caadf7331a7b6c`.
No seed or private signing material is stored. Signing tests generate ephemeral
in-memory keys and independently decode Borsh and verify signatures with Node.

Regeneration is explicit (`--record`), uses only public view and historical status
RPCs, and spaces requests by at least 1.1 seconds. `--compare <python-fixture>` is
an offline byte comparison. Neither tests nor CI regenerate from the network.

## Verification and auto-refutation

The suite has 350 passing offline tests. All 16 constructors fix exact default
arguments, receiver, gas and deposit on both networks. Storage tests cover empty
values and decoded metadata bytes. Each feedback correlation is tested with an
otherwise valid authenticated event: agent, decimals, each tag, endpoint, URI,
hash, verifier and proof identifier. Separate tests cover duplicate registered
events, a rejection accompanied by new_feedback, and a proof on plain feedback.

When args.verifier is present, the feedback outcome parser requires exact equality
with NEAR_ERC8004_CONTRACTS[network].verifier before returning accepted, rejected
or failed. It does not normalize the account or infer its network from a suffix.
Transaction parsers and the transaction event API require any present
final_execution_status to equal FINAL. Missing fields remain compatible; null,
undefined, empty, wrong-case, whitespace, non-string and intermediate values
are rejected. Receipt-only consumers must establish finality themselves.

The indexing guide requires both the selected network's verifier and the expected
proof context (em for Execution Market) before counting feedback as verified.
The raw event API continues to expose schema-valid proofs for caller policies.

An independent adversarial reviewer found no P1/P2 issues. Its suggestion to
preserve positive empty-URI and empty-metadata coverage was incorporated.

## Final verification

Node 20.20.2, Python 3.11.4. npm ci, typecheck, lint, ESM/CJS/declaration build,
package smoke and the local pre-CI passed. The full offline CI-mode suite passed
4268 tests; base origin/main f15b429 passed 3918. Both have exactly one failing
suite: src/adapters/ows.test.ts cannot load the unavailable Windows OWS native
binary (@open-wallet-standard/core-win32-x64-msvc). There are zero new failures.
SQLite was reinstalled under Node 20 before both final measurements.

Existing TS/Python conformance passed 512 checks across nine phases, using a fresh
Python 3.11 environment and Python main f76c6d84a04a26909cc9f511d94b0f6fc2379aeb.
ERC-8128 derivation, registry generation, the registry fixture pinned by CI and
the ERC-8004 byte comparison all passed. The ERC-8004 fixture remains 212059 bytes
with the SHA256 above; it was not regenerated. Release entries remain in 2.112.0.
The latest origin/main was integrated before final checks (already up to date).

Pre-CI command: `preci.py --repo . --base origin/main --ejecutar`. The PR contains
the complete job/command/result table and the pre-CI table. No transactions,
deployment, publication or PR merge were performed.

## Mutation inventory

`scripts/mutate-near-erc8004.mjs` now enumerates M01-M105 and the external review's
R01-R20. Every mutant was rerun: **125/125 killed**, with no survivors, invalid
mutants or timeouts. Each process has a 120-second timeout and each mutation is
restored with git checkout; the tree was clean before and after the run.
M90-M96 isolate each formerly grouped correlation; M97-M102 isolate network and
finality rules; M103-M105 cover storage defaults. R01-R20 retain the review IDs,
including all 15 previously surviving mutations.

| ID | Guard or default | Result |
| --- | --- | --- |
| M01 | network allowlist | KILLED |
| M02 | config network binding | KILLED |
| M03 | identity binding | KILLED |
| M04 | escrow binding | KILLED |
| M05 | config deposit positive | KILLED |
| M06 | config deposit ceiling | KILLED |
| M07 | config gas floor | KILLED |
| M08 | config gas ceiling | KILLED |
| M09 | signer account | KILLED |
| M10 | unknown args | KILLED |
| M11 | required argument checks | KILLED |
| M12 | optional argument checks | KILLED |
| M13 | deadline expired | KILLED |
| M14 | deadline maximum | KILLED |
| M15 | verifier network | KILLED |
| M16 | deposit floor | KILLED |
| M17 | deposit ceiling | KILLED |
| M18 | gas floor | KILLED |
| M19 | gas ceiling | KILLED |
| M20 | null deposit option | KILLED |
| M21 | null gas option | KILLED |
| M22 | one signing action | KILLED |
| M23 | signing action type | KILLED |
| M24 | signing receiver binding | KILLED |
| M25 | nonce positive | KILLED |
| M26 | block hash length | KILLED |
| M27 | signature verification | KILLED |
| M28 | view HTTP status | KILLED |
| M29 | view byte ceiling | KILLED |
| M30 | RPC error envelope | KILLED |
| M31 | view timeout minimum | KILLED |
| M32 | view timeout maximum | KILLED |
| M33 | default bounded pagination | KILLED |
| M34 | view verifier network | KILLED |
| M35 | view byte-array maximum | KILLED |
| M36 | view byte-array type | KILLED |
| M37 | view schema check | KILLED |
| M38 | view config budget check | KILLED |
| M39 | identity view binding | KILLED |
| M40 | receipt status uniqueness | KILLED |
| M41 | receipt successful execution | KILLED |
| M42 | receipt log-array shape | KILLED |
| M43 | event emitter role | KILLED |
| M44 | event standard | KILLED |
| M45 | event version | KILLED |
| M46 | single event data row | KILLED |
| M47 | event data schema | KILLED |
| M48 | final transaction success | KILLED |
| M49 | outcome receiver network | KILLED |
| M50 | register outcome ID equality | KILLED |
| M51 | register outcome owner equality | KILLED |
| M52 | register outcome URI equality | KILLED |
| M53 | rejection code allowlist | KILLED |
| M54 | rejection multiplicity | KILLED |
| M55 | rejection receipt emitter | KILLED |
| M56 | feedback outcome index equality | KILLED |
| M57 | feedback outcome signer equality | KILLED |
| M58 | feedback outcome value equality | KILLED |
| M59 | required schema fields | KILLED |
| M60 | optional schema fields | KILLED |
| M61 | unknown schema fields | KILLED |
| M62 | all list rows | KILLED |
| M63 | list bound | KILLED |
| M64 | safe number maximum | KILLED |
| M65 | number integer | KILLED |
| M66 | unsigned string representation | KILLED |
| M67 | positive feedback index | KILLED |
| M68 | signed canonicality | KILLED |
| M69 | signed summary width | KILLED |
| M70 | value lower bound | KILLED |
| M71 | value upper bound | KILLED |
| M72 | decimal maximum | KILLED |
| M73 | tag controls | KILLED |
| M74 | Unicode scalar strings | KILLED |
| M75 | UTF-8 byte length | KILLED |
| M76 | hash lowercase | KILLED |
| M77 | hash width | KILLED |
| M78 | metadata key width | KILLED |
| M79 | reserved metadata key | KILLED |
| M80 | proof alphabet | KILLED |
| M81 | proof label alphabet | KILLED |
| M82 | URI limit | KILLED |
| M83 | URI scheme alpha | KILLED |
| M84 | URI scheme alphabet | KILLED |
| M85 | base64 canonical padding | KILLED |
| M86 | base64 decoded limit | KILLED |
| M87 | parallel feedback arrays | KILLED |
| M88 | argument snapshot | KILLED |
| M89 | config snapshot | KILLED |
| M90 | feedback tag1 equality | KILLED |
| M91 | feedback tag2 equality | KILLED |
| M92 | feedback endpoint equality | KILLED |
| M93 | feedback URI equality | KILLED |
| M94 | feedback hash equality | KILLED |
| M95 | feedback proof verifier equality | KILLED |
| M96 | feedback proof identifier equality | KILLED |
| M97 | outcome verifier network | KILLED |
| M98 | final execution status equality | KILLED |
| M99 | explicit malformed finality is present | KILLED |
| M100 | event API checks finality | KILLED |
| M101 | outcome API checks finality | KILLED |
| M102 | legacy outcome without finality | KILLED |
| M103 | URI storage bytes | KILLED |
| M104 | metadata decoded bytes | KILLED |
| M105 | storage safety yocto | KILLED |
| R01 | proof feedback default 150 to 120 TGas | KILLED |
| R02 | plain feedback default 60 to 40 TGas | KILLED |
| R03 | ordinary default 30 to 300 TGas | KILLED |
| R04 | transfer-call default 50 to 300 TGas | KILLED |
| R05 | metadata omits 128 storage bytes | KILLED |
| R06 | response budget 512 to 256 bytes | KILLED |
| R07 | approval budget 256 to 1 byte | KILLED |
| R08 | feedback agent correlation | KILLED |
| R09 | proof verifier and identifier correlation | KILLED |
| R10 | feedback tag correlations | KILLED |
| R11 | feedback endpoint URI and hash correlations | KILLED |
| R12 | feedback decimals correlation | KILLED |
| R13 | rejected callback with new_feedback | KILLED |
| R14 | duplicate registered events | KILLED |
| R15 | proof on plain feedback | KILLED |
| R16 | signer ignores caller clock | KILLED |
| R17 | optimistic RPC finality | KILLED |
| R18 | ignore verifier config gas floor | KILLED |
| R19 | ordinary default 30 to 31 TGas | KILLED |
| R20 | transfer-call default 50 to 51 TGas | KILLED |
