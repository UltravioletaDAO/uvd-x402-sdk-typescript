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

The new suite currently has 276 passing offline tests. It covers every builder,
view and event, config/amount/gas bounds, exact decimals and UTF-8, URI schemes and
RFC characters, base64 canonicality, deadlines, accounts, network binding,
receipt status, rejection provenance, and Borsh signatures.

`scripts/mutate-near-erc8004.mjs` enumerates M01-M89. The first pass identified
six test gaps in independently checking transport and optional-event fields;
regressions now isolate these conditions. One redundant emitter filter was
removed because each event already binds the exact network-specific executor.
Each mutant runs with a 120-second timeout and is restored using git checkout.
No subagents were used, following the task-specific restriction.

The initial dependency installation lacked SQLite bindings and a Hedera module.
After installation repair, the baseline with `CI=true` passed 3918 tests and
failed only `src/adapters/ows.test.ts`: OWS has no Windows native binary. An earlier
non-CI baseline run also showed an isolated existing `too_large` assertion in
`src/backend/durable-evidence.test.ts`; it passed in the subsequent CI baseline.
Final CI commands and results are recorded in the PR. Pre-CI command:
`preci.py --repo . --base origin/main --ejecutar`.

No transactions were sent, no deployment or publication was performed, and no
merge was made. On-chain ownership, proof availability, actual storage charges
and pending callback state remain contract checks.

The original 87 mutations all passed their second run. Two additional mutations
cover detached argument/config snapshots before validation and signing.

## Final verification

Node 20.20.2, Python 3.11.4: typecheck, lint, ESM/CJS/declaration build and package
smoke passed. The full offline CI-mode suite passed 4194 tests and retained only
the baseline Windows OWS native-load failure (zero new failures). The 276 new
tests pass. ESM and CJS package APIs replay both networks' configs and outcomes.
Existing TS/Python runtime conformance passed 512 checks across nine phases; both
existing registry fixture checks and the new ERC-8004 byte comparison passed.
Gitleaks found no secrets in the three-point diff or the new commit history.

The final complete mutation run killed **89/89**, with no survivors, invalid
mutants or timeout kills. The worktree was clean before and after restoration.

| ID | Guard | Result |
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
