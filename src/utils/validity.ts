/**
 * uvd-x402-sdk - EIP-3009 validity window
 *
 * How long a signed authorization stays settleable: `validBefore = now +
 * validitySeconds`. One definition, read by every EVM signing path, because the
 * number used to be written twice — `X402Client.createEVMPayment` and
 * `EVMProvider.signPayment` each carried their own copy of a per-chain ternary:
 * 300 s on Base, 60 s on every other network.
 *
 * Why the per-chain ternary is gone: the window is not a property of the chain,
 * it is how long the SELLER needs to settle, and the seller is the one party
 * that could not set it. A seller that settles async — verify, hand over the
 * resource, settle afterwards — has to land the settlement inside this window
 * or the authorization expires by itself and a paid-for resource gets revoked.
 * That is MeshRelay Turnstile's exact flow. On Base (300 s) nobody ever felt it;
 * on the other eleven EVM networks the buyer had 60 s, minus the facilitator's
 * 6 s clock-skew grace, to open a wallet and sign.
 *
 * Why 300 and not 60 or 3600 — where the number actually comes from:
 *   - it is the timeout the seller side of THIS SDK announces by default
 *     (`DEFAULT_PAYMENT_TIMEOUT_SECONDS` in `src/backend/index.ts`), so a buyer
 *     and a seller both built on `uvd-x402-sdk` agree without configuring
 *     anything;
 *   - it is what MeshRelay Turnstile, the async seller that surfaced this,
 *     announces (`timeoutSeconds: 300` in its `turnstile/payments.js`);
 *   - it is the fallback the facilitator's catalog applies to a seller entry
 *     that omits the field (`DEFAULT_MAX_TIMEOUT_SECS` in `x402-rs`
 *     `src/discovery_price.rs`). That is a catalog default, not a timeout the
 *     facilitator enforces or advertises for itself: its `/supported` carries
 *     no timeout at all.
 *
 * The facilitator only ever rejects a window for being too SHORT — `assert_time`
 * (`x402-rs`, `src/chain/evm.rs`), which runs in both verify and settle, refuses
 * `valid_before < now + 6 s` — and compares `valid_before` against no ceiling.
 * That is why the ceiling below lives in the payer's SDK, and why signing LESS
 * than a seller declared is the failure that bites.
 *
 * When the seller's 402 declares `maxTimeoutSeconds`, `X402Client.fetch()` signs
 * that window instead of the client's own; see {@link clampValiditySeconds}.
 *
 * The Python SDK's equivalent (`valid_duration`, 3600 s) stays where it is: the
 * two SDKs still differ, but both are configurable now.
 */

import { X402Error } from '../types';

/**
 * Seconds an EIP-3009 authorization stays valid when nobody says otherwise.
 *
 * Exported so a consumer can READ the effective default instead of re-typing
 * `300` in its own timeout math.
 */
export const DEFAULT_VALIDITY_SECONDS = 300;

/**
 * Longest window this SDK will sign, one hour.
 *
 * A ceiling exists because the seller gets a say in the window: `fetch()`
 * honours the `maxTimeoutSeconds` a 402 declares, and {@link PaymentInfo} is
 * shaped like "what the backend returned on its 402", so a caller that hands a
 * parsed 402 body straight to `createPayment` lets the seller pick too. Without
 * a limit, a year-long window is a standing claim on the payer's balance: the
 * resource is never delivered, the authorization looks expired to a buyer who
 * assumed minutes, and it settles months later against a funded wallet.
 * Cancelling one costs gas and knowing the nonce.
 *
 * 3600 and not something rounder: it is the largest window anything in this
 * stack signs today — the Python SDK's `valid_duration` default — so nothing
 * that works now is refused by this limit.
 */
export const MAX_VALIDITY_SECONDS = 3600;

/**
 * Pick the validity window for one payment, most specific source first.
 *
 * @param perPayment - `PaymentInfo.validitySeconds`, the window for this single
 *   payment. Wins over everything.
 * @param clientDefault - `X402ClientConfig.validitySeconds`, the window this
 *   client signs with when a payment does not ask for one.
 * @returns The window in whole seconds; {@link DEFAULT_VALIDITY_SECONDS} when
 *   neither source named one.
 * @throws {X402Error} `INVALID_CONFIG` when a source named something that is not
 *   a positive whole number of seconds, or more than
 *   {@link MAX_VALIDITY_SECONDS}. Thrown rather than silently falling back to
 *   the default: a caller that asked for a window and got a different one would
 *   be signing an authorization it did not choose, and the mistake would only
 *   surface as a failed settlement much later.
 */
export function resolveValiditySeconds(
  perPayment?: number,
  clientDefault?: number
): number {
  const chosen = perPayment ?? clientDefault ?? DEFAULT_VALIDITY_SECONDS;

  // `Number.isInteger` is false for NaN, Infinity and 1.5 alike, and a
  // fractional window would reach `validBefore` as a fractional unix timestamp
  // that the EIP-712 uint256 encoder rejects anyway — just later, and with a
  // message about the signature rather than about the window.
  if (!Number.isInteger(chosen) || chosen <= 0) {
    throw new X402Error(
      `validitySeconds must be a positive whole number of seconds, got ${String(chosen)}`,
      'INVALID_CONFIG',
      { validitySeconds: chosen }
    );
  }

  if (chosen > MAX_VALIDITY_SECONDS) {
    throw new X402Error(
      `validitySeconds must be at most ${MAX_VALIDITY_SECONDS} seconds, got ${String(chosen)}. ` +
        'A longer window is a standing claim on the payer: it can be settled long ' +
        'after the payer gave the payment up for expired.',
      'INVALID_CONFIG',
      { validitySeconds: chosen, max: MAX_VALIDITY_SECONDS }
    );
  }

  return chosen;
}

/**
 * The window to sign when a seller's 402 declared `maxTimeoutSeconds`.
 *
 * The seller's number wins over the client's configured window: it is the one
 * party that knows how long its settlement takes, and since the facilitator
 * never rejects a window for being long, signing less than it declared only
 * produces an authorization that dies before the seller's own settle.
 *
 * Clamped to `[1, MAX_VALIDITY_SECONDS]` rather than refused, because a 402 is
 * the seller's declaration and not the buyer's config: a seller asking for a
 * day still gets paid, inside the payer's ceiling. A fractional declaration is
 * floored.
 */
export function clampValiditySeconds(maxTimeoutSeconds: number): number {
  return Math.min(MAX_VALIDITY_SECONDS, Math.max(1, Math.floor(maxTimeoutSeconds)));
}
