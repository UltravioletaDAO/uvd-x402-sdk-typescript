/**
 * One purchase binding per payment, and the answers of a facilitator with
 * durable receipts to a resend of an authorization it already admitted.
 *
 * Facilitator contract (x402-rs 2.39.0, `docs/facilitator-receipts.md`,
 * "Replays of an admitted authorization"): the original answer, marked
 * `Idempotent-Replayed: true`, goes back only to the binding that admitted the
 * payment -- the same `Idempotency-Key` or the same `X-UVD-Purchase`. A resend
 * without it gets `409 authorization_already_settled` (confirmed),
 * `409 authorization_in_flight` (pending/unknown) or
 * `409 receipt_request_conflict`; `/verify` answers `isValid: false` with the
 * first two. Older facilitators replay the original answer to anyone holding
 * the payment. Every facilitator here is a double; nothing is settled.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTHORIZATION_ALREADY_SETTLED,
  AUTHORIZATION_IN_FLIGHT,
  FacilitatorClient,
  IDEMPOTENCY_KEY_HEADER,
  RECEIPT_REQUEST_CONFLICT,
  buildPaymentConflictResponse,
  createHonoMiddleware,
  createIdempotencyKey,
  createPaymentMiddleware,
  isAuthorizationAlreadyUsed,
  isAuthorizationInFlight,
} from './index';
import type { PaymentRequirements, SettleResponse, VerifiedPaymentState } from './index';
import {
  createPurchaseContext,
  purchaseContextHeader,
  receiptCommitment,
  receiptFromResponse,
} from '../receipts';
import type { X402Header } from '../types';
import * as sdk from '../index';
import vectors from '../fixtures/facilitator-receipts-v1.json';

const TX = '0x' + '22'.repeat(32);
const PAY_TO = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RESOURCE = 'https://merchant.example/data';

const HEADER = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: {
    signature: '0xdead',
    authorization: {
      from: '0x0000000000000000000000000000000000000001',
      to: PAY_TO,
      value: '1000000',
      validAfter: '0',
      validBefore: '9999999999',
      nonce: '0x' + '11'.repeat(32),
    },
  },
} as unknown as X402Header;
const PAYMENT = Buffer.from(JSON.stringify(HEADER)).toString('base64');

const REQUIREMENTS = {
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '1000000',
  resource: RESOURCE,
  description: '',
  mimeType: 'application/json',
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
} as PaymentRequirements;

const expressRequirements = () => ({ amount: '1.00', recipient: PAY_TO, resource: RESOURCE, chainName: 'base' });
const HONO_ACCEPTS = [{ network: 'base', asset: REQUIREMENTS.asset, amount: '1000000', payTo: PAY_TO }];

/** A receipt of a payment made WITHOUT a purchase context, which the facilitator returns to any resend. */
function settleReceipt(status: 'confirmed' | 'pending' = 'confirmed') {
  const base = vectors.cases[0].receipt;
  const request = { ...base.request, purchaseId: null, method: null, bodySha256: null };
  return {
    ...base, purchaseId: null, request, requestHash: receiptCommitment('uvd-x402-request-v1', request),
    operation: 'settle', status, proof: null,
    settlement: { id: TX, idType: 'evm-transaction-hash' },
    diagnosticCode: status === 'pending' ? 'transaction_prepared' : null,
    retry: status === 'pending' ? { action: 'poll', afterSeconds: 2 } : { action: 'none' },
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
const REPLAYED = { 'Idempotent-Replayed': 'true' };

const VERIFIED = () => json({ isValid: true, payer: '0x0000000000000000000000000000000000000001' });
const SETTLED = () => json({ success: true, transaction: TX, network: 'base', payer: '0x0000000000000000000000000000000000000001' });

/** The body facilitator 2.39.0 sends for a resend without the admitting binding. */
const refused = (code: string, receipt?: unknown) =>
  json({ success: false, error: code, retryable: false, safeToReplay: false, ...(receipt ? { receipt } : {}) }, 409, { 'Cache-Control': 'no-store' });

type Call = { path: 'verify' | 'settle'; headers: Headers };

/** Stub the facilitator. `answer` gets the endpoint and how many times it was called before. */
function stubFacilitator(answer: (path: 'verify' | 'settle', attempt: number) => Response): Call[] {
  const calls: Call[] = [];
  const attempts = { verify: 0, settle: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = url.endsWith('/verify') ? 'verify' : 'settle';
    calls.push({ path, headers: new Headers(init.headers) });
    return answer(path, attempts[path]++);
  }));
  return calls;
}
const keyOf = (call: Call) => call.headers.get(IDEMPOTENCY_KEY_HEADER);

