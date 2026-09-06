/**
 * uvd-x402-sdk - Signed lifecycle orders for `release` / `refundInEscrow`.
 *
 * Both actions move money that is ALREADY escrowed, so neither carries an
 * ERC-3009 signature: there is no transfer left to authorize. That left the
 * other half of the question open — who is entitled to ask for the move —
 * and the de-facto answer was "whoever calls". On 2026-08-30 a third party
 * probed exactly that: five calls with a fabricated `paymentInfo`, two of
 * them mined, gas spent.
 *
 * This module is the client half of the answer: an EIP-712 order signed by
 * the party the action belongs to, hung off `payload.lifecycleAuth`.
 *
 * >>> THE SIGNER IS INJECTED <<<
 * The SDK never reaches for a key on its own. Any adapter that can sign
 * typed data works — `EnvKeyAdapter` (server / CLI), `OWSWalletAdapter`, a
 * wagmi/viem wallet client in the browser ({@link wagmiLifecycleSigner}), a
 * KMS. In H2A/H2H the PAYER signs in their own browser with the same wallet
 * they paid with, and the marketplace merely transports the block.
 *
 * >>> TWO SHAPES, ONE ORDER <<<
 * `buildLifecycleAuth` does the whole ceremony in one call: it mints the
 * nonce and the deadline, signs through the injected adapter, and returns the
 * block. That is the server and the `wagmi` paths.
 *
 * A publisher's browser cannot use it. There the backend assembles the
 * document — nonce and deadline included — the browser signs whatever it was
 * handed, and gives back a signature and nothing else. That is
 * {@link buildLifecycleTypedData} on one side and
 * {@link lifecycleAuthFromSignature} on the other, and it produces the SAME
 * bytes as the one-call path for the same nonce and deadline, pinned in
 * `src/lifecycle-auth.test.ts`.
 *
 * Source of truth for the format is the facilitator, `x402-rs`
 * `src/payment_operator/lifecycle_auth.rs` (PR #21). The Python twin is
 * `uvd_x402_sdk.escrow_signing.build_lifecycle_auth` (0.78.0); the two must
 * produce byte-identical signatures, pinned here by the shared vector in
 * `src/lifecycle-auth.test.ts`.
 *
 * Facilitator rollout is by `ESCROW_LIFECYCLE_AUTH`: `off` (default, the
 * order is not looked at), `log` (verify when present, log the verdict,
 * never reject) and `enforce`. That is why `lifecycleSigner` is OPTIONAL
 * everywhere: without one, the request goes out byte-for-byte as before.
 *
 * @example Server-side (EnvKeyAdapter)
 * ```typescript
 * import { buildLifecycleAuth, EnvKeyAdapter } from 'uvd-x402-sdk';
 *
 * const auth = await buildLifecycleAuth({
 *   action: 'release',
 *   paymentInfo: pi,          // the SAME camelCase object that is sent
 *   payer: payerAddress,      // payload.payer — NOT inside paymentInfo
 *   amount: '1000000',        // the SAME as payload.amount
 *   chainId: 8453,
 *   wallet: new EnvKeyAdapter(),
 * });
 * // -> payload.lifecycleAuth = auth
 * ```
 */

import { ethers } from 'ethers';
import { X402Error } from './types';

// ============================================================================
// CONSTANTS — mirrored from lifecycle_auth.rs, do not "clean up"
// ============================================================================

/**
 * EIP-712 domain. `chainId` is the payment network's; there is NO
 * `verifyingContract` because `paymentInfo.operator` already rides inside the
 * signed struct. Copied from `lifecycle_auth.rs:69-70` (DOMAIN_NAME /
 * DOMAIN_VERSION).
 */
export const LIFECYCLE_DOMAIN_NAME = 'x402 escrow lifecycle';
export const LIFECYCLE_DOMAIN_VERSION = '1';

/**
 * The facilitator's `deadline` ceiling: 900 s (`lifecycle_auth.rs:64`,
 * `DEFAULT_MAX_DEADLINE_SECS`). A leaked order is not a standing permission.
 */
