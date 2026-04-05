import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  create402Response,
  createHonoMiddleware,
  createPaymentMiddleware,
} from './index';
import { X402Client } from '../client/X402Client';

function encodePaymentHeader(payment: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payment), 'utf8').toString('base64');
}

function createEvmPaymentHeader(options: {
  network?: string;
  to?: string;
  value?: string;
} = {}): string {
  return encodePaymentHeader({
    x402Version: options.network?.includes(':') ? 2 : 1,
    scheme: 'exact',
    network: options.network || 'eip155:1',
    payload: {
      signature: '0xdead',
      authorization: {
        from: '0x0000000000000000000000000000000000000001',
        to: options.to || '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        value: options.value || '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: `0x${'11'.repeat(32)}`,
      },
    },
  });
}

function createResponseRecorder() {
  const state: {
    statusCode?: number;
    headers?: Record<string, string>;
    body?: unknown;
  } = {};

  return {
    state,
    res: {
      status(code: number) {
        state.statusCode = code;
        return {
          json(body: unknown) {
            state.body = body;
          },
          set(headers: Record<string, string>) {
            state.headers = headers;
            return {
              json(body: unknown) {
                state.body = body;
              },
            };
          },
        };
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('create402Response', () => {
  it('emits a consistent v2 shape for multi-option responses', () => {
    const response = create402Response(
      {
        amount: '1.00',
        recipient: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        resource: 'https://example.com/premium',
        chainName: 'base',
      },
      {
        accepts: [
          {
            network: 'ethereum',
            asset: '0x2222222222222222222222222222222222222222',
            amount: '1000000',
            payTo: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            extra: { token: 'USDC' },
          },
        ],
      }
    );

    const body = response.body as Record<string, unknown> & { accepts?: Array<Record<string, unknown>> };
    expect(body.x402Version).toBe(2);
    expect(body.network).toBe('eip155:8453');
    expect(body.payTo).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(body.accepts).toHaveLength(2);
    expect(body.accepts?.[0]?.network).toBe('eip155:8453');
    expect(body.accepts?.[1]?.network).toBe('eip155:1');
    expect(body.accepts?.[1]?.payTo).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(body.accepts?.[1]?.extra).toEqual({ token: 'USDC' });
  });
});

describe('createPaymentMiddleware', () => {
  it('settles before the handler by default (before-handler strategy)', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/verify')
        ? { isValid: true }
        : { transactionHash: '0xsettled', network: 'ethereum' },
      text: async () => 'ok',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const middleware = createPaymentMiddleware(
      () => ({
        amount: '1.00',
        recipient: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        resource: 'https://example.com/premium',
        chainName: 'ethereum',
        x402Version: 2,
      })
    );

    const req: {
      headers: Record<string, string>;
      x402?: { settle: () => Promise<unknown> };
    } = {
      headers: {
        'x-payment': createEvmPaymentHeader(),
      },
    };
    const { res } = createResponseRecorder();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://facilitator.ultravioletadao.xyz/verify');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://facilitator.ultravioletadao.xyz/settle');
    expect(req.x402).toBeDefined();

    // Double-settle guard: calling settle() again returns cached result
    await req.x402?.settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('exposes manual settlement when explicitly requested', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => ({ isValid: true }),
      text: async () => 'ok',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const middleware = createPaymentMiddleware(
      () => ({
        amount: '1.00',
        recipient: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        resource: 'https://example.com/premium',
        chainName: 'ethereum',
        x402Version: 2,
      }),
      { settlementStrategy: 'manual' }
    );

    const req: {
      headers: Record<string, string>;
      x402?: { settle: () => Promise<unknown> };
    } = {
      headers: {
        'x-payment': createEvmPaymentHeader(),
      },
    };
    const { res, state } = createResponseRecorder();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(state.statusCode).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(req.x402).toBeDefined();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transactionHash: '0xsettled', network: 'ethereum' }),
      text: async () => 'ok',
    });

    await req.x402?.settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://facilitator.ultravioletadao.xyz/settle');
  });
});

