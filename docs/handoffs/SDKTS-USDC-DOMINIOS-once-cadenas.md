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
  `usdc_domain_version: 2` (a number) is refused by TS and signed by Python. TS is the
  stricter side (refuses, never signs a wrong domain); left as is, see the PR.
- npm already has 2.104.1 published while CHANGELOG still says "unreleased" for it;
  not touched here.
