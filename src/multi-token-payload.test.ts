import { describe, expect, it } from 'vitest';

import { EVMProvider } from './providers/evm';
import { getChainByName, getTokenByAddress } from './chains';
import {
  encodeBase64Json,
  encodeBase64Utf8,
  decodeBase64Utf8,
  buildTokenMetadata,
} from './utils';
import { encodeX402Header, decodeX402Header } from './utils/x402';

/**
 * Multi-token payloads: the header must say WHICH stablecoin was paid.
 *
 * An EIP-3009 authorization is signed against a token contract, but the encoded
 * payload only carried `{signature, authorization}` — so a EURC payment on Base
 * and a USDC payment on Base produced indistinguishable headers. A resource
 * that accepts several stablecoins per chain then cannot rebuild
 * `paymentRequirements` (`asset` + the `extra` EIP-712 domain) and the
 * facilitator cannot settle.
 *
 * 402milly hit this in production and worked around it downstream, by hand:
 * it stopped calling the SDK for anything that was not USDC and hand-rolled the
 * EIP-712 signing so it could attach its own `token` block. These tests pin the
 * shape of that block, byte for byte, so the SDK covers the case for everyone.
 *
 * The fixtures below are the real (chain, token) pairs 402milly settles on,
 * including the two that break naive implementations:
 *   - USDT on Optimism/Arbitrum: EIP-712 domain name is `USD₮0` (U+20AE), which
 *     a plain `btoa()` cannot encode.
 *   - USDC on BSC: 18 decimals, not 6.
 */

const SIGNED = {
  from: '0x7052cA449702e5ffafbE3dc63b74C7b7d8aF402B',
  to: '0xe4dc963c56979E0260fc146b87eE24F18220e545',
  value: '1000000',
  validAfter: 0,
  validBefore: 1799999999,
  nonce: '0x' + 'ab'.repeat(32),
  v: 27,
  r: '0x' + '11'.repeat(32),
  s: '0x' + '22'.repeat(32),
};

/** (chain, token address) -> the metadata block the payload must carry. */
const TOKEN_FIXTURES: Array<{
  chain: string;
  address: string;
  expected: {
    address: string;
    symbol: string;
    decimals: number;
    eip712: { name: string; version: string };
  };
}> = [
  {
    chain: 'base',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    expected: {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      symbol: 'USDC',
      decimals: 6,
      eip712: { name: 'USD Coin', version: '2' },
    },
  },
  {
    chain: 'base',
    address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
    expected: {
      address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
      symbol: 'EURC',
      decimals: 6,
      eip712: { name: 'EURC', version: '2' },
    },
  },
  {
    chain: 'polygon',
    address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    expected: {
      address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
      symbol: 'AUSD',
      decimals: 6,
      eip712: { name: 'Agora Dollar', version: '1' },
    },
  },
  {
    chain: 'ethereum',
    address: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8',
    expected: {
      address: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8',
      symbol: 'PYUSD',
      decimals: 6,
      eip712: { name: 'PayPal USD', version: '1' },
    },
  },
  {
    chain: 'optimism',
    address: '0x01bff41798a0bcf287b996046ca68b395dbc1071',
    expected: {
      address: '0x01bff41798a0bcf287b996046ca68b395dbc1071',
      symbol: 'USDT',
      decimals: 6,
      // U+20AE. This is the character that makes plain btoa() throw.
      eip712: { name: 'USD₮0', version: '1' },
    },
  },
  {
    chain: 'ethereum',
    address: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
    expected: {
      address: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
      symbol: 'EURC',
      decimals: 6,
      eip712: { name: 'Euro Coin', version: '2' },
    },
  },
  {
    chain: 'bsc',
    address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    expected: {
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      symbol: 'USDC',
      // Binance-Peg USDC is an 18-decimal token. Assuming 6 here would
      // under-charge by a factor of 10^12.
      decimals: 18,
      eip712: { name: 'USD Coin', version: '2' },
    },
  },
];

