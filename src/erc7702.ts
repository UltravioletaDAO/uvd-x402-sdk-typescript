/**
 * EIP-7702: make a DELEGATED EOA's EIP-3009 signature settle again.
 *
 * **THE PROBLEM.** A gasless-wallet provider's first sponsored operation on a
 * chain may delegate the user's EOA (EIP-7702) to a smart-account
 * implementation — Alchemy's `SemiModularAccount7702` (`0x69007702…`) is the one
 * seen in the wild. From then on the address HAS code, so Circle's USDC (and any
 * `SignatureChecker` consumer) verifies signatures via **ERC-1271 only**. A raw
 * ECDSA authorization, however perfect, is rejected: `0x151d90fe`. The account is
 * not broken and the signature is not wrong — they simply no longer speak the
 * same dialect.
 *
 * Consequence for anything x402: a delegated payer's `transferWithAuthorization`
 * / `receiveWithAuthorization` becomes **unsettleable on-chain**, so direct x402
 * payments AND marketplace escrow locks both fail. Measured in production
 * 2026-07-31: 14 of 14 delegated agents failed their escrow lock; the one
 * non-delegated agent locked fine. The failure is silent in the worst way — the
 * sellers looked broken and they were correct.
 *
 * **THE FIX** (verified on-chain; the wallet provider needs to change nothing).
 * That account's `isValidSignature` DOES accept the EOA's own ECDSA — it just
 * wants it in the account's envelope. Two steps, both provable against the
 * verified source (`SemiModularAccountBase._exec1271Validation` +
 * `SparseCalldataSegmentLib`):
 *
 * 1. The account does not check `hash` directly; it checks a REPLAY-SAFE hash =
 *    EIP-712 over the account's OWN domain
 *    `EIP712Domain(uint256 chainId, address verifyingContract=account)` with
 *    struct `ReplaySafeHash(bytes32 hash)`. Sign THAT, not the transfer digest.
 * 2. Wrap the 65-byte signature with the account's fallback-validation locator:
 *    `0x00 00000000` (validation type 0, entity id 0 = FALLBACK_VALIDATION_ID)
 *    `FF` (RESERVED_VALIDATION_DATA_INDEX, the final segment) `00`
 *    (SignatureType.EOA).
 *
 * Because step 1 is still an ordinary typed-data signature, a REMOTE signer (a
 * delegated agentic wallet) can produce it: the private key is never needed
 * locally.
 *
 * **THE WRAP IS DELEGATE-SPECIFIC, NOT "delegated == wrap".** This is the part
 * that bit us on 2026-08-25, and it is why this module exists in TypeScript at
 * all: the moment a worker rates an agent through the facilitator's EIP-7702
 * feedback rail, their EOA becomes delegated to Execution Market's
 * `FeedbackDelegate` — which validates PLAIN ECDSA
 * (`ECDSA.recover(hash, sig) == address(this)`). Wrapping that signature makes it
 * invalid, so *the act of rating would break the rater's next payment*. Same
 * silent-at-lock-time failure the wrap was built to fix, now caused by
 * over-applying it.
 *
 * **DETECTION IS INJECTABLE, ON PURPOSE.** Knowing whether an address is
 * delegated needs one `eth_getCode` — a chain read, and this SDK does not own an
 * RPC policy. So detection is a callable you pass in ({@link DelegationResolver}).
 * {@link rpcDelegationResolver} ships a default over `fetch`; a caller with its
 * own endpoints, proxy or rotation passes its own.
 *
 * **THE THIRD STATE IS LOAD-BEARING.** A resolver returns `true` / `false` /
 * **`null` = could not tell**. `null` must never collapse to "not delegated":
 * that is exactly how the original bug survived eight days — the resolver failed,
 * returned nothing, and the caller's `if (delegated)` read it as falsy and signed
 * raw. **An unreadable answer is not a negative answer.**
 *
 * Port of `uvd_x402_sdk.erc7702` (Python). Keep the two in step: they are the
 * same protocol seen from two languages, and a divergence here is a signature
 * that cannot settle.
 */

/** EIP-7702 delegation designator. */
export const DELEGATE_PREFIX = 'ef0100';

/**
 * Delegate targets whose ERC-1271 needs the account-envelope wrap.
 *
 * Only a known Alchemy SMA implementation needs it. Every other delegate signs
 * PLAIN (the standard 1271 "smart-EOA" pattern accepts the EOA's own ECDSA), and
 * if some exotic future delegate needs a third dialect it fails VISIBLY at lock
 * time — never silently.
 *
 * Notably NOT here: Execution Market's `FeedbackDelegate` (all nine deploys). An
 * account that has rated through the facilitator's rail is delegated to it and
 * must sign plain.
 */
export const SMA_WRAP_TARGETS: readonly string[] = [
  '0x69007702764179f14f51cdce752f4f775d74e139', // Alchemy SemiModularAccount7702
];

/**
 * `true` only when this delegate target needs the account-envelope wrap.
 *
 * A plain EOA (`target` null/undefined) and any other delegate — FeedbackDelegate,
 * a standard 1271 smart-EOA — do NOT: they take the ordinary ECDSA signature.
 */
export function needsAccountWrap(target: string | null | undefined): boolean {
  return !!target && SMA_WRAP_TARGETS.includes(target.toLowerCase());
}

/**
 * Account fallback-validation locator + final-segment marker + EOA signature type.
 *
 * - `0x00 00000000` — validation type 0, entity id 0 (FALLBACK_VALIDATION_LOOKUP_KEY)
 * - `0xFF`          — RESERVED_VALIDATION_DATA_INDEX (getFinalSegment)
 * - `0x00`          — SignatureType.EOA
 */