export const LIFECYCLE_MAX_DEADLINE_SECS = 900;

/**
 * What we sign by default, leaving 300 s of headroom under the ceiling.
 * Signing the full 900 s is an order that a facilitator clock five seconds
 * behind already reads as `deadline_too_far`: the margin is not cosmetic, it
 * is what separates a valid order from a rejection the caller cannot explain.
 */
export const LIFECYCLE_DEFAULT_DEADLINE_SECS = 600;

/** The two wire values, which are also what enters the signature. */
export const LIFECYCLE_ACTIONS = ['release', 'refundInEscrow'] as const;

export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

/**
 * The EIP-712 types. `PaymentInfo` is the AuthCaptureEscrow type string
 * VERBATIM — the same one this SDK already types for ERC-3009. The field
 * ORDER is part of the type hash: reordering it invalidates every order ever
 * issued. Exact mirror of `lifecycle_auth.rs:73-99`.
 */
export const LIFECYCLE_ORDER_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  LifecycleOrder: [
    { name: 'action', type: 'string' },
    { name: 'amount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'paymentInfo', type: 'PaymentInfo' },
  ],
  PaymentInfo: [
    { name: 'operator', type: 'address' },
    { name: 'payer', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'maxAmount', type: 'uint120' },
    { name: 'preApprovalExpiry', type: 'uint48' },
    { name: 'authorizationExpiry', type: 'uint48' },
    { name: 'refundExpiry', type: 'uint48' },
    { name: 'minFeeBps', type: 'uint16' },
    { name: 'maxFeeBps', type: 'uint16' },
    { name: 'feeReceiver', type: 'address' },
    { name: 'salt', type: 'uint256' },
  ],
};

/**
 * The 11 keys the wire `paymentInfo` MUST carry. `payer` is not among them:
 * it travels as a sibling (`payload.payer`), not inside paymentInfo — that is
 * how the facilitator assembles it (`ContractPaymentInfo::from_lifecycle_payload`,
 * `types.rs:275-290`).
 */
const LIFECYCLE_PI_KEYS = [
  'operator',
  'receiver',
  'token',
  'maxAmount',
  'preApprovalExpiry',
  'authorizationExpiry',
  'refundExpiry',
  'minFeeBps',
  'maxFeeBps',
  'feeReceiver',
  'salt',
] as const;

// ============================================================================
// TYPES
// ============================================================================

/** The wire `paymentInfo` of a lifecycle request (camelCase, `salt` in hex). */
export interface LifecyclePaymentInfo {
  operator: string;
  receiver: string;
  token: string;
  /** Atomic units (uint120 on-chain). */
  maxAmount: string | number | bigint;
  preApprovalExpiry: number | string;
  authorizationExpiry: number | string;
  refundExpiry: number | string;
  minFeeBps: number | string;
  maxFeeBps: number | string;
  feeReceiver: string;
  /** 32-byte hex on the wire; uint256 in the signature. */
  salt: string | number | bigint;
}

/**
 * Minimal signer for {@link buildLifecycleAuth}: an address plus EIP-712
 * typed-data signing over the full typed-data JSON string. This is the same
 * contract as `SigningWalletAdapter`, so `EnvKeyAdapter` and
 * `OWSWalletAdapter` satisfy it structurally, and a browser wallet only has
 * to wrap its own `signTypedData` in this shape — the key never leaves it.
 */
export interface LifecycleSigner {
  /** The EVM address that will be claimed as `lifecycleAuth.signer`. */
  getAddress(): string;
  /** Sign the full EIP-712 JSON (`domain`, `types`, `primaryType`, `message`). */
  signTypedData(typedData: string): Promise<{ signature: string }>;
}

/** The block that goes in `payload.lifecycleAuth`. */
export interface LifecycleAuth {
  /** Who claims to have signed. Checked against the recovered address. */
  signer: string;
  /** Unix seconds after which the order is dead. */
  deadline: number;
  /** 32-byte hex replay guard, consumed by the facilitator on success. */
  nonce: string;
  /** 65-byte EIP-712 signature over the `LifecycleOrder`. */
  signature: string;
}