describe('createHonoMiddleware', () => {
  it('returns a consistent 402 body instead of a custom paymentRequirements shape', async () => {
    const middleware = createHonoMiddleware({
      accepts: [
        {
          network: 'base',
          asset: '0x1111111111111111111111111111111111111111',
          amount: '1000000',
          payTo: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        {
          network: 'ethereum',
          asset: '0x2222222222222222222222222222222222222222',
          amount: '1000000',
          payTo: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          extra: { token: 'USDC' },
        },
      ],
    });

    const result = await middleware(
      {
        req: {
          header: () => undefined,
          url: 'https://example.com/premium',
        },
        json: (body, status) => ({ body, status }),
      },
      async () => {}
    ) as { body: Record<string, unknown>; status: number };

    expect(result.status).toBe(402);
    expect(result.body.x402Version).toBe(2);
    expect(result.body.paymentRequirements).toBeUndefined();
    expect(result.body.network).toBe('eip155:8453');
    expect((result.body.accepts as Array<Record<string, unknown>>)[1]?.network).toBe('eip155:1');
  });

  it('matches the correct advertised requirement and settles before handler by default', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/verify')
        ? { isValid: true }
        : { transactionHash: '0xsettled', network: 'ethereum' },
      text: async () => 'ok',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const stored = new Map<string, unknown>();
    const next = vi.fn(async () => {});
    const middleware = createHonoMiddleware({
      accepts: [
        {
          network: 'base',
          asset: '0x1111111111111111111111111111111111111111',
          amount: '1000000',
          payTo: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        {
          network: 'ethereum',
          asset: '0x2222222222222222222222222222222222222222',
          amount: '1000000',
          payTo: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
    });

    await middleware(
      {
        req: {
          header: (name) => name.toLowerCase() === 'x-payment'
            ? createEvmPaymentHeader({
                network: 'eip155:1',
                to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              })
            : undefined,
          url: 'https://example.com/premium',
        },
        json: (body, status) => ({ body, status }),
        set: (key, value) => stored.set(key, value),
      },
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const verifyRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      paymentRequirements: Record<string, unknown>;
    };
    expect(verifyRequest.paymentRequirements.network).toBe('eip155:1');
    expect(verifyRequest.paymentRequirements.asset).toBe('0x2222222222222222222222222222222222222222');
    expect(stored.has('x402')).toBe(true);
  });

  it('rejects ambiguous multi-accept payments instead of silently using the first option', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const middleware = createHonoMiddleware({
      accepts: [
        {
          network: 'ethereum',
          asset: '0x1111111111111111111111111111111111111111',
          amount: '1000000',
          payTo: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        {
          network: 'ethereum',
          asset: '0x2222222222222222222222222222222222222222',
          amount: '1000000',
          payTo: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ],
    });

    const result = await middleware(
      {
        req: {
          header: (name) => name.toLowerCase() === 'x-payment'
            ? createEvmPaymentHeader({
                network: 'eip155:1',
                to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              })
            : undefined,
          url: 'https://example.com/premium',
        },
        json: (body, status) => ({ body, status }),
      },
      async () => {}
    ) as { body: Record<string, unknown>; status: number };

    expect(result.status).toBe(402);
    expect(result.body.reason).toMatch(/matched multiple advertised requirements/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('commerce scheme support', () => {
  it('should accept commerce scheme in payment header', () => {
    const header = encodePaymentHeader({
      x402Version: 2,
      scheme: 'commerce',
      network: 'eip155:84532',
      payload: {
        signature: '0xdead',
        authorization: {
          from: '0x0000000000000000000000000000000000000001',
          to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          value: '1000000',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: `0x${'11'.repeat(32)}`,
        },
      },
    });
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded.scheme).toBe('commerce');
  });

  it('should accept escrow scheme in payment header', () => {
    const header = encodePaymentHeader({
      x402Version: 2,
      scheme: 'escrow',
      network: 'eip155:84532',
      payload: {
        signature: '0xdead',
        authorization: {
          from: '0x0000000000000000000000000000000000000001',
          to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          value: '1000000',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: `0x${'11'.repeat(32)}`,
        },
      },
    });
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded.scheme).toBe('escrow');
  });

  it('should default to exact scheme in buildPaymentRequirements', () => {
    const response = create402Response({
      amount: '1.00',
      recipient: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      resource: 'https://example.com/premium',
      chainName: 'base',
    });
    const body = response.body as Record<string, unknown>;
    expect(body.scheme).toBe('exact');
  });
});

describe('X402Client private-key chain switching', () => {
  it('recreates the signer on the new chain and keeps payment creation working', async () => {
    const client = new X402Client({ defaultChain: 'base' });
    const privateKey = '0x59c6995e998f97a5a0044976f3f12c0bbd1f8c8d6ef45f78c4e0d8bbd06c7c6b';

    const connectedAddress = await client.connectWithPrivateKey(privateKey, 'base');
    expect(connectedAddress).toBe(client.getAddress());
    expect(client.getChainName()).toBe('base');

    await client.switchChain('ethereum');

    expect(client.getAddress()).toBe(connectedAddress);
    expect(client.getChainName()).toBe('ethereum');
    expect(client.getChainId()).toBe(1);

    const payment = await client.createPayment({
      recipient: '0x000000000000000000000000000000000000dEaD',
      amount: '1.00',
    });

    expect(payment.success).toBe(true);
    expect(payment.network).toBe('ethereum');
    expect(payment.paymentHeader.length).toBeGreaterThan(0);
  });
});
