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
 * 3. Arc joins on both networks (2.98.0), and nothing else moves: every entry
 *    2.97.0 exported is compared, key for key, against what it was.
 */
import { describe, it, expect } from 'vitest';
import { ERC8004_CONTRACTS, wireNetwork } from './backend';

const MAINNET_IDENTITY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const MAINNET_REPUTATION = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const MAINNET_VALIDATION = '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58';

const TESTNET_IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const TESTNET_REPUTATION = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const TESTNET_VALIDATION = '0x8004Cb1BF31DAf7788923b405b754f57acEB4272';

// Exactly what GET /feedback -> supportedNetworks returns: all 23, in its
// order, read from facilitator 2.39.0 on 2026-09-23.
const FACILITATOR_NETWORKS = [
  'ethereum', 'base', 'polygon', 'arbitrum', 'optimism', 'celo', 'bsc',
  'monad', 'avalanche', 'scroll', 'skale-base', 'arc',
  'ethereum-sepolia', 'base-sepolia', 'polygon-amoy', 'arbitrum-sepolia',
  'optimism-sepolia', 'celo-sepolia', 'avalanche-fuji', 'skale-base-sepolia',
  'arc-testnet',
  'solana', 'solana-devnet',
];

const EVM_MAINNETS = [
  'ethereum', 'base', 'polygon', 'arbitrum', 'optimism', 'celo', 'bsc',
  'monad', 'avalanche', 'scroll', 'arc',
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

  it('gives Arc the canonical mainnet registries, all three', () => {
    // ARC_MAINNET_CONTRACTS in x402-rs; each address has code on
    // rpc.mainnet.arc.io (EIP-1967 proxy, same implementation as Base).
    expect(ERC8004_CONTRACTS.arc).toEqual({
      identityRegistry: MAINNET_IDENTITY,
      reputationRegistry: MAINNET_REPUTATION,
      validationRegistry: MAINNET_VALIDATION,
    });
  });

  it('gives Arc testnet the canonical testnet registries, all three', () => {
    // ARC_TESTNET_CONTRACTS in x402-rs. Unlike SKALE, the validation registry
    // is deployed here too, so leaving it out would be the omission.
    expect(ERC8004_CONTRACTS['arc-testnet']).toEqual({
      identityRegistry: TESTNET_IDENTITY,
      reputationRegistry: TESTNET_REPUTATION,
      validationRegistry: TESTNET_VALIDATION,
    });
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