/** An Express `res` double: `set` throws after the response is sent, as Express does. */
function expressResponse(initial: Record<string, string> = {}) {
  const headers = new Map(Object.entries(initial).map(([k, v]) => [k.toLowerCase(), v]));
  const state: { status?: number; body?: unknown; sent: boolean; headers: Map<string, string> } = { sent: false, headers };
  const set = (values: Record<string, string>) => {
    if (state.sent) throw Object.assign(new Error('Cannot set headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' });
    for (const [k, v] of Object.entries(values)) headers.set(k.toLowerCase(), v);
  };
  const json = (body: unknown) => { state.body = body; state.sent = true; };
  const res = {
    get headersSent() { return state.sent; },
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    set,
    status: (code: number) => { state.status = code; return { json, set: (values: Record<string, string>) => { set(values); return { json }; } }; },
  };
  return { res, state };
}

async function runExpress(options: Parameters<typeof createPaymentMiddleware>[1] = {}, initial: Record<string, string> = {},
  extraHeaders: Record<string, string> = {}) {
  const middleware = createPaymentMiddleware(expressRequirements, { retries: 0, ...options });
  const req: { headers: Record<string, string>; method: string; originalUrl: string; x402?: VerifiedPaymentState } =
    { headers: { 'x-payment': PAYMENT, ...extraHeaders }, method: 'GET', originalUrl: '/data' };
  const { res, state } = expressResponse(initial);
  const next = vi.fn();
  await middleware(req, res, next);
  return { req, state, next };
}

