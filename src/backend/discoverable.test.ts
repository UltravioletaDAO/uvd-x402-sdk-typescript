/**
 * `extra.discoverable` from the seller's side: the `discoverable` option of
 * createHonoMiddleware / createFetchPaywall and the `withDiscoverable` helper.
 *
 * The Ultravioleta facilitator lists a resource in its Bazaar after a settle
 * whose requirements carry `extra.discoverable` as a JSON `true`
 * (x402-rs `post_settle`: `extra.get("discoverable").and_then(as_bool)`).
 * So the flag must be in the 402 a buyer reads AND in the requirements that
 * reach `/settle`, with the other `extra` fields (`name`, `version`) kept.
 *
 * The facilitator is a double on 127.0.0.1 and the network is closed: `fetch`
 * refuses every host but loopback, and each test checks nothing tried one.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Hono } from 'hono';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFetchPaywall, createHonoMiddleware, withDiscoverable } from './index';
import type { HonoMiddlewareOptions, PaymentAcceptance } from './index';
import * as root from '../index';
import { getChainByName } from '../chains';
import { decodeX402Header } from '../utils/x402';

const PAYER = '0x1111111111111111111111111111111111111111';
const PAY_TO = '0x2222222222222222222222222222222222222222';
const TX = '0x' + '22'.repeat(32);
const URL_ = 'https://shop.example/api/premium';
const BASE_USDC = getChainByName('base')!.usdc.address;
const POLYGON_USDC = getChainByName('polygon')!.usdc.address;
const BASE_EXTRA = { name: 'USD Coin', version: '2' };
const POLYGON_EXTRA = { name: 'USD Coin', version: '2', note: { kept: [1, 2] } };

const baseAccept = (): PaymentAcceptance => ({ network: 'base', asset: BASE_USDC, amount: '10000', payTo: PAY_TO, extra: { ...BASE_EXTRA } });
const polygonAccept = (): PaymentAcceptance => ({
  network: 'polygon', asset: POLYGON_USDC, amount: '20000', payTo: PAY_TO,
  extra: { ...POLYGON_EXTRA, note: { kept: [1, 2] } },
});
/** An accept with no extra at all: the flag must create one. */
const bareBaseAccept = (): PaymentAcceptance => ({ network: 'base', asset: BASE_USDC, amount: '10000', payTo: PAY_TO });

function xPayment(network: 'base' | 'polygon', value: string): string {
  return Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: 'exact',
    network,
    payload: {
      signature: '0x' + 'ab'.repeat(65),
      authorization: { from: PAYER, to: PAY_TO, value, validAfter: '0', validBefore: '9999999999', nonce: '0x' + '11'.repeat(32) },
    },
  })).toString('base64');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The facilitator double and the closed network
// ---------------------------------------------------------------------------

type FacilitatorCall = { path: string; body: any };
const facilitator = { url: '', calls: [] as FacilitatorCall[] };
const leftLoopback: string[] = [];
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const route = (req.url ?? '').slice(1);
      const body = JSON.parse(Buffer.concat(chunks).toString() || 'null');
      facilitator.calls.push({ path: route, body });
      const network = (body?.paymentRequirements ?? body?.accepted)?.network ?? 'base';
      const answer = route === 'verify' ? { isValid: true, payer: PAYER }
        : route === 'settle' ? { success: true, transaction: TX, network, payer: PAYER }
          : { error: 'no such route' };
      res.writeHead(route === 'verify' || route === 'settle' ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  facilitator.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const loopbackFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  facilitator.calls = [];
  leftLoopback.length = 0;
  fetchCalls = 0;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls += 1;
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
  expect(leftLoopback, 'a request tried to leave loopback').toEqual([]);
});

// ---------------------------------------------------------------------------
// Both frameworks, driven as they are in production
// ---------------------------------------------------------------------------

type Reply = { status: number; body: any; paymentRequired: any };
type Server = (headers?: Record<string, string>) => Promise<Reply>;