export interface LifecycleTypedDataParams {
  /** `'release'` or `'refundInEscrow'`. */
  action: LifecycleAction;
  /**
   * The paymentInfo EXACTLY as it is serialized on the wire. This same object
   * is signed, which is what keeps the two ends from drifting.
   */
  paymentInfo: LifecyclePaymentInfo;
  /** The escrow's payer — travels as `payload.payer`, not inside paymentInfo. */
  payer: string;
  /** Atomic amount, the SAME one as `payload.amount`. */
  amount: string | number | bigint;
  /** EVM chain id of the payment network. */
  chainId: number;
  /**
   * Unix seconds after which the order is dead. Default: `now + 600`, which
   * leaves 300 s of headroom under the facilitator's 900 s ceiling.
   */
  deadline?: number;
  /**
   * 32 bytes, hex. Default: a fresh random one. Distinct PER ORDER — the
   * facilitator consumes it on acceptance.
   */
  nonce?: string;
  /** Unix seconds, for the `deadline` default and for tests. Default: the clock. */
  now?: number;
}

/**
 * The EIP-712 document itself: what {@link buildLifecycleTypedData} returns and
 * what {@link lifecycleAuthFromSignature} reads back.
 *
 * Named because it is a WIRE type in the split flow: a backend builds it,
 * ships it to a browser as JSON, and the browser hands it to `signTypedData`.
 * `types` carries no `EIP712Domain` entry — ethers and viem both derive that
 * one, and including it makes ethers throw `ambiguous primary types`.
 */
export interface LifecycleTypedData {
  domain: { name: string; version: string; chainId: number };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: 'LifecycleOrder';
  message: Record<string, unknown>;
}

export interface BuildLifecycleAuthParams extends LifecycleTypedDataParams {
  /**
   * The signer. Must be the payer, the receiver or the operator owner
   * depending on the action — see the table in the module docblock.
   */
  wallet: LifecycleSigner;
}

// ============================================================================
// COERCIONS — each one is a rejection the caller cannot see
// ============================================================================

/**
 * `salt` is bytes32 on the wire and uint256 in the signature.
 *
 * The facilitator converts it with `U256::from_be_bytes` (`types.rs:288`):
 * the wire hex enters the signed struct as an INTEGER. Signing it as a
 * string yields a different digest and a mute `bad_signature` whose only
 * symptom is that no order ever verifies.
 */
function saltToBigInt(salt: unknown): bigint {
  if (typeof salt === 'bigint') return salt;
  if (typeof salt === 'number') {
    if (!Number.isInteger(salt) || salt < 0) {
      throw new X402Error(`paymentInfo.salt invalid: ${String(salt)}`, 'INVALID_CONFIG');
    }
    return BigInt(salt);
  }
  if (typeof salt === 'string') {
    const trimmed = salt.trim();
    // A bare hex string with no 0x is still hex here: that is how the wire
    // carries it in some payloads, and reading it as decimal would sign a
    // different struct than the one that is sent.
    const hex = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed : `0x${trimmed}`;
    try {
      return BigInt(hex);
    } catch {
      throw new X402Error(`paymentInfo.salt invalid: ${salt}`, 'INVALID_CONFIG');
    }
  }
  throw new X402Error(`paymentInfo.salt invalid: ${String(salt)}`, 'INVALID_CONFIG');
}

/** 32-byte hex, lowercase, 0x-prefixed — or a throw naming the real length. */
function nonceToBytes32(nonce: unknown): string {
  if (typeof nonce !== 'string') {
    throw new X402Error(`lifecycleAuth.nonce invalid: ${String(nonce)}`, 'INVALID_CONFIG');
  }
  const raw = nonce.startsWith('0x') || nonce.startsWith('0X') ? nonce.slice(2) : nonce;
  if (!/^[0-9a-fA-F]*$/.test(raw)) {
    throw new X402Error(`lifecycleAuth.nonce is not hex: ${nonce}`, 'INVALID_CONFIG');
  }
  if (raw.length !== 64) {
    throw new X402Error(
      `lifecycleAuth.nonce must be 32 bytes, got ${raw.length / 2}`,
      'INVALID_CONFIG'
    );
  }
  return `0x${raw.toLowerCase()}`;
}

