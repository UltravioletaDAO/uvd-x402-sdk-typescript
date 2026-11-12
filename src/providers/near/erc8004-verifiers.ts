/** The ERC-8004 verifier of each Arras escrow. Data only, so a release changes one row and nothing else. */
import type { NearEscrowNetwork } from './escrow';

/**
 * The ERC-8004 verifier that rates the payments of each registered Arras escrow, one row per contract of
 * NEAR_ESCROW_CONTRACTS: a verifier reads one escrow. null: no verifier is registered for that escrow yet, and rating
 * its payments is refused (fail closed) rather than sent to a verifier that reads another contract. A row is filled in
 * a release only after its verifier account is deployed on chain.
 */
export const NEAR_ERC8004_ESCROW_VERIFIERS: Readonly<Record<NearEscrowNetwork, Readonly<Record<string, string | null>>>> = Object.freeze({
  'near:mainnet': Object.freeze({ 'v1.arras-escrow.near': 'erc8004-verifier.arras-escrow.near', 'v2.arras-escrow.near': null }),
  'near:testnet': Object.freeze({ 'arras-v1b-1101.testnet': 'erc8004-verifier.arras-dev.testnet' }),
});
