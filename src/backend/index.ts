/**
 * uvd-x402-sdk - Backend Utilities
 *
 * Server-side utilities for building x402 payment APIs.
 * These utilities help backend developers:
 * - Build verify/settle requests for the facilitator
 * - Parse X-PAYMENT headers from incoming requests
 * - Configure CORS for x402 payment flows
 * - Create atomic payment handlers
 * - Discover and register resources via Bazaar Discovery API
 * - Manage escrow payments with refund and dispute resolution
 *
 * @example Basic payment flow
 * ```ts
 * import {
 *   parsePaymentHeader,
 *   FacilitatorClient,
 *   X402_CORS_HEADERS,
 * } from 'uvd-x402-sdk/backend';
 *
 * // Parse payment from request header
 * const payment = parsePaymentHeader(req.headers['x-payment']);
 *
 * // Verify with facilitator
 * const client = new FacilitatorClient();
 * const verifyResult = await client.verify(payment, paymentRequirements);
 *
 * // If valid, provide service then settle
 * const settleResult = await client.settle(payment, paymentRequirements);
 * ```
 *
 * @example Escrow payment with refund support
 * ```ts
 * import { EscrowClient } from 'uvd-x402-sdk/backend';
 *
 * const escrow = new EscrowClient();
 *
 * // Hold payment in escrow
 * const escrowPayment = await escrow.createEscrow({
 *   paymentHeader: req.headers['x-payment'],
 *   requirements: paymentRequirements,
 *   escrowDuration: 86400, // 24 hours
 * });
 *
 * // After service delivered, release to recipient
 * await escrow.release(escrowPayment.id);
 *
 * // Or if service failed, request refund
 * await escrow.requestRefund({
 *   escrowId: escrowPayment.id,
 *   reason: 'Service not delivered',
 * });
 * ```
 *
 * @example Resource discovery
 * ```ts
 * import { BazaarClient } from 'uvd-x402-sdk/backend';
 *
 * const bazaar = new BazaarClient();
 * const resources = await bazaar.discover({
 *   category: 'ai',
 *   network: 'base',
 *   maxPrice: '0.10',
 * });
 * ```
 */

import type {
  X402Header,
  X402Version,
} from '../types';
import { decodeX402Header, chainToCAIP2 } from '../utils';
import { getChainByName } from '../chains';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Payment requirements sent to the facilitator
 */
export interface PaymentRequirements {
  /** Payment scheme (always "exact") */
  scheme: 'exact';
  /** Network name (v1) or CAIP-2 identifier (v2) */
  network: string;
  /** Maximum amount required in atomic units (e.g., "1000000" for 1 USDC) */
  maxAmountRequired: string;
  /** Resource URL being paid for */
  resource: string;
  /** Description of what's being paid for */
  description: string;
  /** MIME type of the resource */
  mimeType: string;
  /** Recipient address for payment */
  payTo: string;
  /** Maximum timeout in seconds */
  maxTimeoutSeconds: number;
  /** Token contract address */
  asset: string;
  /** Optional output schema for the resource */
  outputSchema?: unknown;
  /** Optional extra data */
  extra?: unknown;
}

/**
 * Verify request body for the facilitator /verify endpoint
 */
export interface VerifyRequest {
  x402Version: X402Version;
  paymentPayload: X402Header;
  paymentRequirements: PaymentRequirements;
}

/**
 * Settle request body for the facilitator /settle endpoint
 */
export interface SettleRequest {
  x402Version: X402Version;
  paymentPayload: X402Header;
  paymentRequirements: PaymentRequirements;
}

/**
 * Verify response from the facilitator
 */
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  network?: string;
}

/**
 * Settle response from the facilitator
 */
export interface SettleResponse {
  success: boolean;
  transactionHash?: string;
  network?: string;
  error?: string;
}

/**
 * Options for building payment requirements
 */
export interface PaymentRequirementsOptions {
  /** Amount in human-readable format (e.g., "1.00") */
  amount: string;
  /** Recipient address */
  recipient: string;
  /** Resource URL being protected */
  resource: string;
  /** Chain name (e.g., "base") */
  chainName?: string;
  /** Description of the resource */
  description?: string;
  /** MIME type of the resource */
  mimeType?: string;
  /** Timeout in seconds (default: 300) */
  timeoutSeconds?: number;
  /** x402 version to use */
  x402Version?: X402Version;
}

// ============================================================================
// HEADER PARSING
// ============================================================================

/**
 * Parse X-PAYMENT or PAYMENT-SIGNATURE header value
 *
 * @param headerValue - Base64-encoded header value (or undefined/null)
 * @returns Parsed x402 header object, or null if invalid
 *
 * @example
 * ```ts
 * // Express.js
 * const payment = parsePaymentHeader(req.headers['x-payment']);
 * if (!payment) {
 *   return res.status(400).json({ error: 'Invalid payment header' });
 * }
 * ```
 */
export function parsePaymentHeader(
  headerValue: string | undefined | null
): X402Header | null {
  if (!headerValue) {
    return null;
  }

  try {
    return decodeX402Header(headerValue);
  } catch {
    return null;
  }
}

