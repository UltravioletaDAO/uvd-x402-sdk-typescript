import { describe, expect, it, vi } from 'vitest';

import { X402Client } from './X402Client';
import { decodeX402Header } from '../utils/x402';
import { X402Error } from '../types';

/**
 * The buyer loop: `X402Client.fetch()`.
 *
 * The client could sign a payment but never ask for one, so every consumer in
 * the stack hand-rolled the same probe/parse/sign/retry sequence and each one
 * invented its own answer to "how much is too much". Python shipped this loop
 * first (`client.fetch`, PR #5); these tests pin the TypeScript half to the
 * same contract:
 *
 *   - a non-402 response is returned untouched, unsigned;
 *   - `maxAmount` is a HARD ceiling -- over it, nothing is signed;
 *   - both 402 dialects are read (v1 `maxAmountRequired` + plain network name,
 *     v2 `amount` + CAIP-2), and the retry is built in the version the
 *     resource asked for, not the one the config guessed;
 *   - the cheapest offer wins, compared at a common scale, because BSC USDC
 *     has 18 decimals and reading it at 6 picks the wrong chain.
 *
 * Anvil/Hardhat account #0. Es una llave PUBLICA y conocida, a proposito: todo
 * escaner la reconoce como fixture y nadie le manda fondos jamas. NUNCA poner
 * aca una llave generada.
 */
const PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const PAY_TO = '0x000000000000000000000000000000000000dEaD';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch that answers the given responses in order, recording every call. */
function scriptedFetch(responses: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('scriptedFetch: unexpected extra call');
    return next;
  });
  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

async function connectedClient() {
  const client = new X402Client({ defaultChain: 'base' });
  await client.connectWithPrivateKey(PRIVATE_KEY, 'base');
  return client;
}

/** Header of the second (paid) call, decoded. */
function paidPayload(calls: Array<{ init?: RequestInit }>) {
  const headers = calls[1].init?.headers as Record<string, string>;
  return decodeX402Header(headers['X-PAYMENT']);
}

