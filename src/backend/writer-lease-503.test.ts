/**
 * A `503` from the writer lease must never be readable as a rejected payment.
 *
 * `402` says "the payment was REFUSED, sign a new authorization". `503` says "no
 * verdict was reached, send the SAME credential again". Collapsing the second
 * into the first makes the buyer sign and broadcast a second payment for money
 * that was never refused — they pay twice, and the first authorization is still
 * perfectly spendable by the facilitator afterwards.
 *
 * The facilitator's shape is pinned from x402-rs `src/handlers.rs`
 * `writer_lease_unavailable()`: `503` + `Retry-After: 5` + a JSON body carrying
 * `error` and `reason`. The five reasons do not share retry semantics — four are
 * emitted before the write is handed to anyone, and `forward_failed` is emitted
 * after, so the write may already have landed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  Erc8004Client,
  FacilitatorClient,
  createHonoMiddleware,
  createPaymentMiddleware,
  isAmbiguousLeaseReason,
  isReplayableLeaseReason,
  readFacilitatorError,
  MAX_RETRY_AFTER_SECONDS,
} from './index';
import type { PaymentRequirements } from './index';
import type { X402Header } from '../types';

const HEADER = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: {
    signature: '0xdead',
    authorization: {
      from: '0x0000000000000000000000000000000000000001',
      to: '0x0000000000000000000000000000000000000002',
      value: '1000000',
      validAfter: '0',
      validBefore: '1800000000',
      nonce: '0x' + '11'.repeat(32),
    },
  },
} as unknown as X402Header;

const REQUIREMENTS = {
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '1000000',
  resource: 'https://example.test/thing',
  payTo: '0x0000000000000000000000000000000000000002',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
} as unknown as PaymentRequirements;

/** The facilitator's literal writer-lease refusal. */
function leaseRefusal(reason: string, retryAfter = '5') {
  const body = JSON.stringify({
    error: 'this instance does not hold the EVM writer lease; retry',
    reason,
  });
  return {
    ok: false,
    status: 503,
    headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** A real 402: the facilitator looked at the payment and said no. */
function rejection() {
  const body = JSON.stringify({ error: 'invalid_signature' });
  return {
    ok: false,
    status: 402,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readFacilitatorError', () => {
  it('separates the four pre-execution reasons from the ambiguous one', async () => {
    for (const reason of [
      'holder_unknown',
      'forwarding_disabled',
      'forwarded_but_not_writer',
      'body_unreadable',
    ]) {
      const info = await readFacilitatorError(leaseRefusal(reason) as never);
      expect(info.retryable, reason).toBe(true);
      expect(info.safeToReplay, reason).toBe(true);
      expect(info.reason, reason).toBe(reason);
      expect(isReplayableLeaseReason(reason)).toBe(true);
    }

    // The write may already have run: the hop died AFTER handing it over.
    const ambiguous = await readFacilitatorError(leaseRefusal('forward_failed') as never);
    expect(ambiguous.retryable).toBe(true);
    expect(ambiguous.safeToReplay).toBe(false);
    expect(isAmbiguousLeaseReason('forward_failed')).toBe(true);
  });

  it('never marks a 402 retryable — that one really was a refusal', async () => {
    const info = await readFacilitatorError(rejection() as never);
    expect(info.retryable).toBe(false);
    expect(info.safeToReplay).toBe(false);
    expect(info.retryAfterSeconds).toBeUndefined();
  });

  it('will not replay an unattributed 503 from a proxy', async () => {
    // No `reason`: "something in front of the facilitator answered" is not
    // evidence that nothing ran.
    const info = await readFacilitatorError({
      status: 503,
      headers: { get: () => null },
      text: async () => '<html>503 Service Unavailable</html>',
    } as never);
    expect(info.retryable).toBe(true);
    expect(info.safeToReplay).toBe(false);
  });

  it('caps a misconfigured Retry-After instead of obeying it', async () => {
    const info = await readFacilitatorError(leaseRefusal('holder_unknown', '3600') as never);
    // An hour-long sleep inside a function documented as returning promptly is
    // a hang, not a backoff.
    expect(info.retryAfterSeconds).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(info.retryAfterSeconds).toBeLessThan(3600);
  });

  it('survives a response object with no headers at all', async () => {
    const info = await readFacilitatorError({
      status: 503,
      text: async () => '{"reason":"holder_unknown"}',
    } as never);
    expect(info.reason).toBe('holder_unknown');
    expect(info.retryAfterSeconds).toBe(5);
  });
});

describe('FacilitatorClient.settle on a lease 503', () => {
  it('reports retryable, not a rejected payment, and names the reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(leaseRefusal('forward_failed')));

    const result = await new FacilitatorClient({ retries: 0 }).settle(HEADER, REQUIREMENTS);

    expect(result.success).toBe(false);
    expect(result.status).toBe(503);
    expect(result.reason).toBe('forward_failed');
    expect(result.retryable).toBe(true);
    // The one thing a caller must not do on this reason.
    expect(result.safeToReplay).toBe(false);
    expect(result.retryAfterSeconds).toBe(5);
  });

  it('replays the SAME authorization when the facilitator proved nothing ran', async () => {
    const fetchMock = vi
      .fn()
      // `Retry-After: 0` only to keep the test fast; the clamp is pinned above.
      .mockResolvedValueOnce(leaseRefusal('holder_unknown', '0'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, transaction: '0x' + 'ab'.repeat(32) }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new FacilitatorClient({ retries: 1 }).settle(HEADER, REQUIREMENTS);

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Byte-for-byte the same body: re-signing is exactly what must NOT happen.
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
  });

  it('never replays forward_failed, however many retries are allowed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(leaseRefusal('forward_failed'));
    vi.stubGlobal('fetch', fetchMock);

    await new FacilitatorClient({ retries: 5 }).settle(HEADER, REQUIREMENTS);

    // The holder may be mining the transfer right now.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks a timeout retryable but not replayable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );

    const result = await new FacilitatorClient({ timeout: 5 }).settle(HEADER, REQUIREMENTS);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.safeToReplay).toBe(false);
  });
});