/** 32 random bytes as 0x-hex (WebCrypto when available, ethers otherwise). */
function randomNonce(): string {
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webCrypto?.getRandomValues) {
    const bytes = new Uint8Array(32);
    webCrypto.getRandomValues(bytes);
    return ethers.hexlify(bytes);
  }
  return ethers.hexlify(ethers.randomBytes(32));
}

/**
 * The two values that must be IDENTICAL in the signed document and in the
 * `lifecycleAuth` block, resolved in ONE place so the two entry points cannot
 * drift. {@link buildLifecycleAuth} needs them before signing; the split
 * browser flow reads them back out of the document it built.
 */
function resolveOrderTiming(params: { deadline?: number; nonce?: string; now?: number }): {
  nowSec: number;
  deadline: number;
  nonce: string;
} {
  const nowSec = params.now === undefined ? Math.floor(Date.now() / 1000) : Math.floor(params.now);
  return {
    nowSec,
    deadline:
      params.deadline === undefined
        ? nowSec + LIFECYCLE_DEFAULT_DEADLINE_SECS
        : Math.floor(params.deadline),
    nonce: params.nonce === undefined ? randomNonce() : params.nonce,
  };
}

function toUintString(value: unknown, field: string): string {
  let n: bigint;
  try {
    n = typeof value === 'bigint' ? value : BigInt(value as string | number);
  } catch {
    throw new X402Error(`${field} must be a non-negative integer, got ${String(value)}`, 'INVALID_CONFIG');
  }
  if (n < 0n) {
    throw new X402Error(`${field} must be a non-negative integer, got ${String(value)}`, 'INVALID_CONFIG');
  }
  return n.toString();
}

// ============================================================================
// TYPED DATA
// ============================================================================

/**
 * The exact EIP-712 document a lifecycle order signs.
 *
 * Kept separate from {@link buildLifecycleAuth} because it is the useful
 * seam: it is what the Python twin mirrors, what a test can poke field by
 * field to confirm the signature stops verifying, and — the reason it is
 * PUBLIC — what a backend hands to a browser that signs.
 *
 * {@link buildLifecycleAuth} cannot serve that browser: it takes an injected
 * `WalletAdapter` and mints its own nonce and deadline, while a publisher
 * signs a document the backend already assembled and hands back only a
 * signature. Build it here, ship it, and reassemble the wire block with
 * {@link lifecycleAuthFromSignature} — which reads `deadline` and `nonce`
 * back out of this same document, so the two cannot disagree.
 *
 * @example The split flow, backend half
 * ```typescript
 * const typedData = buildLifecycleTypedData({
 *   action: 'release',
 *   paymentInfo: pi,   // the SAME object that will be sent
 *   payer,             // payload.payer
 *   amount,            // the SAME as payload.amount
 *   chainId: 8453,
 * });                  // deadline -> now + 600, nonce -> 32 fresh bytes
 * // -> res.json({ typedData })  ... the browser signs it and posts back a signature
 * const lifecycleAuth = lifecycleAuthFromSignature(typedData, signature, payer);
 * ```
 *
 * @throws {X402Error} `INVALID_CONFIG` on an unknown action or a paymentInfo
 *   missing a field; `INVALID_AMOUNT` on a negative amount. Nothing IN THE
 *   SIGNED STRUCT is defaulted: an invented field is a signature over a
 *   different struct than the one that is sent, i.e. a rejection the caller
 *   cannot diagnose. `deadline` and `nonce` are the exception because they
 *   exist nowhere else — they are born here and read back from the document.
 */
