/**
 * `X402Client.connect()` must route SVM chains to the SVM provider.
 *
 * The registry declares Solana and Fogo as `networkType: 'svm'`
 * (`src/chains/index.ts`), but `connect()` switched on `case 'solana'`. No
 * chain in the registry has ever carried that value, so the branch was dead
 * and Solana fell through to `default:` — the caller got
 * "Unknown network type for chain solana", not even the branch's own message.
 * `NetworkType` lists BOTH `'svm'` and `'solana'`, so the compiler never
 * flagged it.
 *
 * The provider it should have reached, `SVMProvider`, with Phantom detection
 * and gasless USDC transfers, has been in the SDK the whole time.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { X402Client } from './X402Client';

const ADDRESS = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

function stubPhantom(opts: { installed: boolean } = { installed: true }) {
  const phantom = opts.installed
    ? {
        solana: {
          isPhantom: true,
          isConnected: false,
          publicKey: null,
          connect: async () => ({ publicKey: { toBase58: () => ADDRESS } }),
          disconnect: async () => undefined,
          on: () => undefined,
          removeListener: () => undefined,
        },
      }
    : undefined;
  vi.stubGlobal('window', { phantom, ethereum: undefined });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('X402Client.connect on an SVM chain', () => {
  it('does not fall through to "Unknown network type"', async () => {
    stubPhantom({ installed: false });
    const client = new X402Client();
    // The dead `case 'solana'` sent every Solana caller here.
    await expect(client.connect('solana')).rejects.not.toThrow(/Unknown network type/);
  });

  it('reaches the Phantom provider and says so when Phantom is missing', async () => {
    stubPhantom({ installed: false });
    const client = new X402Client();
    // Actionable and provider-specific, instead of "chain not supported".
    await expect(client.connect('solana')).rejects.toThrow(/Phantom/i);
  });

  it('connects and reports the wallet address', async () => {
    stubPhantom();
    const client = new X402Client();
    const address = await client.connect('solana');
    expect(address).toBe(ADDRESS);
    expect(client.getState().address).toBe(ADDRESS);
    expect(client.getState().connected).toBe(true);
  });

  it('routes fogo, the other SVM chain, the same way', async () => {
    stubPhantom();
    const client = new X402Client();
    await expect(client.connect('fogo')).resolves.toBe(ADDRESS);
  });

  it('leaves EVM routing untouched', async () => {
    stubPhantom({ installed: false });
    const client = new X402Client();
    await expect(client.connect('base')).rejects.toThrow(/Ethereum wallet|MetaMask/i);
  });
});
