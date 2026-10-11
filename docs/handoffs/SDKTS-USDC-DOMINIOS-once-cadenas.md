# SDKTS-USDC-DOMINIOS: the USDC EIP-712 domain checked on the 11 escrow chains

## Estado

- Hecho: `VERIFIED_USDC_DOMAINS` (`src/escrow-preauth.ts`) carries the 11 rows of
  the Python SDK's table (uvd-x402-sdk-python `3c81050`, 0.97.0), written out and
  frozen; a chain without a domain row is refused like one without an escrow row;
  a pair that differs is refused before signing. Per-chain tests, a cross-language
  phase 9, version 2.104.2, CHANGELOG, README.
- Falta: review of the PR; publishing is not part of this task.
- Proximo paso: review and merge by the maintainers; publish 2.104.2 when they decide.

## Base measured (before any change)

- TS `main` `6a7a2798e`, 2.104.1: `VERIFIED_USDC_DOMAINS` had 2 rows (5042, 5042002),
  built from the chain registry; a chain outside it was signed with the config's domain
  (a test pinned that: "signs a chain outside the table exactly as before").
- Python `3c81050`, 0.97.0: 11 rows, and `_check_rows` refuses a chain without one.
- The claim of the task matches what was measured.
- Base suite (Node 20.20.2, network closed): typecheck, lint, build, `npm pack --dry-run` ok;
  `vitest run` 69 files / 1707 tests passed; xlang 432 checks across 8 phases passed.
  No reds in the base.

## Change

- `src/escrow-preauth.ts`: 11 literal rows, each `Object.freeze`d, table frozen.
  `escrowRows` requires a `VERIFIED_USDC_DOMAINS` row (message lists it with the other
  missing tables); the mismatch check compares strictly against that row, before the
  address checks and before any delegation lookup or signature.
- Tests: `src/escrow-preauth.test.ts`, `src/escrow-preauth.rows.test.ts`.
- Parity: `scripts/xlang/agent.mjs`, `scripts/xlang/agent.py` (ops `usdc_domains`,
  `escrow_pre_auth`), `scripts/xlang/cross-language-conformance.mjs` phase 9.

## Open points

- The TS comparison is strict (`!==`); Python compares `str(value)`. A config with
  `usdc_domain_version: 2` (a number) is refused by TS and signed by Python with `"2"`.
  Until 2.104.1 TS signed the number itself (`"version":2`), an authorization that does
  not settle. Pinned by tests (number version, array name, object name on every chain)
  and measured as a divergence in xlang phase 9 (Base and Arc).
- npm already has 2.104.1 published while CHANGELOG still says "unreleased" for it;
  not touched here.

## Verification after the change (Node 20.20.2, network closed, over origin/main `6a7a279`)

| CI job / step | Command | Result |
|---|---|---|
| test: install | `npm ci --no-audit --no-fund` | 0 |
| test: OWS probe | `node -e "...require('@open-wallet-standard/core')..."` (ci.yml) | 0, 1.4.2 |
| test: typecheck | `npm run typecheck` | 0 |
| test: tests | `npm run test:run` | 0, 69 files / 1786 tests passed (base 1707) |
| test: lint | `npm run lint` | 0 |
| test: build | `npm run build` | 0 |
| test: package | `npm pack --dry-run` | 0, uvd-x402-sdk-2.104.2.tgz |
| cross-language | `UVD_X402_PY_ROOT=... UVD_PYTHON=... node scripts/xlang/cross-language-conformance.mjs` | 0, 501 checks across 9 phases (base 432 / 8) |
| vectors | `node scripts/derive-erc8128-f3-3.mjs --check` | 0 |
| secrets | `gitleaks detect --log-opts=origin/main..HEAD` | no leaks |

## Mutations (each applied to `src/escrow-preauth.ts`, reverted with `git checkout --`)

| Id | Mutation | Result | A test that fails |
|---|---|---|---|
| M1 | Base row removed | red, 104 | `has the Python SDK's eleven rows, no more`; rows test chain 8453 |
| M2 | Celo name `USD Coin` | red, 20 | `celo (chain 42220): the chain registry's USDC domain is the table's` |
| M3 | SKALE Base version `1` | red, 23 | `skale-base (chain 1187947933): the chain registry's USDC domain is the table's` |
| M4 | domain row not required in `escrowRows` | red, 1 | `chain 84532, missing only VERIFIED_USDC_DOMAINS, is refused before anything is signed` |
| M5 | mismatch guard off | red, 59 | `ethereum (chain 1): refuses another name ("USDC" / "2") before anything is signed` |
| M6 | version not compared | red, 23 | `ethereum (chain 1): refuses another version ("USD Coin" / "1") ...` |
| M7 | name compared case-insensitively | red, 11 | `... refuses the name in lower case ("usd coin" / "2") ...` |
| M8 | name and version trimmed | red, 22 | `... refuses the name with a trailing space ("USD Coin " / "2") ...` |
| M9 | Arc row not frozen | red, 1 | `VERIFIED_USDC_DOMAINS and each of its domains are frozen; ...` |
| M10 | table not frozen | red, 1 | same |
| M11 | mismatch guard off, rebuilt, xlang run | red, 44 checks | phase 9 `ethereum/other-name: both SDKs refuse it, ...` |

`git status` clean after every mutation.