describe('FacilitatorClient.verify on a lease 503', () => {
  it('does not report the authorization as invalid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(leaseRefusal('holder_unknown')));

    const result = await new FacilitatorClient({ retries: 0 }).verify(HEADER, REQUIREMENTS);

    expect(result.isValid).toBe(false); // nothing was validated
    expect(result.retryable).toBe(true); // ...but nothing was rejected either
    expect(result.reason).toBe('holder_unknown');
  });
});

/** Minimal Express `res` double that records what was sent. */
function expressRes() {
  const sent: { code?: number; body?: any; headers?: Record<string, string> } = {};
  const chain = (code: number) => ({
    json: (body: unknown) => {
      sent.code = code;
      sent.body = body;
    },
    set: (headers: Record<string, string>) => {
      sent.headers = headers;
      return {
        json: (body: unknown) => {
          sent.code = code;
          sent.body = body;
        },
      };
    },
  });
  return { res: { status: chain }, sent };
}

describe('Express middleware', () => {
  const requirements = () => ({
    amount: '1.00',
    recipient: '0x0000000000000000000000000000000000000002',
    resource: 'https://example.test/thing',
    network: 'base' as const,
  });

  it('answers 503 + Retry-After, NOT 402, when verify reaches no verdict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(leaseRefusal('holder_unknown')));
    const { res, sent } = expressRes();

    await createPaymentMiddleware(requirements, { retries: 0 })(
      { headers: { 'x-payment': encodeHeader() } },
      res as never,
      () => {
        throw new Error('handler must not run');
      },
    );

    // A 402 here is the double-charge: it tells the buyer to sign again.
    expect(sent.code).toBe(503);
    expect(sent.headers?.['Retry-After']).toBe('5');
    expect(sent.body.retryable).toBe(true);
    expect(sent.body.reason).toBe('holder_unknown');
  });

  it('still answers 402 when the facilitator genuinely rejected the payment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ isValid: false, invalidReason: 'invalid_signature' }),
      }),
    );
    const { res, sent } = expressRes();

    await createPaymentMiddleware(requirements, { retries: 0 })(
      { headers: { 'x-payment': encodeHeader() } },
      res as never,
      () => {
        throw new Error('handler must not run');
      },
    );

    expect(sent.code).toBe(402);
  });

  it('answers 503, not 500, when the settle reaches no verdict', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ isValid: true }) })
      .mockResolvedValue(leaseRefusal('forward_failed'));
    vi.stubGlobal('fetch', fetchMock);
    const { res, sent } = expressRes();

    await createPaymentMiddleware(requirements, { retries: 0 })(
      { headers: { 'x-payment': encodeHeader() } },
      res as never,
      () => {
        throw new Error('handler must not run');
      },
    );

    // 500 tells a client to stop. This is the one case where it should retry.
    expect(sent.code).toBe(503);
    expect(sent.body.safeToReplay).toBe(false);
  });
});

describe('Hono middleware', () => {
  function honoContext() {
    const sent: { code?: number; body?: any; headers: Record<string, string> } = { headers: {} };
    return {
      c: {
        req: { header: () => encodeHeader(), url: 'https://example.test/thing' },
        json: (body: unknown, status?: number) => {
          sent.body = body;
          sent.code = status;
          return body;
        },
        header: (name: string, value: string) => {
          sent.headers[name] = value;
        },
      },
      sent,
    };
  }

  const accepts = [
    {
      network: 'base',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1000000',
      payTo: '0x0000000000000000000000000000000000000002',
    },
  ];

  it('answers 503 + Retry-After instead of 402 on a lease refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(leaseRefusal('forwarding_disabled')));
    const { c, sent } = honoContext();

    await createHonoMiddleware({ accepts: accepts as never, retries: 0 })(c as never, async () => {
      throw new Error('handler must not run');
    });

    expect(sent.code).toBe(503);
    expect(sent.headers['Retry-After']).toBe('5');
    expect(sent.body.reason).toBe('forwarding_disabled');
    expect(sent.body.safeToReplay).toBe(true);
  });
});

describe('Erc8004Client write routes', () => {
  it('does not report a lease 503 as a rejected feedback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(leaseRefusal('forward_failed')));

    const result = await new Erc8004Client({ retries: 0 }).submitFeedback({
      x402Version: 1,
      network: 'base',
      feedback: { agentId: 18896, value: 95 },
    } as never);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.reason).toBe('forward_failed');
    expect(result.safeToReplay).toBe(false);
  });

  it('never re-POSTs an ambiguous mint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(leaseRefusal('forward_failed'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new Erc8004Client({ retries: 3 }).registerAgent({
      x402Version: 1,
      network: 'base',
      agentUri: 'ipfs://QmAgent',
      recipient: '0x0000000000000000000000000000000000000003',
    } as never);

    // Re-POSTing a mint the holder may already have executed is exactly what
    // minted five duplicate agents. One attempt, and a flag that says so.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.safeToReplay).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('replays a mint only when the facilitator refused it in the router', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(leaseRefusal('holder_unknown', '0'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, agentId: 42, network: 'base' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new Erc8004Client({ retries: 1 }).registerAgent({
      x402Version: 1,
      network: 'base',
      agentUri: 'ipfs://QmAgent',
    } as never);

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/** A valid base64 X-PAYMENT header for the middleware tests. */
function encodeHeader(): string {
  return Buffer.from(JSON.stringify(HEADER)).toString('base64');
}