export function buildLifecycleTypedData(params: LifecycleTypedDataParams): LifecycleTypedData {
  const { action, paymentInfo, payer, amount, chainId } = params;
  const { deadline, nonce } = resolveOrderTiming(params);

  if (!LIFECYCLE_ACTIONS.includes(action)) {
    throw new X402Error(
      `unknown lifecycle action ${String(action)}; the facilitator only signs ${LIFECYCLE_ACTIONS.join(', ')}`,
      'INVALID_CONFIG'
    );
  }

  let amountBig: bigint;
  try {
    amountBig = typeof amount === 'bigint' ? amount : BigInt(amount);
  } catch {
    throw new X402Error(`amount must be an integer >= 0, got ${String(amount)}`, 'INVALID_AMOUNT');
  }
  if (amountBig < 0n) {
    throw new X402Error(`amount must be an integer >= 0, got ${String(amount)}`, 'INVALID_AMOUNT');
  }

  const pi = (paymentInfo ?? {}) as unknown as Record<string, unknown>;
  const missing = LIFECYCLE_PI_KEYS.filter((k) => pi[k] === undefined);
  if (missing.length > 0) {
    throw new X402Error(
      `paymentInfo is missing fields that enter the signature: ${missing.join(', ')}. ` +
        'The paymentInfo that is SENT is the one that is signed; defaulting a field would ' +
        'sign a different struct than the one that reaches the facilitator.',
      'INVALID_CONFIG'
    );
  }

  return {
    domain: {
      name: LIFECYCLE_DOMAIN_NAME,
      version: LIFECYCLE_DOMAIN_VERSION,
      chainId: Number(chainId),
    },
    types: LIFECYCLE_ORDER_TYPES,
    primaryType: 'LifecycleOrder',
    message: {
      action,
      amount: amountBig.toString(),
      deadline: toUintString(deadline, 'deadline'),
      nonce: nonceToBytes32(nonce),
      paymentInfo: {
        operator: ethers.getAddress(paymentInfo.operator),
        payer: ethers.getAddress(payer),
        receiver: ethers.getAddress(paymentInfo.receiver),
        token: ethers.getAddress(paymentInfo.token),
        maxAmount: toUintString(paymentInfo.maxAmount, 'paymentInfo.maxAmount'),
        preApprovalExpiry: toUintString(paymentInfo.preApprovalExpiry, 'paymentInfo.preApprovalExpiry'),
        authorizationExpiry: toUintString(
          paymentInfo.authorizationExpiry,
          'paymentInfo.authorizationExpiry'
        ),
        refundExpiry: toUintString(paymentInfo.refundExpiry, 'paymentInfo.refundExpiry'),
        minFeeBps: toUintString(paymentInfo.minFeeBps, 'paymentInfo.minFeeBps'),
        maxFeeBps: toUintString(paymentInfo.maxFeeBps, 'paymentInfo.maxFeeBps'),
        feeReceiver: ethers.getAddress(paymentInfo.feeReceiver),
        // uint256 in the signature, bytes32 on the wire — see saltToBigInt.
        salt: saltToBigInt(paymentInfo.salt).toString(),
      },
    },
  };
}

// ============================================================================
// THE ORDER
// ============================================================================

/**
 * Sign the order and return the complete `payload.lifecycleAuth` block.
 *
 * This is the first link of enforce: the facilitator already verifies these
 * orders in `log` mode and measured ZERO signatures across 17 days of traffic
 * (2,953 release/refund, 22 payers, 9 networks) — the field did not exist and
 * nobody sent it. Under `enforce` today, 100% would be rejected.
 *
 * The signer is INJECTED; the SDK does not read keys from the environment.
 *
 * @throws {X402Error} `INVALID_CONFIG` if the deadline has already passed or
 *   sits past the facilitator's 900 s ceiling. It fails HERE and not there:
 *   an out-of-window order is an `expired` / `deadline_too_far` that under
 *   `enforce` is stuck money, and the caller has no log to see it in.
 */