describe('buildTokenMetadata', () => {
  for (const { chain, address, expected } of TOKEN_FIXTURES) {
    it(`resolves ${expected.symbol} on ${chain} from its address`, () => {
      expect(buildTokenMetadata(chain, address)).toEqual(expected);
    });
  }

  it('is case-insensitive on EVM addresses', () => {
    const lower = buildTokenMetadata('base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    const mixed = buildTokenMetadata('base', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(lower).toEqual(mixed);
  });

  it('returns undefined for an address that is not in the registry', () => {
    expect(buildTokenMetadata('base', '0x' + '00'.repeat(20))).toBeUndefined();
  });

  it('returns undefined for an unknown chain', () => {
    expect(buildTokenMetadata('not-a-chain', '0x0')).toBeUndefined();
  });
});

describe('getTokenByAddress', () => {
  it('names the token type, not just the config', () => {
    const match = getTokenByAddress('optimism', '0x01bff41798a0bcf287b996046ca68b395dbc1071');
    expect(match?.tokenType).toBe('usdt');
    expect(match?.config.name).toBe('USD₮0');
  });
});

describe('EVMProvider.encodePaymentHeader — token metadata', () => {
  const provider = new EVMProvider();

  it('omits the token block by default, keeping the legacy wire format', () => {
    const chain = getChainByName('base')!;
    const header = provider.encodePaymentHeader(
      JSON.stringify({ ...SIGNED, chainId: 8453, token: chain.usdc.address }),
      chain
    );
    const decoded = JSON.parse(decodeBase64Utf8(header));

    expect(decoded.payload).not.toHaveProperty('token');
    expect(Object.keys(decoded.payload)).toEqual(['signature', 'authorization']);
  });

  it('carries the token block when asked for it', () => {
    const chain = getChainByName('base')!;
    const header = provider.encodePaymentHeader(
      JSON.stringify({
        ...SIGNED,
        chainId: 8453,
        token: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', // EURC
      }),
      chain,
      1,
      { includeTokenMetadata: true }
    );
    const decoded = JSON.parse(decodeBase64Utf8(header));

    expect(decoded.payload.token).toEqual({
      address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
      symbol: 'EURC',
      decimals: 6,
      eip712: { name: 'EURC', version: '2' },
    });
    // The rest of the payload is untouched.
    expect(decoded.payload.authorization.from).toBe(SIGNED.from);
    expect(decoded.x402Version).toBe(1);
    expect(decoded.network).toBe('base');
  });

  it('encodes a non-ASCII domain name instead of throwing', () => {
    const chain = getChainByName('optimism')!;
    const header = provider.encodePaymentHeader(
      JSON.stringify({
        ...SIGNED,
        chainId: 10,
        token: '0x01bff41798a0bcf287b996046ca68b395dbc1071', // USDT, domain `USD₮0`
      }),
      chain,
      1,
      { includeTokenMetadata: true }
    );
    const decoded = JSON.parse(decodeBase64Utf8(header));

    expect(decoded.payload.token.eip712.name).toBe('USD₮0');
  });

  it('refuses to invent metadata for a token it does not know', () => {
    const chain = getChainByName('base')!;
    expect(() =>
      provider.encodePaymentHeader(
        JSON.stringify({ ...SIGNED, chainId: 8453, token: '0x' + '00'.repeat(20) }),
        chain,
        1,
        { includeTokenMetadata: true }
      )
    ).toThrow(/not in the registry/);
  });

  it('uses CAIP-2 for v2 while still carrying the token', () => {
    const chain = getChainByName('base')!;
    const header = provider.encodePaymentHeader(
      JSON.stringify({ ...SIGNED, chainId: 8453, token: chain.usdc.address }),
      chain,
      2,
      { includeTokenMetadata: true }
    );
    const decoded = JSON.parse(decodeBase64Utf8(header));

    expect(decoded.x402Version).toBe(2);
    expect(decoded.network).toBe('eip155:8453');
    expect(decoded.payload.token.symbol).toBe('USDC');
  });
});

describe('UTF-8 safe base64', () => {
  it('round-trips a non-ASCII token domain that plain btoa cannot encode', () => {
    const value = JSON.stringify({ name: 'USD₮0' });

    expect(() => btoa(value)).toThrow();
    expect(decodeBase64Utf8(encodeBase64Utf8(value))).toBe(value);
  });

  it('is byte-identical to btoa for ASCII input', () => {
    // This is what makes swapping the encoder in safe: every header that
    // worked before produces exactly the same string.
    const ascii = JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base' });
    expect(encodeBase64Utf8(ascii)).toBe(btoa(ascii));
  });

  it('round-trips through encodeX402Header/decodeX402Header', () => {
    const header = {
      x402Version: 1 as const,
      scheme: 'exact' as const,
      network: 'optimism',
      payload: {
        signature: '0xdead',
        authorization: {
          from: SIGNED.from,
          to: SIGNED.to,
          value: SIGNED.value,
          validAfter: '0',
          validBefore: '1799999999',
          nonce: SIGNED.nonce,
        },
        token: {
          address: '0x01bff41798a0bcf287b996046ca68b395dbc1071',
          symbol: 'USDT',
          decimals: 6,
          eip712: { name: 'USD₮0', version: '1' },
        },
      },
    };

    expect(decodeX402Header(encodeX402Header(header))).toEqual(header);
  });

  it('encodeBase64Json matches encodeBase64Utf8 of the serialized value', () => {
    const value = { a: 'USD₮0', b: 1 };
    expect(encodeBase64Json(value)).toBe(encodeBase64Utf8(JSON.stringify(value)));
  });
});