async function toReply(response: Response): Promise<Reply> {
  const header = response.headers.get('PAYMENT-REQUIRED');
  return {
    status: response.status,
    body: await response.json().catch(() => null),
    paymentRequired: header ? JSON.parse(Buffer.from(header, 'base64').toString()) : undefined,
  };
}

const FRAMEWORKS: Array<[string, (options: HonoMiddlewareOptions) => Server]> = [
  ['Hono', (options) => {
    const app = new Hono();
    app.use('/api/*', createHonoMiddleware(options));
    app.get('/api/premium', (c) => c.json({ premium: true }));
    return async (headers = {}) => toReply(await app.request(URL_, { headers }));
  }],
  ['Fetch', (options) => {
    const route = createFetchPaywall(options)(async () => Response.json({ premium: true }));
    return async (headers = {}) => toReply(await route(new Request(URL_, { headers })));
  }],
];

const settledRequirements = () => facilitator.calls
  .filter((call) => call.path === 'settle')
  .map((call) => call.body.paymentRequirements ?? call.body.accepted);
const verifiedRequirements = () => facilitator.calls
  .filter((call) => call.path === 'verify')
  .map((call) => call.body.paymentRequirements ?? call.body.accepted);

const CASES: Array<[string, boolean | undefined]> = [['true', true], ['false', false], ['omitted', undefined]];

