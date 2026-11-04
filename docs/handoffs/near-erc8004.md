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
