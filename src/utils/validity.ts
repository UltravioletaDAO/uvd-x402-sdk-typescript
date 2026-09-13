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
 * Why 300 and not 60 or 3600: 300 is what the facilitator publishes as
 * `max_timeout_seconds` in its own discovery document (`x402-rs`,
 * `src/discovery.rs`), so it is the vendor's number, not a guess. The
 * facilitator only ever rejects a window for being too SHORT — `assert_time`
 * refuses `valid_before < now + 6 s` (`x402-rs`, `src/chain/evm.rs`) — and puts
 * no ceiling on it, which is why a caller may raise this as far as it likes.
 *
 * The Python SDK's equivalent (`valid_duration`, 3600 s) stays where it is: the
 * two SDKs still differ, but now both are configurable and the TypeScript
 * default is the one the facilitator advertises.
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
 * A ceiling exists because {@link PaymentInfo} is shaped like "what the backend
 * returned on its 402", and a caller that hands a parsed 402 body straight to
 * `createPayment` would let the SELLER pick how long the buyer's authorization
 * stays alive. A year-long window is a standing claim on the payer's balance:
 * the resource is never delivered, the authorization looks expired to a buyer
 * who assumed minutes, and it settles months later against a funded wallet.
 * Cancelling one costs gas and knowing the nonce.
 *
 * 3600 and not something rounder: it is the largest window anything in this
 * stack signs today — the Python SDK's `valid_duration` default — so nothing
 * that works now is refused by this limit. The facilitator itself puts no
 * ceiling on `validBefore` (it only rejects windows that are too short), which
 * is precisely why the payer's SDK has to.
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
