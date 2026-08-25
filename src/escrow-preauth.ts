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
 * outside the on-chain deposit limit, or a `maxFeeBps` that cannot cover the
 * operator's static fee all throw instead of falling back — a silent
 * fallback would sign an EIP-3009 authorization with the WRONG EIP-712
 * domain (chainId + verifyingContract): a mismatched, wallet-draining auth.
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
import { X402Error } from './types';
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
 * cover it or the on-chain release reverts.
 */
export const OPERATOR_FEE_BPS = 1300;

/** Fee-bound defaults for optional config keys only — never for the domain. */
const DEFAULT_MIN_FEE_BPS = 0;
const DEFAULT_MAX_FEE_BPS = 1800;

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

/** Canonical fallback — mirrors uvd_x402_sdk TIER_TIMINGS. */
export const ESCROW_TIER_WINDOWS: Record<string, EscrowTierWindows> = {
  micro: { pre: 3600, auth: 7200, refund: 86400 },
  standard: { pre: 7200, auth: 86400, refund: 604800 },
};

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

function hex32(value: string): string {
  return value.startsWith('0x') ? value : `0x${value}`;
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
 */
export function computeEscrowNonce(
  chainId: number,
  escrowAddress: string,
  paymentInfoTypehash: string,
  pi: EscrowPaymentInfo
): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();

  const piTuple = [
    ethers.getAddress(pi.operator),
    ZERO_ADDRESS, // payer = 0 for the payer-agnostic hash
    ethers.getAddress(pi.receiver),
    ethers.getAddress(pi.token),
    BigInt(pi.maxAmount), // uint120
    pi.preApprovalExpiry, // uint48
    pi.authorizationExpiry, // uint48
    pi.refundExpiry, // uint48
    pi.minFeeBps, // uint16
    pi.maxFeeBps, // uint16
    ethers.getAddress(pi.feeReceiver),
    BigInt(hex32(pi.salt)), // uint256
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
 *   unknown tier, or a `maxFeeBps` that cannot cover the operator's static
 *   fee; `INVALID_AMOUNT` on a bounty outside (0, deposit limit].
 */
export async function buildEscrowPreAuth(
  wallet: EscrowPreAuthSigner,
  params: EscrowPreAuthParams
): Promise<string> {
  const cfg = params.networkConfig;

  const missing = REQUIRED_NETWORK_KEYS.filter((key) => !cfg[key]);
  if (missing.length > 0) {
    throw new X402Error(
      `Incomplete escrow network config (missing ${missing.join(', ')}) — ` +
        'refusing to sign an EIP-3009 authorization with a mismatched domain.',
      'INVALID_CONFIG'
    );
  }

  const maxAmount = BigInt(params.bountyAtomic);
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

  const minFeeBps = cfg.min_fee_bps ?? DEFAULT_MIN_FEE_BPS;
  const maxFeeBps = cfg.max_fee_bps ?? DEFAULT_MAX_FEE_BPS;
  if (maxFeeBps < OPERATOR_FEE_BPS) {
    throw new X402Error(
      `maxFeeBps=${maxFeeBps} cannot cover the operator's ${OPERATOR_FEE_BPS} ` +
        'bps static fee — the on-chain release would revert.',
      'INVALID_CONFIG'
    );
  }

  const tierKey = params.tier ?? 'micro';
  const windows = cfg.tiers?.[tierKey] ?? ESCROW_TIER_WINDOWS[tierKey];
  if (!windows) {
    const known = [...new Set([...Object.keys(cfg.tiers ?? {}), ...Object.keys(ESCROW_TIER_WINDOWS)])].sort();
    throw new X402Error(
      `Unknown escrow tier '${tierKey}' — known tiers: ${known.join(', ')}`,
      'INVALID_CONFIG'
    );
  }

  const now = Math.floor(Date.now() / 1000);

  // The release window must outlast the human review. Base it on the task
  // deadline (the worker delivers near it) plus a generous buffer, and never
  // shorter than the SDK tier window. preApprovalExpiry stays short — the
  // lock executes immediately at assignment.
  const reviewBase = Math.max(now, params.reviewDeadlineSec ?? now);
  const authExpiry = Math.max(now + windows.auth, reviewBase + REVIEW_WINDOW_SEC);
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
    cfg.chain_id,
    cfg.escrow,
    cfg.payment_info_typehash,
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
      chainId: cfg.chain_id,
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
    `eip155:${cfg.chain_id}`,
    params.delegationResolver
  );
  if (delegated === null && params.delegationResolver) {
    throw new X402Error(
      `Could not determine whether ${payer} is EIP-7702-delegated on chain ` +
        `${cfg.chain_id} (the resolver gave no verdict) — refusing to sign an ` +
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
    const replaySafe = replaySafeTypedData(innerDigest, cfg.chain_id, payer);
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
      network: `eip155:${cfg.chain_id}`,
    },
  });
}
