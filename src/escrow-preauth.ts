/**
 * uvd-x402-sdk - Escrow Pre-Auth Builder (sign-on-assignment)
 *
 * Builds and signs the EIP-3009 `ReceiveWithAuthorization` that locks a
 * bounty in the x402r AuthCaptureEscrow, and packs it into the raw-JSON
 * `X-Payment-Auth` wrapper the Ultravioleta Facilitator's `/settle` expects.
 * Used by marketplaces built on the escrow rail (e.g. Execution Market's
 * universal escrow, ADR-002).
 *
 * >>> PROTOCOL CONSTRAINT <<<
 * The EIP-3009 nonce is `AuthCaptureEscrow.getHash(paymentInfo)` which
 * INCLUDES the receiver — the escrow signature can only be created AT
 * ASSIGNMENT, when the worker/payee is known. Never design flows that sign
 * an escrow auth before the receiver is chosen ("stored pre-auth with late
 * receiver fill" is on-chain unsound).
 *
 * Fail-loud policy: an incomplete network config, an unknown tier, a bounty
 * outside the on-chain deposit limit, a `maxFeeBps` that cannot cover the
 * operator's static fee, or a USDC domain that contradicts
 * {@link VERIFIED_USDC_DOMAINS} all throw instead of falling back — a silent
 * fallback would sign an EIP-3009 authorization with the WRONG EIP-712
 * domain (chainId + verifyingContract): a mismatched, wallet-draining auth.
 *
 * What the network config asserts is checked against this SDK's own tables
 * before anything is signed, with the policy of the domain table: the chain id
 * against the `network` the caller names, the escrow, token collector and USDC
 * against {@link ESCROW_CONTRACTS}, the operator against
 * {@link ESCROW_OPERATORS}, and `maxFeeBps` against that chain's ceiling
 * ({@link ESCROW_MAX_FEE_BPS}). A contradiction throws, and so does a chain
 * without a row in any of those three tables or in
 * {@link VERIFIED_USDC_DOMAINS}, with or without `network`. Tier
 * windows and the authorization window have ceilings
 * ({@link ESCROW_TIER_WINDOW_MAX}, {@link ESCROW_MAX_AUTHORIZATION_SEC}).
 * Mirrors the Python SDK's `escrow_signing.build_escrow_pre_auth` (0.97.0).
 *
 * Wire format is pinned by golden vectors (`src/escrow-preauth.vectors.json`):
 * payer-zeroed raw-keccak nonce (`keccak(chainId, escrow,
 * keccak(PAYMENT_INFO_TYPEHASH, paymentInfo tuple with payer=0))`),
 * `ReceiveWithAuthorization` typed data, raw JSON (NOT base64) wrapper.
 * Byte-parity with the production references is enforced in
 * `src/escrow-preauth.test.ts`.
 *
 * @example Sign the escrow lock at assignment time
 * ```typescript
 * import { buildEscrowPreAuth, EnvKeyAdapter } from 'uvd-x402-sdk';
 *
 * // Server-published escrow config (e.g. GET /api/v1/h2a/payment-config
 * // on Execution Market — escrow_networks[network]).
 * const paymentAuth = await buildEscrowPreAuth(new EnvKeyAdapter(), {
 *   networkConfig: config.escrow.networks.base,
 *   network: 'base',                    // checked against chain_id
 *   payerWallet: '0xPublisher...',
 *   workerWallet: '0xWorker...',        // committed by the nonce
 *   bountyAtomic: '100000',             // $0.10 in 6-decimal USDC
 *   reviewDeadlineSec: taskDeadlineEpoch,
 * });
 * // Send as the X-Payment-Auth header (raw JSON, NOT base64).
 * ```
 *
 * Reference implementations (kept in byte-parity via the shared vectors):
 *   - Python: `em_plugin_sdk.escrow_signing.build_escrow_pre_auth`
 *     (production reference, derived from `uvd_x402_sdk.advanced_escrow`)
 *   - Browser (viem): Execution Market `dashboard/src/services/h2aSigning.ts`
 */

import { ethers } from 'ethers';
import { getChainByName } from './chains';
import { ESCROW_CONTRACTS, ESCROW_MAX_FEE_BPS, ESCROW_OPERATORS } from './escrow-contracts';
import { X402Error } from './types';
import { inexactNumberMessage, toUint } from './utils/uint';
import {
  needsAccountWrap,
  replaySafeTypedData,
  resolveDelegation,
  wrapSignature,
  type DelegationResolver,
} from './erc7702.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const USDC_DECIMALS = 6;

/** AuthCaptureEscrow deposit condition: $100 max per deposit. */
export const ESCROW_DEPOSIT_LIMIT_USD = 100;

/**
 * StaticFeeCalculator: canonical 13% flat fee. The signed maxFeeBps MUST
 * cover it or the on-chain authorize reverts (`FeeBoundsIncompatible`) — the
 * guard runs on the way IN, so a bound that is too low never opens the escrow
 * at all. It is not a way to pay less.
 *
 * This is a CEILING TO PLAN AGAINST, not a reading of any one deployment. The
 * operator fee is an immutable of each PaymentOperator instance, chosen from
 * `OperatorConfig.feeCalculator` when the factory deploys it, so two operators
 * on the same chain can charge differently and neither is knowable from here.
 *
 * Measured 2026-09-05: every `operator` address in {@link ESCROW_CONTRACTS} that
 * answered is the PaymentOperatorFactory, not a deployed operator — it exposes
 * `ESCROW()` and `operators(bytes32)` and reverts on `FEE_CALCULATOR()`,
 * `FEE_RECIPIENT()` and `release(...)`. Confirmed on Base mainnet, Base Sepolia
 * and Arbitrum, and matched by x402-rs `docs/X402R_MULTICHAIN_DEPLOYMENT.md`,
 * which labels those same addresses "PaymentOperatorFactory".
 *
 *   cast call 0x3D0837fF8Ea36F417261577b9BA568400A840260 \
 *     "ESCROW()(address)" --rpc-url https://mainnet.base.org
 *   # 0xb9488351E48b23D798f24e8174514F28B741Eb4f   (factory immutable)
 *   cast call 0x3D0837fF8Ea36F417261577b9BA568400A840260 \
 *     "FEE_CALCULATOR()(address)" --rpc-url https://mainnet.base.org
 *   # execution reverted                            (operator-only getter)
 *
 * So read the fee off the operator you were actually given — the marketplace
 * publishes it in {@link EscrowNetworkConfig} — and pass `max_fee_bps` when it
 * differs. This constant is only the default bound.
 */
