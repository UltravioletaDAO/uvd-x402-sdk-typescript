# c0-sdk-ts-near-kk: SDK 2.109.0

Arras/NEAR golden-flow helpers for local agents. No transaction, deploy, merge or package publication was performed. Import the public helpers from `uvd-x402-sdk/near`.

## Change

- `parseArrasEvents` returns typed NEP-297 envelopes for all eleven Arras v1 events. It skips foreign/malformed/unknown logs, validates each whole batch, preserves atomic decimal strings and supports partial operator updates. Receipt executor/status authentication stays with the caller.
- `buildArrasStorageDeposit` and `buildUsdcStorageDeposit` prepare unsigned normal transactions paid by the payer. Arras keeps surplus (`registration_only=false`, 0.05 NEAR default); USDC only registers (`true`, 0.00125 NEAR default). Use explicit trusted Arras configuration and the queried live minimum/deposit, with no inferred mainnet parent.
- `signNep413` / `nep413Preimage` implement the official NEP-413 example, callback Option, UTF-8 scalar validation and external signature verification. Reject `intents.near` recipients and equivalent domain case/trailing-dot spellings before signing.
- `signExactNearDelegate` exposes the existing local escrow serializer/signing routine for exact: network-native USDC, one ft_transfer, one yocto, at most 30 TGas, exact u128 amount, and nonce/height checks. The pre-existing browser provider is not an offline local-key raw-digest API, so it is not reused by local agents; no second local delegate serializer was added.
- O-258 polls npm at absolute increasing offsets through 300 seconds, with a 305-second deadline and transient network recovery. Absolute timing preserves the last read under RTT. The tag job has a ten-minute budget; version/gitHead/tag immutability guards remain enforced.
- Fixed independent vectors and a TS/Python runner compare preimages, signatures, delegates, storage and parsed events. On Windows the Python agent reads stdin bytes explicitly as UTF-8.
- Version 2.109.0 in manifest, lock and CHANGELOG. Guide updated. Existing gitleaks exact-value/path exception covers the new fixture's two public USDC identifiers; no rule was disabled.

## Local verification

PowerShell only. Node 20.20.2 / npm 10.8.2 and Python 3.11.4; tag tests also Node 24.22.1. Tests used empty AWS credential configuration, no AWS_PROFILE, proxies to loopback port 9 and loopback-only NO_PROXY. No RPC, production API or mainnet transaction was used.

| Job / check | Command | Result |
|---|---|---|
| validate / dependencies | `npm ci` with Node 20 | pass, exact lock |
| clean base origin/main 0425803 | `node node_modules/vitest/vitest.mjs run --maxWorkers=4 --minWorkers=1` | 91 files, 3448 passed / 75 skipped |
| validate / suite | same command on branch | 92 files, 3599 passed / 75 skipped; 151 added, zero new failures |
| validate / Typecheck | `npm run typecheck` | pass |
| validate / Lint | `npm run lint` | pass |
| validate / Build | `npm run build` | pass, CJS/ESM/declarations |
| validate / Package | `npm pack --dry-run` | pass |
| cross-language / frozen vectors | `node scripts/derive-erc8128-f3-3.mjs --check` | pass |
| cross-language / CI runner | `node scripts/xlang/cross-language-conformance.mjs` | pass against H-7 checkout |
| new NEAR positive parity | `node scripts/xlang/near-kk-conformance.mjs` | 3 NEP-413 preimages/signatures, 2 exact delegates, 3 storage transactions, 11 event variants identical |
| tag job Node 24 | `node node_modules/vitest/vitest.mjs run src/publish-tag.test.ts src/publish-workflow.test.ts --maxWorkers=2 --minWorkers=1` | 146 passed |
| example | `node examples/near-escrow-agent.mjs` | pass, offline only |
| mandatory pre-CI | `python C:/Users/lxhxr/c0der-specs/hooks/preci.py --repo . --base origin/main --ejecutar --timeout 300` | pass; typecheck/lint, dependencies reused after explicit npm ci |
| concurrency / Nano #65 | `git merge-tree --write-tree --name-only HEAD refs/remotes/c0der/pr-65` | exit 0; base vs #65 also exit 0 |

### Rojos de base / environment

The first base run had one suite error in `src/reputation/outbox.test.ts` because the inherited better-sqlite3 binary was built for a different Node ABI. A matching cached Node 20 binary was confirmed with SELECT 1; then `npm ci` was run under Node 20 and both clean base and head suites passed with all 51 outbox tests. No base failure remains under the corrected environment. OWS has no Windows native binary: its 75 skips match the base, and the dedicated Linux CI `OWS native library loads` step must still confirm the Linux binary.

## Auto-refutacion

One Codex adversarial agent (`gpt-6.1-sol`, xhigh) reviewed the diff and sources, reproduced a P3 in registry polling under RTT, and reviewed its correction. Verdict: MERGEABLE; no open P1/P2. No agent usage tokens were exposed; none are estimated.

