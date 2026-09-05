/**
 * The no-verdict refusal must be reachable WITHOUT Express.
 *
 * `verify` returns invalid for two different things: a payment that was
 * REJECTED, and a facilitator that reached NO VERDICT at all (`retryable`).
 * Answering 402 in the second case tells the buyer to sign a fresh
 * authorization while the first one is still live and still spendable — they
 * pay twice.
 *
 * The SDK already got this right, but only inside two private functions, one
 * per framework (`respondUnavailable` for Express, `honoUnavailable` for Hono).
 * An integrator writing the handler by hand — Lambda, Hono, Next route, Fastify
 * — could not reach either, so they re-derived it, and re-derived it wrong.
 * `buildUnavailableResponse` is that decision as data: status, headers and body,
 * with no framework object anywhere in the signature.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildUnavailableResponse,
  createPaymentMiddleware,
  DEFAULT_RETRY_AFTER_SECONDS,
} from './index';
import { encodeX402Header } from '../utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildUnavailableResponse', () => {
  it('answers a no-verdict refusal as 503, never 402', () => {
    const r = buildUnavailableResponse('Payment verification unavailable', {
      retryable: true,
      reason: 'writer_lease_unavailable',
      retryAfterSeconds: 5,
      safeToReplay: true,
    });
    // 402 here is the double-charge: it asks for a NEW signature.
    expect(r.status).toBe(503);
    expect(r.body.retryable).toBe(true);
    expect(r.body.reason).toBe('writer_lease_unavailable');
  });

  it('carries Retry-After as the whole-second integer RFC 9110 requires', () => {
    const r = buildUnavailableResponse('unavailable', { retryable: true, retryAfterSeconds: 2.4 });
    expect(r.headers['Retry-After']).toBe('3');
    expect(r.retryAfterSeconds).toBe(3);
    expect(Number.isInteger(r.retryAfterSeconds)).toBe(true);
  });

  it('never advertises a wait below one second', () => {
    const r = buildUnavailableResponse('unavailable', { retryable: true, retryAfterSeconds: 0 });
    expect(r.retryAfterSeconds).toBe(1);
    expect(r.headers['Retry-After']).toBe('1');
  });

  it('falls back to the SDK default when the facilitator named no delay', () => {
    const r = buildUnavailableResponse('unavailable', { retryable: true });
    expect(r.retryAfterSeconds).toBe(DEFAULT_RETRY_AFTER_SECONDS);
  });

  it('only claims safeToReplay when the facilitator proved it executed nothing', () => {
    // forward_failed and a bare timeout: the write may already have landed.
    expect(buildUnavailableResponse('u', { retryable: true }).body.safeToReplay).toBe(false);
    expect(
      buildUnavailableResponse('u', { retryable: true, safeToReplay: false }).body.safeToReplay,
    ).toBe(false);
    expect(
      buildUnavailableResponse('u', { retryable: true, safeToReplay: true }).body.safeToReplay,
    ).toBe(true);
  });

  it('reads the reason from whichever field the facilitator populated', () => {
    expect(buildUnavailableResponse('u', { invalidReason: 'insufficient_funds' } as never).body.reason)
      .toBe('insufficient_funds');
    expect(buildUnavailableResponse('u', { error: 'boom' } as never).body.reason).toBe('boom');
  });
});

/**
 * The tie: the Express reply and the public builder are the SAME decision.
 * If Express ever drifts back to its own copy, this goes red.
 */
describe('Express reply is built from the public function', () => {
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

  const header = () =>
    encodeX402Header({
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
    } as never);

  const requirements = () => ({
    amount: '1.00',
    recipient: '0x0000000000000000000000000000000000000002',
    resource: 'https://example.test/thing',
    network: 'base' as const,
  });

  it('emits byte-for-byte what buildUnavailableResponse produces', async () => {
    const refusalBody = JSON.stringify({ error: 'no writer lease', reason: 'holder_unknown' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? '5' : null) },
        text: async () => refusalBody,
        json: async () => JSON.parse(refusalBody),
      }),
    );
    const { res, sent } = expressRes();

    await createPaymentMiddleware(requirements, { retries: 0 })(
      { headers: { 'x-payment': header() } },
      res as never,
      () => {
        throw new Error('handler must not run');
      },
    );

    const expected = buildUnavailableResponse('Payment verification unavailable', {
      retryable: true,
      reason: 'holder_unknown',
      retryAfterSeconds: 5,
      safeToReplay: true,
    });
    expect(sent.code).toBe(expected.status);
    expect(sent.headers).toEqual(expected.headers);
    expect(sent.body).toEqual(expected.body);
  });
});