/**
 * Extract payment header from request headers object
 *
 * Checks both X-PAYMENT and PAYMENT-SIGNATURE headers.
 *
 * @param headers - Request headers object (case-insensitive)
 * @returns Parsed x402 header object, or null if not found/invalid
 *
 * @example
 * ```ts
 * const payment = extractPaymentFromHeaders(req.headers);
 * ```
 */
export function extractPaymentFromHeaders(
  headers: Record<string, string | string[] | undefined>
): X402Header | null {
  // Normalize header keys to lowercase
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      normalizedHeaders[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      normalizedHeaders[key.toLowerCase()] = value[0];
    }
  }

  // Try X-PAYMENT first, then PAYMENT-SIGNATURE
  const headerValue =
    normalizedHeaders['x-payment'] ||
    normalizedHeaders['payment-signature'];

  return parsePaymentHeader(headerValue);
}

// ============================================================================
// REQUEST BUILDERS
// ============================================================================

/**
 * Build payment requirements for the facilitator
 *
 * @param options - Payment requirements options
 * @returns PaymentRequirements object ready for verify/settle
 *
 * @example
 * ```ts
 * const requirements = buildPaymentRequirements({
 *   amount: '1.00',
 *   recipient: '0x1234...',
 *   resource: 'https://api.example.com/premium-data',
 *   chainName: 'base',
 * });
 * ```
 */