export const OPERATOR_FEE_BPS = 1300;

/**
 * Hard cap the shared ProtocolFeeConfig puts on the PROTOCOL's slice, mirrored
 * from `ProtocolFeeConfig.MAX_PROTOCOL_FEE_BPS` (x402-rs
 * `contracts/src/plugins/fees/ProtocolFeeConfig.sol`). `getProtocolFeeBps`
 * clamps to it, so no deployment can ever charge more than this on top of the
 * operator's own fee.
 *
 * Measured on Base mainnet 2026-09-05 against the ProtocolFeeConfig the SDK
 * ships for chain 8453 (`0x59314674BAbb1a24Eb2704468a9cCdD50668a1C6`):
 *
 *   cast call 0x59314674BAbb1a24Eb2704468a9cCdD50668a1C6 \
 *     "MAX_PROTOCOL_FEE_BPS()(uint256)" --rpc-url https://mainnet.base.org
 *   # 500
 *   cast call 0x59314674BAbb1a24Eb2704468a9cCdD50668a1C6 \
 *     "calculator()(address)" --rpc-url https://mainnet.base.org
 *   # 0x0000000000000000000000000000000000000000  -> protocol fee is 0 today
 */
export const MAX_PROTOCOL_FEE_BPS = 500;

/**
 * Fee-bound defaults for optional config keys only — never for the domain.
 *
 * `PaymentOperator` charges `protocolFee + operatorFee` and compares that SUM
 * against the signed `maxFeeBps` (`_calculateFees`, then the guard in
 * `authorize`/`charge`). So the only bound guaranteed never to revert is the
 * canonical operator fee plus the protocol's hard cap — derived here rather
 * than re-typed, so the two can never drift apart.
 */
export const DEFAULT_MIN_FEE_BPS = 0;
export const DEFAULT_MAX_FEE_BPS = OPERATOR_FEE_BPS + MAX_PROTOCOL_FEE_BPS;

/**
 * EIP-712 type for the escrow flow. The token collector pulls the funds, so
 * the scheme is ReceiveWithAuthorization (not TransferWithAuthorization).
 */
const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

/**
 * ABI type of the paymentInfo tuple — mirrors AdvancedEscrowClient /
 * em_plugin_sdk.escrow_signing (unnamed components, positional encoding).
 */
const PAYMENT_INFO_TUPLE =
  'tuple(address,address,address,address,uint120,uint48,uint48,uint48,uint16,uint16,address,uint256)';

/** Per-tier expiry windows in seconds, relative to now() at signing. */
export interface EscrowTierWindows {
  pre: number;
  auth: number;
  refund: number;
}

/** Canonical fallback — mirrors uvd_x402_sdk TIER_TIMINGS. Frozen, each tier included. */
export const ESCROW_TIER_WINDOWS: Readonly<Record<string, Readonly<EscrowTierWindows>>> = Object.freeze({
  micro: Object.freeze({ pre: 3600, auth: 7200, refund: 86400 }),
  standard: Object.freeze({ pre: 7200, auth: 86400, refund: 604800 }),
});

/**
 * Human review windows. Agents approve in seconds, so the short SDK tier
 * windows (micro auth = 2h) work for them. A HUMAN publisher reviews on
 * their own schedule — if authorizationExpiry passes before approval, the
 * on-chain release REVERTS (AfterAuthorizationExpiry). So release/refund
 * windows are extended to comfortably outlast the deadline + review buffer.
 */
export const REVIEW_WINDOW_SEC = 7 * 24 * 3600; // >=7 days to approve after the deadline
export const REFUND_WINDOW_SEC = 7 * 24 * 3600; // +7 days to refund after that

/**
 * The longest window a tier may give each expiry, in seconds: the `enterprise`
 * tier of `TIER_TIMINGS` (`uvd-x402-sdk/backend`), the longest the SDK ships
 * (pinned by a test). A server-published tier above it is refused before
 * signing, never clamped. The windows Execution Market serves today reach the
 * `auth` ceiling exactly (REVIEW_WINDOW_SEC); a test pins that they fit.
 */
export const ESCROW_TIER_WINDOW_MAX: Readonly<EscrowTierWindows> = Object.freeze({
  pre: 86400,
  auth: 604800,
  refund: 2592000,
});

/**
 * The latest `authorizationExpiry` the pre-auth signs, in seconds after now:
 * Execution Market's longest task deadline (720 h: `deadline_hours` is
 * `le=720` in its task models) plus {@link REVIEW_WINDOW_SEC}. A later one
 * (from a `reviewDeadlineSec` further ahead) is refused, never clamped. Now is
 * the signer's clock: a deadline exactly 720 h ahead, read by a clock that runs
 * behind, is refused.
 */
export const ESCROW_MAX_AUTHORIZATION_SEC = 720 * 3600 + REVIEW_WINDOW_SEC;

/**
 * One network's escrow parameters, as published by the marketplace server
 * (e.g. Execution Market's `GET /api/v1/h2a/payment-config` →
 * `escrow_networks[network]`). Snake_case on purpose: pass the server's
 * JSON straight through so the SDK builds the paymentInfo EXACTLY like the
 * production reference.
 */