export async function buildLifecycleAuth(
  params: BuildLifecycleAuthParams
): Promise<LifecycleAuth> {
  const { wallet, ...rest } = params;

  const { nowSec, deadline: dl, nonce: nonceHex } = resolveOrderTiming(params);

  if (dl < nowSec) {
    throw new X402Error(
      `deadline ${dl} is in the past (now ${nowSec}): the facilitator discards it as \`expired\``,
      'INVALID_CONFIG'
    );
  }
  if (dl - nowSec > LIFECYCLE_MAX_DEADLINE_SECS) {
    throw new X402Error(
      `deadline ${dl} is ${dl - nowSec} s ahead and the facilitator's ceiling is ` +
        `${LIFECYCLE_MAX_DEADLINE_SECS} s (\`deadline_too_far\`): a leaked order cannot be a ` +
        'standing permission',
      'INVALID_CONFIG'
    );
  }

  const typed = buildLifecycleTypedData({ ...rest, deadline: dl, nonce: nonceHex });
  const signed = await wallet.signTypedData(JSON.stringify(typed));

  return {
    signer: wallet.getAddress(),
    deadline: dl,
    nonce: nonceToBytes32(nonceHex),
    signature: signed.signature,
  };
}

/**
 * Reassemble `payload.lifecycleAuth` from a document that was signed
 * ELSEWHERE — the other half of the split flow.
 *
 * `buildLifecycleAuth` owns the whole ceremony: it mints the nonce and the
 * deadline, signs, and returns the block. A publisher's browser owns none of
 * that. It receives a document the backend already assembled and gives back
 * one string. This is the seam where that string becomes a wire block.
 *
 * `deadline` and `nonce` are NOT parameters: they are read out of
 * `typedData.message`, which is the document that was actually hashed. Taking
 * them from the caller would let the block claim a nonce the signature never
 * committed to — a `bad_signature` the caller cannot see, because both halves
 * look right on their own.
 *
 * The signature is NOT recovered here. This SDK's payers include ERC-7702
 * delegated accounts and contract wallets that validate through ERC-1271
 * (`src/erc7702.ts:8`), whose signatures do not ecrecover to their address;
 * `ethers.verifyTypedData` would reject the good ones. Recovery — and the
 * role check that goes with it — is the facilitator's, against the chain.
 *
 * @param typedData - what {@link buildLifecycleTypedData} returned, unmodified.
 * @param signature - the 0x-hex the wallet gave back (`signTypedData`).
 * @param signer - the address that signed, claimed in the block and checked
 *   against the recovered one by the facilitator.
 *
 * @throws {X402Error} `INVALID_CONFIG` if the document is not a
 *   `LifecycleOrder` for this domain, if the signature is not hex, or if the
 *   signer is not an address.
 *
 * @example The browser half
 * ```typescript
 * const signature = await walletClient.signTypedData({
 *   domain: typedData.domain,
 *   types: typedData.types,
 *   primaryType: typedData.primaryType,
 *   message: typedData.message,
 * });
 * const lifecycleAuth = lifecycleAuthFromSignature(typedData, signature, address);
 * ```
 */