Guards/edges: case/whitespace/newlines, 0x/0X, null/empty values, unsafe numbers, u64/u128 equality/overflow, network/token/payee binding, gas/nonce/height boundaries, key/signature shape and validity, Borsh domains/order/UTF-8, absent/empty callback, batch/schema validation, prototype-like event names, normal storage payer vs beneficiary, deposit units/registration flags, propagation/network errors/RTT and job budget. Paths and child-process Unicode were exercised on Windows; no POSIX-only path equality was introduced.

49 final mutations, each restored with `git checkout -- <file>`, all killed (exit 1), with 60-second timeout per mutant. No timeout kills and no mutation left in the tree. The control suite was green before mutation. An initial anchored-regex `test()` substitution was equivalent for the patterns in use, so it was excluded and replaced by a real trimming regression. Removing the zero-height check alone was redundant with the nonce ceiling; the final mutation changes the minimum-positive boundary and the test now accepts height=1/nonce=999999. The payer guard mutation exposed a missing case with an explicit valid beneficiary; that test was added and the mutation then failed.

| ID | Altered guard / behavior | Result |
|---|---|---|
| M1 | NEP413 domain prefix | killed, exit 1 |
| M2 | NEP413 fixed nonce length | killed, exit 1 |
| M3 | NEP413 forbidden recipient | killed, exit 1 |
| M4 | NEP413 recipient whitespace | killed, exit 1 |
| M5 | NEP413 Option callback tag | killed, exit 1 |
| M6 | NEP413 public key before signer | killed, exit 1 |
| M7 | NEP413 external signature verification | killed, exit 1 |
| M8 | NEP413 digest hashing | killed, exit 1 |
| M9 | Unicode scalar validity | killed, exit 1 |
| M10 | Borsh UTF8 byte length | killed, exit 1 |
| M11 | Exact unsigned string without trimming | killed, exit 1 |
| M12 | Safe number guard | killed, exit 1 |
| M13 | Unsigned range upper equality | killed, exit 1 |
| M14 | Canonical decimal integer strings | killed, exit 1 |
| M15 | Exact payee intents guard | killed, exit 1 |
| M16 | Exact USDC binding | killed, exit 1 |
| M17 | Exact positive amount | killed, exit 1 |
| M18 | Exact gas upper bound | killed, exit 1 |
| M19 | Exact gas positive | killed, exit 1 |
| M20 | Delegate positive nonce | killed, exit 1 |
| M21 | Delegate minimum positive height | killed, exit 1 |
| M22 | Delegate nonce height ceiling | killed, exit 1 |
| M23 | Exact FT method | killed, exit 1 |
| M24 | Exact one yocto | killed, exit 1 |
| M25 | Exact amount decimal string | killed, exit 1 |
| M26 | Events standard | killed, exit 1 |
| M27 | Events version | killed, exit 1 |
| M28 | Events known event names | killed, exit 1 |
| M29 | Events whole batch validation | killed, exit 1 |
| M30 | Events required fields | killed, exit 1 |
| M31 | Events optional fields | killed, exit 1 |
| M32 | Events JSON integer strings | killed, exit 1 |
| M33 | Events u16 fee | killed, exit 1 |
| M34 | Events U64 timestamp | killed, exit 1 |
| M35 | Storage forbidden target | killed, exit 1 |
| M36 | Storage positive deposit | killed, exit 1 |
| M37 | Storage Arras surplus | killed, exit 1 |
| M38 | Storage USDC registration only | killed, exit 1 |
| M39 | Storage Arras deposit amount | killed, exit 1 |
| M40 | Storage USDC deposit amount | killed, exit 1 |
| M41 | Tag late propagation attempts | killed, exit 1 |
| M42 | Tag absolute schedule under latency | killed, exit 1 |
| M43 | Tag transient registry recovery | killed, exit 1 |
| M44 | Exact sender account grammar | killed, exit 1 |
| M45 | Exact payee account grammar | killed, exit 1 |
| M46 | Storage target account grammar | killed, exit 1 |
| M47 | Storage payer account grammar | killed, exit 1 |
| M48 | Storage beneficiary account grammar | killed, exit 1 |
| M49 | Tag workflow budget exceeds polling window | killed, exit 1 |

## Remaining integration work

No live testnet key was supplied, so this delivery contains deterministic offline verification, not a live golden-flow payment. Arras v1 mainnet signing remains closed until its deployment is registered in an SDK release; mainnet account parent, funding, merge and publish belong to c0der. v2 budget signing still awaits frozen contract vectors as before.

The sibling H-7 worktree used for positive parity did not yet expose `NEAR_ESCROW_CONTRACTS` in near_escrow, so the pre-existing `near-escrow-conformance.mjs` raises AttributeError against that checkout. Its near_exact also lacked nonce < max_block_height*10^6. These are external Python alignment items; TypeScript keeps both safeguards from main. The new positive golden-flow runner passes against the actual Python helpers; full negative escrow-policy parity must be rerun after H-7 aligns. No other repo was edited.