export function buildPaymentRequirements(
  options: PaymentRequirementsOptions
): PaymentRequirements {
  const {
    amount,
    recipient,
    resource,
    chainName = 'base',
    description = 'Payment for resource access',
    mimeType = 'application/json',
    timeoutSeconds = 300,
    x402Version = 1,
  } = options;

  const chain = getChainByName(chainName);
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainName}`);
  }

  // Convert amount to atomic units
  const atomicAmount = Math.floor(
    parseFloat(amount) * Math.pow(10, chain.usdc.decimals)
  ).toString();

  // Use CAIP-2 for v2, chain name for v1
  const network = x402Version === 2 ? chainToCAIP2(chainName) : chainName;

  return {
    scheme: 'exact',
    network,
    maxAmountRequired: atomicAmount,
    resource,
    description,
    mimeType,
    payTo: recipient,
    maxTimeoutSeconds: timeoutSeconds,
    asset: chain.usdc.address,
  };
}

/**
 * Build a verify request for the facilitator /verify endpoint
 *
 * @param paymentHeader - Parsed x402 payment header
 * @param requirements - Payment requirements
 * @returns VerifyRequest body ready for fetch/axios
 *
 * @example
 * ```ts
 * const payment = parsePaymentHeader(req.headers['x-payment']);
 * const verifyBody = buildVerifyRequest(payment, requirements);
 *
 * const response = await fetch('https://facilitator.uvd.xyz/verify', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify(verifyBody),
 * });
 * ```
 */
export function buildVerifyRequest(
  paymentHeader: X402Header,
  requirements: PaymentRequirements
): VerifyRequest {
  return {
    x402Version: paymentHeader.x402Version,
    paymentPayload: paymentHeader,
    paymentRequirements: requirements,
  };
}

/**
 * Build a settle request for the facilitator /settle endpoint
 *
 * @param paymentHeader - Parsed x402 payment header
 * @param requirements - Payment requirements
 * @returns SettleRequest body ready for fetch/axios
 */
export function buildSettleRequest(
  paymentHeader: X402Header,
  requirements: PaymentRequirements
): SettleRequest {
  return {
    x402Version: paymentHeader.x402Version,
    paymentPayload: paymentHeader,
    paymentRequirements: requirements,
  };
}

// ============================================================================
// CORS CONFIGURATION
// ============================================================================

/**
 * Recommended CORS headers for x402 payment APIs
 *
 * These headers allow browsers to send payment headers in cross-origin requests.
 */
export const X402_CORS_HEADERS = {
  'Access-Control-Allow-Headers':
    'Content-Type, X-PAYMENT, PAYMENT-SIGNATURE, Authorization',
  'Access-Control-Expose-Headers':
    'X-PAYMENT-RESPONSE, PAYMENT-RESPONSE, PAYMENT-REQUIRED',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
} as const;

/**
 * All x402 custom header names that should be allowed in CORS
 */
export const X402_HEADER_NAMES = [
  'X-PAYMENT',
  'PAYMENT-SIGNATURE',
  'X-PAYMENT-RESPONSE',
  'PAYMENT-RESPONSE',
  'PAYMENT-REQUIRED',
] as const;

/**
 * Get CORS headers with custom origin
 *
 * @param origin - Allowed origin (use '*' for any, or specific domain)
 * @returns Complete CORS headers object
 *
 * @example
 * ```ts
 * // Express.js middleware
 * app.use((req, res, next) => {
 *   const corsHeaders = getCorsHeaders('https://myapp.com');
 *   Object.entries(corsHeaders).forEach(([key, value]) => {
 *     res.setHeader(key, value);
 *   });
 *   if (req.method === 'OPTIONS') {
 *     return res.status(204).end();
 *   }
 *   next();
 * });
 * ```
 */
export function getCorsHeaders(origin: string = '*'): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    ...X402_CORS_HEADERS,
  };
}

// ============================================================================
// FACILITATOR CLIENT
// ============================================================================

/**
 * Options for the FacilitatorClient
 */
export interface FacilitatorClientOptions {
  /** Base URL of the facilitator (default: https://facilitator.ultravioletadao.xyz) */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Client for interacting with the x402 facilitator API
 *
 * @example
 * ```ts
 * const client = new FacilitatorClient();
 *
 * // Verify a payment
 * const verifyResult = await client.verify(paymentHeader, requirements);
 * if (!verifyResult.isValid) {
 *   return res.status(402).json({ error: verifyResult.invalidReason });
 * }
 *
 * // Provide the service, then settle
 * const settleResult = await client.settle(paymentHeader, requirements);
 * if (!settleResult.success) {
 *   // Handle settlement failure (maybe refund or retry)
 * }
 * ```
 */
export class FacilitatorClient {
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(options: FacilitatorClientOptions = {}) {
    this.baseUrl = options.baseUrl || 'https://facilitator.ultravioletadao.xyz';
    this.timeout = options.timeout || 30000;
  }

  /**
   * Verify a payment with the facilitator
   *
   * Call this before providing the paid resource to validate the payment.
   *
   * @param paymentHeader - Parsed x402 payment header
   * @param requirements - Payment requirements
   * @returns Verification result
   */
  async verify(
    paymentHeader: X402Header,
    requirements: PaymentRequirements
  ): Promise<VerifyResponse> {
    const body = buildVerifyRequest(paymentHeader, requirements);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        return {
          isValid: false,
          invalidReason: `Facilitator error: ${response.status} - ${errorText}`,
        };
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      return {
        isValid: false,
        invalidReason: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Settle a payment with the facilitator
   *
   * Call this after providing the paid resource to execute the on-chain transfer.
   *
   * @param paymentHeader - Parsed x402 payment header
   * @param requirements - Payment requirements
   * @returns Settlement result with transaction hash
   */
  async settle(
    paymentHeader: X402Header,
    requirements: PaymentRequirements
  ): Promise<SettleResponse> {
    const body = buildSettleRequest(paymentHeader, requirements);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `Facilitator error: ${response.status} - ${errorText}`,
        };
      }

      const result = await response.json();
      return {
        success: true,
        transactionHash: result.transactionHash || result.transaction_hash,
        network: result.network,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Verify and settle atomically
   *
   * Convenience method that verifies first, then settles if valid.
   * Use this for simple payment flows where you don't need custom logic between verify and settle.
   *
   * @param paymentHeader - Parsed x402 payment header
   * @param requirements - Payment requirements
   * @returns Combined result with verify and settle status
   */
  async verifyAndSettle(
    paymentHeader: X402Header,
    requirements: PaymentRequirements
  ): Promise<{
    verified: boolean;
    settled: boolean;
    transactionHash?: string;
    error?: string;
  }> {
    // Verify first
    const verifyResult = await this.verify(paymentHeader, requirements);
    if (!verifyResult.isValid) {
      return {
        verified: false,
        settled: false,
        error: verifyResult.invalidReason,
      };
    }

    // Settle
    const settleResult = await this.settle(paymentHeader, requirements);
    return {
      verified: true,
      settled: settleResult.success,
      transactionHash: settleResult.transactionHash,
      error: settleResult.error,
    };
  }

  /**
   * Check if the facilitator is healthy
   *
   * @returns True if the facilitator is responding
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// ATOMIC PAYMENT HELPERS
// ============================================================================

/**
 * Create a 402 Payment Required response
 *
 * @param requirements - Payment requirements
 * @param options - Additional response options
 * @returns Object with status code, headers, and body for the 402 response
 *
 * @example
 * ```ts
 * // Express.js
 * app.get('/premium-data', (req, res) => {
 *   const payment = extractPaymentFromHeaders(req.headers);
 *
 *   if (!payment) {
 *     const { status, headers, body } = create402Response({
 *       amount: '1.00',
 *       recipient: '0x...',
 *       resource: 'https://api.example.com/premium-data',
 *     });
 *     return res.status(status).set(headers).json(body);
 *   }
 *
 *   // Verify and serve...
 * });
 * ```
 */
export function create402Response(
  requirements: PaymentRequirementsOptions,
  options: {
    accepts?: Array<{ network: string; asset: string; amount: string }>;
  } = {}
): {
  status: 402;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const reqs = buildPaymentRequirements(requirements);

  const body: Record<string, unknown> = {
    x402Version: requirements.x402Version || 1,
    ...reqs,
  };

  if (options.accepts) {
    body.accepts = options.accepts;
  }

  return {
    status: 402,
    headers: {
      'Content-Type': 'application/json',
      ...X402_CORS_HEADERS,
    },
    body,
  };
}

/**
 * Create an Express-compatible middleware for x402 payments
 *
 * @param getRequirements - Function to get payment requirements for a request
 * @param options - Middleware options
 * @returns Express middleware function
 *
 * @example
 * ```ts
 * const paymentMiddleware = createPaymentMiddleware(
 *   (req) => ({
 *     amount: '1.00',
 *     recipient: process.env.PAYMENT_RECIPIENT,
 *     resource: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
 *   }),
 *   { facilitatorUrl: 'https://facilitator.uvd.xyz' }
 * );
 *
 * app.get('/premium/*', paymentMiddleware, (req, res) => {
 *   res.json({ premium: 'data' });
 * });
 * ```
 */
export function createPaymentMiddleware(
  getRequirements: (req: { headers: Record<string, string | string[] | undefined> }) => PaymentRequirementsOptions,
  options: FacilitatorClientOptions = {}
): (
  req: { headers: Record<string, string | string[] | undefined> },
  res: { status: (code: number) => { json: (body: unknown) => void; set: (headers: Record<string, string>) => { json: (body: unknown) => void } } },
  next: () => void
) => Promise<void> {
  const client = new FacilitatorClient(options);

  return async (req, res, next) => {
    // Extract payment header
    const payment = extractPaymentFromHeaders(req.headers);

    // If no payment, return 402
    if (!payment) {
      const reqOptions = getRequirements(req);
      const { status, headers, body } = create402Response(reqOptions);
      res.status(status).set(headers).json(body);
      return;
    }

    // Build requirements and verify
    const reqOptions = getRequirements(req);
    const requirements = buildPaymentRequirements(reqOptions);
    const verifyResult = await client.verify(payment, requirements);

    if (!verifyResult.isValid) {
      res.status(402).json({
        error: 'Payment verification failed',
        reason: verifyResult.invalidReason,
      });
      return;
    }

    // Payment is valid, continue to handler
    // Note: Settlement should be done after the response is sent
    next();
  };
}

// ============================================================================
// BAZAAR DISCOVERY API
// ============================================================================

/**
 * Resource category for discovery
 */
export type BazaarCategory =
  | 'api'
  | 'data'
  | 'ai'
  | 'media'
  | 'compute'
  | 'storage'
  | 'other';

/**
 * Network/chain filter for discovery
 */
export type BazaarNetwork =
  | 'base'
  | 'ethereum'
  | 'polygon'
  | 'arbitrum'
  | 'optimism'
  | 'avalanche'
  | 'celo'
  | 'hyperevm'
  | 'unichain'
  | 'monad'
  | 'solana'
  | 'fogo'
  | 'stellar'
  | 'near';

/**
 * Token/asset filter for discovery
 */
export type BazaarToken = 'USDC' | 'EURC' | 'AUSD' | 'PYUSD' | 'USDT';

/**
 * Resource registered in the Bazaar
 */
export interface BazaarResource {
  /** Unique resource ID */
  id: string;
  /** Resource URL */
  url: string;
  /** Human-readable name */
  name: string;
  /** Description of the resource */
  description: string;
  /** Category of the resource */
  category: BazaarCategory;
  /** Supported networks for payment */
  networks: BazaarNetwork[];
  /** Supported tokens for payment */
  tokens: BazaarToken[];
  /** Price per request in atomic units */
  pricePerRequest: string;
  /** Price currency (e.g., "USDC") */
  priceCurrency: BazaarToken;
  /** Recipient address for payments */
  payTo: string;
  /** MIME type of the resource */
  mimeType: string;
  /** Optional output schema */
  outputSchema?: unknown;
  /** Resource owner/provider */
  provider?: string;
  /** Resource tags for search */
  tags?: string[];
  /** Whether the resource is active */
  isActive: boolean;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Options for registering a resource
 */
export interface BazaarRegisterOptions {
  /** Resource URL (must be unique) */
  url: string;
  /** Human-readable name */
  name: string;
  /** Description of the resource */
  description: string;
  /** Category of the resource */
  category: BazaarCategory;
  /** Supported networks for payment */
  networks: BazaarNetwork[];
  /** Supported tokens for payment */
  tokens?: BazaarToken[];
  /** Price per request (e.g., "0.01") */
  price: string;
  /** Price currency (default: USDC) */
  priceCurrency?: BazaarToken;
  /** Recipient address for payments */
  payTo: string;
  /** MIME type of the resource (default: application/json) */
  mimeType?: string;
  /** Optional output schema */
  outputSchema?: unknown;
  /** Resource tags for search */
  tags?: string[];
}

/**
 * Options for discovering resources
 */
export interface BazaarDiscoverOptions {
  /** Filter by category */
  category?: BazaarCategory;
  /** Filter by network */
  network?: BazaarNetwork;
  /** Filter by token */
  token?: BazaarToken;
  /** Filter by provider address */
  provider?: string;
  /** Filter by tags (match any) */
  tags?: string[];
  /** Search query (name, description) */
  query?: string;
  /** Maximum price filter (e.g., "0.10") */
  maxPrice?: string;
  /** Page number (1-indexed) */
  page?: number;
  /** Results per page (default: 20, max: 100) */
  limit?: number;
  /** Sort order */
  sortBy?: 'price' | 'createdAt' | 'name';
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated discovery response
 */
export interface BazaarDiscoverResponse {
  /** List of resources matching the query */
  resources: BazaarResource[];
  /** Total number of matching resources */
  total: number;
  /** Current page number */
  page: number;
  /** Results per page */
  limit: number;
  /** Total number of pages */
  totalPages: number;
  /** Whether there are more pages */
  hasMore: boolean;
}

/**
 * Options for the BazaarClient
 */
export interface BazaarClientOptions {
  /** Base URL of the Bazaar API (default: https://bazaar.ultravioletadao.xyz) */
  baseUrl?: string;
  /** API key for authenticated operations (required for register/update/delete) */
  apiKey?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Client for interacting with the x402 Bazaar Discovery API
 *
 * The Bazaar is a discovery service for x402-enabled resources.
 * Providers can register their APIs and consumers can discover them.
 *
 * @example
 * ```ts
 * // Discover resources (no auth required)
 * const bazaar = new BazaarClient();
 * const results = await bazaar.discover({
 *   category: 'ai',
 *   network: 'base',
 *   maxPrice: '0.10',
 * });
 *
 * // Register a resource (requires API key)
 * const authBazaar = new BazaarClient({ apiKey: 'your-api-key' });
 * const resource = await authBazaar.register({
 *   url: 'https://api.example.com/v1/chat',
 *   name: 'AI Chat API',
 *   description: 'Pay-per-message AI chat',
 *   category: 'ai',
 *   networks: ['base', 'ethereum'],
 *   price: '0.01',
 *   payTo: '0x...',
 * });
 * ```
 */
export class BazaarClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeout: number;

  constructor(options: BazaarClientOptions = {}) {
    this.baseUrl = options.baseUrl || 'https://bazaar.ultravioletadao.xyz';
    this.apiKey = options.apiKey;
    this.timeout = options.timeout || 30000;
  }

  /**
   * Discover x402-enabled resources
   *
   * @param options - Discovery filters
   * @returns Paginated list of matching resources
   *
   * @example
   * ```ts
   * // Find AI APIs on Base with USDC under $0.10
   * const results = await bazaar.discover({
   *   category: 'ai',
   *   network: 'base',
   *   token: 'USDC',
   *   maxPrice: '0.10',
   * });
   *
   * for (const resource of results.resources) {
   *   console.log(`${resource.name}: ${resource.url}`);
   * }
   * ```
   */
  async discover(
    options: BazaarDiscoverOptions = {}
  ): Promise<BazaarDiscoverResponse> {
    const params = new URLSearchParams();

    if (options.category) params.set('category', options.category);
    if (options.network) params.set('network', options.network);
    if (options.token) params.set('token', options.token);
    if (options.provider) params.set('provider', options.provider);
    if (options.tags?.length) params.set('tags', options.tags.join(','));
    if (options.query) params.set('query', options.query);
    if (options.maxPrice) params.set('maxPrice', options.maxPrice);
    if (options.page) params.set('page', options.page.toString());
    if (options.limit) params.set('limit', options.limit.toString());
    if (options.sortBy) params.set('sortBy', options.sortBy);
    if (options.sortOrder) params.set('sortOrder', options.sortOrder);

    const url = `${this.baseUrl}/resources${params.toString() ? `?${params}` : ''}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bazaar API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Get a specific resource by ID
   *
   * @param resourceId - Resource ID
   * @returns Resource details
   */
  async getResource(resourceId: string): Promise<BazaarResource> {
    const url = `${this.baseUrl}/resources/${encodeURIComponent(resourceId)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bazaar API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Get a resource by its URL
   *
   * @param resourceUrl - Resource URL
   * @returns Resource details
   */
  async getResourceByUrl(resourceUrl: string): Promise<BazaarResource> {
    const url = `${this.baseUrl}/resources/by-url?url=${encodeURIComponent(resourceUrl)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bazaar API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Register a new resource in the Bazaar
   *
   * Requires API key authentication.
   *
   * @param options - Resource registration options
   * @returns Registered resource
   *
   * @example
   * ```ts
   * const resource = await bazaar.register({
   *   url: 'https://api.example.com/v1/generate',
   *   name: 'Image Generator API',
   *   description: 'Generate images with AI',
   *   category: 'ai',
   *   networks: ['base', 'ethereum', 'polygon'],
   *   price: '0.05',
   *   payTo: '0x1234...',
   *   tags: ['ai', 'image', 'generator'],
   * });
   * ```
   */
  async register(options: BazaarRegisterOptions): Promise<BazaarResource> {
    if (!this.apiKey) {
      throw new Error('API key required for resource registration');
    }

    const url = `${this.baseUrl}/resources`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          url: options.url,
          name: options.name,
          description: options.description,
          category: options.category,
          networks: options.networks,
          tokens: options.tokens || ['USDC'],
          price: options.price,
          priceCurrency: options.priceCurrency || 'USDC',
          payTo: options.payTo,
          mimeType: options.mimeType || 'application/json',
          outputSchema: options.outputSchema,
          tags: options.tags,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bazaar API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Update an existing resource
   *
   * Requires API key authentication. Only the owner can update.
   *
   * @param resourceId - Resource ID to update
   * @param updates - Partial update options
   * @returns Updated resource
   */
  async update(
    resourceId: string,
    updates: Partial<BazaarRegisterOptions>
  ): Promise<BazaarResource> {
    if (!this.apiKey) {
      throw new Error('API key required for resource update');
    }

    const url = `${this.baseUrl}/resources/${encodeURIComponent(resourceId)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(updates),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bazaar API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Delete a resource from the Bazaar
   *
   * Requires API key authentication. Only the owner can delete.
   *
   * @param resourceId - Resource ID to delete
   */
  async delete(resourceId: string): Promise<void> {
    if (!this.apiKey) {
      throw new Error('API key required for resource deletion');
    }

    const url = `${this.baseUrl}/resources/${encodeURIComponent(resourceId)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bazaar API error: ${response.status} - ${errorText}`);
      }
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Deactivate a resource (soft delete)
   *
   * Requires API key authentication. Only the owner can deactivate.
   *
   * @param resourceId - Resource ID to deactivate
   * @returns Updated resource with isActive: false
   */
  async deactivate(resourceId: string): Promise<BazaarResource> {
    if (!this.apiKey) {
      throw new Error('API key required for resource deactivation');
    }

    const url = `${this.baseUrl}/resources/${encodeURIComponent(resourceId)}/deactivate`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bazaar API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Reactivate a deactivated resource
   *
   * Requires API key authentication. Only the owner can reactivate.
   *
   * @param resourceId - Resource ID to reactivate
   * @returns Updated resource with isActive: true
   */
  async reactivate(resourceId: string): Promise<BazaarResource> {
    if (!this.apiKey) {
      throw new Error('API key required for resource reactivation');
    }

    const url = `${this.baseUrl}/resources/${encodeURIComponent(resourceId)}/reactivate`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bazaar API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * List all resources owned by the authenticated user
   *
   * Requires API key authentication.
   *
   * @param options - Pagination options
   * @returns Paginated list of owned resources
   */
  async listMyResources(options: {
    page?: number;
    limit?: number;
    includeInactive?: boolean;
  } = {}): Promise<BazaarDiscoverResponse> {
    if (!this.apiKey) {
      throw new Error('API key required to list owned resources');
    }

    const params = new URLSearchParams();
    if (options.page) params.set('page', options.page.toString());
    if (options.limit) params.set('limit', options.limit.toString());
    if (options.includeInactive) params.set('includeInactive', 'true');

    const url = `${this.baseUrl}/resources/mine${params.toString() ? `?${params}` : ''}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bazaar API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Get Bazaar API health status
   *
   * @returns True if the Bazaar API is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get Bazaar statistics
   *
   * @returns Global statistics about the Bazaar
   */
  async getStats(): Promise<{
    totalResources: number;
    activeResources: number;
    totalProviders: number;
    categoryCounts: Record<BazaarCategory, number>;
    networkCounts: Record<BazaarNetwork, number>;
  }> {
    const url = `${this.baseUrl}/stats`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bazaar API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }
}

// ============================================================================
// ESCROW & REFUND EXTENSION
// ============================================================================

/**
 * Escrow payment status
 */
export type EscrowStatus =
  | 'pending'        // Payment initiated, awaiting confirmation
  | 'held'           // Funds held in escrow
  | 'released'       // Funds released to recipient
  | 'refunded'       // Funds returned to payer
  | 'disputed'       // Dispute in progress
  | 'expired';       // Escrow expired without resolution

/**
 * Refund request status
 */
export type RefundStatus =
  | 'pending'        // Refund requested, awaiting processing
  | 'approved'       // Refund approved
  | 'rejected'       // Refund rejected
  | 'processed'      // Refund completed on-chain
  | 'disputed';      // Under dispute review

/**
 * Dispute resolution outcome
 */
export type DisputeOutcome =
  | 'pending'        // Dispute under review
  | 'payer_wins'     // Payer gets refund
  | 'recipient_wins' // Recipient keeps funds
  | 'split';         // Funds split between parties

/**
 * Escrow payment record
 */
export interface EscrowPayment {
  /** Unique escrow ID */
  id: string;
  /** Original payment header (base64 encoded) */
  paymentHeader: string;
  /** Current status */
  status: EscrowStatus;
  /** Network where payment was made */
  network: string;
  /** Payer address */
  payer: string;
  /** Recipient address */
  recipient: string;
  /** Amount in atomic units */
  amount: string;
  /** Token/asset contract */
  asset: string;
  /** Resource URL being paid for */
  resource: string;
  /** Escrow expiration timestamp (ISO) */
  expiresAt: string;
  /** Release conditions (optional) */
  releaseConditions?: {
    /** Minimum time before release (seconds) */
    minHoldTime?: number;
    /** Required confirmations */
    confirmations?: number;
    /** Custom condition metadata */
    custom?: unknown;
  };
  /** Transaction hash if released/refunded */
  transactionHash?: string;
  /** Creation timestamp (ISO) */
  createdAt: string;
  /** Last update timestamp (ISO) */
  updatedAt: string;
}

/**
 * Refund request record
 */
export interface RefundRequest {
  /** Unique refund request ID */
  id: string;
  /** Related escrow ID */
  escrowId: string;
  /** Current status */
  status: RefundStatus;
  /** Reason for refund request */
  reason: string;
  /** Additional evidence/details */
  evidence?: string;
  /** Amount requested (may be partial) */
  amountRequested: string;
  /** Amount approved (if any) */
  amountApproved?: string;
  /** Requester (payer) address */
  requester: string;
  /** Transaction hash if processed */
  transactionHash?: string;
  /** Response from recipient/facilitator */
  response?: {
    status: 'approved' | 'rejected';
    reason?: string;
    respondedAt: string;
  };
  /** Creation timestamp (ISO) */
  createdAt: string;
  /** Last update timestamp (ISO) */
  updatedAt: string;
}

/**
 * Dispute record
 */
export interface Dispute {
  /** Unique dispute ID */
  id: string;
  /** Related escrow ID */
  escrowId: string;
  /** Related refund request ID (if any) */
  refundRequestId?: string;
  /** Dispute outcome */
  outcome: DisputeOutcome;
  /** Initiator (payer or recipient) */
  initiator: 'payer' | 'recipient';
  /** Reason for dispute */
  reason: string;
  /** Evidence from payer */
  payerEvidence?: string;
  /** Evidence from recipient */
  recipientEvidence?: string;
  /** Arbitration notes */
  arbitrationNotes?: string;
  /** Amount resolved to payer */
  payerAmount?: string;
  /** Amount resolved to recipient */
  recipientAmount?: string;
  /** Transaction hash(es) for resolution */
  transactionHashes?: string[];
  /** Creation timestamp (ISO) */
  createdAt: string;
  /** Resolution timestamp (ISO) */
  resolvedAt?: string;
}

/**
 * Options for creating an escrow payment
 */
export interface CreateEscrowOptions {
  /** Payment header (from client SDK) */
  paymentHeader: string;
  /** Payment requirements */
  requirements: PaymentRequirements;
  /** Escrow duration in seconds (default: 86400 = 24h) */
  escrowDuration?: number;
  /** Release conditions */
  releaseConditions?: {
    minHoldTime?: number;
    confirmations?: number;
    custom?: unknown;
  };
}

/**
 * Options for requesting a refund
 */
export interface RequestRefundOptions {
  /** Escrow ID to refund */
  escrowId: string;
  /** Reason for refund */
  reason: string;
  /** Amount to refund (full amount if not specified) */
  amount?: string;
  /** Supporting evidence */
  evidence?: string;
}

/**
 * Options for the EscrowClient
 */
export interface EscrowClientOptions {
  /** Base URL of the Escrow API (default: https://escrow.ultravioletadao.xyz) */
  baseUrl?: string;
  /** API key for authenticated operations */
  apiKey?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Client for x402 Escrow & Refund operations
 *
 * The Escrow system holds payments until service is verified,
 * enabling refunds and dispute resolution.
 *
 * @example
 * ```ts
 * // Create escrow payment (backend)
 * const escrow = new EscrowClient();
 * const escrowPayment = await escrow.createEscrow({
 *   paymentHeader: req.headers['x-payment'],
 *   requirements: paymentRequirements,
 *   escrowDuration: 86400, // 24 hours
 * });
 *
 * // After service is provided, release the escrow
 * await escrow.release(escrowPayment.id);
 *
 * // If service not provided, payer can request refund
 * await escrow.requestRefund({
 *   escrowId: escrowPayment.id,
 *   reason: 'Service not delivered within expected timeframe',
 * });
 * ```
 */
export class EscrowClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeout: number;

  constructor(options: EscrowClientOptions = {}) {
    this.baseUrl = options.baseUrl || 'https://escrow.ultravioletadao.xyz';
    this.apiKey = options.apiKey;
    this.timeout = options.timeout || 30000;
  }

  private getHeaders(authenticated: boolean = false): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (authenticated && this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Create an escrow payment
   *
   * Holds the payment in escrow until released or refunded.
   *
   * @param options - Escrow creation options
   * @returns Created escrow payment
   */
  async createEscrow(options: CreateEscrowOptions): Promise<EscrowPayment> {
    const url = `${this.baseUrl}/escrow`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({
          paymentHeader: options.paymentHeader,
          paymentRequirements: options.requirements,
          escrowDuration: options.escrowDuration || 86400,
          releaseConditions: options.releaseConditions,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Get escrow payment by ID
   *
   * @param escrowId - Escrow payment ID
   * @returns Escrow payment details
   */
  async getEscrow(escrowId: string): Promise<EscrowPayment> {
    const url = `${this.baseUrl}/escrow/${encodeURIComponent(escrowId)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Release escrow funds to recipient
   *
   * Call this after service has been successfully provided.
   *
   * @param escrowId - Escrow payment ID
   * @returns Updated escrow payment with transaction hash
   */
  async release(escrowId: string): Promise<EscrowPayment> {
    const url = `${this.baseUrl}/escrow/${encodeURIComponent(escrowId)}/release`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(true),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Request a refund for an escrow payment
   *
   * Initiates a refund request that must be approved.
   *
   * @param options - Refund request options
   * @returns Created refund request
   */
  async requestRefund(options: RequestRefundOptions): Promise<RefundRequest> {
    const url = `${this.baseUrl}/escrow/${encodeURIComponent(options.escrowId)}/refund`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({
          reason: options.reason,
          amount: options.amount,
          evidence: options.evidence,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Approve a refund request (for recipients)
   *
   * @param refundId - Refund request ID
   * @param amount - Amount to approve (may be less than requested)
   * @returns Updated refund request
   */
  async approveRefund(refundId: string, amount?: string): Promise<RefundRequest> {
    const url = `${this.baseUrl}/refund/${encodeURIComponent(refundId)}/approve`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({ amount }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Reject a refund request (for recipients)
   *
   * @param refundId - Refund request ID
   * @param reason - Reason for rejection
   * @returns Updated refund request
   */
  async rejectRefund(refundId: string, reason: string): Promise<RefundRequest> {
    const url = `${this.baseUrl}/refund/${encodeURIComponent(refundId)}/reject`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({ reason }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Get refund request by ID
   *
   * @param refundId - Refund request ID
   * @returns Refund request details
   */
  async getRefund(refundId: string): Promise<RefundRequest> {
    const url = `${this.baseUrl}/refund/${encodeURIComponent(refundId)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Open a dispute for an escrow payment
   *
   * Initiates arbitration when payer and recipient disagree.
   *
   * @param escrowId - Escrow payment ID
   * @param reason - Reason for dispute
   * @param evidence - Supporting evidence
   * @returns Created dispute
   */
  async openDispute(
    escrowId: string,
    reason: string,
    evidence?: string
  ): Promise<Dispute> {
    const url = `${this.baseUrl}/escrow/${encodeURIComponent(escrowId)}/dispute`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({ reason, evidence }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Submit evidence to a dispute
   *
   * @param disputeId - Dispute ID
   * @param evidence - Evidence to submit
   * @returns Updated dispute
   */
  async submitEvidence(disputeId: string, evidence: string): Promise<Dispute> {
    const url = `${this.baseUrl}/dispute/${encodeURIComponent(disputeId)}/evidence`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(true),
        body: JSON.stringify({ evidence }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Get dispute by ID
   *
   * @param disputeId - Dispute ID
   * @returns Dispute details
   */
  async getDispute(disputeId: string): Promise<Dispute> {
    const url = `${this.baseUrl}/dispute/${encodeURIComponent(disputeId)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * List escrow payments (with filters)
   *
   * @param options - Filter and pagination options
   * @returns Paginated list of escrow payments
   */
  async listEscrows(options: {
    status?: EscrowStatus;
    payer?: string;
    recipient?: string;
    page?: number;
    limit?: number;
  } = {}): Promise<{
    escrows: EscrowPayment[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }> {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.payer) params.set('payer', options.payer);
    if (options.recipient) params.set('recipient', options.recipient);
    if (options.page) params.set('page', options.page.toString());
    if (options.limit) params.set('limit', options.limit.toString());

    const url = `${this.baseUrl}/escrow${params.toString() ? `?${params}` : ''}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(true),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Escrow API error: ${response.status} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Check Escrow API health
   *
   * @returns True if healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// ESCROW HELPER FUNCTIONS
// ============================================================================

/**
 * Check if an escrow can be released
 *
 * @param escrow - Escrow payment to check
 * @returns True if the escrow can be released
 */
export function canReleaseEscrow(escrow: EscrowPayment): boolean {
  if (escrow.status !== 'held') {
    return false;
  }

  // Check expiration
  if (new Date(escrow.expiresAt) < new Date()) {
    return false;
  }

  // Check minimum hold time if specified
  if (escrow.releaseConditions?.minHoldTime) {
    const createdAt = new Date(escrow.createdAt);
    const minReleaseTime = new Date(
      createdAt.getTime() + escrow.releaseConditions.minHoldTime * 1000
    );
    if (new Date() < minReleaseTime) {
      return false;
    }
  }

  return true;
}

/**
 * Check if an escrow can be refunded
 *
 * @param escrow - Escrow payment to check
 * @returns True if the escrow can be refunded
 */
export function canRefundEscrow(escrow: EscrowPayment): boolean {
  // Can only refund held or pending escrows
  return escrow.status === 'held' || escrow.status === 'pending';
}

/**
 * Check if an escrow is expired
 *
 * @param escrow - Escrow payment to check
 * @returns True if the escrow is expired
 */
export function isEscrowExpired(escrow: EscrowPayment): boolean {
  return new Date(escrow.expiresAt) < new Date();
}

/**
 * Calculate time remaining until escrow expires
 *
 * @param escrow - Escrow payment to check
 * @returns Milliseconds until expiration (negative if expired)
 */
export function escrowTimeRemaining(escrow: EscrowPayment): number {
  return new Date(escrow.expiresAt).getTime() - Date.now();
}