describe.each(FRAMEWORKS)('%s paywall: discoverable', (_name, serve) => {
  describe.each(CASES)('discoverable %s', (_label, flag) => {
    const options = (accepts: PaymentAcceptance[]): HonoMiddlewareOptions => ({
      accepts, facilitatorUrl: facilitator.url, retries: 0,
      ...(flag === undefined ? {} : { discoverable: flag }),
    });
    const expectedExtra = (extra: Record<string, unknown>) =>
      (flag === undefined ? extra : { ...extra, discoverable: flag });

    it('one accept: the 402 body, the PAYMENT-REQUIRED header and the settled requirements carry it, extras kept', async () => {
      const request = serve(options([baseAccept()]));
      const challenge = await request();
      expect(challenge.status).toBe(402);
      expect(challenge.body.accepts).toHaveLength(1);
      expect(challenge.body.accepts[0].extra).toStrictEqual(expectedExtra(BASE_EXTRA));
      expect(challenge.paymentRequired.accepts[0].extra).toStrictEqual(expectedExtra(BASE_EXTRA));
      expect(fetchCalls).toBe(0);

      const paid = await request({ 'X-PAYMENT': xPayment('base', '10000') });
      expect(paid.status).toBe(200);
      expect(verifiedRequirements().map((r) => r.extra)).toStrictEqual([expectedExtra(BASE_EXTRA)]);
      expect(settledRequirements().map((r) => r.extra)).toStrictEqual([expectedExtra(BASE_EXTRA)]);
      if (flag !== undefined) expect(typeof settledRequirements()[0].extra.discoverable).toBe('boolean');
    });

    it('several accepts: every advertised accept, and the one settled, carry it with their own extras', async () => {
      const request = serve(options([baseAccept(), polygonAccept(), bareBaseAccept()]));
      const challenge = await request();
      expect(challenge.status).toBe(402);
      const expected = [expectedExtra(BASE_EXTRA), expectedExtra(POLYGON_EXTRA), flag === undefined ? undefined : { discoverable: flag }];
      expect(challenge.body.accepts.map((a: any) => a.extra)).toStrictEqual(expected);
      expect(challenge.paymentRequired.accepts.map((a: any) => a.extra)).toStrictEqual(expected);

      const paid = await request({ 'X-PAYMENT': xPayment('polygon', '20000') });
      expect(paid.status).toBe(200);
      const settled = settledRequirements();
      expect(settled).toHaveLength(1);
      expect(settled[0].asset).toBe(POLYGON_USDC);
      expect(settled[0].extra).toStrictEqual(expectedExtra(POLYGON_EXTRA));
    });

    it("leaves the caller's options and accepts as they were", async () => {
      const accepts = deepFreeze([baseAccept(), polygonAccept()]);
      const given = deepFreeze(options(accepts));
      const before = JSON.stringify(given);
      const request = serve(given);
      await request();
      await request({ 'X-PAYMENT': xPayment('base', '10000') });
      expect(JSON.stringify(given)).toBe(before);
      expect(given.accepts).toBe(accepts);
      expect(accepts[0].extra).toStrictEqual(BASE_EXTRA);
    });
  });

  it.each([true, false])('discoverable %s leaves every native Hedera accept as given and flags the others', async (flag) => {
    const accepts = deepFreeze([...HEDERA_ACCEPTS.map(([, accept]) => accept), baseAccept()]);
    const request = serve({ accepts, facilitatorUrl: facilitator.url, retries: 0, x402Version: 2, discoverable: flag });
    const challenge = await request();
    expect(challenge.status).toBe(402);
    const expected = [...HEDERA_ACCEPTS.map(() => ({ feePayer: '0.0.5678' })), { ...BASE_EXTRA, discoverable: flag }];
    expect(challenge.paymentRequired.accepts.map((a: any) => a.extra)).toStrictEqual(expected);
    expect(accepts.map((a) => a.extra)).toStrictEqual(expected.map((extra, i) => (i < HEDERA_ACCEPTS.length ? extra : BASE_EXTRA)));
    expect(fetchCalls).toBe(0);
    expect(facilitator.calls).toEqual([]);
  });

  it('true overrides an extra.discoverable: false in an accept, false overrides a true', async () => {
    const flagged = (value: boolean): PaymentAcceptance => ({ ...baseAccept(), extra: { ...BASE_EXTRA, discoverable: value } });
    const on = await serve({ accepts: [flagged(false)], facilitatorUrl: facilitator.url, discoverable: true })();
    expect(on.body.accepts[0].extra).toStrictEqual({ ...BASE_EXTRA, discoverable: true });
    const off = await serve({ accepts: [flagged(true)], facilitatorUrl: facilitator.url, discoverable: false })();
    expect(off.body.accepts[0].extra).toStrictEqual({ ...BASE_EXTRA, discoverable: false });
    const kept = await serve({ accepts: [flagged(true)], facilitatorUrl: facilitator.url })();
    expect(kept.body.accepts[0].extra).toStrictEqual({ ...BASE_EXTRA, discoverable: true });
  });
});

// ---------------------------------------------------------------------------
// Invalid input: refused when the paywall is built, before any I/O
// ---------------------------------------------------------------------------

const INVALID_FLAGS: unknown[] = ['true', 'false', 1, 0, null, {}, [], 'yes'];
const hedera = (): PaymentAcceptance => ({
  network: 'hedera:mainnet', asset: '0.0.456858', amount: '10000', payTo: '0.0.1234', extra: { feePayer: '0.0.5678' },
});
const INVALID_ACCEPTS: Array<[string, PaymentAcceptance]> = [
  ['extra is an array', { ...baseAccept(), extra: ['name'] }],
  ['extra is a string', { ...baseAccept(), extra: 'USD Coin' }],
  ['extra is null', { ...baseAccept(), extra: null }],
  ['extra is a class instance', { ...baseAccept(), extra: new Map([['name', 'USD Coin']]) }],
];
const HEDERA_ACCEPTS: Array<[string, PaymentAcceptance]> = [
  ['CAIP-2', hedera()],
  ['upper case CAIP-2', { ...hedera(), network: 'HEDERA:MAINNET' }],
  ['mixed case CAIP-2', { ...hedera(), network: 'Hedera:Testnet' }],
  ['by alias', { ...hedera(), network: 'hedera-testnet' }],
  ['upper case alias', { ...hedera(), network: 'HEDERA' }],
];

