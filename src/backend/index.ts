/**
 * uvd-x402-sdk - Backend Utilities
 *
 * Server-side utilities for building x402 payment APIs.
 * These utilities help backend developers:
 * - Build verify/settle requests for the facilitator
 * - Parse X-PAYMENT headers from incoming requests
 * - Configure CORS for x402 payment flows
 * - Create atomic payment handlers
 *
 * @example
 * ```ts
 * import {
 *   parsePaymentHeader,
 *   buildVerifyRequest,
 *   buildSettleRequest,
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
