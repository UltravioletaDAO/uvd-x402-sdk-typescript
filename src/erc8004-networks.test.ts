/**
 * The ERC-8004 network table has to agree with what the facilitator accepts.
 *
 * Two things get checked here that no other test covered:
 *
 * 1. The names in `Erc8004Network` are the ones the facilitator parses. The
 *    table used to name Base 'base-mainnet', which the facilitator rejects
 *    outright (400 {"error": "Invalid network: base-mainnet"}) -- so the only
 *    spelling the type offered for Base was the one that could not work.
 * 2. Every mainnet except SKALE Base carries a validation registry. That
 *    address was deployed after the identity/reputation pair and was missing.
 */
import { describe, it, expect } from 'vitest';
import { ERC8004_CONTRACTS, wireNetwork } from './backend';

const MAINNET_IDENTITY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const MAINNET_REPUTATION = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const MAINNET_VALIDATION = '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58';

// Exactly what GET /feedback -> supportedNetworks returns, plus scroll.
const FACILITATOR_NETWORKS = [
  'ethereum', 'base', 'polygon', 'arbitrum', 'optimism', 'celo', 'bsc',
  'monad', 'avalanche', 'scroll', 'skale-base',
  'ethereum-sepolia', 'base-sepolia', 'polygon-amoy', 'arbitrum-sepolia',
  'optimism-sepolia', 'celo-sepolia', 'avalanche-fuji', 'skale-base-sepolia',
  'solana', 'solana-devnet',
];

const EVM_MAINNETS = [
  'ethereum', 'base', 'polygon', 'arbitrum', 'optimism', 'celo', 'bsc',
  'monad', 'avalanche', 'scroll',
];

describe('ERC-8004 network table', () => {
  it('covers every network the facilitator serves', () => {
    const missing = FACILITATOR_NETWORKS.filter((n) => !(n in ERC8004_CONTRACTS));
    expect(missing).toEqual([]);
  });

  it('invents no network the facilitator would reject', () => {
    // 'base-mainnet' is the one deliberate extra: a deprecated alias.
    const extra = Object.keys(ERC8004_CONTRACTS).filter(
      (n) => !FACILITATOR_NETWORKS.includes(n)
    );
    expect(extra).toEqual(['base-mainnet']);
  });

  it('rewrites base-mainnet to the name the facilitator parses', () => {
    // Passing this through unchanged is a 400 at the edge, not a 404.
    expect(wireNetwork('base-mainnet')).toBe('base');
  });

  it('leaves every other name untouched', () => {
    for (const n of FACILITATOR_NETWORKS) {
      expect(wireNetwork(n)).toBe(n);
    }
  });

  it('gives Scroll the canonical mainnet registries', () => {
    expect(ERC8004_CONTRACTS.scroll).toEqual({
      identityRegistry: MAINNET_IDENTITY,
      reputationRegistry: MAINNET_REPUTATION,
      validationRegistry: MAINNET_VALIDATION,
    });
  });

  it('carries the validation registry on every EVM mainnet', () => {
    for (const n of EVM_MAINNETS) {
      expect(ERC8004_CONTRACTS[n].validationRegistry).toBe(MAINNET_VALIDATION);
    }
  });

  it('leaves SKALE Base without a validation registry, which is correct', () => {
    // Not an omission: there is no code at the canonical address on SKALE Base.
    expect(ERC8004_CONTRACTS['skale-base'].validationRegistry).toBeUndefined();
    expect(ERC8004_CONTRACTS['skale-base'].identityRegistry).toBe(MAINNET_IDENTITY);
  });

  it('keeps the deprecated alias resolving to the same contracts', () => {
    expect(ERC8004_CONTRACTS['base-mainnet']).toEqual(ERC8004_CONTRACTS.base);
  });
});
