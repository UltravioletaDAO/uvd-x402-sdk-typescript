/**
 * uvd-x402-sdk - Adapters
 *
 * Adapters for integrating with popular wallet connection libraries.
 */

export {
  createPaymentFromWalletClient,
  createPaymentWithResult,
  useX402Wagmi,
  type WalletClient,
  type WagmiPaymentOptions,
} from './wagmi';
