/**
 * createFetchPaywall: the x402 paywall for routes that take a `Request` and
 * return a `Response`, driven the way Astro and Next.js drive them.
 *
 * Neither framework is a dependency of this repo: astro 7 needs Node >= 22.12
 * while CI runs Node 20, and next unpacks to 190 MB. So each route below is
 * written the way that framework's docs write it, and is called with what the
 * framework passes it:
 *
 * - Astro calls an endpoint's `GET` with its `APIContext`, an object that
 *   carries the `Request` as `context.request` beside `params`, `url`, `locals`.
 * - Next.js calls a route handler's `POST` with a `NextRequest` (a `Request`
 *   subclass) and `{ params }`, a promise since Next 15.
 *
 * The facilitator is a double, an HTTP server on 127.0.0.1, and the network is
 * closed: `fetch` refuses every host but loopback, and each test checks that
 * nothing tried one. Nothing is signed or settled anywhere.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTHORIZATION_ALREADY_SETTLED,
  AUTHORIZATION_IN_FLIGHT,
  IDEMPOTENCY_KEY_HEADER,
  createFetchPaywall,
  createHonoMiddleware,
} from './index';
import type { FetchPaywallOptions, VerifiedPaymentState } from './index';
import { createPurchaseContext, purchaseContextHeader, receiptCommitment, receiptFromResponse } from '../receipts';
import vectors from '../fixtures/facilitator-receipts-v1.json';
import * as sdk from '../index';

const PAYER = '0x1111111111111111111111111111111111111111';
const PAY_TO = '0x2222222222222222222222222222222222222222';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TX = '0x' + '22'.repeat(32);
const ACCEPTS = [{ network: 'base', asset: USDC_BASE, amount: '10000', payTo: PAY_TO }];

/** An X-PAYMENT for the accept above. Only the double reads it; nothing checks the signature. */
function xPayment(value = '10000'): string {
  return Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature: '0x' + 'ab'.repeat(65),
      authorization: { from: PAYER, to: PAY_TO, value, validAfter: '0', validBefore: '9999999999', nonce: '0x' + '11'.repeat(32) },
    },
  })).toString('base64');
}

/** The fixture's verify receipt, and the settle receipt the facilitator issues after it. */
const VERIFY_RECEIPT = vectors.cases[0].receipt;
const settleReceipt = () => ({
  ...VERIFY_RECEIPT, operation: 'settle', status: 'confirmed', proof: null,
  settlement: { id: TX, idType: 'evm-transaction-hash' },
});
/** A valid receipt whose request is too large for a 32 KiB header once encoded. */
function oversized<R extends { request: Record<string, unknown> }>(receipt: R): R {
  const request = { ...receipt.request, note: 'x'.repeat(40_000) };
  return { ...receipt, request, requestHash: receiptCommitment('uvd-x402-request-v1', request), proof: null };
}

// ---------------------------------------------------------------------------
// The facilitator double, on loopback, and the closed network
// ---------------------------------------------------------------------------

type Answer = { status?: number; headers?: Record<string, string>; body: Record<string, unknown> };
type FacilitatorCall = { path: string; headers: http.IncomingHttpHeaders; body: any };

const VERIFIED: Answer = { body: { isValid: true, payer: PAYER } };
const SETTLED: Answer = { body: { success: true, transaction: TX, network: 'base', payer: PAYER } };
/** Broadcast, not confirmed: the one settle failure that must not be retried. */
const UNCONFIRMED: Answer = {
  status: 502,
  body: { error: 'settlement_unconfirmed', transaction: TX, paymentId: 'pay_1', retryable: false },
};
const withReceipt = (answer: Answer, receipt: unknown): Answer => ({ ...answer, body: { ...answer.body, receipt } });