describe.each([
  ['createHonoMiddleware', createHonoMiddleware],
  ['createFetchPaywall', createFetchPaywall],
] as const)('%s refuses invalid discoverable input without I/O', (_name, create) => {
  it.each(INVALID_FLAGS.map((value) => [String(JSON.stringify(value)), value]))('discoverable: %s', (_label, value) => {
    expect(() => create({ accepts: [baseAccept()], facilitatorUrl: facilitator.url, discoverable: value as boolean }))
      .toThrow(/discoverable must be true or false/);
    expect(fetchCalls).toBe(0);
    expect(facilitator.calls).toEqual([]);
  });

  it.each(INVALID_FLAGS.map((value) => [String(JSON.stringify(value)), value]))('discoverable: %s with no accept to copy', (_label, value) => {
    expect(() => create({ accepts: [], facilitatorUrl: facilitator.url, discoverable: value as boolean }))
      .toThrow(/discoverable must be true or false/);
    expect(fetchCalls).toBe(0);
  });

  it.each(INVALID_ACCEPTS)('%s', (_label, accept) => {
    for (const discoverable of [true, false]) {
      expect(() => create({ accepts: [baseAccept(), accept], facilitatorUrl: facilitator.url, discoverable }))
        .toThrow(/discoverable/);
    }
    expect(fetchCalls).toBe(0);
    expect(facilitator.calls).toEqual([]);
  });

  it('without the option, the same accepts build as before (nothing is checked or added)', () => {
    for (const [, accept] of INVALID_ACCEPTS) {
      expect(() => create({ accepts: [accept], facilitatorUrl: facilitator.url })).not.toThrow();
    }
    expect(() => create({ accepts: [hedera()], facilitatorUrl: facilitator.url, x402Version: 2 })).not.toThrow();
    expect(fetchCalls).toBe(0);
  });
});

describe('withDiscoverable', () => {
  it('defaults to true, keeps the other extras and returns a new accept', () => {
    const accept = deepFreeze(polygonAccept());
    const flagged = withDiscoverable(accept);
    expect(flagged).not.toBe(accept);
    expect(flagged.extra).not.toBe(accept.extra);
    expect(flagged).toStrictEqual({ ...polygonAccept(), extra: { ...POLYGON_EXTRA, discoverable: true } });
    expect(accept.extra).toStrictEqual(POLYGON_EXTRA);
    expect(withDiscoverable(accept, false).extra).toStrictEqual({ ...POLYGON_EXTRA, discoverable: false });
    expect(withDiscoverable(bareBaseAccept()).extra).toStrictEqual({ discoverable: true });
  });

  it('works for a hand-built accept in the paywall: the settle carries it', async () => {
    const route = createFetchPaywall({ accepts: [withDiscoverable(baseAccept())], facilitatorUrl: facilitator.url, retries: 0 })(
      async () => Response.json({ premium: true }),
    );
    const paid = await route(new Request(URL_, { headers: { 'X-PAYMENT': xPayment('base', '10000') } }));
    expect(paid.status).toBe(200);
    expect(settledRequirements().map((r) => r.extra)).toStrictEqual([{ ...BASE_EXTRA, discoverable: true }]);
  });

  it('works with create402Response accepts', () => {
    const { body, headers } = root.create402Response(
      { amount: '0.01', recipient: PAY_TO, resource: URL_, x402Version: 2 },
      { accepts: [withDiscoverable(polygonAccept())] },
    );
    const accepts = body.accepts as Array<{ extra?: unknown }>;
    expect(accepts[1].extra).toStrictEqual({ ...POLYGON_EXTRA, discoverable: true });
    const header = decodeX402Header(headers['PAYMENT-REQUIRED']) as unknown as { accepts: Array<{ extra?: unknown }> };
    expect(header.accepts[1].extra).toStrictEqual({ ...POLYGON_EXTRA, discoverable: true });
  });

  it.each(INVALID_FLAGS.map((value) => [String(JSON.stringify(value)), value]))('refuses discoverable: %s', (_label, value) => {
    expect(() => withDiscoverable(baseAccept(), value as boolean)).toThrow(/discoverable must be true or false/);
  });

  it.each(INVALID_ACCEPTS)('refuses an accept where %s', (_label, accept) => {
    expect(() => withDiscoverable(accept)).toThrow(/discoverable/);
  });

  it.each(HEDERA_ACCEPTS)('refuses a native Hedera accept, %s', (_label, accept) => {
    expect(() => withDiscoverable(accept)).toThrow(/native Hedera/);
    expect(() => withDiscoverable(accept, false)).toThrow(/native Hedera/);
  });

  it('refuses something that is not an accept', () => {
    for (const value of [null, undefined, 'base', [baseAccept()], { asset: BASE_USDC }]) {
      expect(() => withDiscoverable(value as unknown as PaymentAcceptance)).toThrow(/discoverable/);
    }
    expect(fetchCalls).toBe(0);
  });

  it('is exported from the package root as from uvd-x402-sdk/backend', () => {
    expect(root.withDiscoverable).toBe(withDiscoverable);
  });
});

