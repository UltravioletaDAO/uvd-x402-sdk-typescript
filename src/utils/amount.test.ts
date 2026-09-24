/**
 * `toAtomicUnits` -- the decimal-string -> atomic-units conversion every non-EVM
 * provider and both seller-side builders go through.
 *
 * The defect it replaces: `Math.floor(parseFloat(amount) * 1e6)`. `2.01 * 1e6` is
 * 2009999.9999999998 in binary floating point, so the floor signed one atom less
 * than the price -- 151 of the 9,999 cent prices 0.01..99.99 at 6 decimals, 636 of
 * them at Stellar's 7. A facilitator that compares non-EVM amounts by equality
 * rejects each of those payments.
 */
import { describe, expect, it } from 'vitest';
import { formatUnits, parseUnits } from 'ethers';

import { toAtomicUnits } from './amount';
import { generatePaymentOptions } from './x402';
import { buildPaymentRequirements } from '../backend';
import { getChainByName } from '../chains';
import { X402Error } from '../types';

/** Cent count -> the price string a seller writes: 201 -> "2.01". */
function cents(c: number): string {
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

/** The first cent price in `[1, last]` whose conversion is not exact, or null. */
function firstMismatch(
  last: number,
  convert: (price: string) => bigint,
  atomsPerCent: bigint
): string | null {
  for (let c = 1; c <= last; c++) {
    const price = cents(c);
    if (convert(price) !== BigInt(c) * atomsPerCent) return price;
  }
  return null;
}

describe('toAtomicUnits: every cent price converts exactly', () => {
  it('0.01..9,999.99 at 6 decimals is c * 10**4, all 999,999 of them', () => {
    expect(firstMismatch(999_999, (p) => toAtomicUnits(p, 6), 10_000n)).toBeNull();
  }, 60_000);

  it('0.01..99.99 at 7 decimals (Stellar USDC) is c * 10**5', () => {
    expect(firstMismatch(9_999, (p) => toAtomicUnits(p, 7), 100_000n)).toBeNull();
  });

  it('0.01..99.99 at 18 decimals (BSC USDC) is c * 10**16', () => {
    expect(firstMismatch(9_999, (p) => toAtomicUnits(p, 18), 10n ** 16n)).toBeNull();
  });

  it('the sweep is discriminating: the float formula it replaces misses 151 prices', () => {
    let short = 0;
    for (let c = 1; c <= 9_999; c++) {
      if (Math.floor(parseFloat(cents(c)) * 1_000_000) !== c * 10_000) short++;
    }
    expect(short).toBe(151);
    expect(Math.floor(parseFloat('2.01') * 1_000_000)).toBe(2_009_999);
    expect(toAtomicUnits('2.01', 6)).toBe(2_010_000n);
  });

  it('round-trips the amount the buyer loop hands a provider (formatUnits of the offer)', () => {
    for (const decimals of [6, 7]) {
      for (let c = 1; c <= 9_999; c++) {
        const atomic = BigInt(c) * 10n ** BigInt(decimals - 2);
        expect(toAtomicUnits(formatUnits(atomic, decimals), decimals)).toBe(atomic);
      }
    }
  });
});

describe('toAtomicUnits: accepted shapes', () => {
  it.each([
    ['2', 6, 2_000_000n],
    ['2.', 6, 2_000_000n],
    ['.5', 6, 500_000n],
    ['0', 6, 0n],
    ['0.000001', 6, 1n],
    ['007.10', 6, 7_100_000n],
    ['1.0000000', 6, 1_000_000n],
    ['123456789.123456', 6, 123_456_789_123_456n],
    ['5', 0, 5n],
    ['1000', 18, 10n ** 21n],
  ])('%s at %i decimals -> %s', (amount, decimals, expected) => {
    expect(toAtomicUnits(amount, decimals)).toBe(expected);
  });

  it('agrees with ethers parseUnits -- the EVM signing path -- on every accepted shape', () => {
    for (const amount of ['2.01', '0.1', '99.99', '10', '1.', '.25', '1.500000', '42.000001']) {
      expect(toAtomicUnits(amount, 6)).toBe(parseUnits(amount, 6));
    }
  });
});

describe('toAtomicUnits: refused with INVALID_AMOUNT', () => {
  const refused = (amount: unknown, decimals = 6) => {
    try {
      toAtomicUnits(amount as string, decimals);
    } catch (error) {
      return error;
    }
    return null;
  };

  it.each([
    ['1.0000001', 6],
    ['2.0100005', 6],
    ['0.0000001', 6],
    ['0.12345678', 7],
    ['1.5', 0],
  ])('more decimals than the token admits: %s at %i', (amount, decimals) => {
    const error = refused(amount, decimals);
    expect(error).toBeInstanceOf(X402Error);
    expect((error as X402Error).code).toBe('INVALID_AMOUNT');
    expect((error as X402Error).message).toContain('more decimal places');
  });

  it.each(['-1', '-0.01', '-0', '+1'])('a sign: %s', (amount) => {
    expect((refused(amount) as X402Error).code).toBe('INVALID_AMOUNT');
  });

  it.each(['1e6', '1E6', '2.01e0', '1e-2'])('exponent notation: %s', (amount) => {
    expect((refused(amount) as X402Error).code).toBe('INVALID_AMOUNT');
  });

  it.each(['', '.', ' 1.00', '1.00 ', 'abc', '1.2.3', '1,00', '0x10', 'Infinity', 'NaN', '$1'])(
    'not a plain decimal: %j',
    (amount) => {
      expect((refused(amount) as X402Error).code).toBe('INVALID_AMOUNT');
    }
  );

  it.each([1.5, 2n, null, undefined, {}])('not a string: %s', (amount) => {
    const error = refused(amount) as X402Error;
    expect(error.code).toBe('INVALID_AMOUNT');
    expect(error.message).toContain(`a ${typeof amount}`);
  });

  it('a bad decimals argument is a config error, not an amount error', () => {
    for (const decimals of [-1, 1.5, Number.NaN]) {
      expect((refused('1', decimals) as X402Error).code).toBe('INVALID_CONFIG');
    }
  });
});

describe('seller-side builders price in exact atomic units', () => {
  const SOLANA = getChainByName('solana')!;
  const STELLAR = getChainByName('stellar')!;
  const BASE = getChainByName('base')!;
  const PAY_TO = 'recipient';

  it('buildPaymentRequirements: 0.01..99.99 on Solana is c * 10**4, on Stellar c * 10**5', () => {
    const atomic = (price: string, chainName: string) =>
      BigInt(
        buildPaymentRequirements({ amount: price, recipient: PAY_TO, resource: '/r', chainName })
          .maxAmountRequired
      );
    expect(firstMismatch(9_999, (p) => atomic(p, SOLANA.name), 10_000n)).toBeNull();
    expect(firstMismatch(9_999, (p) => atomic(p, STELLAR.name), 100_000n)).toBeNull();
  });

  it('generatePaymentOptions: 0.01..99.99 is c * 10**4 on Solana and c * 10**5 on Stellar', () => {
    const atomic = (price: string) =>
      generatePaymentOptions([SOLANA, STELLAR], price).map((option) => BigInt(option.amount));
    for (let c = 1; c <= 9_999; c++) {
      expect(atomic(cents(c))).toEqual([BigInt(c) * 10_000n, BigInt(c) * 100_000n]);
    }
  });

  it('an EVM seller now asks for the price it wrote, not one atom under it', () => {
    const requirements = buildPaymentRequirements({
      amount: '2.01',
      recipient: '0x0000000000000000000000000000000000000001',
      resource: '/r',
      chainName: BASE.name,
    });
    expect(requirements.maxAmountRequired).toBe('2010000');
    expect(generatePaymentOptions([BASE], '2.01')[0].amount).toBe('2010000');
  });

  it('an amount no listed token can hold exactly throws instead of being truncated', () => {
    expect(() => generatePaymentOptions([SOLANA], '0.0000001')).toThrow(/more decimal places/);
    expect(() =>
      buildPaymentRequirements({ amount: '1e3', recipient: PAY_TO, resource: '/r', chainName: 'solana' })
    ).toThrow(/plain non-negative decimal/);
  });
});