const facilitator = { url: '', calls: [] as FacilitatorCall[], verify: VERIFIED, settle: SETTLED };
const paths = () => facilitator.calls.map((call) => call.path);
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '').slice(1);
      facilitator.calls.push({ path, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
      const answer: Answer = path === 'verify' ? facilitator.verify
        : path === 'settle' ? facilitator.settle
          : { status: 404, body: { error: 'no such route' } };
      res.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json', ...answer.headers });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  facilitator.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const loopbackFetch = globalThis.fetch;
const leftLoopback: string[] = [];

beforeEach(() => {
  facilitator.calls = [];
  facilitator.verify = VERIFIED;
  facilitator.settle = SETTLED;
  leftLoopback.length = 0;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== '127.0.0.1') {
      leftLoopback.push(url.href);
      return Promise.reject(new TypeError(`network closed: ${url.host}`));
    }
    return loopbackFetch(input, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(leftLoopback, 'a request tried to leave loopback').toEqual([]);
});

const options = (extra: Partial<FetchPaywallOptions> = {}): FetchPaywallOptions => ({
  accepts: ACCEPTS, facilitatorUrl: facilitator.url, retries: 0, ...extra,
});

// ---------------------------------------------------------------------------
// An Astro endpoint: src/pages/api/premium/[id].ts
// ---------------------------------------------------------------------------

/** The part of Astro's `APIContext` these endpoints read. Astro passes the whole object. */
interface APIContext {
  request: Request;
  params: Record<string, string | undefined>;
  url: URL;
  locals: Record<string, unknown>;
  redirect: (path: string, status?: number) => Response;
}
/** Astro's `APIRoute`. */
type APIRoute = (context: APIContext) => Response | Promise<Response>;

/**
 * The endpoint module as its file exports it (`prerender = false`: an endpoint
 * prerendered at build time would bake the 402 in), and what it served.
 */
function astroEndpoint(extra: Partial<FetchPaywallOptions> = {}, answer?: (context: APIContext) => Response) {
  const served: Array<{ id?: string; payment: VerifiedPaymentState }> = [];
  const paywall = createFetchPaywall(options(extra));
  const GET: APIRoute = paywall(async (context, x402) => {
    served.push({ id: context.params.id, payment: x402 });
    if (answer) return answer(context);
    return new Response(JSON.stringify({ id: context.params.id, payer: x402.verifyResult.payer }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=60',
        'Access-Control-Expose-Headers': 'X-Request-Id',
      },
    });
  });
  return { module: { prerender: false, GET }, served };
}

const ASTRO_URL = 'https://shop.example/api/premium/abc';

/** What Astro does for `GET /api/premium/abc`: the context around the request, then the export. */
function astroServes(route: APIRoute, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request(ASTRO_URL, { headers });
  return Promise.resolve(route({
    request,
    params: { id: 'abc' },
    url: new URL(request.url),
    locals: {},
    redirect: (path, status = 302) => new Response(null, { status, headers: { Location: path } }),
  }));
}

describe('an Astro endpoint behind createFetchPaywall', () => {
  it('unpaid: 402 with the accept, and neither the endpoint nor the facilitator runs', async () => {
    const { module, served } = astroEndpoint();
    const response = await astroServes(module.GET);
    expect(response.status).toBe(402);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toMatchObject({
      x402Version: 1, scheme: 'exact', network: 'base', maxAmountRequired: '10000',
      payTo: PAY_TO, asset: USDC_BASE, resource: ASTRO_URL,
    });
    expect(served).toEqual([]);
    expect(paths()).toEqual([]);
  });

  it('paid: verified and settled under one key, then served with its params and its own headers untouched', async () => {
    const { module, served } = astroEndpoint();
    const response = await astroServes(module.GET, { 'X-PAYMENT': xPayment() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'abc', payer: PAYER });
    expect(paths()).toEqual(['verify', 'settle']);
    const [verify, settle] = facilitator.calls;
    const key = IDEMPOTENCY_KEY_HEADER.toLowerCase();
    expect(verify.headers[key]).toMatch(/^x402-[0-9a-f]{64}$/);
    expect(settle.headers[key]).toBe(verify.headers[key]);
    expect(verify.body.paymentRequirements).toMatchObject({ resource: ASTRO_URL, payTo: PAY_TO, maxAmountRequired: '10000' });
    // The endpoint got the settled payment; settle() hands back that same settle.
    expect(served.map((s) => s.id)).toEqual(['abc']);
    expect(await served[0].payment.settle()).toMatchObject({ success: true, transactionHash: TX });
    expect(paths()).toEqual(['verify', 'settle']);
    // This facilitator issues no receipt: nothing is added to the endpoint's headers.
    expect(response.headers.get('PAYMENT-RESPONSE')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=60');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('X-Request-Id');
  });

  it('a settle receipt goes out as PAYMENT-RESPONSE, joined to the endpoint CORS and cache headers, without the merchant key', async () => {
    facilitator.settle = withReceipt(SETTLED, settleReceipt());
    const { module } = astroEndpoint();
    const response = await astroServes(module.GET, { 'X-PAYMENT': xPayment() });
    expect(response.status).toBe(200);
    expect(receiptFromResponse(response)).toEqual(settleReceipt());
    expect(response.headers.get('X-PAYMENT-RESPONSE')).toBe(response.headers.get('PAYMENT-RESPONSE'));
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=60, no-store');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('X-Request-Id, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE');
    const propagated = JSON.parse(Buffer.from(response.headers.get('PAYMENT-RESPONSE')!, 'base64').toString());
    expect(propagated).toMatchObject({ success: true, transactionHash: TX });
    expect(propagated).not.toHaveProperty('idempotencyKey');
  });

  it('a redirect, whose headers are immutable, still carries the receipt', async () => {
    facilitator.settle = withReceipt(SETTLED, settleReceipt());
    const { module } = astroEndpoint({}, () => Response.redirect('https://shop.example/thanks', 303));
    const response = await astroServes(module.GET, { 'X-PAYMENT': xPayment() });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('https://shop.example/thanks');
    expect(receiptFromResponse(response)?.settlement?.id).toBe(TX);
  });

  it('a refused payment: 402 with the reason, nothing settled, the endpoint does not run', async () => {
    facilitator.verify = { body: { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' } };
    const { module, served } = astroEndpoint();
    const response = await astroServes(module.GET, { 'X-PAYMENT': xPayment() });
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: 'Payment verification failed', reason: 'invalid_exact_evm_payload_signature' });
    expect(paths()).toEqual(['verify']);
    expect(served).toEqual([]);
  });

  it('a facilitator with no verdict: 503 + Retry-After, never a 402 that asks to sign again', async () => {
    facilitator.verify = { status: 503, headers: { 'Retry-After': '7' }, body: { error: 'upstream unavailable' } };
    const { module, served } = astroEndpoint();
    const response = await astroServes(module.GET, { 'X-PAYMENT': xPayment() });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('7');
    expect(await response.json()).toMatchObject({ error: 'Payment verification unavailable', retryable: true, retryAfterSeconds: 7 });
    expect(paths()).toEqual(['verify']);
    expect(served).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A Next.js route handler: app/api/articles/[slug]/route.ts
// ---------------------------------------------------------------------------

/** Next.js' `NextRequest`, which is what the framework passes: a `Request` with `nextUrl`. */
class NextRequest extends Request {
  readonly nextUrl: URL;

  constructor(input: string, init?: RequestInit) {
    super(input, init);
    this.nextUrl = new URL(this.url);
  }
}
type RouteContext = { params: Promise<{ slug: string }> };

/** The route module: it takes the order, settles once it accepted it, and answers with the transaction. */
function nextRoute(extra: Partial<FetchPaywallOptions> = {}) {
  const served: string[] = [];
  const paywall = createFetchPaywall(options({ settlementStrategy: 'manual', ...extra }));
  const POST = paywall(async (request: NextRequest, x402, { params }: RouteContext) => {
    const { slug } = await params;
    const order = await request.json();
    served.push(slug);
    const settled = await x402.settle();
    return Response.json({ slug, order, transaction: settled.transactionHash, path: request.nextUrl.pathname });
  });
  return { module: { dynamic: 'force-dynamic', POST }, served };
}

const NEXT_URL = 'https://shop.example/api/articles/x402-intro';
const ORDER = JSON.stringify({ quantity: 2 });

/** What Next.js does for `POST /api/articles/x402-intro`: a NextRequest, and the params as a promise. */
function nextServes(
  route: (request: NextRequest, context: RouteContext) => Promise<Response>,
  headers: Record<string, string> = {},
  body = ORDER,
): Promise<Response> {
  const request = new NextRequest(NEXT_URL, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });
  return route(request, { params: Promise.resolve({ slug: 'x402-intro' }) });
}

/** The buyer's `X-UVD-Purchase` for this exact POST. */
function purchaseFor(body: string): string {
  return purchaseContextHeader({
    ...createPurchaseContext(), method: 'POST', url: NEXT_URL,
    bodySha256: createHash('sha256').update(body).digest('hex'),
  });
}

describe('a Next.js route handler behind createFetchPaywall', () => {
  it('unpaid: 402, and the handler does not run', async () => {
    const { module, served } = nextRoute();
    const response = await nextServes(module.POST);
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ x402Version: 1, payTo: PAY_TO, resource: NEXT_URL });
    expect(served).toEqual([]);
    expect(paths()).toEqual([]);
  });

  it('paid, settled by the handler: X-UVD-Purchase binds the exact body, the handler still reads it, and the settle receipt goes out', async () => {
    facilitator.settle = withReceipt(SETTLED, settleReceipt());
    const purchase = purchaseFor(ORDER);
    const { module, served } = nextRoute();
    const response = await nextServes(module.POST, { 'X-PAYMENT': xPayment(), 'X-UVD-Purchase': purchase });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slug: 'x402-intro', order: { quantity: 2 }, transaction: TX, path: '/api/articles/x402-intro' });
    expect(served).toEqual(['x402-intro']);
    expect(paths()).toEqual(['verify', 'settle']);
    expect(facilitator.calls.map((call) => call.headers['x-uvd-purchase'])).toEqual([purchase, purchase]);
    expect(receiptFromResponse(response)?.operation).toBe('settle');
  });

  it('a body other than the one the buyer bound: 400 before the facilitator is asked', async () => {
    const { module, served } = nextRoute();
    const response = await nextServes(module.POST, { 'X-PAYMENT': xPayment(), 'X-UVD-Purchase': purchaseFor(ORDER) },
      JSON.stringify({ quantity: 200 }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'receipt_context_mismatch' });
    expect(paths()).toEqual([]);
    expect(served).toEqual([]);
  });

  it('settled before the handler and unconfirmed: 500 with the transaction, no Retry-After, the handler does not run', async () => {
    facilitator.settle = UNCONFIRMED;
    const { module, served } = nextRoute({ settlementStrategy: 'before-handler' });
    const response = await nextServes(module.POST, { 'X-PAYMENT': xPayment() });
    expect(response.status).toBe(500);
    expect(response.headers.get('Retry-After')).toBeNull();
    expect(await response.json()).toMatchObject({
      error: 'Payment settlement failed', retryable: false, transaction: TX, paymentId: 'pay_1',
    });
    expect(served).toEqual([]);
  });

  it('a handler that fails after a receipted settle: 500 that keeps the receipt, the error logged', async () => {
    facilitator.settle = withReceipt(SETTLED, settleReceipt());
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('database down');
    const throwing = createFetchPaywall(options())(async (_request: NextRequest) => { throw failure; });
    const response = await nextServes(throwing, { 'X-PAYMENT': xPayment() });
    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=UTF-8');
    expect(await response.text()).toBe('Internal Server Error');
    expect(receiptFromResponse(response)?.settlement?.id).toBe(TX);
    expect(logged).toHaveBeenCalledWith(failure);
    // A Response no header can be added to, even by copying it, ends the same way.
    const broken = createFetchPaywall(options())(async (_request: NextRequest) => Response.error());
    const answer = await nextServes(broken, { 'X-PAYMENT': xPayment() });
    expect(answer.status).toBe(500);
    expect(receiptFromResponse(answer)?.settlement?.id).toBe(TX);
    expect(paths()).toEqual(['verify', 'settle', 'verify', 'settle']);
  });

  it('a handler that fails with no receipt to keep: the error reaches the framework', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = createFetchPaywall(options())(async (_request: NextRequest) => { throw new Error('database down'); });
    await expect(nextServes(throwing, { 'X-PAYMENT': xPayment() })).rejects.toThrow('database down');
    expect(paths()).toEqual(['verify', 'settle']);
    expect(logged).not.toHaveBeenCalled();
  });

  it("the framework's control flow passes through a receipted route: Next.js redirect(), a SvelteKit redirect, a thrown Response", async () => {
    facilitator.settle = withReceipt(SETTLED, settleReceipt());
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = (thrown: unknown) => createFetchPaywall(options())(async (_request: NextRequest) => { throw thrown; });
    const paid = { 'X-PAYMENT': xPayment() };

    // next/navigation's redirect(): an Error whose digest Next.js answers as a 307.
    const nextRedirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/thanks;307;' });
    await expect(nextServes(throwing(nextRedirect), paid)).rejects.toBe(nextRedirect);

    // SvelteKit's redirect(): not an Error at all.
    const svelteRedirect = { status: 303, location: '/thanks' };
    await expect(nextServes(throwing(svelteRedirect), paid)).rejects.toBe(svelteRedirect);

    // React Router's `throw redirect()`: the thrown Response is the answer, and it carries the receipt.
    const thrownResponse = new Response(null, { status: 302, headers: { Location: '/thanks' } });
    const rejection = await nextServes(throwing(thrownResponse), paid).then(
      () => { throw new Error('the route resolved'); },
      (reason: unknown) => reason,
    );
    expect(rejection).toBe(thrownResponse);
    expect(thrownResponse.headers.get('Location')).toBe('/thanks');
    expect(receiptFromResponse(thrownResponse)?.settlement?.id).toBe(TX);

    expect(logged).not.toHaveBeenCalled();
    expect(paths()).toEqual(['verify', 'settle', 'verify', 'settle', 'verify', 'settle']);
  });

  it('a settle() still running when the handler returns leaves the returned response alone', async () => {
    facilitator.settle = withReceipt(SETTLED, settleReceipt());
    let settling: Promise<unknown> | undefined;
    const POST = createFetchPaywall(options({ settlementStrategy: 'manual' }))(async (_request: NextRequest, x402) => {
      settling = x402.settle(); // handed to waitUntil, say
      return Response.json({ accepted: true }, { status: 202 });
    });
    const response = await nextServes(POST, { 'X-PAYMENT': xPayment() });
    expect(response.status).toBe(202);
    expect(response.headers.get('PAYMENT-RESPONSE')).toBeNull();
    await settling;
    expect(paths()).toEqual(['verify', 'settle']);
    expect(response.headers.get('PAYMENT-RESPONSE')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The adapter itself
// ---------------------------------------------------------------------------

describe('createFetchPaywall', () => {
  const URL_ = 'https://shop.example/data';

  it('answers every outcome as createHonoMiddleware does: they share one core', async () => {
    type Case = { name: string; headers?: Record<string, string>; verify?: Answer; settle?: Answer; throws?: boolean };
    const paid = { 'X-PAYMENT': xPayment() };
    const receipts = { verify: withReceipt(VERIFIED, VERIFY_RECEIPT), settle: withReceipt(SETTLED, settleReceipt()) };
    const cases: Case[] = [
      { name: 'unpaid' },
      { name: 'unreadable X-PAYMENT', headers: { 'X-PAYMENT': 'not a payment' } },
      { name: 'an amount no accept advertises', headers: { 'X-PAYMENT': xPayment('9999') } },
      { name: 'refused', headers: paid, verify: { body: { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' } } },
      { name: 'already settled, with its receipt', headers: paid,
        verify: withReceipt({ body: { isValid: false, invalidReason: AUTHORIZATION_ALREADY_SETTLED } }, VERIFY_RECEIPT) },
      { name: 'in flight', headers: paid, verify: { body: { isValid: false, invalidReason: AUTHORIZATION_IN_FLIGHT } } },
      { name: 'no verdict', headers: paid, verify: { status: 503, headers: { 'Retry-After': '7' }, body: { error: 'upstream unavailable' } } },
      { name: 'settle unconfirmed', headers: paid, settle: UNCONFIRMED },
      { name: 'settle refused as used', headers: paid,
        settle: { status: 409, body: { success: false, error: AUTHORIZATION_ALREADY_SETTLED, retryable: false, safeToReplay: false } } },
      { name: 'paid, with receipts', headers: paid, ...receipts },
      { name: 'paid through PAYMENT-SIGNATURE', headers: { 'PAYMENT-SIGNATURE': xPayment() }, ...receipts },
      { name: 'paid, and the handler throws', headers: paid, ...receipts, throws: true },
    ];
    const seen = async (response: Response) => ({
      status: response.status,
      contentType: response.headers.get('Content-Type'),
      retryAfter: response.headers.get('Retry-After'),
      paymentResponse: response.headers.get('PAYMENT-RESPONSE'),
      xPaymentResponse: response.headers.get('X-PAYMENT-RESPONSE'),
      exposeHeaders: response.headers.get('Access-Control-Expose-Headers'),
      cacheControl: response.headers.get('Cache-Control'),
      body: await response.text(),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const statuses: number[] = [];
    for (const { name, headers = {}, verify, settle, throws } of cases) {
      facilitator.verify = verify ?? VERIFIED;
      facilitator.settle = settle ?? SETTLED;
      const serve = () => { if (throws) throw new Error('handler failed'); };

      const app = new Hono();
      app.use('/data', createHonoMiddleware(options()) as never);
      app.get('/data', (c) => { serve(); return c.json({ served: true }); });
      const viaHono = await app.request(URL_, { headers });

      const route = createFetchPaywall(options())(async (_request: Request) => { serve(); return Response.json({ served: true }); });
      const viaFetch = await route(new Request(URL_, { headers }));

      expect({ name, ...await seen(viaFetch) }).toEqual({ name, ...await seen(viaHono) });
      statuses.push(viaFetch.status);
    }
    // The table covers every answer the core gives, and the handler's failure.
    expect(statuses).toEqual([402, 400, 402, 402, 409, 503, 503, 500, 409, 200, 200, 500]);
  });

  it('a thrown non-Error passes through Hono and through the paywall alike, receipts or not', async () => {
    facilitator.verify = withReceipt(VERIFIED, VERIFY_RECEIPT);
    facilitator.settle = withReceipt(SETTLED, settleReceipt());
    const redirect = { status: 303, location: '/thanks' };
    const app = new Hono();
    app.use('/data', createHonoMiddleware(options()) as never);
    app.get('/data', () => { throw redirect; });
    await expect(app.request(URL_, { headers: { 'X-PAYMENT': xPayment() } })).rejects.toBe(redirect);
    const route = createFetchPaywall(options())(async (_request: Request) => { throw redirect; });
    await expect(route(new Request(URL_, { headers: { 'X-PAYMENT': xPayment() } }))).rejects.toBe(redirect);
  });

  it('takes a Request, or an object whose request is one, and refuses anything else before asking the facilitator', async () => {
    const handler = vi.fn(async () => new Response('served'));
    const route = createFetchPaywall(options())(handler as (input: any) => Promise<Response>);
    const notRequests: unknown[] = [
      undefined,
      'https://shop.example/data',
      new URL(URL_),
      {},
      { request: URL_ },
      { request: { url: URL_, method: 'GET' } },
      { request: { url: URL_, method: 'GET', headers: {} } },
      { request: { url: URL_, headers: new Headers() } },
      { request: { method: 'GET', headers: new Headers() } },
      { url: new URL(URL_), method: 'GET', headers: new Headers() },
      // An Express `req`: a path for a url, and plain headers.
      { url: '/data', method: 'GET', headers: { 'x-payment': xPayment() } },
    ];
    for (const input of notRequests) {
      await expect(route(input), JSON.stringify(input) ?? String(input)).rejects.toThrow(/createFetchPaywall: call the route with a Request/);
    }
    expect(paths()).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
    // Both shapes reach the paywall: unpaid, 402.
    expect((await route(new Request(URL_))).status).toBe(402);
    expect((await route({ request: new Request(URL_) })).status).toBe(402);
  });

  it('a verify receipt too large for any header stops the purchase before the settle', async () => {
    facilitator.verify = withReceipt(VERIFIED, oversized(VERIFY_RECEIPT));
    const handler = vi.fn(async () => new Response('served'));
    const route = createFetchPaywall(options())(handler);
    await expect(route(new Request(URL_, { headers: { 'X-PAYMENT': xPayment() } }))).rejects.toThrow(/payment response too large/);
    expect(paths()).toEqual(['verify']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a settle receipt too large for any header never costs the paid response: served with the verify receipt', async () => {
    facilitator.verify = withReceipt(VERIFIED, VERIFY_RECEIPT);
    facilitator.settle = withReceipt(SETTLED, oversized(settleReceipt()));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const route = createFetchPaywall(options())(async (_request: Request) => Response.json({ served: true }));
    const response = await route(new Request(URL_, { headers: { 'X-PAYMENT': xPayment() } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ served: true });
    expect(receiptFromResponse(response)?.operation).toBe('verify');
    expect(paths()).toEqual(['verify', 'settle']);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('settled, but the payment response headers could not be attached'), expect.any(Error));
  });

  it('refuses, as Hono does, to be created without an accept', () => {
    expect(() => createFetchPaywall(options({ accepts: [] }))).toThrow('At least one accept entry is required');
  });

  it('is exported from the package root', () => {
    expect(sdk.createFetchPaywall).toBe(createFetchPaywall);
  });
});
