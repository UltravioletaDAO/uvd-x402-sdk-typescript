/**
 * uvd-x402-sdk - x402 Protocol Utilities
 *
 * Utilities for working with x402 v1 and v2 protocols.
 * Handles version detection, payload encoding, and CAIP-2 conversions.
 */

import type {
  X402Header,
  X402HeaderV1,
  X402HeaderV2,
  X402PayloadData,
  X402PaymentOption,
  X402Version,
  ChainConfig,
  TokenType,
} from '../types';
import { CAIP2_IDENTIFIERS, CAIP2_TO_CHAIN } from '../types';
import { getChainByName, getTokenConfig } from '../chains';
import { decodeBase64Utf8, encodeBase64Json } from './base64';

/**
 * Detect x402 version from a response header or body
 *
 * @param data - The 402 response data (parsed JSON or header value)
 * @returns The detected version (1 or 2)
 */
export function detectX402Version(data: unknown): X402Version {
  if (typeof data === 'string') {
    // A `PAYMENT-REQUIRED` header value is base64 JSON, and the doc above
    // invites one. Returning 1 without decoding misread every v2 challenge as
    // v1 — silently, as a plausible value rather than an error, and the two
    // wire forms are structurally incompatible.
    //
    // This is not hypothetical: measured 2026-08-20, 36 of 36 live Bazaar
    // resources answering 402 carry the challenge in the header, and several
    // put a free content preview in the body, so the header is the only place
    // the version signal exists.
    const trimmed = data.trim();
    if (!trimmed) return 1;
    for (const decode of [
      () => JSON.parse(decodeBase64Utf8(trimmed)),
      () => JSON.parse(trimmed),
    ]) {
      try {
        const parsed = decode();
        if (typeof parsed === 'object' && parsed !== null) {
          return detectX402Version(parsed);
        }
      } catch {
        // not this encoding; try the next
      }
    }
    return 1; // undecodable: fall back to v1, as before
  }

  if (typeof data !== 'object' || data === null) {
    return 1; // Default to v1
  }

  const obj = data as Record<string, unknown>;

  // Check explicit version field
  if (obj.x402Version === 2) {
    return 2;
  }

  // Check for v2 indicators
  if (obj.accepts && Array.isArray(obj.accepts)) {
    return 2;
  }

  // `paymentRequirements` is the v1 spelling, so its presence points at v1 --
  // but only when there is no v2 signal, which the checks above already ruled
  // out. Recognised so the value is not treated as an unknown shape.
  if (Array.isArray(obj.paymentRequirements)) {
    return 1;
  }

  // Check if network is in CAIP-2 format
  if (typeof obj.network === 'string') {
    if (obj.network.includes(':')) {
      return 2;
    }
  }

  return 1;
}

/**
 * Convert chain name to CAIP-2 identifier
 *
 * @param chainName - Chain name (e.g., 'base', 'solana')
 * @returns CAIP-2 identifier (e.g., 'eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
 */
export function chainToCAIP2(chainName: string): string {
  const caip2 = CAIP2_IDENTIFIERS[chainName.toLowerCase()];
  if (caip2) {
    return caip2;
  }

  // Try to construct from chain config
  const chain = getChainByName(chainName);
  if (chain) {
    if (chain.networkType === 'evm') {
      return `eip155:${chain.chainId}`;
    }
    // For non-EVM, return the name as-is with network prefix
    return `${chain.networkType}:${chainName}`;
  }

  return chainName; // Return as-is if unknown
}

/**
 * Convert CAIP-2 identifier to chain name
 *
 * @param caip2 - CAIP-2 identifier
 * @returns Chain name or null if unknown
 */
export function caip2ToChain(caip2: string): string | null {
  // Check direct mapping
  if (CAIP2_TO_CHAIN[caip2]) {
    return CAIP2_TO_CHAIN[caip2];
  }

  // Try to extract from EIP-155 format
  const match = caip2.match(/^eip155:(\d+)$/);
  if (match) {
    const chainId = parseInt(match[1], 10);
    // Find chain by ID
    for (const [name, _config] of Object.entries(CAIP2_IDENTIFIERS)) {
      const chain = getChainByName(name);
      if (chain?.chainId === chainId) {
        return name;
      }
    }
  }

  // Try to extract from network:name format
  const parts = caip2.split(':');
  if (parts.length === 2) {
    const networkName = parts[1];
    if (getChainByName(networkName)) {
      return networkName;
    }
  }

  return null;
}