export interface EscrowNetworkConfig {
  chain_id: number;
  operator: string;
  escrow: string;
  token_collector: string;
  usdc: string;
  usdc_domain_name: string;
  usdc_domain_version: string;
  /** 32-byte hex PAYMENT_INFO_TYPEHASH (with or without 0x prefix). */
  payment_info_typehash: string;
  /** Server-published tier windows; falls back to ESCROW_TIER_WINDOWS. */
  tiers?: Record<string, EscrowTierWindows>;
  min_fee_bps?: number;
  max_fee_bps?: number;
}

/** paymentInfo exactly as serialized in the X-Payment-Auth wrapper. */
export interface EscrowPaymentInfo {
  operator: string;
  receiver: string;
  token: string;
  /** Atomic units, as string (uint120 on-chain). */
  maxAmount: string;
  preApprovalExpiry: number;
  authorizationExpiry: number;
  refundExpiry: number;
  minFeeBps: number;
  maxFeeBps: number;
  feeReceiver: string;
  /** 32-byte hex. */
  salt: string;
}

/**
 * USDC EIP-712 domains VERIFIED ON-CHAIN, per chain ID.
 *
 * `usdc_domain_name` / `usdc_domain_version` arrive with the server's config,
 * and they ARE the domain the authorization is signed under: a wrong pair
 * produces an authorization that never settles. {@link buildEscrowPreAuth}
 * refuses a config whose pair differs from the chain's row, and a chain with
 * no row here is refused like a chain with no row in the escrow tables.
 *
 * The rows of the Python SDK's `escrow_signing.VERIFIED_USDC_DOMAINS`
 * (uvd-x402-sdk 0.97.0), read from each token's `name()` / `version()`, one
 * per chain with an escrow operator row. Written out here, not read from the
 * chain registry (`src/chains`), so that a registry edit cannot move the
 * domain this check accepts; a test pins that both agree. Frozen, each row
 * included.
 */
export const VERIFIED_USDC_DOMAINS: Readonly<Record<number, Readonly<{ name: string; version: string }>>> =
  Object.freeze({
    8453: Object.freeze({ name: 'USD Coin', version: '2' }), // Base
    1: Object.freeze({ name: 'USD Coin', version: '2' }), // Ethereum
    137: Object.freeze({ name: 'USD Coin', version: '2' }), // Polygon
    42161: Object.freeze({ name: 'USD Coin', version: '2' }), // Arbitrum
    42220: Object.freeze({ name: 'USDC', version: '2' }), // Celo
    143: Object.freeze({ name: 'USDC', version: '2' }), // Monad
    43114: Object.freeze({ name: 'USD Coin', version: '2' }), // Avalanche
    10: Object.freeze({ name: 'USD Coin', version: '2' }), // Optimism
    1187947933: Object.freeze({ name: 'Bridged USDC (SKALE Bridge)', version: '2' }), // SKALE Base
    5042: Object.freeze({ name: 'USDC', version: '2' }), // Arc
    5042002: Object.freeze({ name: 'USDC', version: '2' }), // Arc Testnet
  });

/**
 * AuthCaptureEscrow's PaymentInfo typehash: keccak256 of
 * `PaymentInfo(address operator,address payer,address receiver,address token,
 * uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,
 * uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,
 * uint256 salt)`, 0x-prefixed. A constant of the contract, not a setting: the
 * nonce hashes it, so {@link buildEscrowPreAuth} refuses a config whose
 * `payment_info_typehash` is any other value. Equal to `PAYMENT_INFO_TYPEHASH`
 * (`uvd-x402-sdk/backend`); mirrors the Python SDK's
 * `escrow_signing.ESCROW_PAYMENT_INFO_TYPEHASH`.
 */
export const ESCROW_PAYMENT_INFO_TYPEHASH =
  '0xae68ac7ce30c86ece8196b61a7c486d8f0061f575037fbd34e7fe4e2820c6591';

const REQUIRED_NETWORK_KEYS: Array<keyof EscrowNetworkConfig> = [
  'chain_id',
  'operator',
  'escrow',
  'token_collector',
  'usdc',
  'usdc_domain_name',
  'usdc_domain_version',
  'payment_info_typehash',
];

/** Every key of {@link EscrowNetworkConfig}: what `buildEscrowPreAuth` reads from it. */
const NETWORK_CONFIG_KEYS: Array<keyof EscrowNetworkConfig> = [
  ...REQUIRED_NETWORK_KEYS,
  'tiers',
  'min_fee_bps',
  'max_fee_bps',
];

// ── What the signature commits to, against the SDK's tables ─────────────────
// The domain is not the only thing the server asserts and the signature carries:
//   chain_id        -> domain.chainId, the nonce and paymentRequirements.network
//   escrow          -> the nonce (AuthCaptureEscrow.getHash)
//   token_collector -> message.to and authorization.to
//   usdc            -> domain.verifyingContract and paymentInfo.token
//   operator        -> paymentInfo.operator and paymentInfo.feeReceiver
//   max_fee_bps     -> paymentInfo.maxFeeBps
// Same policy as VERIFIED_USDC_DOMAINS, with the tables of ./escrow-contracts:
//   - a network this SDK registers, and a config that names another chain -> refused
//   - a network this SDK does not register                                -> refused
//   - a chain with a row, and a value other than the row's               -> refused
//   - a chain without a row in any of the three tables (or the domain's) -> refused
// Addresses are compared in the form they are signed in (checksummed).

/** A table's row for `chainId`: own rows only, never one inherited from a prototype. */
function rowOf<T>(table: Readonly<Record<number, T>>, chainId: number): T | undefined {
  return Object.hasOwn(table, chainId) ? table[chainId] : undefined;
}

/** A config value as an error shows it: strings quoted, anything else with its type. */
function shown(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : `${String(value)} (${typeof value})`;
}

/** Config key -> the ESCROW_CONTRACTS field it is checked against. */
const REGISTERED_ADDRESS_KEYS = [
  ['escrow', 'escrow'],
  ['token_collector', 'tokenCollector'],
  ['usdc', 'usdc'],
] as const;

