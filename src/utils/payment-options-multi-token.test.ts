import { describe, expect, it } from 'vitest';

import { generatePaymentOptions } from './x402';
import { getChainByName, getEnabledChains, getTokenConfig } from '../chains';

/**
 * `generatePaymentOptions()` and the chain's token map.
 *
 * The function emitted `chain.usdc` and nothing else, so a chain the registry
 * knows two stablecoins for still produced exactly one option. tumblrfi calls
 * it from `tokens.ts` and `x402.ts` believing it is multi-token; it never was.
 *
 * The fix is opt-in rather than "emit everything the registry knows", and that
 * is a money decision, not a style one: this array becomes the `accepts` of a
 * 402, so every entry is a currency the seller publicly agreed to be paid in at
 * `amount` units. Emitting EURC for a seller who priced in dollars would sell
 * at a 1:1 EUR/USD rate nobody agreed to. So the caller names its tokens, and
 * the default stays USDC-only -- byte for byte what every existing caller got.
 */

const BASE = getChainByName('base')!;

describe('generatePaymentOptions - multi-token', () => {
  it('emits one option per named token on a chain that has several', () => {
    // Base is in the registry with both USDC and EURC.
    expect(Object.keys(BASE.tokens ?? {})).toEqual(
      expect.arrayContaining(['usdc', 'eurc'])
    );

    const options = generatePaymentOptions([BASE], '5', undefined, [
      'usdc',
      'eurc',
    ]);

    expect(options).toHaveLength(2);
    expect(options.map(o => o.asset)).toEqual([
      getTokenConfig('base', 'usdc')!.address,
      getTokenConfig('base', 'eurc')!.address,
    ]);
    // Both are 6-decimal tokens on Base; each priced in its OWN units, not
    // converted between currencies.
    expect(options.map(o => o.amount)).toEqual(['5000000', '5000000']);
    expect(new Set(options.map(o => o.network))).toEqual(
      new Set(['eip155:8453'])
    );
  });

  it('prices each token in its own decimals, not the chain USDC decimals', () => {
    // BSC USDC has EIGHTEEN decimals. Reading a price at the wrong scale is how
    // an offer ends up 10^12 off. BSC ships x402-disabled (its USDC has no
    // EIP-3009), so the fixture enables it just to exercise the arithmetic.
    const bsc = getChainByName('bsc')!;
    expect(getTokenConfig('bsc', 'usdc')!.decimals).toBe(18);
    const enabled = { ...bsc, x402: { ...bsc.x402, enabled: true } };

    const [option] = generatePaymentOptions([enabled], '1', undefined, ['usdc']);
    expect(option.amount).toBe('1000000000000000000');
  });

  it('skips a named token the chain does not have instead of inventing one', () => {
    const options = generatePaymentOptions([BASE], '5', undefined, [
      'usdc',
      'eurc',
      'usdt', // not in Base's token map
    ]);

    expect(options).toHaveLength(2);
    expect(options.every(o => o.asset !== undefined)).toBe(true);
  });

  it('defaults to USDC only, which is byte-for-byte the old behaviour', () => {
    const chains = getEnabledChains();

    const options = generatePaymentOptions(chains, '5');

    // One option per enabled chain, all of them USDC.
    expect(options).toHaveLength(chains.length);
    for (const chain of chains) {
      const match = options.filter(
        o => o.asset === getTokenConfig(chain.name, 'usdc')!.address
      );
      expect(match.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('still honours the facilitator override and skips disabled chains', () => {
    const disabled = { ...BASE, x402: { ...BASE.x402, enabled: false } };

    expect(generatePaymentOptions([disabled], '5')).toHaveLength(0);
    expect(
      generatePaymentOptions([BASE], '5', 'https://facilitator.example.com')[0]
        .facilitator
    ).toBe('https://facilitator.example.com');
  });
});