/** A real Hono app: CORS and a cache header in front of the paywall, as merchants deploy it. */
function honoApp(options: Partial<Parameters<typeof createHonoMiddleware>[0]> = {}) {
  const app = new Hono();
  const served = vi.fn();
  app.use('*', cors({ origin: '*', exposeHeaders: ['X-Request-Id'] }));
  app.use('*', async (c, next) => { c.header('Cache-Control', 'private'); await next(); });
  app.use('/data', createHonoMiddleware({ accepts: HONO_ACCEPTS, retries: 0, ...options }) as never);
  app.get('/data', (c) => { served(); return c.json({ premium: true }); });
  return { app, served };
}
const honoRequest = (app: Hono) => app.request(RESOURCE, { headers: { 'X-PAYMENT': PAYMENT, Origin: 'https://buyer.example' } });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('one Idempotency-Key per payment', () => {
  it('verifyAndSettle sends the same fresh key to /verify and /settle and reports it', async () => {
    const calls = stubFacilitator((path) => (path === 'verify' ? VERIFIED() : SETTLED()));
    const result = await new FacilitatorClient({ retries: 0 }).verifyAndSettle(HEADER, REQUIREMENTS);
    expect(result.settled).toBe(true);
    expect(calls.map(c => c.path)).toEqual(['verify', 'settle']);
    expect(keyOf(calls[0])).toMatch(/^x402-[0-9a-f]{64}$/);
    expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
    expect(result.idempotencyKey).toBe(keyOf(calls[0]));
  });

  it('a caller key travels on verify, settle and the automatic retries of both', async () => {
    // A pre-execution refusal, replayed by the client itself; Retry-After 0 keeps the test fast.
    const lease = () => json({ error: 'writer lease unavailable', reason: 'holder_unknown' }, 503, { 'Retry-After': '0' });
    const calls = stubFacilitator((path, attempt) => (attempt === 0 ? lease() : path === 'verify' ? VERIFIED() : SETTLED()));
    const client = new FacilitatorClient({ retries: 1 });
    const idempotencyKey = createIdempotencyKey();
    expect((await client.verify(HEADER, REQUIREMENTS, { idempotencyKey })).isValid).toBe(true);
    expect((await client.settle(HEADER, REQUIREMENTS, { idempotencyKey })).success).toBe(true);
    expect(calls.map(c => c.path)).toEqual(['verify', 'verify', 'settle', 'settle']);
    expect(new Set(calls.map(keyOf))).toEqual(new Set([idempotencyKey]));
  });

  it('two payments never share a key, and a settle without one reports the key it sent', async () => {
    const calls = stubFacilitator(() => SETTLED());
    const client = new FacilitatorClient({ retries: 0 });
    const first = await client.settle(HEADER, REQUIREMENTS);
    const second = await client.settle(HEADER, REQUIREMENTS);
    expect(first.idempotencyKey).toBe(keyOf(calls[0]));
    expect(second.idempotencyKey).toBe(keyOf(calls[1]));
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it('a lost settle response still reports the key to resend with', async () => {
    stubFacilitator(() => { throw new TypeError('fetch failed'); });
    const idempotencyKey = createIdempotencyKey();
    const lost = await new FacilitatorClient({ retries: 0 }).settle(HEADER, REQUIREMENTS, { idempotencyKey });
    expect(lost).toMatchObject({ success: false, retryable: true, safeToReplay: false, idempotencyKey });
  });

  it('refuses a key the facilitator reserves or a header cannot carry', async () => {
    const calls = stubFacilitator(() => SETTLED());
    const client = new FacilitatorClient({ retries: 0 });
    for (const bad of ['', 'receipt:v1:abc', 'two words', 'a\r\nInjected: 1', 'x'.repeat(256)]) {
      await expect(client.settle(HEADER, REQUIREMENTS, { idempotencyKey: bad })).rejects.toThrow(/idempotencyKey/);
      await expect(client.verify(HEADER, REQUIREMENTS, { idempotencyKey: bad })).rejects.toThrow(/idempotencyKey/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('409s of an admitted authorization', () => {
  it('authorization_already_settled: this X-PAYMENT was used, not a 500 and not retryable', async () => {
    const calls = stubFacilitator(() => refused(AUTHORIZATION_ALREADY_SETTLED, settleReceipt()));
    const result = await new FacilitatorClient({ retries: 2 }).settle(HEADER, REQUIREMENTS);
    expect(result).toMatchObject({ success: false, status: 409, errorCode: AUTHORIZATION_ALREADY_SETTLED, retryable: false, safeToReplay: false });
    expect(result.transactionHash).toBeUndefined();
    expect(result.receipt?.status).toBe('confirmed');
    expect(result.receipt?.settlement?.id).toBe(TX);
    expect(isAuthorizationAlreadyUsed(result)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('authorization_in_flight: retryable to learn the verdict, never replayed automatically', async () => {
    const calls = stubFacilitator(() => refused(AUTHORIZATION_IN_FLIGHT, settleReceipt('pending')));
    const result = await new FacilitatorClient({ retries: 2 }).settle(HEADER, REQUIREMENTS);
    expect(result).toMatchObject({ success: false, status: 409, errorCode: AUTHORIZATION_IN_FLIGHT, retryable: true, safeToReplay: false, retryAfterSeconds: 5 });
    expect(isAuthorizationInFlight(result)).toBe(true);
    expect(isAuthorizationAlreadyUsed(result)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('receipt_request_conflict: the authorization belongs to another request', async () => {
    stubFacilitator(() => json({ success: false, error: RECEIPT_REQUEST_CONFLICT, retryable: false, safeToReplay: false }, 409));
    const result = await new FacilitatorClient({ retries: 0 }).settle(HEADER, REQUIREMENTS);
    expect(result).toMatchObject({ success: false, status: 409, errorCode: RECEIPT_REQUEST_CONFLICT, retryable: false });
    expect(result.receipt).toBeNull();
    expect(isAuthorizationAlreadyUsed(result)).toBe(true);
  });

  it('/verify names them with isValid:false, and they stop looking like a refused signature', async () => {
    stubFacilitator(() => json({ isValid: false, invalidReason: AUTHORIZATION_ALREADY_SETTLED, payer: '0x01', receipt: settleReceipt() }));
    const settled = await new FacilitatorClient({ retries: 0 }).verify(HEADER, REQUIREMENTS);
    expect(settled).toMatchObject({ isValid: false, errorCode: AUTHORIZATION_ALREADY_SETTLED, retryable: false, safeToReplay: false });
    expect(settled.receipt?.status).toBe('confirmed');

    stubFacilitator(() => json({ isValid: false, invalidReason: AUTHORIZATION_IN_FLIGHT, payer: '0x01' }));
    const inFlight = await new FacilitatorClient({ retries: 0 }).verify(HEADER, REQUIREMENTS);
    expect(inFlight).toMatchObject({ isValid: false, errorCode: AUTHORIZATION_IN_FLIGHT, retryable: true, safeToReplay: false });

    stubFacilitator(() => json({ isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' }));
    const refusedSignature = await new FacilitatorClient({ retries: 0 }).verify(HEADER, REQUIREMENTS);
    expect(refusedSignature.errorCode).toBeUndefined();
    expect(refusedSignature.retryable).toBeUndefined();
  });

  it('buildPaymentConflictResponse: 409 for a used payment, 503 while in flight, null otherwise', () => {
    expect(buildPaymentConflictResponse({ errorCode: AUTHORIZATION_ALREADY_SETTLED, status: 409 })).toMatchObject(
      { status: 409, body: { error: 'Payment authorization already used', reason: AUTHORIZATION_ALREADY_SETTLED, retryable: false } });
    expect(buildPaymentConflictResponse({ errorCode: RECEIPT_REQUEST_CONFLICT, status: 409 })?.status).toBe(409);
    expect(buildPaymentConflictResponse({ errorCode: 'idempotency_key_conflict', status: 409 })).toMatchObject(
      { status: 409, body: { error: 'Payment request conflict', reason: 'idempotency_key_conflict', retryable: false } });
    expect(buildPaymentConflictResponse({ errorCode: AUTHORIZATION_IN_FLIGHT, retryable: true, retryAfterSeconds: 5 })).toMatchObject(
      { status: 503, headers: { 'Retry-After': '5' }, body: { reason: AUTHORIZATION_IN_FLIGHT, retryable: true, safeToReplay: false } });
    expect(buildPaymentConflictResponse({ status: 503, retryable: true })).toBeNull();
    expect(buildPaymentConflictResponse({ status: 400, errorCode: 'contract_call_failed' })).toBeNull();
  });
});

describe('Idempotent-Replayed on SettleResponse', () => {
  it('a replay to the key that admitted the payment is that purchase: replayed, success kept', async () => {
    stubFacilitator(() => json({ success: true, transaction: TX, network: 'base' }, 200, REPLAYED));
    const idempotencyKey = createIdempotencyKey();
    const result = await new FacilitatorClient({ retries: 0 }).settle(HEADER, REQUIREMENTS, { idempotencyKey });
    expect(result).toMatchObject({ success: true, replayed: true, transactionHash: TX, idempotencyKey });
  });

  it('a replay reached with a fresh key is somebody else\'s purchase: already settled, nothing to deliver on', async () => {
    stubFacilitator(() => json({ success: true, transaction: TX, network: 'base', receipt: settleReceipt() }, 200, REPLAYED));
    const result = await new FacilitatorClient({ retries: 0 }).settle(HEADER, REQUIREMENTS);
    expect(result).toMatchObject({ success: false, replayed: true, errorCode: AUTHORIZATION_ALREADY_SETTLED, retryable: false, safeToReplay: false });
    expect(result.transactionHash).toBeUndefined();
    expect(result.receipt?.settlement?.id).toBe(TX);
  });

  it('an unbound replay of a settle in progress is in flight; a bound one keeps the facilitator\'s 202', async () => {
    const inProgress = () => json({ success: false, error: 'settlement_in_progress', retryable: true, safeToReplay: false, receipt: settleReceipt('pending') }, 202, REPLAYED);
    stubFacilitator(inProgress);
    const unbound = await new FacilitatorClient({ retries: 0 }).settle(HEADER, REQUIREMENTS);
    expect(unbound).toMatchObject({ success: false, replayed: true, errorCode: AUTHORIZATION_IN_FLIGHT, retryable: true, retryAfterSeconds: 5 });

    stubFacilitator(inProgress);
    const bound = await new FacilitatorClient({ retries: 0 }).settle(HEADER, REQUIREMENTS, { idempotencyKey: createIdempotencyKey() });
    expect(bound).toMatchObject({ success: false, replayed: true, errorCode: 'settlement_in_progress', retryable: true, safeToReplay: false });
  });

  it('a replayed rejection is the original rejection and passes unchanged', async () => {
    stubFacilitator(() => json({ success: false, errorReason: 'invalid_exact_evm_payload_signature' }, 200, REPLAYED));
    const result = await new FacilitatorClient({ retries: 0 }).settle(HEADER, REQUIREMENTS);
    expect(result).toMatchObject({ success: false, replayed: true, errorReason: 'invalid_exact_evm_payload_signature' });
    expect(result.errorCode).toBeUndefined();
  });

  it('verifyAndSettle with its own fresh key refuses an unbound replay', async () => {
    stubFacilitator((path) => (path === 'verify' ? VERIFIED() : json({ success: true, transaction: TX }, 200, REPLAYED)));
    const result = await new FacilitatorClient({ retries: 0 }).verifyAndSettle(HEADER, REQUIREMENTS);
    expect(result).toMatchObject({ verified: true, settled: false, errorCode: AUTHORIZATION_ALREADY_SETTLED, replayed: true });
    expect(result.transactionHash).toBeUndefined();
  });
});

describe('Express middleware', () => {
  it('uses one key for verify and settle and keeps it out of PAYMENT-RESPONSE', async () => {
    const calls = stubFacilitator((path) => (path === 'verify' ? VERIFIED() : json({ success: true, transaction: TX, receipt: settleReceipt() })));
    const { state, next, req } = await runExpress();
    expect(next).toHaveBeenCalledTimes(1);
    expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
    expect(req.x402?.idempotencyKey).toBe(keyOf(calls[0]));
    const propagated = Buffer.from(state.headers.get('payment-response')!, 'base64').toString();
    expect(propagated).not.toContain(keyOf(calls[0])!);
    expect(JSON.parse(propagated).idempotencyKey).toBeUndefined();
  });

  it('verify authorization_already_settled -> 409 with the receipt, never 402, handler not run', async () => {
    const calls = stubFacilitator(() => json({ isValid: false, invalidReason: AUTHORIZATION_ALREADY_SETTLED, receipt: settleReceipt() }));
    const { state, next } = await runExpress();
    expect(state.status).toBe(409);
    expect(state.body).toMatchObject({ error: 'Payment authorization already used', reason: AUTHORIZATION_ALREADY_SETTLED, retryable: false });
    expect(next).not.toHaveBeenCalled();
    expect(calls.map(c => c.path)).toEqual(['verify']);
    const receipt = receiptFromResponse(new Response(null, { headers: Object.fromEntries(state.headers) }));
    expect(receipt?.status).toBe('confirmed');
  });

  it('verify authorization_in_flight -> 503 + Retry-After, the buyer keeps the same credential', async () => {
    stubFacilitator(() => json({ isValid: false, invalidReason: AUTHORIZATION_IN_FLIGHT }));
    const { state, next } = await runExpress();
    expect(state.status).toBe(503);
    expect(state.headers.get('retry-after')).toBe('5');
    expect(state.body).toMatchObject({ reason: AUTHORIZATION_IN_FLIGHT, retryable: true, safeToReplay: false });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([AUTHORIZATION_ALREADY_SETTLED, RECEIPT_REQUEST_CONFLICT])('settle 409 %s -> 409, not 500', async (code) => {
    stubFacilitator((path) => (path === 'verify' ? VERIFIED() : refused(code)));
    const { state, next } = await runExpress();
    expect(state.status).toBe(409);
    expect(state.body).toMatchObject({ reason: code, retryable: false });
    expect(next).not.toHaveBeenCalled();
  });

  it('settle 409 authorization_in_flight -> 503, not 500', async () => {
    stubFacilitator((path) => (path === 'verify' ? VERIFIED() : refused(AUTHORIZATION_IN_FLIGHT)));
    const { state, next } = await runExpress();
    expect(state.status).toBe(503);
    expect(state.body).toMatchObject({ reason: AUTHORIZATION_IN_FLIGHT, retryable: true });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not serve a replay the request did not bind (a facilitator older than 2.39.0 replays to any resend)', async () => {
    stubFacilitator((path) => (path === 'verify'
      ? json({ isValid: true, receipt: settleReceipt() })
      : json({ success: true, transaction: TX, receipt: settleReceipt() }, 200, REPLAYED)));
    const { state, next } = await runExpress();
    expect(next).not.toHaveBeenCalled();
    expect(state.status).toBe(409);
    expect(state.body).toMatchObject({ reason: AUTHORIZATION_ALREADY_SETTLED, retryable: false });
  });

  it('manual: the handler receives an unbound replay as a failure, not a success to deliver on', async () => {
    stubFacilitator((path) => (path === 'verify' ? VERIFIED() : json({ success: true, transaction: TX }, 200, REPLAYED)));
    const { req, next } = await runExpress({ settlementStrategy: 'manual' });
    expect(next).toHaveBeenCalledTimes(1);
    const result = await req.x402!.settle();
    expect(result).toMatchObject({ success: false, replayed: true, errorCode: AUTHORIZATION_ALREADY_SETTLED });
  });

  it('serves a replay bound by the buyer\'s X-UVD-Purchase: that is a resumed purchase', async () => {
    const url = `${RESOURCE}?item=1`;
    const context = { ...createPurchaseContext(), method: 'GET', url, bodySha256: vectors.cases[0].receipt.request.bodySha256! };
    const calls = stubFacilitator((path) => (path === 'verify' ? VERIFIED() : json({ success: true, transaction: TX }, 200, REPLAYED)));
    const middleware = createPaymentMiddleware(expressRequirements, { retries: 0 });
    const req: { headers: Record<string, string>; method: string; originalUrl: string; x402?: VerifiedPaymentState } = {
      headers: { 'x-payment': PAYMENT, 'x-uvd-purchase': purchaseContextHeader(context) }, method: 'GET', originalUrl: '/data?item=1' };
    const { res } = expressResponse();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect((await req.x402!.settle())).toMatchObject({ success: true, replayed: true, transactionHash: TX });
    expect(calls.every(c => c.headers.get('X-UVD-Purchase'))).toBe(true);
    expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
  });

  it('adds to Access-Control-Expose-Headers and Cache-Control instead of replacing them', async () => {
    stubFacilitator((path) => (path === 'verify' ? VERIFIED() : json({ success: true, transaction: TX, receipt: settleReceipt() })));
    const { state, next } = await runExpress({}, {
      'Access-Control-Expose-Headers': 'X-Request-Id, payment-response',
      'Cache-Control': 'private, max-age=60',
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(state.headers.get('access-control-expose-headers')).toBe('X-Request-Id, payment-response, X-PAYMENT-RESPONSE');
    expect(state.headers.get('cache-control')).toBe('private, max-age=60, no-store');
  });

  it('manual: settling after the handler answered does not touch the sent response (real node:http)', async () => {
    stubFacilitator((path) => (path === 'verify' ? VERIFIED() : json({ success: true, transaction: TX, receipt: settleReceipt() })));
    const warn = vi.spyOn(console, 'warn');
    const middleware = createPaymentMiddleware(expressRequirements, { retries: 0, settlementStrategy: 'manual' });
    let late: ((values: Record<string, string>) => void) | undefined;
    let settled: Promise<SettleResponse> | undefined;
    const server = http.createServer((incoming, out) => {
      // What Express does underneath: `res.set` is `setHeader`, `res.headersSent` is Node's.
      const res = {
        get headersSent() { return out.headersSent; },
        getHeader: (name: string) => out.getHeader(name),
        set: (values: Record<string, string>) => { for (const [k, v] of Object.entries(values)) out.setHeader(k, v); },
        status: (code: number) => {
          out.statusCode = code;
          const send = (body: unknown) => { out.end(JSON.stringify(body)); };
          return { json: send, set: (values: Record<string, string>) => { res.set(values); return { json: send }; } };
        },
      };
      late = res.set;
      const req: { headers: Record<string, string | string[] | undefined>; method?: string; originalUrl?: string; x402?: VerifiedPaymentState } =
        { headers: incoming.headers, method: incoming.method, originalUrl: incoming.url };
      void middleware(req, res, () => {
        out.end('premium');          // the handler answers first...
        settled = req.x402!.settle(); // ...and settles afterwards
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const body = await new Promise<string>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/data', headers: { 'x-payment': PAYMENT } }, (response) => {
          let text = '';
          response.on('data', (chunk) => { text += chunk; });
          response.on('end', () => resolve(text));
        }).on('error', reject);
      });
      expect(body).toBe('premium');
      await expect(settled!).resolves.toMatchObject({ success: true, transactionHash: TX });
      expect(warn).not.toHaveBeenCalled();
      // The double is faithful: setting a header now is exactly the Express failure.
      expect(() => late!({ 'X-Late': '1' })).toThrow(expect.objectContaining({ code: 'ERR_HTTP_HEADERS_SENT' }));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('Hono middleware (real app with CORS)', () => {
  it('verify authorization_already_settled -> 409, handler not run', async () => {
    stubFacilitator(() => json({ isValid: false, invalidReason: AUTHORIZATION_ALREADY_SETTLED, receipt: settleReceipt() }));
    const { app, served } = honoApp();
    const response = await honoRequest(app);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: AUTHORIZATION_ALREADY_SETTLED, retryable: false });
    expect(served).not.toHaveBeenCalled();
    expect(receiptFromResponse(response)?.status).toBe('confirmed');
  });

  it('verify authorization_in_flight -> 503 + Retry-After', async () => {
    stubFacilitator(() => json({ isValid: false, invalidReason: AUTHORIZATION_IN_FLIGHT }));
    const { app, served } = honoApp();
    const response = await honoRequest(app);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(served).not.toHaveBeenCalled();
  });

  it.each([AUTHORIZATION_ALREADY_SETTLED, RECEIPT_REQUEST_CONFLICT])('settle 409 %s -> 409, not 500', async (code) => {
    stubFacilitator((path) => (path === 'verify' ? VERIFIED() : refused(code)));
    const { app, served } = honoApp();
    const response = await honoRequest(app);
    expect(response.status).toBe(409);
    expect(served).not.toHaveBeenCalled();
  });

  it('settle 409 authorization_in_flight -> 503, not 500', async () => {
    stubFacilitator((path) => (path === 'verify' ? VERIFIED() : refused(AUTHORIZATION_IN_FLIGHT)));
    const { app, served } = honoApp();
    expect((await honoRequest(app)).status).toBe(503);
    expect(served).not.toHaveBeenCalled();
  });

  it('does not serve a replay the request did not bind', async () => {
    stubFacilitator((path) => (path === 'verify' ? VERIFIED() : json({ success: true, transaction: TX, receipt: settleReceipt() }, 200, REPLAYED)));
    const { app, served } = honoApp();
    const response = await honoRequest(app);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: AUTHORIZATION_ALREADY_SETTLED });
    expect(served).not.toHaveBeenCalled();
  });

  it('one key for verify and settle; CORS expose list and Cache-Control are kept and extended', async () => {
    const calls = stubFacilitator((path) => (path === 'verify' ? VERIFIED() : json({ success: true, transaction: TX, receipt: settleReceipt() })));
    const { app, served } = honoApp();
    const response = await honoRequest(app);
    expect(response.status).toBe(200);
    expect(served).toHaveBeenCalledTimes(1);
    expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('X-Request-Id, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(receiptFromResponse(response)?.settlement?.id).toBe(TX);
    expect(Buffer.from(response.headers.get('PAYMENT-RESPONSE')!, 'base64').toString()).not.toContain(keyOf(calls[0])!);
  });

  it('manual: a settle after the response was returned resolves with the settlement', async () => {
    stubFacilitator((path) => (path === 'verify' ? VERIFIED() : json({ success: true, transaction: TX, receipt: settleReceipt() })));
    const warn = vi.spyOn(console, 'warn');
    const app = new Hono<{ Variables: { x402: VerifiedPaymentState } }>();
    let settled: Promise<SettleResponse> | undefined;
    const late: string[] = [];
    app.use('*', async (c, next) => {
      const header = c.header;
      c.header = ((name: string, ...rest: [string | undefined]) => {
        if (c.finalized) late.push(name);
        return header(name, ...rest);
      }) as typeof c.header;
      await next();
    });
    app.use('/data', createHonoMiddleware({ accepts: HONO_ACCEPTS, retries: 0, settlementStrategy: 'manual' }) as never);
    app.get('/data', (c) => {
      const response = c.json({ premium: true });
      settled = c.get('x402').settle();
      return response;
    });
    const response = await honoRequest(app as unknown as Hono);
    expect(response.status).toBe(200);
    await expect(settled!).resolves.toMatchObject({ success: true, transactionHash: TX });
    // The response already handed back is left alone and stays readable.
    expect(await response.json()).toEqual({ premium: true });
    expect(late).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

it('the package root exports the binding and conflict API', () => {
  expect(sdk.createIdempotencyKey).toBe(createIdempotencyKey);
  expect(sdk.buildPaymentConflictResponse).toBe(buildPaymentConflictResponse);
  expect(sdk.isAuthorizationAlreadyUsed).toBe(isAuthorizationAlreadyUsed);
  expect(sdk.isAuthorizationInFlight).toBe(isAuthorizationInFlight);
  expect([sdk.AUTHORIZATION_ALREADY_SETTLED, sdk.AUTHORIZATION_IN_FLIGHT, sdk.RECEIPT_REQUEST_CONFLICT])
    .toEqual(['authorization_already_settled', 'authorization_in_flight', 'receipt_request_conflict']);
  expect([sdk.IDEMPOTENCY_KEY_HEADER, sdk.IDEMPOTENT_REPLAYED_HEADER]).toEqual(['Idempotency-Key', 'Idempotent-Replayed']);
  expect(typeof sdk.mergePaymentResponseHeaders).toBe('function');
});

describe('facilitators without receipts (legacy networks) behave as before', () => {
  // No `headers` on the answer at all, as the older doubles in this suite do.
  const legacy = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

  it('Express: verify + settle succeed, no receipt headers, the app\'s CORS and cache headers untouched', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ path: url.endsWith('/verify') ? 'verify' : 'settle', headers: new Headers(init.headers) });
      return url.endsWith('/verify') ? legacy({ isValid: true }) : legacy({ success: true, transactionHash: TX, network: 'base' });
    }));
    const initial = { 'Access-Control-Expose-Headers': 'X-Request-Id', 'Cache-Control': 'public, max-age=60' };
    const { state, next, req } = await runExpress({}, initial);
    expect(next).toHaveBeenCalledTimes(1);
    expect(state.status).toBeUndefined();
    expect(state.headers.get('payment-response')).toBeUndefined();
    expect(state.headers.get('access-control-expose-headers')).toBe('X-Request-Id');
    expect(state.headers.get('cache-control')).toBe('public, max-age=60');
    const result = await req.x402!.settle();
    expect(result).toMatchObject({ success: true, transactionHash: TX, receipt: null });
    expect(result.replayed).toBeUndefined();
    expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
  });

  it('Express: a refused payment is still 402, and a failed settle is still 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => legacy({ isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' })));
    expect((await runExpress()).state).toMatchObject({ status: 402, body: { reason: 'invalid_exact_evm_payload_signature' } });

    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/verify')
      ? legacy({ isValid: true })
      : legacy({ error: 'contract_call_failed' }, 400))));
    const failed = await runExpress();
    expect(failed.state.status).toBe(500);
    expect(failed.next).not.toHaveBeenCalled();
  });

  it('Hono: verify + settle succeed and the response carries no receipt headers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/verify')
      ? legacy({ isValid: true })
      : legacy({ success: true, transactionHash: TX }))));
    const { app, served } = honoApp();
    const response = await honoRequest(app);
    expect(response.status).toBe(200);
    expect(served).toHaveBeenCalledTimes(1);
    expect(response.headers.get('PAYMENT-RESPONSE')).toBeNull();
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('X-Request-Id');
    expect(response.headers.get('Cache-Control')).toBe('private');
  });
});