/**
 * A number of the config as given, or one written in ASCII decimal digits (the
 * Python twin reads both with `int()`); `NaN` for anything else. Each caller
 * checks the range.
 */
function configInteger(value: unknown): number {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
}

/**
 * The chain id the authorization is signed for, from the config's `chain_id`:
 * a positive safe integer, or one written in ASCII decimal digits (the Python
 * twin reads it with `int()`). Anything else is refused — a boolean (`true`
 * would read as chain 1), a hex, signed or padded string, a fraction, a number
 * past 2**53 - 1 — so the chain the tables are read for is the chain signed.
 */
function escrowChainId(value: unknown): number {
  const id = configInteger(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new X402Error(
      `Invalid chain_id ${shown(value)} in the escrow ` +
        'network config (a positive integer) — refusing to sign.',
      'INVALID_CONFIG'
    );
  }
  return id;
}

/**
 * A fee bound of the config as the integer the paymentInfo signs (uint16), or
 * `fallback` when the key is absent: a number, or one written in ASCII decimal
 * digits (the Python twin reads it with `int()`), from 0 to 65535. Anything
 * else is refused, so the bound the guards compare is the one on the wire.
 */
function feeBps(value: unknown, fallback: number, key: 'min_fee_bps' | 'max_fee_bps'): number {
  if (value === undefined || value === null) return fallback;
  const bps = configInteger(value);
  if (!Number.isInteger(bps) || bps < 0 || bps > 65535) {
    throw new X402Error(
      `Invalid ${key} ${shown(value)} in the escrow ` +
        'network config (an integer number of bps, 0 to 65535) — refusing to sign.',
      'INVALID_CONFIG'
    );
  }
  return bps;
}

/**
 * The tier's windows as the integers the paymentInfo adds to now(): each one an
 * integer from 0 to its {@link ESCROW_TIER_WINDOW_MAX}, or one written in
 * decimal digits. A window above the ceiling is refused, never clamped.
 */
function tierWindows(windows: EscrowTierWindows, tier: string): EscrowTierWindows {
  const read = (key: keyof EscrowTierWindows): number => {
    const value = (windows as unknown as Record<string, unknown>)[key];
    const seconds = configInteger(value);
    const max = ESCROW_TIER_WINDOW_MAX[key];
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > max) {
      throw new X402Error(
        `Invalid ${key} window ${shown(value)} for escrow tier '${tier}' (an integer number of ` +
          `seconds, 0 to ${max}: ESCROW_TIER_WINDOW_MAX) — refusing to sign.`,
        'INVALID_CONFIG'
      );
    }
    return seconds;
  };
  return { pre: read('pre'), auth: read('auth'), refund: read('refund') };
}

/**
 * The chain id this SDK registers for `network`, or `undefined` if none.
 *
 * `eip155:<id>` names its own chain id (ASCII decimal digits; anything else
 * throws); any other name goes through the chain registry
 * ({@link getChainByName}, `CHAIN_ALIASES` included),
 * case and surrounding spaces aside. A non-EVM network is registered with
 * chain id 0, which no config can match (0 is a missing `chain_id`), so it is
 * refused like any other mismatch. Mirrors the Python SDK's
 * `escrow_signing._registered_chain_id`.
 */
function registeredChainId(network: string): bigint | undefined {
  const name = network.trim().toLowerCase();
  if (name.startsWith('eip155:')) {
    const reference = name.slice('eip155:'.length);
    if (!/^[0-9]+$/.test(reference)) {
      throw new X402Error(
        `'${network}' names no EVM chain id (eip155:<decimal id>) — refusing to sign.`,
        'INVALID_CONFIG'
      );
    }
    return BigInt(reference);
  }
  const chain = getChainByName(name);
  // The registry is a plain object: a name such as 'constructor' finds an
  // Object.prototype member, which is no chain.
  return typeof chain?.chainId === 'number' ? BigInt(chain.chainId) : undefined;
}

/**
 * The network the caller named, against the config's chain:
 *   - no `network`: nothing to check here (the chain still needs its rows);
 *   - a `network` this SDK registers (a chain registry name, an alias, or
 *     `eip155:<id>`): its chain must be the config's;
 *   - a `network` it does not register: refused.
 */
function checkNetworkChainId(network: unknown, chainId: number): void {
  if (network === undefined || network === null) return;
  if (typeof network !== 'string' || network.trim() === '') {
    throw new X402Error(
      `network ${typeof network === 'string' ? `'${network}'` : String(network)} names no ` +
        'network — refusing to sign.',
      'INVALID_CONFIG'
    );
  }
  const registered = registeredChainId(network);
  if (registered === undefined) {
    throw new X402Error(
      `'${network}' is not a network this SDK registers (a chain registry name or ` +
        'eip155:<decimal id>) — refusing to sign.',
      'INVALID_CONFIG'
    );
  }
  if (registered !== BigInt(chainId)) {
    throw new X402Error(
      `Chain id mismatch for '${network}': the escrow config asserts chain ${chainId} but this ` +
        `SDK registers '${network}' as chain ${registered} — refusing to sign.`,
      'INVALID_CONFIG'
    );
  }
}

/** The config's address under `key`, checksummed, or a refusal that names the key. */
function configAddress(
  cfg: EscrowNetworkConfig,
  key: 'operator' | (typeof REGISTERED_ADDRESS_KEYS)[number][0]
): string {
  try {
    return ethers.getAddress(cfg[key]);
  } catch {
    throw new X402Error(
      `The escrow config's ${key} '${String(cfg[key])}' is not an address — refusing to sign.`,
      'INVALID_CONFIG'
    );
  }
}

/**
 * A table address in the form it is signed in. Not lowercased first: a row
 * whose mixed case is not its EIP-55 checksum throws here instead of being
 * repaired (a test pins every row's spelling).
 */
function tableAddress(address: string): string {
  return ethers.getAddress(address);
}

