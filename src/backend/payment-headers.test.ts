import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFetchPaywall, createHonoMiddleware, createPaymentMiddleware,
  extractPaymentFromHeaders, FacilitatorClient, parsePaymentHeader,
} from './index';
import type { VerifiedPaymentState } from './index';

const PAY_TO = '0x2222222222222222222222222222222222222222';
const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const URL_ = 'https://merchant.example/data';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const envelope = (version: 1 | 2 = 1) => ({
  x402Version: version, scheme: 'exact', network: version === 1 ? 'base' : 'eip155:8453',
  payload: { signature: '0x' + 'ab'.repeat(65), authorization: {
    from: PAY_TO, to: PAY_TO, value: '10000', validAfter: '0', validBefore: '9999999999', nonce: '0x' + '11'.repeat(32),
  } },
});
const accepts = [{ network: 'base', asset: ASSET, amount: '10000', payTo: PAY_TO }];
type HeadersRecord = Record<string, string | string[] | undefined>;

async function request(framework: string, headers: HeadersRecord, strategy: 'before-handler' | 'manual') {
  const handler = vi.fn(async (payment: VerifiedPaymentState) => {
    if (strategy === 'manual') expect((await payment.settle()).success).toBe(true);
  });
  const options = { accepts, retries: 0, settlementStrategy: strategy };
  if (framework === 'express') {
    const req: { headers: HeadersRecord; x402?: VerifiedPaymentState } = { headers };
    const state = { status: 200, body: undefined as unknown };
    const res = {
      status(code: number) { state.status = code; return this; },
      set() { return this; },
      json(body: unknown) { state.body = body; },
    };
    const middleware = createPaymentMiddleware(() => ({ amount: '0.01', recipient: PAY_TO, resource: URL_, chainName: 'base' }), options);
    const next = vi.fn();
    await middleware(req, res, next);
    if (next.mock.calls.length) await handler(req.x402!);
    return { ...state, handler };
  }
  const init = { headers: headers as Record<string, string> };
  let response: Response;
  if (framework === 'hono') {
    const app = new Hono();
    app.use('*', createHonoMiddleware(options) as never);
    app.get('/data', async c => {
      await handler(c.get('x402' as never));
      return c.json({ ok: true });
    });
    response = await app.request(URL_, init);
  } else {
    const route = createFetchPaywall(options)(async (_request: Request, payment) => {
      await handler(payment);
      return Response.json({ ok: true });
    });
    response = await route(new Request(URL_, init));
  }
  return { status: response.status, body: await response.json(), handler };
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); })));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each([1, 2] as const)('payment header selection v%s', version => {
  const payment = envelope(version);
  const header = encode(payment);
  const other = encode({ ...payment, payload: { ...payment.payload, signature: '0x' + 'cd'.repeat(65) } });
  const { network: _network, ...noNetwork } = payment;
  const cases: { name: string; headers: HeadersRecord; status: number; error?: string }[] = [
    { name: 'X-PAYMENT only', headers: { 'X-PAYMENT': header }, status: 200 },
    { name: 'PAYMENT-SIGNATURE only', headers: { 'PAYMENT-SIGNATURE': header }, status: 200 },
    { name: 'both identical', headers: { 'X-PAYMENT': header, 'PAYMENT-SIGNATURE': header }, status: 200 },
    { name: 'both distinct', headers: { 'X-PAYMENT': header, 'PAYMENT-SIGNATURE': other }, status: 400, error: 'Conflicting payment headers' },
    { name: 'missing network', headers: { 'X-PAYMENT': encode(noNetwork) }, status: 400 },
    { name: 'mixed header case and HTTP whitespace', headers: { 'x-PaYmEnT': ` \t${header}\t `, 'pAyMeNt-SiGnAtUrE': header }, status: 200 },
    { name: 'empty header beside a valid one', headers: { 'X-PAYMENT': '', 'PAYMENT-SIGNATURE': header }, status: 400 },
    { name: 'malformed header beside a valid one', headers: { 'X-PAYMENT': 'bad', 'PAYMENT-SIGNATURE': header }, status: 400 },
    { name: 'no headers', headers: {}, status: 402 },
    ...[null, '', ' ', 177, {}, [], ' base ', '\tbase', 'base\n'].map(network => ({
      name: `invalid network ${JSON.stringify(network)}`, headers: { 'PAYMENT-SIGNATURE': encode({ ...payment, network }) }, status: 400,
    })),
    ...[null, [], 'payment', 42, true].map(value => ({ name: `invalid envelope ${JSON.stringify(value)}`, headers: { 'X-PAYMENT': encode(value) }, status: 400 })),
    ...['', ' \t ', 'not base64', encode({})].map(value => ({ name: `unreadable header ${JSON.stringify(value)}`, headers: { 'X-PAYMENT': value }, status: 400 })),
  ];

  it.each(cases)('extractor: $name', ({ headers, status }) => {
    expect(extractPaymentFromHeaders(headers)).toEqual(status === 200 ? payment : null);
  });

  describe.each(['express', 'hono', 'fetch'])('%s', framework => {
    describe.each(['before-handler', 'manual'] as const)('%s', strategy => {
      it.each(cases)('$name', async ({ headers, status, error }) => {
        const verify = vi.spyOn(FacilitatorClient.prototype, 'verify').mockResolvedValue({ isValid: true, payer: PAY_TO });
        const settle = vi.spyOn(FacilitatorClient.prototype, 'settle').mockResolvedValue({ success: true, transaction: '0x' + '22'.repeat(32) });
        const result = await request(framework, headers, strategy);
        expect(result.status).toBe(status);
        if (error) expect(result.body).toEqual({ error });
        if (status === 200) {
          expect(result.handler).toHaveBeenCalledTimes(1);
          expect(verify).toHaveBeenCalledTimes(1);
          expect(settle).toHaveBeenCalledTimes(1);
          expect(verify.mock.calls[0][0]).toEqual(payment);
          expect(settle.mock.calls[0][0]).toBe(verify.mock.calls[0][0]);
          expect(settle.mock.calls[0][1]).toEqual(verify.mock.calls[0][1]);
          expect(settle.mock.calls[0][2]).toEqual(verify.mock.calls[0][2]);
        } else {
          expect(result.handler).not.toHaveBeenCalled();
          expect(verify).not.toHaveBeenCalled();
          expect(settle).not.toHaveBeenCalled();
        }
      });
    });
  });
});

it('handles duplicate keys and arrays without dropping conflicting credentials', async () => {
  const header = encode(envelope());
  for (const headers of [
    { 'X-PAYMENT': [header, header] },
    { 'X-PAYMENT': header, 'x-payment': header },
    { 'PAYMENT-SIGNATURE': [header], 'X-PAYMENT': undefined },
  ]) expect(extractPaymentFromHeaders(headers)).toEqual(envelope());
  for (const headers of [
    { 'X-PAYMENT': [header, 'different'] },
    { 'X-PAYMENT': header, 'x-payment': 'different' },
    { 'X-PAYMENT': [] },
    { 'X-PAYMENT': null } as unknown as HeadersRecord,
    { 'X-PAYMENT': [null] } as unknown as HeadersRecord,
    { 'X-PAYMENT': `${header}, ${header}` },
  ]) {
    expect(extractPaymentFromHeaders(headers)).toBeNull();
    expect((await request('express', headers, 'before-handler')).status).toBe(400);
  }
});

it('parsePaymentHeader refuses absent or non-string networks', () => {
  for (const value of [undefined, null, '', encode({}), encode({ network: 1 })]) {
    expect(parsePaymentHeader(value)).toBeNull();
  }
});
