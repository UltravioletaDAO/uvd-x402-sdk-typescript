/**
 * uvd-x402-sdk
 *
 * x402 Payment SDK - Gasless crypto payments using the Ultravioleta facilitator.
 *
 * Supports 14 blockchain networks:
 * - EVM (10): Base, Ethereum, Polygon, Arbitrum, Optimism, Avalanche, Celo, HyperEVM, Unichain, Monad
 * - SVM (2): Solana, Fogo
 * - Stellar (1): Stellar
 * - NEAR (1): NEAR Protocol
 *
 * Supports both x402 v1 and v2 protocols.
 *
 * @example Basic usage (EVM)
 * ```ts
 * import { X402Client } from 'uvd-x402-sdk';
 *
 * const client = new X402Client({ defaultChain: 'base' });
 *
 * // Connect wallet
 * await client.connect('base');
 *
 * // Create payment
 * const result = await client.createPayment({
 *   recipient: '0x...',
 *   amount: '10.00',
 * });
 *
 * // Use result.paymentHeader in X-PAYMENT HTTP header
 * ```
 *
 * @example With SVM (Solana/Fogo)
 * ```ts
 * import { SVMProvider } from 'uvd-x402-sdk/solana';
 * import { getChainByName } from 'uvd-x402-sdk';
 *
 * const svm = new SVMProvider();
 * const address = await svm.connect();
 *
 * // Solana payment
 * const solanaConfig = getChainByName('solana')!;
 * const payload = await svm.signPayment(paymentInfo, solanaConfig);
 * const header = svm.encodePaymentHeader(payload, solanaConfig);
 *
 * // Fogo payment (same provider, different config)
 * const fogoConfig = getChainByName('fogo')!;
 * const fogoPayload = await svm.signPayment(paymentInfo, fogoConfig);
 * const fogoHeader = svm.encodePaymentHeader(fogoPayload, fogoConfig);
 * ```
 *
 * @example With NEAR
 * ```ts
 * import { NEARProvider } from 'uvd-x402-sdk/near';
 * import { getChainByName } from 'uvd-x402-sdk';
 *
 * const near = new NEARProvider();
 * const accountId = await near.connect();
 * const nearConfig = getChainByName('near')!;
 * const payload = await near.signPayment(paymentInfo, nearConfig);
 * const header = near.encodePaymentHeader(payload);
 * ```
 *
 * @example With React
 * ```tsx
 * import { X402Provider, useX402, usePayment } from 'uvd-x402-sdk/react';
 *
 * function App() {
 *   return (
 *     <X402Provider>
 *       <PaymentButton />
 *     </X402Provider>
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 */

// Main client
export { X402Client } from './client';

// Chain configuration
export {
  SUPPORTED_CHAINS,
  DEFAULT_CHAIN,
  DEFAULT_FACILITATOR_URL,
  getChainById,
  getChainByName,
  isChainSupported,
  getEnabledChains,
  getChainsByNetworkType,
  getEVMChainIds,
  getSVMChains,
  isSVMChain,
  getNetworkType,
  getExplorerTxUrl,
  getExplorerAddressUrl,
  // Multi-token support functions
  getTokenConfig,
  getSupportedTokens,
  isTokenSupported,
  getChainsByToken,
} from './chains';

// x402 utilities
export {
  detectX402Version,
  chainToCAIP2,
  caip2ToChain,
  parseNetworkIdentifier,
  encodeX402Header,
  decodeX402Header,
  createX402V1Header,
  createX402V2Header,
  createX402Header,
  generatePaymentOptions,
  isCAIP2Format,
  convertX402Header,
  // Validation utilities
  validateRecipient,
  validateAmount,
} from './utils';

// Types
export type {
  // Chain types
  ChainConfig,
  USDCConfig,
  NativeCurrency,
  NetworkType,

  // Token types (multi-token support)
  TokenType,
  TokenConfig,

  // Wallet types
  WalletState,
  WalletAdapter,
  EIP712Domain,
  EIP712Types,

  // Payment types
  PaymentInfo,
  PaymentRequest,
  PaymentResult,
  PaymentPayload,
  EVMPaymentPayload,
  SolanaPaymentPayload,
  StellarPaymentPayload,
  NEARPaymentPayload,

  // x402 header types (v1 and v2)
  X402Version,
  X402Header,
  X402HeaderV1,
  X402HeaderV2,
  X402PaymentOption,
  X402PayloadData,
  X402EVMPayload,
  X402SolanaPayload,
  X402StellarPayload,
  X402NEARPayload,

  // Config types
  X402ClientConfig,
  MultiPaymentConfig,
  NetworkBalance,

  // Event types
  X402Event,
  X402EventData,
  X402EventHandler,

  // Error types
  X402ErrorCode,
} from './types';

export { X402Error, DEFAULT_CONFIG, CAIP2_IDENTIFIERS, CAIP2_TO_CHAIN } from './types';