/**
 * The config's `payment_info_typehash` as `computeEscrowNonce` reads it
 * (0x-prefixed, lowercase), when it is {@link ESCROW_PAYMENT_INFO_TYPEHASH}
 * (case, an `0x` / `0X` prefix and surrounding spaces aside); any other value
 * is refused: the nonce would not be the escrow's getHash and the lock would
 * revert. Mirrors the Python SDK's check in `build_escrow_pre_auth`.
 */
function checkPaymentInfoTypehash(typehash: unknown): string {
  const given = typeof typehash === 'string' ? typehash.trim().toLowerCase() : '';
  const digits = given.startsWith('0x') ? given.slice(2) : given;
  if (digits !== ESCROW_PAYMENT_INFO_TYPEHASH.slice(2)) {
    throw new X402Error(
      `The escrow config's payment_info_typehash is ${shown(typehash)}, not AuthCaptureEscrow's ` +
        `PaymentInfo typehash ${ESCROW_PAYMENT_INFO_TYPEHASH} — refusing to sign: the nonce would ` +
        "not be the escrow's getHash and the lock would revert.",
      'INVALID_CONFIG'
    );
  }
  return ESCROW_PAYMENT_INFO_TYPEHASH;
}

/** The chain's row in each of the four tables; a chain missing any is refused. */
interface EscrowRows {
  contracts: (typeof ESCROW_CONTRACTS)[number];
  operator: string;
  maxFeeBps: number;
  domain: Readonly<{ name: string; version: string }>;
}

function escrowRows(chainId: number): EscrowRows {
  const contracts = rowOf(ESCROW_CONTRACTS, chainId);
  const operator = rowOf(ESCROW_OPERATORS, chainId);
  const maxFeeBps = rowOf(ESCROW_MAX_FEE_BPS, chainId);
  const domain = rowOf(VERIFIED_USDC_DOMAINS, chainId);
  if (contracts === undefined || operator === undefined || maxFeeBps === undefined || domain === undefined) {
    const missing = [
      contracts === undefined ? 'ESCROW_CONTRACTS' : null,
      operator === undefined ? 'ESCROW_OPERATORS' : null,
      maxFeeBps === undefined ? 'ESCROW_MAX_FEE_BPS' : null,
      domain === undefined ? 'VERIFIED_USDC_DOMAINS' : null,
    ].filter((name) => name !== null);
    throw new X402Error(
      `Chain ${chainId} has no row in this SDK's escrow tables (${missing.join(', ')}) — ` +
        'refusing to sign.',
      'INVALID_CONFIG'
    );
  }
  return { contracts, operator, maxFeeBps, domain };
}

function checkRegisteredAddresses(cfg: EscrowNetworkConfig, chainId: number, rows: EscrowRows): void {
  for (const [key, field] of REGISTERED_ADDRESS_KEYS) {
    const asserted = configAddress(cfg, key);
    const expected = tableAddress(rows.contracts[field]);
    if (asserted !== expected) {
      throw new X402Error(
        `Escrow address mismatch for chain ${chainId}: the escrow config asserts ${key} ` +
          `${asserted} but this SDK's escrow registry (ESCROW_CONTRACTS) has ${expected} — ` +
          'refusing to sign.',
        'INVALID_CONFIG'
      );
    }
  }
  const operator = configAddress(cfg, 'operator');
  const expectedOperator = tableAddress(rows.operator);
  if (operator !== expectedOperator) {
    throw new X402Error(
      `Escrow operator mismatch for chain ${chainId}: the escrow config asserts operator ` +
        `${operator} but this SDK's ESCROW_OPERATORS has ${expectedOperator} — refusing to sign.`,
      'INVALID_CONFIG'
    );
  }
}

function hex32(value: string): string {
  return value.startsWith('0x') ? value : `0x${value}`;
}

/**
 * The salt as the uint256 the hash takes, from the bytes32 hex string the
 * escrow wire carries (x402-rs: `FixedBytes<32>`). Anything else is refused: a
 * number past 2**53 - 1 was rounded on its way in, and a bigint or a safe
 * number has no hex form both SDKs agree on (the Python twin reads
 * `str(salt)` as hex, so 12345 would hash as 0x12345).
 */
function escrowSaltToBigInt(salt: unknown): bigint {
  if (typeof salt === 'string') return BigInt(hex32(salt));
  if (typeof salt === 'number' && Number.isInteger(salt) && !Number.isSafeInteger(salt)) {
    throw new X402Error(inexactNumberMessage('paymentInfo.salt', salt), 'INVALID_CONFIG');
  }
  throw new X402Error(
    `paymentInfo.salt must be the bytes32 hex string the escrow wire carries, got the ${typeof salt} ` +
      `${typeof salt === 'bigint' ? `${salt}n` : String(salt)}`,
    'INVALID_CONFIG'
  );
}

/** 32 random bytes as 0x-hex (WebCrypto when available, ethers otherwise). */
function randomSalt(): string {
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webCrypto?.getRandomValues) {
    const bytes = new Uint8Array(32);
    webCrypto.getRandomValues(bytes);
    return ethers.hexlify(bytes);
  }
  return ethers.hexlify(ethers.randomBytes(32));
}

/**
 * Compute the escrow EIP-3009 nonce = `AuthCaptureEscrow.getHash(paymentInfo)`.
 *
 * `keccak(chainId, escrow, keccak(PAYMENT_INFO_TYPEHASH, paymentInfo tuple
 * with payer=0))` — the payer slot is zeroed for the payer-agnostic hash;
 * the RECEIVER is part of the hash, which is why the signature commits to
 * the chosen worker. Port of `AdvancedEscrowClient._compute_nonce` /
 * `em_plugin_sdk.escrow_signing.compute_escrow_nonce`.
 *
 * @param chainId - EVM chain id.
 * @param escrowAddress - AuthCaptureEscrow contract on that chain.
 * @param paymentInfoTypehash - 32-byte hex typehash from the server config.
 * @param pi - paymentInfo exactly as serialized on the wire.
 * @returns 32-byte hex nonce (0x-prefixed, lowercase).
 * @throws {X402Error} `INVALID_CONFIG` when `maxAmount` is a number above
 *   2**53 - 1 (it was rounded by `JSON.parse`, and hashing it would commit to
 *   a different paymentInfo than the one that is sent), or when `salt` is not
 *   a string.
 */
