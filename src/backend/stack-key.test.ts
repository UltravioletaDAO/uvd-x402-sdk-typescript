/**
 * Stack key: `X-UVD-Stack-Key` on the facilitator calls of a service run by
 * Ultravioleta DAO.
 *
 * The contract the SDK needs: the key is `uvdsk_` followed by 43-128 base64url
 * characters, it travels on every `/verify` and `/settle` and on the ERC-8004
 * routes, and a facilitator that does not know it ignores it. What is pinned
 * here is the SDK's own rule on top: a key that was read badly never breaks a
 * payment, and the key never shows up anywhere but in that header.
 *
 * Every key below is synthetic, built in this file. Every facilitator is a
 * double; nothing leaves the machine.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Erc8004Client, FacilitatorClient, createHonoMiddleware, createPaymentMiddleware } from './index';
import type { PaymentRequirements } from './index';
import type { X402Header } from '../types';
import { STACK_KEY_HEADER } from './stack-key';

/** Synthetic, and recognisable wherever it might leak. */
const BODY = 'synthetic-test-key_'.repeat(3);
const KEY = `uvdsk_${BODY}`;
const OTHER_BODY = 'another-synthetic-key_'.repeat(2);
const OTHER_KEY = `uvdsk_${OTHER_BODY}`;

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

const TX = '0x' + '22'.repeat(32);
const ANSWER = { isValid: true, success: true, transaction: TX, network: 'base', payer: '0x01' };

type Call = { url: string; headers: Record<string, string> };

/**
 * Stub `fetch` and record the headers EXACTLY as the SDK passed them: a real
 * `Headers` would normalise the value and hide what the SDK did.
 */
function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    return new Response(JSON.stringify(ANSWER), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return calls;
}
const sent = (call: Call) => call.headers[STACK_KEY_HEADER];

/** Payment through `verify` + `settle`; returns what each carried. */
async function pay(client: FacilitatorClient, calls: Call[]) {
  const verified = await client.verify(HEADER, REQUIREMENTS);
  const settled = await client.settle(HEADER, REQUIREMENTS);
  return { verified, settled, calls: calls.map(sent) };
}

/** Every facilitator route of Erc8004Client that writes. */
const WRITES: Array<[string, (c: Erc8004Client) => Promise<unknown>]> = [
  ['submitFeedback', (c) => c.submitFeedback({ x402Version: 1, network: 'base', feedback: { agentId: 1, value: 1 } } as never)],
  ['submitRelayedFeedback', (c) => c.submitRelayedFeedback({ network: 'base' } as never)],
  ['submitSolanaFeedback', (c) => c.submitSolanaFeedback({ network: 'solana' } as never)],
  ['revokeFeedback', (c) => c.revokeFeedback('base', 1, 1)],
  ['prepareRelayedResponse', (c) => c.prepareRelayedResponse({ network: 'base' } as never)],
  ['submitRelayedResponse', (c) => c.submitRelayedResponse({ network: 'base' } as never)],
  ['appendResponse', (c) => c.appendResponse('base', 1, 1, 'ok')],
  ['registerAgent', (c) => c.registerAgent({ x402Version: 1, network: 'base', agentUri: 'https://agent.example' } as never)],
  ['registerAgentAsync', (c) => c.registerAgentAsync({ x402Version: 1, network: 'base', agentUri: 'https://agent.example' } as never)],
];

/** Every facilitator route of Erc8004Client that reads. */
const READS: Array<[string, (c: Erc8004Client) => Promise<unknown>]> = [
  ['getIdentity', (c) => c.getIdentity('base', 1)],
  ['getIdentityByOwner', (c) => c.getIdentityByOwner('base', PAY_TO)],
  ['getReputation', (c) => c.getReputation('base', 1)],
  ['prepareRelayedFeedback', (c) => c.prepareRelayedFeedback({ network: 'base' } as never)],
  ['prepareSolanaFeedback', (c) => c.prepareSolanaFeedback({ network: 'solana' } as never)],
  ['getFeedbackMetadata', (c) => c.getFeedbackMetadata()],
  ['getRegisterStatus', (c) => c.getRegisterStatus('job-1')],
  ['getRegisterInfo', (c) => c.getRegisterInfo()],
  ['getIdentityMetadata', (c) => c.getIdentityMetadata('base', 1, 'name')],
  ['getIdentityTotalSupply', (c) => c.getIdentityTotalSupply('base')],
];

/** Call each route once; the answer does not matter, only what went out. */
async function callEach(client: Erc8004Client, routes: typeof READS, calls: Call[]) {
  const out: Array<[string, string | undefined]> = [];
  for (const [name, call] of routes) {
    const before = calls.length;
    await call(client).catch(() => undefined);
    expect(calls.length, `${name} made no request`).toBe(before + 1);
    out.push([name, sent(calls[before])]);
  }
  return out;
}