/**
 * Parse network identifier from either v1 or v2 format
 *
 * @param network - Network identifier (v1 string or v2 CAIP-2)
 * @returns Normalized chain name
 */
export function parseNetworkIdentifier(network: string): string {
  // If it contains a colon, it's likely CAIP-2
  if (network.includes(':')) {
    return caip2ToChain(network) || network;
  }
  return network.toLowerCase();
}

/**
 * Encode x402 payload as base64 header value
 *
 * @param header - The x402 header object
 * @returns Base64-encoded string
 */
export function encodeX402Header(header: X402Header): string {
  return encodeBase64Json(header);
}

/**
 * Decode x402 header from base64 string
 *
 * @param encoded - Base64-encoded header value
 * @returns Parsed x402 header
 */
export function decodeX402Header(encoded: string): X402Header {
  const json = decodeBase64Utf8(encoded);
  return JSON.parse(json) as X402Header;
}

/**
 * Create x402 v1 header
 *
 * @param network - Chain name (e.g., 'base')
 * @param payload - Network-specific payload
 * @returns x402 v1 header object
 */
export function createX402V1Header(
  network: string,
  payload: X402PayloadData
): X402HeaderV1 {
  return {
    x402Version: 1,
    scheme: 'exact',
    network,
    payload,
  };
}

/**
 * Create x402 v2 header
 *
 * @param network - CAIP-2 network identifier
 * @param payload - Network-specific payload
 * @param accepts - Optional array of payment options
 * @returns x402 v2 header object
 */
export function createX402V2Header(
  network: string,
  payload: X402PayloadData,
  accepts?: X402PaymentOption[]
): X402HeaderV2 {
  const header: X402HeaderV2 = {
    x402Version: 2,
    scheme: 'exact',
    network: network.includes(':') ? network : chainToCAIP2(network),
    payload,
  };

  if (accepts && accepts.length > 0) {
    header.accepts = accepts;
  }

  return header;
}

/**
 * Create x402 header with automatic version selection
 *
 * @param chainConfig - Chain configuration
 * @param payload - Network-specific payload
 * @param version - Version to use (1, 2, or 'auto')
 * @returns x402 header object
 */
export function createX402Header(
  chainConfig: ChainConfig,
  payload: X402PayloadData,
  version: X402Version | 'auto' = 'auto'
): X402Header {
  // Default to v1 for maximum compatibility
  const effectiveVersion = version === 'auto' ? 1 : version;

  if (effectiveVersion === 2) {
    return createX402V2Header(chainConfig.name, payload);
  }

  return createX402V1Header(chainConfig.name, payload);
}

/**
 * Generate payment options array for multi-network support
 *
 * One entry per (chain, token) pair. By default the token is USDC on every
 * chain, which is exactly what this emitted before `tokens` existed.
 *
 * **`tokens` is opt-in on purpose, and the reason is money.** The chain
 * registry knows more stablecoins than USDC (Base also has EURC), and it is
 * tempting to just emit all of them. But this array becomes the `accepts` of a
 * `402`, so every entry is a currency the seller has publicly agreed to be paid
 * in -- at `amount` units of it. Emitting EURC for a seller who priced in
 * dollars would quietly sell at a 1:1 EUR/USD rate nobody agreed to. So the
 * caller names the tokens it actually accepts, and `amount` is read as units of
 * each named token, NOT converted between them.
 *
 * A token a chain does not have is skipped: an option is only emitted for pairs
 * the registry can actually price.
 *
 * @param chainConfigs - Array of chain configurations
 * @param amount - Amount in units of each token (e.g., "10.00")
 * @param facilitator - Optional facilitator URL override
 * @param tokens - Tokens to offer per chain (default: `['usdc']`)
 * @returns Array of x402 v2 payment options
 *
 * @example
 * ```ts
 * // Dollars only -- the default, and what every existing caller gets.
 * generatePaymentOptions([base], '5.00');
 *
 * // Dollars or euros, priced separately and both genuinely accepted.
 * generatePaymentOptions([base], '5.00', undefined, ['usdc', 'eurc']);
 * ```
 */