export function computeEscrowNonce(
  chainId: number,
  escrowAddress: string,
  paymentInfoTypehash: string,
  pi: EscrowPaymentInfo
): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();

  // `maxAmount` and `salt` are the two that do not fit in a double: as JSON
  // numbers they arrive rounded, and `BigInt()` would hash the rounded value.
  // The uint48 / uint16 fields fit, and ethers refuses an unsafe number there.
  const piTuple = [
    ethers.getAddress(pi.operator),
    ZERO_ADDRESS, // payer = 0 for the payer-agnostic hash
    ethers.getAddress(pi.receiver),
    ethers.getAddress(pi.token),
    toUint(pi.maxAmount, 'paymentInfo.maxAmount'), // uint120
    pi.preApprovalExpiry, // uint48
    pi.authorizationExpiry, // uint48
    pi.refundExpiry, // uint48
    pi.minFeeBps, // uint16
    pi.maxFeeBps, // uint16
    ethers.getAddress(pi.feeReceiver),
    escrowSaltToBigInt(pi.salt), // uint256
  ];

  const piHash = ethers.keccak256(
    coder.encode(['bytes32', PAYMENT_INFO_TUPLE], [hex32(paymentInfoTypehash), piTuple])
  );
  return ethers.keccak256(
    coder.encode(
      ['uint256', 'address', 'bytes32'],
      [chainId, ethers.getAddress(escrowAddress), piHash]
    )
  );
}

/**
 * Minimal signer for {@link buildEscrowPreAuth}: EIP-712 typed-data signing
 * over the full typed-data JSON string (`domain`, `types`, `primaryType`,
 * `message`) — the same contract as `SigningWalletAdapter.signTypedData`,
 * so every adapter (EnvKeyAdapter, OWSWalletAdapter, custom) satisfies it
 * structurally. Browser wallets can wrap their own signTypedData in this
 * shape; the key never leaves the signer.
 */
export interface EscrowPreAuthSigner {
  signTypedData(typedData: string): Promise<{ signature: string }>;
}

export interface EscrowPreAuthParams {
  /** Network escrow config as published by the marketplace server. */
  networkConfig: EscrowNetworkConfig;
  /**
   * The network the caller took `networkConfig` for: the key of the server's
   * `escrow_networks` (e.g. `'base'`) or a CAIP-2 id (`'eip155:8453'`). A
   * config whose `chain_id` is another chain than the one this SDK registers
   * for it is refused before signing, and so is a name the SDK does not
   * register. Optional; with it or without it, only a chain with a row in
   * each of the SDK's escrow tables is signed. Name the network you expect to
   * pay on, from your own code: never one read from the config or from the
   * server that sent it.
   */
  network?: string;
  /**
   * Publisher wallet (payer). Not checked against the signer's address —
   * payer binding is enforced on-chain and by the backend, not here.
   */
  payerWallet: string;
  /** Chosen worker's wallet (escrow receiver — committed by the nonce). */
  workerWallet: string;
  /** Bounty in atomic units (6-decimal USDC). */
  bountyAtomic: string | bigint;
  /** Expiry tier; windows come from config when present. Default 'micro'. */
  tier?: string;
  /**
   * Task deadline (epoch seconds). The release/refund windows are extended
   * to outlast it + a review buffer so a human publisher can still approve
   * after the worker delivers. When omitted, falls back to now()-based
   * windows.
   */
  reviewDeadlineSec?: number;
  /**
   * On-chain deposit limit in USD (AuthCaptureEscrow deposit condition).
   * Default {@link ESCROW_DEPOSIT_LIMIT_USD}; override only when the server
   * publishes a different limit.
   */
  depositLimitUsd?: number;
  /**
   * How to find out whether `payerWallet` is EIP-7702-delegated, and to what.
   *
   * Optional, and its absence is honest rather than convenient: with no resolver
   * the verdict is UNKNOWN and this function signs the ordinary way, exactly as
   * it did before. Pass one — {@link rpcDelegationResolver} or your own — as soon
   * as your payers can be delegated accounts, because a delegated payer signing
   * the wrong dialect produces an authorization that **cannot settle on-chain**
   * and only fails at lock time.
   *
   * When a resolver IS supplied and it reaches no verdict, this throws instead of
   * guessing: an unreadable chain is not a "not delegated" answer.
   */
  delegationResolver?: DelegationResolver;
}

/**
 * Build + sign the escrow lock authorization AT ASSIGNMENT time and return
 * the raw JSON string for the `X-Payment-Auth` header (NOT base64 — the
 * backend relays it verbatim to the Facilitator `/settle`). Mirror of
 * `AdvancedEscrowClient.authorize()`'s /settle payload and of
 * `em_plugin_sdk.escrow_signing.build_escrow_pre_auth`.
 *
 * @throws {X402Error} `INVALID_CONFIG` on an incomplete network config,
 *   unknown tier, a `min_fee_bps` / `max_fee_bps` that is not an integer from
 *   0 to 65535, a `minFeeBps` above the operator's static fee, a `maxFeeBps`
 *   that cannot cover it, or
 *   a USDC domain that differs from {@link VERIFIED_USDC_DOMAINS};
 *   also on a config the SDK's tables contradict: a `chain_id` that is not a
 *   positive integer or not the chain this SDK registers for `network`, a
 *   `network` it does not register, a chain without a row in
 *   {@link ESCROW_CONTRACTS}, {@link ESCROW_OPERATORS},
 *   {@link ESCROW_MAX_FEE_BPS} or {@link VERIFIED_USDC_DOMAINS}, a tier window that is not an integer from 0 to
 *   {@link ESCROW_TIER_WINDOW_MAX}, an `authorizationExpiry` further than
 *   {@link ESCROW_MAX_AUTHORIZATION_SEC} from now, an `escrow`,
 *   `token_collector` or `usdc` other than the chain's row in
 *   {@link ESCROW_CONTRACTS}, an `operator` other than its row in
 *   {@link ESCROW_OPERATORS}, or a `maxFeeBps` above its row in
 *   {@link ESCROW_MAX_FEE_BPS};
 *   `INVALID_AMOUNT` on a bounty outside (0, deposit limit], or one that is
 *   not a decimal / 0x-hex string, a bigint, or a number up to 2**53 - 1.
 */
