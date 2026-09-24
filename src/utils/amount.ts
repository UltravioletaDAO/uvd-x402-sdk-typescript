/**
 * uvd-x402-sdk - Decimal amount to atomic units, exactly
 *
 * The one conversion every non-EVM provider and the seller-side builders use to
 * turn a decimal amount string into the integer the chain moves.
 */

import { parseUnits } from 'ethers';

import { X402Error } from '../types';

/** Digits with at most one dot and at least one digit: "2", "2.01", "2.", ".5". */
const PLAIN_DECIMAL = /^(?:\d+\.?\d*|\.\d+)$/;

/**
 * Convert a decimal amount string to integer atomic units of a token with
 * `decimals` places -- `toAtomicUnits('2.01', 6) === 2010000n` -- without ever
 * holding the amount in a JavaScript number.
 *
 * `Math.floor(parseFloat(amount) * 1e6)` is not this. 2.01 has no exact binary
 * form, `2.01 * 1e6` evaluates to 2009999.9999999998, and the floor signs one
 * atom less than the price: 151 of the 9,999 cent prices from 0.01 to 99.99 come
 * out short. Where the facilitator compares amounts by equality, every one of
 * them is rejected.
 *
 * The digit arithmetic is ethers' `parseUnits`, the same function the EVM path
 * signs with, so one string yields one atomic amount on every chain family. On
 * top of it this refuses, with `INVALID_AMOUNT`, anything that is not a plain
 * non-negative decimal (a sign, an exponent, whitespace, a non-string) and any
 * nonzero digit past `decimals`, which could only be paid by dropping it.
 * Trailing zeros past `decimals` are accepted, as in `parseUnits`: `'1.0000000'`
 * is exactly 1000000 at 6 decimals.
 *
 * @param amount - Decimal amount in whole units of the token, e.g. `"2.01"`
 * @param decimals - The token's decimals (6 for USDC, 7 for Stellar USDC)
 * @returns The amount in atomic units
 * @throws X402Error `INVALID_AMOUNT` when the amount is malformed or cannot be
 *         represented exactly in `decimals` places
 */
export function toAtomicUnits(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new X402Error(`Invalid token decimals: ${decimals}`, 'INVALID_CONFIG');
  }

  if (typeof amount !== 'string' || !PLAIN_DECIMAL.test(amount)) {
    const shown = typeof amount === 'string' ? JSON.stringify(amount) : `a ${typeof amount}`;
    throw new X402Error(
      `Invalid payment amount: ${shown}. Expected a plain non-negative decimal ` +
        'string such as "2.01" (no sign, exponent or spaces).',
      'INVALID_AMOUNT'
    );
  }

  const fraction = amount.split('.')[1] ?? '';
  if (/[1-9]/.test(fraction.slice(decimals))) {
    throw new X402Error(
      `Payment amount "${amount}" has more decimal places than the token's ${decimals}; ` +
        'it cannot be paid exactly.',
      'INVALID_AMOUNT'
    );
  }

  return parseUnits(amount, decimals);
}