export function generatePaymentOptions(
  chainConfigs: ChainConfig[],
  amount: string,
  facilitator?: string,
  tokens: TokenType[] = ['usdc']
): X402PaymentOption[] {
  const options: X402PaymentOption[] = [];

  for (const chain of chainConfigs) {
    if (!chain.x402.enabled) continue;

    for (const tokenType of tokens) {
      const token = getTokenConfig(chain.name, tokenType);
      if (!token) continue;

      // Atomic units in THIS token's decimals -- BSC USDC has 18, not 6.
      const atomicAmount = Math.floor(
        parseFloat(amount) * Math.pow(10, token.decimals)
      ).toString();

      options.push({
        network: chainToCAIP2(chain.name),
        asset: token.address,
        amount: atomicAmount,
        facilitator: facilitator || chain.x402.facilitatorUrl,
      });
    }
  }

  return options;
}

/**
 * Check if a network string is in CAIP-2 format
 *
 * @param network - Network identifier
 * @returns True if CAIP-2 format
 */
export function isCAIP2Format(network: string): boolean {
  return network.includes(':');
}

/**
 * Convert between x402 v1 and v2 header formats
 *
 * @param header - Source header
 * @param targetVersion - Target version
 * @returns Converted header
 */
export function convertX402Header(
  header: X402Header,
  targetVersion: X402Version
): X402Header {
  if (header.x402Version === targetVersion) {
    return header;
  }

  if (targetVersion === 2) {
    // v1 -> v2
    return {
      x402Version: 2,
      scheme: 'exact',
      network: chainToCAIP2(header.network),
      payload: header.payload,
    };
  } else {
    // v2 -> v1
    const chainName = isCAIP2Format(header.network)
      ? caip2ToChain(header.network) || header.network
      : header.network;

    return {
      x402Version: 1,
      scheme: 'exact',
      network: chainName,
      payload: header.payload,
    };
  }
}

/**
 * Read a 402 payment challenge from wherever the seller put it.
 *
 * x402 allows BOTH transports and sellers pick freely:
 *
 * - base64 JSON in the `PAYMENT-REQUIRED` (or `X-PAYMENT-REQUIRED`) header
 * - JSON in the response body
 *
 * Measured against production on 2026-08-20: of 40 live Bazaar resources,
 * **36 of 36 that answered 402 carried the challenge in the header, and none in
 * the body**. Worse, sellers like Tenjin use the 402 body for a free preview of
 * the paid content — so the body is valid JSON that simply has no `accepts`, and
 * a body-only reader parses it happily and finds nothing.
 *
 * Reads the header first because that is where live sellers put it, and falls
 * back to the body so the sellers who use it keep working.
 *
 * Returns `null` when neither transport carries a challenge — a real "no terms
 * here", distinct from a challenge we failed to decode.
 */
export function paymentChallengeFrom(
  headers: { get(name: string): string | null } | Record<string, string>,
  body?: unknown,
): Record<string, unknown> | null {
  const read = (name: string): string | null => {
    if (typeof (headers as { get?: unknown }).get === 'function') {
      return (headers as { get(n: string): string | null }).get(name);
    }
    const rec = headers as Record<string, string>;
    return rec[name] ?? rec[name.toLowerCase()] ?? rec[name.toUpperCase()] ?? null;
  };

  const raw = read('payment-required') ?? read('x-payment-required');
  if (raw) {
    const trimmed = raw.trim();
    for (const decode of [
      () => JSON.parse(decodeBase64Utf8(trimmed)),
      () => JSON.parse(trimmed),
    ]) {
      try {
        const parsed = decode();
        if (isChallenge(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // not this encoding; try the next
      }
    }
  }

  const parsedBody = typeof body === 'string' ? tryJson(body) : body;
  return isChallenge(parsedBody) ? (parsedBody as Record<string, unknown>) : null;
}

/**
 * Whether a value actually looks like an x402 challenge.
 *
 * Deliberately stricter than "is an object": a 402 body carrying a free preview
 * is valid JSON with no payment terms in it, and treating that as a challenge is
 * how a body-only reader concludes it looked and found nothing wrong.
 */
function isChallenge(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  // `paymentRequirements` is the v1 spelling of `accepts`. Missing it made a
  // seller using it look like "no terms here" — the exact false negative this
  // function exists to prevent. Found in the Python SDK by KarmaKadabra's
  // buyer, which matched both keys in production, 2026-08-20.
  return (
    Array.isArray(o.accepts) ||
    Array.isArray(o.paymentRequirements) ||
    typeof o.payTo === 'string'
  );
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