export function lifecycleAuthFromSignature(
  typedData: LifecycleTypedData,
  signature: string,
  signer: string
): LifecycleAuth {
  const td = (typedData ?? {}) as Partial<LifecycleTypedData>;
  const message = (td.message ?? {}) as Record<string, unknown>;

  // A payment's typed data would sail through the shape checks below and
  // produce a block over the wrong struct entirely, so the document is
  // identified before anything is read out of it.
  if (td.primaryType !== 'LifecycleOrder') {
    throw new X402Error(
      `typedData.primaryType must be LifecycleOrder, got ${String(td.primaryType)}: ` +
        'pass the document buildLifecycleTypedData returned, unmodified',
      'INVALID_CONFIG'
    );
  }
  const domain = (td.domain ?? {}) as Record<string, unknown>;
  if (
    domain.name !== LIFECYCLE_DOMAIN_NAME ||
    String(domain.version) !== LIFECYCLE_DOMAIN_VERSION
  ) {
    throw new X402Error(
      `typedData.domain must be ${LIFECYCLE_DOMAIN_NAME} v${LIFECYCLE_DOMAIN_VERSION}, got ` +
        `${String(domain.name)} v${String(domain.version)}`,
      'INVALID_CONFIG'
    );
  }
  if (message.deadline === undefined || message.nonce === undefined) {
    throw new X402Error(
      'typedData.message carries no deadline/nonce: the wire block reads them from the ' +
        'document that was signed, it does not invent them',
      'INVALID_CONFIG'
    );
  }

  // uint256 in the signature, a JSON number on the wire. The facilitator's
  // block is typed `u64`, so a deadline that lost precision here is an
  // `expired` on an order whose signature is perfectly good.
  const deadlineBig = BigInt(toUintString(message.deadline, 'typedData.message.deadline'));
  if (deadlineBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new X402Error(
      `typedData.message.deadline ${deadlineBig} does not fit a JSON number`,
      'INVALID_CONFIG'
    );
  }

  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature) ||
      signature.length % 2 !== 0) {
    throw new X402Error(
      `signature must be 0x-prefixed hex, got ${String(signature)}`,
      'INVALID_CONFIG'
    );
  }

  let checksummed: string;
  try {
    checksummed = ethers.getAddress(signer);
  } catch {
    throw new X402Error(`signer is not an EVM address: ${String(signer)}`, 'INVALID_CONFIG');
  }

  return {
    signer: checksummed,
    deadline: Number(deadlineBig),
    nonce: nonceToBytes32(message.nonce),
    signature,
  };
}

// ============================================================================
// BROWSER SIGNERS
// ============================================================================

/**
 * Minimal wagmi/viem wallet client: what {@link wagmiLifecycleSigner} needs.
 *
 * Deliberately narrower than this SDK's payment `WalletClient`: a lifecycle
 * domain has NO `verifyingContract`, so a client typed to require one cannot
 * sign these orders.
 */
export interface WagmiLifecycleWalletClient {
  account?: { address: string } | null;
  signTypedData(args: {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<string>;
}

/**
 * Wrap a wagmi/viem wallet client as a {@link LifecycleSigner}, so the PAYER
 * signs the order in their own browser with the same wallet they paid with,
 * and the marketplace only transports the block.
 *
 * @param walletClient - from `useWalletClient()` (wagmi) or `createWalletClient` (viem).
 * @param address - the signing account; defaults to `walletClient.account.address`.
 *
 * @example
 * ```typescript
 * const { data: walletClient } = useWalletClient();
 * const auth = await buildLifecycleAuth({
 *   action: 'release',
 *   paymentInfo: pi,
 *   payer: address,
 *   amount: task.bountyAtomic,
 *   chainId: 8453,
 *   wallet: wagmiLifecycleSigner(walletClient!),
 * });
 * await fetch('/api/tasks/x/approve', {
 *   method: 'POST',
 *   body: JSON.stringify({ lifecycleAuth: auth }),
 * });
 * ```
 */
export function wagmiLifecycleSigner(
  walletClient: WagmiLifecycleWalletClient,
  address?: string
): LifecycleSigner {
  const account = address ?? walletClient.account?.address;
  if (!account) {
    throw new X402Error(
      'wagmiLifecycleSigner needs an account: pass one, or connect the wallet client first',
      'INVALID_CONFIG'
    );
  }
  const checksummed = ethers.getAddress(account);
  return {
    getAddress: () => checksummed,
    async signTypedData(typedData: string) {
      const parsed = JSON.parse(typedData) as {
        domain: Record<string, unknown>;
        types: Record<string, Array<{ name: string; type: string }>>;
        primaryType: string;
        message: Record<string, unknown>;
      };
      const signature = await walletClient.signTypedData({
        domain: parsed.domain,
        types: parsed.types,
        primaryType: parsed.primaryType,
        message: parsed.message,
      });
      return { signature };
    },
  };
}
