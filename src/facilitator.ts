/**
 * Facilitator Configuration
 *
 * This module contains the known facilitator addresses for each chain.
 * The SDK uses these automatically so users don't need to configure them.
 *
 * The facilitator (https://facilitator.ultravioletadao.xyz) has wallets
 * on each supported blockchain for:
 * - EVM: Signing EIP-3009 transferWithAuthorization transactions
 * - Solana: Paying transaction fees (fee payer)
 * - Algorand: Signing fee transactions in atomic groups
 * - Stellar: Signing authorization entries
 * - NEAR: Acting as relayer for meta-transactions
 */

/**
 * Default facilitator URL
 */
export const DEFAULT_FACILITATOR_URL = 'https://facilitator.ultravioletadao.xyz';

/**
 * Facilitator wallet addresses by chain type
 *
 * These are the public addresses of the facilitator's wallets.
 * The facilitator uses these to pay fees and sign transactions.
 */
export const FACILITATOR_ADDRESSES = {
  /**
   * Solana facilitator address (fee payer)
   * Used for: Paying transaction fees on Solana
   */
  solana: 'F742C4VfFLQ9zRQyithoj5229ZgtX2WqKCSFKgH2EThq',

  /**
   * Algorand facilitator address (fee payer)
   * Used for: Signing Transaction 0 (fee tx) in atomic groups
   * Note: This is derived from the facilitator's Algorand mnemonic
   */
  algorand: 'SXHRBXS22SKKXHXK44DTQMWN2SXK3SFJWBDAQZGF4DRPW7PNFAUM2GYFAQ',

  /**
   * Algorand testnet facilitator address
   */
  'algorand-testnet': 'SXHRBXS22SKKXHXK44DTQMWN2SXK3SFJWBDAQZGF4DRPW7PNFAUM2GYFAQ',

  /**
   * EVM facilitator address
   * Used for: Submitting EIP-3009 transferWithAuthorization transactions
   * Note: Same address across all EVM chains
   */
  evm: '0x7c5F3AdB0C7775968Bc7e7cF61b27fECf2e2b500',

  /**
   * Stellar facilitator address
   * Used for: Signing soroban authorization entries
   */
  stellar: 'GDUTDNV53WQPOB2JUZPO6SXH4LVT7CJSLCMLFQ7W4CNAXGIX7XYMCNP2',

  /**
   * NEAR facilitator address
   * Used for: Relaying meta-transactions
   */
  near: 'uvd-facilitator.near',
} as const;

/**
 * Get the facilitator address for a specific chain
 *
 * @param chainName - The chain name (e.g., 'algorand', 'solana', 'base')
 * @param networkType - The network type (e.g., 'evm', 'svm', 'algorand')
 * @returns The facilitator address for that chain, or undefined if not supported
 */
export function getFacilitatorAddress(
  chainName: string,
  networkType?: string
): string | undefined {
  // Check for exact chain match first
  const exactMatch = FACILITATOR_ADDRESSES[chainName as keyof typeof FACILITATOR_ADDRESSES];
  if (exactMatch) {
    return exactMatch;
  }

  // Fall back to network type
  if (networkType === 'evm') {
    return FACILITATOR_ADDRESSES.evm;
  }
  if (networkType === 'svm' || networkType === 'solana') {
    return FACILITATOR_ADDRESSES.solana;
  }
  if (networkType === 'algorand') {
    return FACILITATOR_ADDRESSES.algorand;
  }
  if (networkType === 'stellar') {
    return FACILITATOR_ADDRESSES.stellar;
  }
  if (networkType === 'near') {
    return FACILITATOR_ADDRESSES.near;
  }

  return undefined;
}

/**
 * Type for facilitator addresses
 */
export type FacilitatorAddresses = typeof FACILITATOR_ADDRESSES;
