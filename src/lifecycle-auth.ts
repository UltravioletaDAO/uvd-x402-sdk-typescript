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
  /** Unix seconds after which the order is dead. */
  deadline: number;
  /** 32 bytes, hex. */
  nonce: string;
}

export interface BuildLifecycleAuthParams
  extends Omit<LifecycleTypedDataParams, 'deadline' | 'nonce'> {
  /**
   * The signer. Must be the payer, the receiver or the operator owner
   * depending on the action — see the table in the module docblock.
   */
  wallet: LifecycleSigner;
  /** Unix seconds. Default: `now + 600`. */
  deadline?: number;
  /**
   * 32 bytes in hex. Default: a fresh random one. Distinct PER ORDER — the
   * facilitator consumes it on acceptance (a stream's partial settles emit
   * one per delta).
   */
  nonce?: string;
  /** Unix seconds, for tests. Default: the clock. */
  now?: number;
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
 * seam: it is what the Python twin mirrors, and what a test can poke field
 * by field to confirm the signature stops verifying.
 *
 * @throws {X402Error} `INVALID_CONFIG` on an unknown action or a paymentInfo
 *   missing a field; `INVALID_AMOUNT` on a negative amount. Nothing is
 *   defaulted: an invented field is a signature over a different struct than
 *   the one that is sent, i.e. a rejection the caller cannot diagnose.
 */
export function buildLifecycleTypedData(params: LifecycleTypedDataParams): {
  domain: { name: string; version: string; chainId: number };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: 'LifecycleOrder';
  message: Record<string, unknown>;
} {
  const { action, paymentInfo, payer, amount, chainId, deadline, nonce } = params;

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
  const { wallet, deadline, nonce, now, ...rest } = params;

  const nowSec = now === undefined ? Math.floor(Date.now() / 1000) : Math.floor(now);
  const dl = deadline === undefined ? nowSec + LIFECYCLE_DEFAULT_DEADLINE_SECS : Math.floor(deadline);
  const nonceHex = nonce === undefined ? randomNonce() : nonce;

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