describe('X402Client.fetch - passthrough', () => {
  it('returns a non-402 response untouched and never signs', async () => {
    const client = await connectedClient();
    const { impl, calls } = scriptedFetch([jsonResponse(200, { ok: true })]);

    const res = await client.fetch('https://api.example.com/free', {
      fetchImpl: impl,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    // One call only: the probe. Nothing was paid.
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.headers).toBeUndefined();
  });

  it('returns a non-402 error response untouched instead of paying it', async () => {
    const client = await connectedClient();
    const { impl, calls } = scriptedFetch([jsonResponse(500, { error: 'boom' })]);

    const res = await client.fetch('https://api.example.com/broken', {
      fetchImpl: impl,
    });

    expect(res.status).toBe(500);
    expect(calls).toHaveLength(1);
  });
});

describe('X402Client.fetch - the ceiling', () => {
  const CHALLENGE_V1 = {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: '5000000', // 5.00 USDC
        payTo: PAY_TO,
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        resource: 'https://api.example.com/data',
      },
    ],
  };

  it('throws PAYMENT_EXCEEDS_MAX and signs nothing when the price is over budget', async () => {
    const client = await connectedClient();
    const { impl, calls } = scriptedFetch([jsonResponse(402, CHALLENGE_V1)]);

    await expect(
      client.fetch('https://api.example.com/data', {
        maxAmount: '0.05',
        fetchImpl: impl,
      })
    ).rejects.toMatchObject({ code: 'PAYMENT_EXCEEDS_MAX' });

    // The probe happened; the paid retry did NOT.
    expect(calls).toHaveLength(1);
  });

  it('pays when the price is exactly at the ceiling', async () => {
    const client = await connectedClient();
    const { impl, calls } = scriptedFetch([
      jsonResponse(402, CHALLENGE_V1),
      jsonResponse(200, { data: 'paid' }),
    ]);

    const res = await client.fetch('https://api.example.com/data', {
      maxAmount: '5.00',
      fetchImpl: impl,
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('pays whatever is asked when no ceiling is given', async () => {
    const client = await connectedClient();
    const { impl, calls } = scriptedFetch([
      jsonResponse(402, CHALLENGE_V1),
      jsonResponse(200, { data: 'paid' }),
    ]);

    await client.fetch('https://api.example.com/data', { fetchImpl: impl });

    expect(calls).toHaveLength(2);
  });
});

describe('X402Client.fetch - both 402 dialects', () => {
  it('reads a v1 challenge and retries with a v1 payload under X-PAYMENT', async () => {
    const client = await connectedClient();
    const { impl, calls } = scriptedFetch([
      jsonResponse(402, {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base',
            maxAmountRequired: '10000', // 0.01 USDC
            payTo: PAY_TO,
          },
        ],
      }),
      jsonResponse(200, { data: 'paid' }),
    ]);

    await client.fetch('https://api.example.com/data', {
      maxAmount: '1.00',
      fetchImpl: impl,
    });

    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers['X-PAYMENT']).toBeTruthy();
    // v1 servers do not read PAYMENT-SIGNATURE; do not invent it.
    expect(headers['PAYMENT-SIGNATURE']).toBeUndefined();

    const payload = paidPayload(calls);
    expect(payload.x402Version).toBe(1);
    expect(payload.network).toBe('base');
    expect(payload.payload.authorization.to).toBe(PAY_TO);
    expect(payload.payload.authorization.value).toBe('10000');
  });

  it('reads a v2 CAIP-2 challenge and retries with a v2 payload under both header names', async () => {
    const client = await connectedClient();
    const { impl, calls } = scriptedFetch([
      jsonResponse(402, {
        x402Version: 2,
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            amount: '20000', // 0.02 USDC, v2 spelling
            payTo: PAY_TO,
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          },
        ],
      }),
      jsonResponse(200, { data: 'paid' }),
    ]);

    await client.fetch('https://api.example.com/data', {
      maxAmount: '1.00',
      fetchImpl: impl,
    });

    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers['PAYMENT-SIGNATURE']).toBe(headers['X-PAYMENT']);

    const payload = paidPayload(calls);
    // The 402 said v2, so the envelope is v2 even though the client config
    // never named a version: this is what `x402Version: 'auto'` has to mean.
    expect(payload.x402Version).toBe(2);
    expect(payload.network).toBe('eip155:8453');
    expect(payload.payload.authorization.value).toBe('20000');
  });

  it('reads the non-spec shape where a lone requirement sits at the top level', async () => {
    const client = await connectedClient();
    const { impl, calls } = scriptedFetch([
      jsonResponse(402, {
        x402Version: 1,
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: '30000',
        payTo: PAY_TO,
      }),
      jsonResponse(200, { data: 'paid' }),
    ]);

    await client.fetch('https://api.example.com/data', {
      maxAmount: '1.00',
      fetchImpl: impl,
    });

    expect(paidPayload(calls).payload.authorization.value).toBe('30000');
  });
});