// ---------------------------------------------------------------------------
// The public types, checked by the compiler with the repo's tsconfig
// ---------------------------------------------------------------------------

function typecheck(source: string): string[] {
  const configPath = path.resolve(__dirname, '../../tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => undefined,
  });
  if (!parsed) throw new Error('tsconfig.json did not parse');
  const file = path.resolve(__dirname, '__discoverable_fixture__.ts').replace(/\\/g, '/');
  const same = (name: string) => name.replace(/\\/g, '/') === file;
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) =>
    same(name) ? ts.createSourceFile(name, source, language) : getSourceFile(name, language, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => same(name) || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => (same(name) ? source : readFile(name));
  const program = ts.createProgram([file], { ...parsed.options, noEmit: true }, host);
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(file))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('public types', () => {
  it('discoverable is an optional boolean of both paywalls, and withDiscoverable is typed from both entry points', () => {
    const errors = typecheck(`
import { createFetchPaywall, createHonoMiddleware, withDiscoverable } from '../index';
import type { FetchPaywallOptions, HonoMiddlewareOptions, PaymentAcceptance } from '../index';
import { withDiscoverable as fromBackend } from './index';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const flagType: Equal<HonoMiddlewareOptions['discoverable'], boolean | undefined> = true;
const fetchFlagType: Equal<FetchPaywallOptions['discoverable'], boolean | undefined> = true;
const helperType: Equal<typeof withDiscoverable, (accept: PaymentAcceptance, discoverable?: boolean) => PaymentAcceptance> = true;
const same: typeof fromBackend = withDiscoverable;

const accept: PaymentAcceptance = { network: 'base', asset: '0x', amount: '1', payTo: '0x' };
createHonoMiddleware({ accepts: [accept], discoverable: true });
createFetchPaywall({ accepts: [accept], discoverable: false });
createHonoMiddleware({ accepts: [withDiscoverable(accept)] });
withDiscoverable(accept, false);

// @ts-expect-error a string is not a boolean
createHonoMiddleware({ accepts: [accept], discoverable: 'true' });
// @ts-expect-error a number is not a boolean
createFetchPaywall({ accepts: [accept], discoverable: 1 });
// @ts-expect-error the helper takes a boolean
withDiscoverable(accept, 'yes');

export { flagType, fetchFlagType, helperType, same };
`);
    expect(errors).toEqual([]);
  });

  it('the fixture catches a wrong type (the check is not vacuous)', () => {
    const errors = typecheck(`
import { createHonoMiddleware } from '../index';
createHonoMiddleware({ accepts: [], discoverable: 'true' });
`);
    expect(errors.join('\n')).toMatch(/discoverable|boolean/);
  });
});
