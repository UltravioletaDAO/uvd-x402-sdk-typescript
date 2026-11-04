# NEAR ERC-8004 implementation handoff

Base: origin/main f15b4295a53a37a59da4e340c1b3ad2dc0aceab3 (2.111.0).
Target release: 2.112.0. The existing Arras registry and EVM ERC-8004 modules are unchanged.

## Inventory

Reuse `NearLocalSigner` and the account, exact integer, base58, compact JSON and
Borsh primitives already used by the NEAR registry. Follow its injectable
JSON-RPC transport and receipt provenance model. Do not reuse its contract
allowlist, deposits, event schemas, score range or outcome parser: these describe
a different protocol. The new API needs identity NFTs, signed values/decimals,
payment proof metadata, network-bound configuration, bounded storage budgets,
wallet deadlines, strict result schemas and identity/reputation receipt filtering.
The new module lives beside the existing registry and uses prefixed exports from
`uvd-x402-sdk/near` to avoid changing existing imports.

## Recorded vectors

The recording script makes read-only RPC requests at most once per second. Each
case preserves the existing fixture conventions (`network`, `receiver_id`,
`calls`, compact `args_json`, `args_hex`, `events` with `log` and `parsed`). A
`vectors` array holds one case per view or historical transaction. View `result`
is decoded JSON without variable block metadata. Transaction `result` is the
historical final execution outcome, including receipt provenance and statuses.
No signing seed or credentials are recorded. JSON uses two-space indentation,
UTF-8 and one trailing LF; key ordering follows the recorder.
