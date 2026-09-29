/**
 * uvd-x402-sdk - Adapters
 *
 * Adapters for integrating with popular wallet connection libraries
 * and signing wallet implementations.
 */

// Wagmi/Viem adapter
export {
  createPaymentFromWalletClient,
  createPaymentWithResult,
  useX402Wagmi,
  type WalletClient,
  type WagmiPaymentOptions,
} from './wagmi';

// Signing wallet adapters
export { EnvKeyAdapter } from './env-key';
export {
  OWSWalletAdapter,
  type OWSCore,
  type OWSWallet,
  type OWSSignResult,
  type OWSAccountInfo,
  type OWSWalletAdapterOptions,
} from './ows';