/** A facilitator double on 127.0.0.1 that records the stack key it received. */
async function facilitatorDouble() {
  const received: Array<string | string[] | undefined> = [];
  const server = http.createServer((req, res) => {
    received.push(req.headers[STACK_KEY_HEADER.toLowerCase()]);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ANSWER));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Nothing the caller can see mentions the key. */
function expectNoKey(...seen: unknown[]) {
  for (const value of seen) {
    const text = typeof value === 'string' ? value : inspect(value, { depth: Infinity, showHidden: true });
    expect(text).not.toContain(BODY.slice(0, 12));
    expect(text).not.toContain(OTHER_BODY.slice(0, 12));
  }
}

const ENV = 'UVD_STACK_KEY';
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env[ENV];
  delete process.env[ENV];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('stack key on the facilitator calls', () => {
  it('verify and settle carry the key', async () => {
    const calls = stubFetch();
    const result = await pay(new FacilitatorClient({ retries: 0, stackKey: KEY }), calls);
    expect(result.calls).toEqual([KEY, KEY]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/verify', '/settle']);
  });

  it('every ERC-8004 write carries the key', async () => {
    const calls = stubFetch();
    const out = await callEach(new Erc8004Client({ retries: 0, stackKey: KEY }), WRITES, calls);
    expect(out).toEqual(WRITES.map(([name]) => [name, KEY]));
  });

  it('every ERC-8004 facilitator read carries the key', async () => {
    const calls = stubFetch();
    const out = await callEach(new Erc8004Client({ stackKey: KEY }), READS, calls);
    expect(out).toEqual(READS.map(([name]) => [name, KEY]));
  });

  it('resolveAgentUri never carries it: that URI is not the facilitator', async () => {
    const calls = stubFetch();
    await new Erc8004Client({ stackKey: KEY }).resolveAgentUri('https://agent.example/registration.json');
    expect(calls).toHaveLength(1);
    expect(STACK_KEY_HEADER in calls[0].headers).toBe(false);
  });

  it('no key configured: no header, anywhere', async () => {
    const calls = stubFetch();
    await pay(new FacilitatorClient({ retries: 0 }), calls);
    await callEach(new Erc8004Client({ retries: 0 }), [...WRITES, ...READS], calls);
    expect(calls).toHaveLength(2 + WRITES.length + READS.length);
    for (const call of calls) expect(STACK_KEY_HEADER in call.headers).toBe(false);
  });

  it('a key read with a trailing \\r\\n (or other surrounding whitespace) goes out trimmed', async () => {
    for (const raw of [`${KEY}\r\n`, `${KEY}\n`, `  ${KEY}\t`, `﻿${KEY}\r\n`]) {
      const calls = stubFetch();
      const result = await pay(new FacilitatorClient({ retries: 0, stackKey: raw }), calls);
      expect(result.calls).toEqual([KEY, KEY]);
      const erc = stubFetch();
      expect(await callEach(new Erc8004Client({ retries: 0, stackKey: raw }), [WRITES[0], READS[0]], erc))
        .toEqual([[WRITES[0][0], KEY], [READS[0][0], KEY]]);
    }
  });

  it('an invalid key is not sent, and the payment goes through without it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invalid: unknown[] = [
      `uvdsk_${BODY.slice(0, 42)}`, // 42 characters: one short
      `uvdsk_${'a'.repeat(129)}`, // one past 128
      `sk_live_${BODY}`, // not a stack key
      `UVDSK_${BODY}`,
      `uvdsk_${BODY.slice(0, 20)} ${BODY.slice(20)}`,
      `uvdsk_${BODY.slice(0, 20)}\n${BODY.slice(20)}`,
      `uvdsk_${BODY.slice(0, 20)}é${BODY.slice(20)}`,
      `uvdsk_${BODY.slice(0, 20)}+/${BODY.slice(20)}`, // base64, not base64url
      12345,
      { toString: () => KEY },
    ];
    for (const stackKey of invalid) {
      const calls = stubFetch();
      const result = await pay(new FacilitatorClient({ retries: 0, stackKey: stackKey as string }), calls);
      expect(result.verified.isValid).toBe(true);
      expect(result.settled.success).toBe(true);
      expect(calls.map((c) => STACK_KEY_HEADER in c.headers)).toEqual([false, false]);
    }
  });

  it('warns once per process, never with the value, and never throws', async () => {
    vi.resetModules();
    const fresh = await import('./stack-key');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = {};
    const b = {};
    expect(() => fresh.bindStackKey(a, `uvdsk_${BODY.slice(0, 20)}\r\n${BODY.slice(20)}`)).not.toThrow();
    expect(() => fresh.bindStackKey(b, `sk_${OTHER_BODY}`)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expectNoKey(...warn.mock.calls.flat());
    expect(String(warn.mock.calls[0][0])).toContain('stackKey option');
    expect(fresh.withStackKey(a, { Accept: 'application/json' })).toEqual({ Accept: 'application/json' });
    expect(fresh.withStackKey(b, {})).toEqual({});
  });

  it('a client built with an invalid key warns once, without the value, and still pays', async () => {
    vi.resetModules();
    const { FacilitatorClient: FreshClient } = await import('./index');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls = stubFetch();
    const client = new FreshClient({ retries: 0, stackKey: `sk_live_${BODY}` });
    const again = new FreshClient({ retries: 0, stackKey: `sk_live_${OTHER_BODY}` });
    const first = await pay(client, calls);
    const second = await pay(again, calls);
    expect(warn).toHaveBeenCalledTimes(1);
    expectNoKey(...warn.mock.calls.flat());
    expect([first.verified.isValid, first.settled.success, second.verified.isValid, second.settled.success]).toEqual([true, true, true, true]);
    expect(calls.some((c) => STACK_KEY_HEADER in c.headers)).toBe(false);
  });

  it('real HTTP: a key no header can carry never breaks a payment, and never shows up in its result', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const double = await facilitatorDouble();
    try {
      // Node's fetch throws on this value -- with the value in the message --
      // before anything is sent. The SDK must never hand it over.
      const broken = `uvdsk_${BODY.slice(0, 20)}\n${BODY.slice(20)}`;
      const client = new FacilitatorClient({ baseUrl: double.baseUrl, retries: 0, stackKey: broken });
      const result = await client.verifyAndSettle(HEADER, REQUIREMENTS);
      expect(result).toMatchObject({ verified: true, settled: true, transactionHash: TX });
      expectNoKey(result);
      expect(double.received).toEqual([undefined, undefined]);

      // A trailing \r\n reaches the wire as the key itself.
      double.received.length = 0;
      const trimmed = new FacilitatorClient({ baseUrl: double.baseUrl, retries: 0, stackKey: `${KEY}\r\n` });
      expect(await trimmed.verifyAndSettle(HEADER, REQUIREMENTS)).toMatchObject({ verified: true, settled: true });
      expect(double.received).toEqual([KEY, KEY]);
    } finally {
      await double.close();
    }
  });

  it('defaults to UVD_STACK_KEY, trimmed', async () => {
    process.env[ENV] = `${KEY}\n`;
    const calls = stubFetch();
    expect((await pay(new FacilitatorClient({ retries: 0 }), calls)).calls).toEqual([KEY, KEY]);
    expect(await callEach(new Erc8004Client({ retries: 0 }), [WRITES[0], READS[0]], calls))
      .toEqual([[WRITES[0][0], KEY], [READS[0][0], KEY]]);
  });

  it('the option wins over UVD_STACK_KEY, and stackKey "" sends none', async () => {
    process.env[ENV] = KEY;
    const calls = stubFetch();
    expect((await pay(new FacilitatorClient({ retries: 0, stackKey: OTHER_KEY }), calls)).calls).toEqual([OTHER_KEY, OTHER_KEY]);
    const none = stubFetch();
    expect((await pay(new FacilitatorClient({ retries: 0, stackKey: '' }), none)).calls).toEqual([undefined, undefined]);
    const erc = stubFetch();
    expect(await callEach(new Erc8004Client({ retries: 0, stackKey: '' }), [WRITES[0], READS[0]], erc))
      .toEqual([[WRITES[0][0], undefined], [READS[0][0], undefined]]);
  });

  it('the key never prints with the client: inspect, JSON, String, own properties', async () => {
    process.env[ENV] = OTHER_KEY;
    const clients = [
      new FacilitatorClient({ stackKey: KEY }),
      new Erc8004Client({ stackKey: KEY }),
      new FacilitatorClient(),
      new Erc8004Client(),
    ];
    for (const client of clients) {
      expectNoKey(
        inspect(client),
        inspect(client, { showHidden: true, depth: Infinity, getters: true }),
        JSON.stringify(client),
        String(client),
        `${client}`,
        Object.getOwnPropertyNames(client).map((name) => String((client as unknown as Record<string, unknown>)[name])),
      );
    }
  });
});

