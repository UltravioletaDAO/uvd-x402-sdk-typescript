/**
 * The fixed facts the reputation module signs against. Nothing here is read
 * from the network: a delegate, a registry or a domain that came back in a
 * prepare is COMPARED to these rows, never trusted.
 *
 * Sources, each read before it was written down:
 * - delegates: x402-rs `src/erc8004/relay.rs::delegate_address` (main
 *   `09c3e371`, all ten re-read on-chain 2026-09-23) and Execution Market
 *   `contracts/deployments/feedback-delegate.json`, which agree row for row;
 * - registries: the same deployment record (`registries`), and this SDK's
 *   `ERC8004_CONTRACTS` (`src/reputation/constants.test.ts` ties the two);
 * - the `RelayedGiveFeedback` struct: x402-rs `src/erc8004/relay_v4.rs`,
 *   pinned there against the v4 delegate deployed on Base.
 *
 * Keyed by chain id on purpose. These delegates were deployed with CREATE, so
 * the same address holds a different version on another chain (arc's v4 is
 * base-sepolia's superseded v2): an address alone never authorises anything.
 */

import { ethers } from 'ethers';

export const MAINNET_IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const MAINNET_REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
export const TESTNET_IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
export const TESTNET_REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';

/** One chain where the rater-authored rail runs: the v4 delegate and its registries. */
export interface ReputationChain {
  /** The facilitator's network name. */
  readonly network: string;
  readonly chainId: number;
  /** The v4 `FeedbackDelegate` of THIS chain: the only EIP-7702 target ever signed. */
  readonly delegate: string;
  /** The ERC-8004 ReputationRegistry the delegate is pinned to (immutable in the contract). */
  readonly reputationRegistry: string;
  readonly identityRegistry: string;
}

const row = (
  network: string,
  chainId: number,
  delegate: string,
  testnet = false
): ReputationChain =>
  Object.freeze({
    network,
    chainId,
    delegate,
    reputationRegistry: testnet ? TESTNET_REPUTATION_REGISTRY : MAINNET_REPUTATION_REGISTRY,
    identityRegistry: testnet ? TESTNET_IDENTITY_REGISTRY : MAINNET_IDENTITY_REGISTRY,
  });

/**
 * Every chain with a live v4 delegate. Avalanche is absent because its
 * C-Chain rejects type-4 transactions; arc-testnet because nothing is
 * deployed there. Neither is a "not yet".
 */
export const REPUTATION_CHAINS: readonly ReputationChain[] = Object.freeze([
  row('base', 8453, '0x260D3D0258680aA458D0EBB8BcAE8A2f68bf6163'),
  row('ethereum', 1, '0x9577F05D10D2052C75D115e3a0A8f9Dc0cBb7A7b'),
  row('polygon', 137, '0x1dfc1A578bf321A42c441B4bd60fD5d7bb4BFaD5'),
  row('arbitrum', 42161, '0xf670C69BCbb2453FaE5Ec009c2b6dd934BE46A7f'),
  row('optimism', 10, '0x794C907FdfC71BFaF0b86D0e463BBD6E949A31bA'),
  row('celo', 42220, '0x0Dff14dFF648769cB8C3D5F5a150f32Ca2BB9511'),
  row('bsc', 56, '0xe25cF9B9F5A3B5faa7628c751466df0166d96B59'),
  row('monad', 143, '0x794C907FdfC71BFaF0b86D0e463BBD6E949A31bA'),
  row('arc', 5042, '0x955Cc9fB9aB95FC0821ae74197D273dde5dA84f1'),
  row('base-sepolia', 84532, '0x9551263b9B83b1A737D55fd5e67Fb6D60e4eF787', true),
]);

/** The row for a facilitator network name (`base-mainnet` is read as `base`), or `undefined`. */
export function reputationChain(network: string): ReputationChain | undefined {
  const name = network === 'base-mainnet' ? 'base' : network;
  return REPUTATION_CHAINS.find((c) => c.network === name);
}

/** The row for a chain id, or `undefined`. A zero or unsafe id never matches. */
export function reputationChainById(chainId: number): ReputationChain | undefined {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return undefined;
  return REPUTATION_CHAINS.find((c) => c.chainId === chainId);
}

export const FEEDBACK_DELEGATE_DOMAIN_NAME = 'FeedbackDelegate';
export const FEEDBACK_DELEGATE_DOMAIN_VERSION = '1';
export const RELAYED_GIVE_FEEDBACK = 'RelayedGiveFeedback';

export interface TypedField {
  readonly name: string;
  readonly type: string;
}

export const EIP712_DOMAIN_FIELDS: readonly TypedField[] = Object.freeze([
  Object.freeze({ name: 'name', type: 'string' }),
  Object.freeze({ name: 'version', type: 'string' }),
  Object.freeze({ name: 'chainId', type: 'uint256' }),
  Object.freeze({ name: 'verifyingContract', type: 'address' }),
]);

/**
 * The v4 `RelayedGiveFeedback`, field for field and in order: the order is
 * part of the typehash, so one field moved is another struct.
 */
export const RELAYED_GIVE_FEEDBACK_FIELDS: readonly TypedField[] = Object.freeze([
  Object.freeze({ name: 'registry', type: 'address' }),
  Object.freeze({ name: 'agentId', type: 'uint256' }),
  Object.freeze({ name: 'value', type: 'int128' }),
  Object.freeze({ name: 'valueDecimals', type: 'uint8' }),
  Object.freeze({ name: 'tag1', type: 'string' }),
  Object.freeze({ name: 'tag2', type: 'string' }),
  Object.freeze({ name: 'endpoint', type: 'string' }),
  Object.freeze({ name: 'feedbackURI', type: 'string' }),
  Object.freeze({ name: 'feedbackHash', type: 'bytes32' }),
  Object.freeze({ name: 'deadline', type: 'uint256' }),
  Object.freeze({ name: 'nonce', type: 'bytes32' }),
]);

/** `NewFeedback` of the ERC-8004 ReputationRegistry, the event a landed rating emits. */
export const NEW_FEEDBACK_TOPIC = ethers.id(
  'NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)'
);

/** ERC-20 `Transfer(address,address,uint256)`. */
export const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

/** secp256k1 group order. A signature with `s` above half of it is malleable. */
export const SECP256K1_N = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'
);

export const ZERO_BYTES32 = '0x' + '00'.repeat(32);

/**
 * How old a payment may be when the facilitator checks a proof
 * (x402-rs `DEFAULT_PROOF_MAX_AGE_SECS`, 7 days, the production value).
 */
export const PROOF_MAX_AGE_SECS = 7 * 24 * 3600;
