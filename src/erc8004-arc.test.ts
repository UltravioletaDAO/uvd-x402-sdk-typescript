/**
 * Arc joins ERC-8004 (2.98.0), and it is the ONLY thing that moves.
 *
 * Payments on Arc shipped in 2.92.0; ERC-8004 on Arc did not, although the
 * facilitator serves it (identity and reputation on both networks since
 * x402-rs 2.37.0, the rater-authored relay on mainnet since 2.38.0). What is
 * pinned here:
 *
 * 1. `arc` and `arc-testnet` carry the registries the facilitator names in
 *    ARC_MAINNET_CONTRACTS / ARC_TESTNET_CONTRACTS -- each read on-chain on
 *    2026-09-23 before it was written down.
 * 2. `arc` is on the relayed rail; `arc-testnet` is not. The facilitator
 *    answers `prepare` on arc with the v4 delegate and refuses arc-testnet with
 *    a 400: no delegate was deployed there, and mainnet having one says
 *    nothing about testnet.
 * 3. Every network 2.97.0 exported is exactly what it was. The snapshots below
 *    are the three exported lists as 2.97.0 built them, written out rather than
 *    derived from the code under test, so an edit that "tidies" another entry
 *    fails here instead of shipping.
 */
import { describe, expect, it } from 'vitest';

import {
  ERC8004_CONTRACTS,
  RELAYED_FEEDBACK_NETWORKS,
  SOLANA_FEEDBACK_NETWORKS,
  supportsRelayedFeedback,
  supportsSolanaFeedback,
} from './backend';

const MAINNET = {
  identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  validationRegistry: '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58',
};
const TESTNET = {
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  validationRegistry: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
};
const SKALE_MAINNET = {
  identityRegistry: MAINNET.identityRegistry,
  reputationRegistry: MAINNET.reputationRegistry,
};
const SOLANA = {
  agentRegistryProgram: '8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ',
  atomEngineProgram: 'AToMw53aiPQ8j7iHVb4fGt6nzUNxUhcPc3tbPBZuzVVb',
};

/** `ERC8004_CONTRACTS` as 2.97.0 exported it: 22 keys, in this order. */
const CONTRACTS_2_97_0: Record<string, Record<string, string>> = {
  ethereum: MAINNET,
  base: MAINNET,
  polygon: MAINNET,
  arbitrum: MAINNET,
  optimism: MAINNET,
  celo: MAINNET,
  bsc: MAINNET,
  monad: MAINNET,
  avalanche: MAINNET,
  scroll: MAINNET,
  'skale-base': SKALE_MAINNET,
  'base-mainnet': MAINNET,
  'ethereum-sepolia': TESTNET,
  'base-sepolia': TESTNET,
  'polygon-amoy': TESTNET,
  'arbitrum-sepolia': TESTNET,
  'optimism-sepolia': TESTNET,
  'celo-sepolia': TESTNET,
  'avalanche-fuji': TESTNET,
  'skale-base-sepolia': TESTNET,
  solana: SOLANA,
  'solana-devnet': SOLANA,
};

/** `RELAYED_FEEDBACK_NETWORKS` as 2.97.0 exported it. */
const RELAYED_2_97_0 = [
  'base', 'ethereum', 'polygon', 'arbitrum', 'optimism', 'celo', 'bsc', 'monad',
  'base-sepolia',
];

/** `SOLANA_FEEDBACK_NETWORKS` as 2.97.0 exported it. */
const SOLANA_2_97_0 = ['solana', 'solana-devnet'];

describe('Arc in the ERC-8004 table', () => {
  it('names the canonical mainnet registries on arc', () => {
    expect(ERC8004_CONTRACTS.arc).toEqual(MAINNET);
  });

  it('names the canonical testnet registries on arc-testnet', () => {
    expect(ERC8004_CONTRACTS['arc-testnet']).toEqual(TESTNET);
  });
});

describe('Arc on the relayed feedback rail', () => {
  it('routes arc to the rail', () => {
    expect(RELAYED_FEEDBACK_NETWORKS).toContain('arc');
    expect(supportsRelayedFeedback('arc')).toBe(true);
  });

  it('keeps arc-testnet off it: no delegate there, and prepare says so', () => {
    // `POST /feedback/evm/prepare` on arc-testnet, facilitator 2.39.0:
    // 400 "relayed feedback is not available on arc-testnet: no FeedbackDelegate
    // is deployed there yet". Serving reads is not serving the relay.
    expect(RELAYED_FEEDBACK_NETWORKS).not.toContain('arc-testnet');
    expect(supportsRelayedFeedback('arc-testnet')).toBe(false);
  });

  it('never routes either Arc network to the Solana rail', () => {
    expect(supportsSolanaFeedback('arc')).toBe(false);
    expect(supportsSolanaFeedback('arc-testnet')).toBe(false);
  });
});

describe('nothing but Arc moved since 2.97.0', () => {
  it('adds exactly arc and arc-testnet to the table', () => {
    const added = Object.keys(ERC8004_CONTRACTS).filter((n) => !(n in CONTRACTS_2_97_0));
    expect(added.sort()).toEqual(['arc', 'arc-testnet']);
  });

  it('removes nothing from the table', () => {
    const removed = Object.keys(CONTRACTS_2_97_0).filter((n) => !(n in ERC8004_CONTRACTS));
    expect(removed).toEqual([]);
  });

  it('leaves every 2.97.0 entry byte-identical', () => {
    for (const [network, contracts] of Object.entries(CONTRACTS_2_97_0)) {
      expect(ERC8004_CONTRACTS[network], network).toStrictEqual(contracts);
    }
  });

  it('adds exactly arc to the relayed rail, and keeps the rest in order', () => {
    expect(RELAYED_FEEDBACK_NETWORKS.filter((n) => n !== 'arc')).toEqual(RELAYED_2_97_0);
    expect(RELAYED_FEEDBACK_NETWORKS.length).toBe(RELAYED_2_97_0.length + 1);
  });

  it('leaves the Solana rail untouched', () => {
    expect([...SOLANA_FEEDBACK_NETWORKS]).toEqual(SOLANA_2_97_0);
  });
});