describe('stack key through the middlewares', () => {
  it('createPaymentMiddleware (Express) passes stackKey to its client', async () => {
    const calls = stubFetch();
    const middleware = createPaymentMiddleware(
      () => ({ amount: '1.00', recipient: PAY_TO, resource: RESOURCE, chainName: 'base' }),
      { retries: 0, stackKey: KEY },
    );
    const res = {
      headersSent: false,
      getHeader: () => undefined,
      set: () => undefined,
      status: () => ({ json: () => undefined, set: () => ({ json: () => undefined }) }),
    };
    const next = vi.fn();
    await middleware({ headers: { 'x-payment': PAYMENT }, method: 'GET', originalUrl: '/data' }, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(calls.map(sent)).toEqual([KEY, KEY]);
  });

  it('createHonoMiddleware passes stackKey to its client', async () => {
    const calls = stubFetch();
    const app = new Hono();
    app.use('/data', createHonoMiddleware({
      accepts: [{ network: 'base', asset: REQUIREMENTS.asset, amount: '1000000', payTo: PAY_TO }],
      retries: 0,
      stackKey: KEY,
    }) as never);
    app.get('/data', (c) => c.json({ premium: true }));
    const response = await app.request(RESOURCE, { headers: { 'X-PAYMENT': PAYMENT } });
    expect(response.status).toBe(200);
    expect(calls.map(sent)).toEqual([KEY, KEY]);
  });
});