export async function buildEscrowPreAuth(
  wallet: EscrowPreAuthSigner,
  params: EscrowPreAuthParams
): Promise<string> {
  // Read once, key by key: every value checked below is the value signed. A
  // getter (own or inherited) or a Proxy is read here, and only here.
  const source = params.networkConfig;
  const cfg = Object.fromEntries(
    NETWORK_CONFIG_KEYS.map((key) => [key, source?.[key]])
  ) as unknown as EscrowNetworkConfig;

  const missing = REQUIRED_NETWORK_KEYS.filter((key) => !cfg[key]);
  if (missing.length > 0) {
    throw new X402Error(
      `Incomplete escrow network config (missing ${missing.join(', ')}) — ` +
        'refusing to sign an EIP-3009 authorization with a mismatched domain.',
      'INVALID_CONFIG'
    );
  }

  // The chain, against the network the caller named: everything below (the
  // domain, the rows of the tables, what is signed) is read for this chain id.
  const chainId = escrowChainId(cfg.chain_id);
  checkNetworkChainId(params.network, chainId);
  const rows = escrowRows(chainId);

  const verified = rows.domain;
  if (cfg.usdc_domain_name !== verified.name || cfg.usdc_domain_version !== verified.version) {
    throw new X402Error(
      `The escrow config gives chain ${chainId} the USDC domain ` +
        `'${cfg.usdc_domain_name}' / '${cfg.usdc_domain_version}', but the token's on-chain ` +
        `domain is '${verified.name}' / '${verified.version}' — refusing to sign an ` +
        'authorization that could never settle.',
      'INVALID_CONFIG'
    );
  }

  // Escrow, token collector, USDC and operator, against ./escrow-contracts.
  checkRegisteredAddresses(cfg, chainId, rows);
  const typehash = checkPaymentInfoTypehash(cfg.payment_info_typehash);

  const maxAmount = toUint(params.bountyAtomic, 'bountyAtomic', 'INVALID_AMOUNT');
  if (maxAmount <= 0n) {
    throw new X402Error(
      `Bounty must be positive, got ${maxAmount} atomic units`,
      'INVALID_AMOUNT'
    );
  }
  const depositLimitUsd = params.depositLimitUsd ?? ESCROW_DEPOSIT_LIMIT_USD;
  const depositLimitAtomic = BigInt(Math.round(depositLimitUsd * 10 ** USDC_DECIMALS));
  if (maxAmount > depositLimitAtomic) {
    throw new X402Error(
      `Bounty ${maxAmount} atomic units exceeds the on-chain escrow deposit ` +
        `limit ($${depositLimitUsd}).`,
      'INVALID_AMOUNT'
    );
  }

  const minFeeBps = feeBps(cfg.min_fee_bps, DEFAULT_MIN_FEE_BPS, 'min_fee_bps');
  const maxFeeBps = feeBps(cfg.max_fee_bps, DEFAULT_MAX_FEE_BPS, 'max_fee_bps');
  // The capture takes the operator's static fee, and the escrow requires
  // minFeeBps <= fee <= maxFeeBps. Mirrors the Python SDK (0.97.0).
  if (minFeeBps > OPERATOR_FEE_BPS) {
    throw new X402Error(
      `minFeeBps=${minFeeBps} must be between 0 and the operator's ${OPERATOR_FEE_BPS} ` +
        'bps static fee — refusing to sign.',
      'INVALID_CONFIG'
    );
  }
  if (maxFeeBps < OPERATOR_FEE_BPS) {
    throw new X402Error(
      `maxFeeBps=${maxFeeBps} cannot cover the operator's ${OPERATOR_FEE_BPS} ` +
        'bps static fee — the on-chain release would revert.',
      'INVALID_CONFIG'
    );
  }
  // SDK policy, not an on-chain limit.
  if (maxFeeBps > rows.maxFeeBps) {
    throw new X402Error(
      `maxFeeBps=${maxFeeBps} for chain ${chainId} is above this SDK's ceiling for ` +
        `that chain (${rows.maxFeeBps} bps, ESCROW_MAX_FEE_BPS) — refusing to sign.`,
      'INVALID_CONFIG'
    );
  }

  const tierKey = params.tier ?? 'micro';
  const tierWindowsGiven = cfg.tiers?.[tierKey] ?? ESCROW_TIER_WINDOWS[tierKey];
  if (!tierWindowsGiven) {
    const known = [...new Set([...Object.keys(cfg.tiers ?? {}), ...Object.keys(ESCROW_TIER_WINDOWS)])].sort();
    throw new X402Error(
      `Unknown escrow tier '${tierKey}' — known tiers: ${known.join(', ')}`,
      'INVALID_CONFIG'
    );
  }

  const windows = tierWindows(tierWindowsGiven, tierKey);

  const now = Math.floor(Date.now() / 1000);

  // The release window must outlast the human review. Base it on the task
  // deadline (the worker delivers near it) plus a generous buffer, and never
  // shorter than the SDK tier window. preApprovalExpiry stays short — the
  // lock executes immediately at assignment.
  const deadline = params.reviewDeadlineSec;
  if (deadline !== undefined && deadline !== null && !Number.isSafeInteger(deadline)) {
    throw new X402Error(
      `Invalid reviewDeadlineSec ${shown(deadline)} (epoch seconds, an integer) — refusing to sign.`,
      'INVALID_CONFIG'
    );
  }
  const reviewBase = Math.max(now, deadline ?? now);
  const authExpiry = Math.max(now + windows.auth, reviewBase + REVIEW_WINDOW_SEC);
  // Refused, never clamped: a shorter window than asked would sign another
  // authorization.
  if (authExpiry - now > ESCROW_MAX_AUTHORIZATION_SEC) {
    throw new X402Error(
      `authorizationExpiry ${authExpiry} is ${authExpiry - now} s after now, past this SDK's ` +
        `${ESCROW_MAX_AUTHORIZATION_SEC} s (ESCROW_MAX_AUTHORIZATION_SEC): reviewDeadlineSec is at ` +
        `most ${ESCROW_MAX_AUTHORIZATION_SEC - REVIEW_WINDOW_SEC} s ahead — refusing to sign.`,
      'INVALID_CONFIG'
    );
  }
  const refundExpiry = Math.max(now + windows.refund, authExpiry + REFUND_WINDOW_SEC);

  const paymentInfo: EscrowPaymentInfo = {
    operator: ethers.getAddress(cfg.operator),
    receiver: ethers.getAddress(params.workerWallet),
    token: ethers.getAddress(cfg.usdc),
    maxAmount: maxAmount.toString(),
    preApprovalExpiry: now + windows.pre,
    authorizationExpiry: authExpiry,
    refundExpiry: refundExpiry,
    minFeeBps: minFeeBps,
    maxFeeBps: maxFeeBps,
    feeReceiver: ethers.getAddress(cfg.operator),
    salt: randomSalt(),
  };

  const nonce = computeEscrowNonce(
    chainId,
    cfg.escrow,
    typehash,
    paymentInfo
  );

  const payer = ethers.getAddress(params.payerWallet);
  const tokenCollector = ethers.getAddress(cfg.token_collector);

  // String-valued message fields: the typed data travels as JSON to the
  // adapter (SigningWalletAdapter.signTypedData contract), and ethers
  // accepts decimal strings for uint256 / 0x-hex for bytes32.
  const typedData = {
    domain: {
      name: cfg.usdc_domain_name,
      version: cfg.usdc_domain_version,
      chainId: chainId,
      verifyingContract: ethers.getAddress(cfg.usdc),
    },
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: payer,
      to: tokenCollector,
      value: maxAmount.toString(),
      validAfter: '0',
      validBefore: String(paymentInfo.preApprovalExpiry),
      nonce: nonce,
    },
  };

  // ── EIP-7702: a DELEGATED payer cannot settle a raw ECDSA authorization ──
  //
  // Once the payer's EOA carries code, USDC validates via ERC-1271 only and raw
  // ECDSA reverts (0x151d90fe) — the lock fails on-chain. Measured in production
  // 2026-07-31: 14 of 14 delegated payers failed; the one plain EOA locked fine.
  //
  // THREE STATES, and the third is the one that matters: an UNKNOWN delegation is
  // NOT "not delegated". Collapsing it to false is exactly how the original bug
  // survived eight days — signing raw for an account that can never settle it,
  // silently.
  //
  // AND THE DIALECT DEPENDS ON THE TARGET. "Delegated" is not one signature
  // scheme: the account-envelope wrap is Alchemy-SMA-specific. A delegate that
  // validates plain ECDSA through ERC-1271 — Execution Market's FeedbackDelegate,
  // which every account that has rated through the facilitator's rail is pointed
  // at — needs the ORDINARY signature. Wrapping it is as unsettleable as signing
  // raw for an SMA.
  const { delegated, target } = await resolveDelegation(
    payer,
    `eip155:${chainId}`,
    params.delegationResolver
  );
  if (delegated === null && params.delegationResolver) {
    throw new X402Error(
      `Could not determine whether ${payer} is EIP-7702-delegated on chain ` +
        `${chainId} (the resolver gave no verdict) — refusing to sign an ` +
        'escrow authorization blindly: the wrong dialect is unsettleable ' +
        'on-chain and the failure only shows up at lock time. Retry when the ' +
        'chain is readable.',
      'INVALID_CONFIG'
    );
  }

  let signature: string;
  if (delegated && (needsAccountWrap(target) || target === null)) {
    // SMA-wrap: the known Alchemy account, OR a legacy boolean-only resolver that
    // could not name the target — for which we keep the conservative behaviour
    // rather than silently changing what such callers got. A resolver that
    // returns the target lands any non-SMA delegate in the plain branch below.
    const innerDigest = ethers.TypedDataEncoder.hash(
      typedData.domain,
      typedData.types,
      typedData.message
    );
    const replaySafe = replaySafeTypedData(innerDigest, chainId, payer);
    const wrapped = await wallet.signTypedData(
      JSON.stringify({ ...replaySafe, primaryType: 'ReplaySafeHash' })
    );
    if (!wrapped?.signature) {
      throw new X402Error(
        'The wallet returned no signature for the replay-safe wrap — refusing ' +
          'to build an unsettleable authorization.',
        'INVALID_CONFIG'
      );
    }
    signature = wrapSignature(wrapped.signature);
  } else {
    // Plain EOA, unknown-with-no-resolver, or a delegate that takes ordinary
    // ECDSA (FeedbackDelegate and the standard 1271 smart-EOA pattern).
    signature = (await wallet.signTypedData(JSON.stringify(typedData))).signature;
  }

  // Raw JSON (NOT base64): the backend relays this verbatim to the
  // Facilitator /settle after validating payer/amount/receiver.
  return JSON.stringify({
    x402Version: 2,
    scheme: 'escrow',
    payload: {
      authorization: {
        from: payer,
        to: tokenCollector,
        value: maxAmount.toString(),
        validAfter: '0',
        validBefore: String(paymentInfo.preApprovalExpiry),
        nonce: nonce,
      },
      signature: signature,
      paymentInfo: paymentInfo,
    },
    paymentRequirements: {
      scheme: 'escrow',
      network: `eip155:${chainId}`,
    },
  });
}