const WRAP_PREFIX = '00000000' + '00' + 'ff' + '00';

/**
 * The delegate target this EOA's EIP-7702 code points at, or `null`.
 *
 * `null` for a plain EOA, for non-7702 code, and for anything unparseable — the
 * caller confirms the implementation before applying the wrap.
 */
export function delegateTarget(code: string | null | undefined): string | null {
  if (!code) return null;
  const h = (code.startsWith('0x') ? code.slice(2) : code).toLowerCase();
  if (!h.startsWith(DELEGATE_PREFIX) || h.length < 46) return null;
  return `0x${h.slice(6, 46)}`;
}

/** Wrap a 65-byte ECDSA signature in the account's fallback-EOA envelope. */
export function wrapSignature(innerSignature: string): string {
  const s = innerSignature.startsWith('0x') ? innerSignature.slice(2) : innerSignature;
  return `0x${WRAP_PREFIX}${s}`;
}

/**
 * The typed data whose signature the delegated account accepts.
 *
 * The domain is the ACCOUNT's own — `chainId` + `verifyingContract=account`, the
 * two fields its typehash declares — and the struct is
 * `ReplaySafeHash(bytes32 hash)` over the inner EIP-3009 digest. Signing THIS,
 * not the digest, is what validates.
 */
export function replaySafeTypedData(
  innerDigest: string,
  chainId: number,
  account: string
): { domain: Record<string, unknown>; types: Record<string, unknown>; message: Record<string, unknown> } {
  return {
    domain: { chainId, verifyingContract: account },
    types: { ReplaySafeHash: [{ name: 'hash', type: 'bytes32' }] },
    message: { hash: innerDigest },
  };
}

/**
 * `(address, network) -> target | true | false | null`.
 *
 * Four answers, richer than a boolean on purpose: a resolver MAY return the
 * delegate **target address** (a string) instead of just `true` — that is what
 * lets the caller pick the right signing dialect (SMA wrap vs plain). `true` =
 * delegated, target unknown; `false` = not delegated; `null` = UNKNOWN
 * (unreadable chain), never "no".
 */
export type DelegationResolver = (
  address: string,
  network: string
) => Promise<string | boolean | null> | (string | boolean | null);

/**
 * A default resolver over plain JSON-RPC `eth_getCode`, using `fetch`.
 *
 * Rotates through `urls` and returns `null` when **every** endpoint failed: an
 * unreadable chain is not a "not delegated" verdict.
 *
 * A caller with its own RPC policy (a signed proxy, paid endpoints, per-chain
 * routing) should pass its own resolver instead; that is the whole point of the
 * injection.
 */
export function rpcDelegationResolver(
  urls: string | string[],
  timeoutMs = 6000
): DelegationResolver {
  const endpoints = typeof urls === 'string' ? [urls] : [...urls];

  return async (address: string): Promise<string | boolean | null> => {
    const addr = (address || '').trim();
    if (!addr || endpoints.length === 0) return null;

    for (const url of endpoints) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getCode',
            params: [addr.toLowerCase(), 'latest'],
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) continue;
        const code = (await res.json())?.result;
        if (typeof code === 'string' && code.startsWith('0x')) {
          // Return the TARGET when delegated, so the caller can pick the signing
          // dialect; `false` for a plain EOA (readable, no delegation).
          return delegateTarget(code) ?? false;
        }
      } catch {
        clearTimeout(timer);
        // Rotate to the next endpoint. Exhausting them all is UNKNOWN, below.
      }
    }
    return null;
  };
}

/** `{ delegated, target }` for one address on one network. */
export interface DelegationVerdict {
  /** `null` = UNKNOWN. Never treat it as `false`. */
  delegated: boolean | null;
  /** The delegate implementation, when the resolver could name it. */
  target: string | null;
}

/**
 * Resolve one address's delegation on one network.
 *
 * - `{delegated: null, target: null}` — unknown (no resolver, or an unreadable
 *   chain). NEVER "no".
 * - `{delegated: false, target: null}` — a plain EOA.
 * - `{delegated: true, target: '0x…'}` — delegated, and we know to WHAT (pick the
 *   dialect from it).
 * - `{delegated: true, target: null}` — delegated, target unknown (a legacy
 *   boolean-only resolver).
 */
export async function resolveDelegation(
  address: string,
  network: string,
  resolver?: DelegationResolver
): Promise<DelegationVerdict> {
  if (!resolver) return { delegated: null, target: null };

  let v: string | boolean | null;
  try {
    v = await resolver(address, network);
  } catch {
    // A broken resolver is UNKNOWN, not a negative.
    return { delegated: null, target: null };
  }

  if (typeof v === 'string') {
    const t = v.trim();
    // Only a real 20-byte address counts as a target. A non-address string is
    // garbage, and garbage is UNKNOWN — never a verdict we sign on.
    if (/^0x[0-9a-fA-F]{40}$/.test(t)) return { delegated: true, target: t };
    return { delegated: null, target: null };
  }
  if (typeof v === 'boolean') return { delegated: v, target: null };
  return { delegated: null, target: null };
}

/**
 * `true` / `false` / `null` (**unknown**) for one address on one network.
 *
 * Without a resolver the answer is `null`, never `false`: "nobody asked" and "the
 * address is a plain EOA" are different facts and only one of them is safe to
 * sign on.
 */
export async function isDelegated(
  address: string,
  network: string,
  resolver?: DelegationResolver
): Promise<boolean | null> {
  return (await resolveDelegation(address, network, resolver)).delegated;
}