describe('X402Client.fetch - choosing among offers', () => {
  it('picks the cheapest offer across chains with different decimals', async () => {
    const client = await connectedClient();
    const { impl, calls } = scriptedFetch([
      jsonResponse(402, {
        x402Version: 1,
        accepts: [
          // 1.00 USDC on Base (6 decimals).
          {
            scheme: 'exact',
            network: 'base',
            maxAmountRequired: '1000000',
            payTo: PAY_TO,
          },
          // 0.50 USDC on BSC, whose USDC has EIGHTEEN decimals. Read at 6 this
          // atomic number looks astronomically expensive; read correctly it is
          // the cheaper of the two, and it must win.
          {
            scheme: 'exact',
            network: 'bsc',
            maxAmountRequired: '500000000000000000',
            payTo: PAY_TO,
          },
        ],
      }),
      jsonResponse(200, { data: 'paid' }),
    ]);

    await client.fetch('https://api.example.com/data', {
      maxAmount: '1.00',
      fetchImpl: impl,
    });

    const payload = paidPayload(calls);
    expect(payload.network).toBe('bsc');
    expect(payload.payload.authorization.value).toBe('500000000000000000');
    // The loop switched chains to pay the offer it chose.
    expect(client.getChainName()).toBe('bsc');
  });

  it('honours a caller-supplied select() over the cheapest default', async () => {
    const client = await connectedClient();
    const { impl, calls } = scriptedFetch([
      jsonResponse(402, {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base',
            maxAmountRequired: '1000000',
            payTo: PAY_TO,
          },
          {
            scheme: 'exact',
            network: 'polygon',
            maxAmountRequired: '2000000',
            payTo: PAY_TO,
          },
        ],
      }),
      jsonResponse(200, { data: 'paid' }),
    ]);

    await client.fetch('https://api.example.com/data', {
      maxAmount: '5.00',
      select: offers => offers.find(o => o.chainName === 'polygon') ?? null,
      fetchImpl: impl,
    });

    expect(paidPayload(calls).network).toBe('polygon');
  });

  it('skips accepts that name no price, recipient or network', async () => {
    const client = await connectedClient();
    const { impl, calls } = scriptedFetch([
      jsonResponse(402, {
        x402Version: 1,
        accepts: [
          { scheme: 'exact', network: 'base' }, // no price, no payTo
          { scheme: 'exact', maxAmountRequired: '1', payTo: PAY_TO }, // no network
          {
            scheme: 'exact',
            network: 'base',
            maxAmountRequired: '40000',
            payTo: PAY_TO,
          },
        ],
      }),
      jsonResponse(200, { data: 'paid' }),
    ]);

    await client.fetch('https://api.example.com/data', {
      maxAmount: '1.00',
      fetchImpl: impl,
    });

    expect(paidPayload(calls).payload.authorization.value).toBe('40000');
  });

  it('throws NO_ACCEPTABLE_PAYMENT when a 402 carries no usable offer', async () => {
    const client = await connectedClient();
    const { impl } = scriptedFetch([
      jsonResponse(402, { x402Version: 1, accepts: [] }),
    ]);

    await expect(
      client.fetch('https://api.example.com/data', { fetchImpl: impl })
    ).rejects.toMatchObject({ code: 'NO_ACCEPTABLE_PAYMENT' });
  });

  it('throws CHAIN_NOT_SUPPORTED when the 402 names a chain the SDK does not know', async () => {
    const client = await connectedClient();
    const { impl } = scriptedFetch([
      jsonResponse(402, {
        x402Version: 2,
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:999999',
            amount: '1000',
            payTo: PAY_TO,
          },
        ],
      }),
    ]);

    await expect(
      client.fetch('https://api.example.com/data', { fetchImpl: impl })
    ).rejects.toMatchObject({ code: 'CHAIN_NOT_SUPPORTED' });
  });
});

describe('X402Client.fetch - request plumbing', () => {
  it('carries method and caller headers into both the probe and the paid retry', async () => {
    const client = await connectedClient();
    const { impl, calls } = scriptedFetch([
      jsonResponse(402, {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base',
            maxAmountRequired: '10000',
            payTo: PAY_TO,
          },
        ],
      }),
      jsonResponse(200, { data: 'paid' }),
    ]);

    await client.fetch('https://api.example.com/data', {
      method: 'POST',
      maxAmount: '1.00',
      init: {
        headers: { 'X-Trace': 'abc123' },
        body: JSON.stringify({ q: 1 }),
      },
      fetchImpl: impl,
    });

    expect(calls[0].init?.method).toBe('POST');
    expect(calls[1].init?.method).toBe('POST');
    expect(calls[1].init?.body).toBe(JSON.stringify({ q: 1 }));
    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers['X-Trace']).toBe('abc123');
    expect(headers['X-PAYMENT']).toBeTruthy();
  });

  it('refuses to run without a connected wallet', async () => {
    const client = new X402Client({ defaultChain: 'base' });
    const { impl } = scriptedFetch([jsonResponse(200, {})]);

    await expect(
      client.fetch('https://api.example.com/data', { fetchImpl: impl })
    ).rejects.toBeInstanceOf(X402Error);
  });

  it('reports a 402 whose body is not JSON instead of hanging on it', async () => {
    const client = await connectedClient();
    const { impl } = scriptedFetch([
      new Response('<html>Payment Required</html>', { status: 402 }),
    ]);

    await expect(
      client.fetch('https://api.example.com/data', { fetchImpl: impl })
    ).rejects.toMatchObject({ code: 'PAYMENT_FAILED' });
  });
});
