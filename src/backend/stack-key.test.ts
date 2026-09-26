/**
 * Stack key: `X-UVD-Stack-Key` on the facilitator calls of a service run by
 * Ultravioleta DAO.
 *
 * The contract the SDK needs: the key is `uvdsk_` followed by 43-128 base64url
 * characters, it travels on every call a client of this SDK makes to the
 * facilitator, and a facilitator that does not know it ignores it. What is
 * pinned here is the SDK's own rules on top: a key that was read badly never
 * breaks a payment, the key only travels to a house facilitator, and it never
 * shows up anywhere but in that header.
 *
 * Every key below is synthetic, built in this file. Every facilitator is a
 * double -- a stubbed `fetch` or a server on 127.0.0.1; nothing leaves the
 * machine, including the calls "to" facilitator.ultravioletadao.xyz.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AdvancedEscrowClient,
  BazaarClient,
  Erc8004Client,
  EscrowClient,
  FacilitatorClient,
  createHonoMiddleware,
  createPaymentMiddleware,
} from './index';
import type { AdvancedPaymentInfo, PaymentRequirements } from './index';
import type { X402Header } from '../types';
import { STACK_KEY_HEADER, StackKeyRedirectError, bindStackKey, stackKeyFetch } from './stack-key';

/** Synthetic, and recognisable wherever it might leak. */
const BODY = 'synthetic-test-key_'.repeat(3);
const KEY = `uvdsk_${BODY}`;
const OTHER_BODY = 'another-synthetic-key_'.repeat(2);
const OTHER_KEY = `uvdsk_${OTHER_BODY}`;

const HOUSE = 'https://facilitator.ultravioletadao.xyz';

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

/** An escrow payment on Base, as the escrow tests build it. */
const PI: AdvancedPaymentInfo = {
  operator: '0x271f9fa7f8907aCf178CCFB470076D9129D8F0Eb',
  receiver: '0x2222222222222222222222222222222222222222',
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  maxAmount: '1000000',
  preApprovalExpiry: 1757003600,
  authorizationExpiry: 1757007200,
  refundExpiry: 1759592000,
  minFeeBps: 0,
  maxFeeBps: 1300,
  feeReceiver: '0xaE07cEB6b395BC685a776a0b4c489E8d9cE9A6ad',
  salt: '0x' + '00'.repeat(30) + '3039',
};
/** ethers.Signer mode, signing nothing real: the facilitator is a double. */
const ESCROW_SIGNER = {
  provider: null,
  getAddress: async () => '0x1111111111111111111111111111111111111111',
  signTypedData: async () => '0x' + 'ab'.repeat(65),
};
const escrowClient = (options: ConstructorParameters<typeof AdvancedEscrowClient>[1] = {}) =>
  new AdvancedEscrowClient(ESCROW_SIGNER, { chainId: 8453, retries: 0, ...options });

type Call = { url: string; headers: Record<string, string>; redirect: RequestRedirect | undefined };

/**
 * Stub `fetch` and record the headers EXACTLY as the SDK passed them: a real
 * `Headers` would normalise the value and hide what the SDK did. `answer`
 * replaces the default 200.
 */
function stubFetch(answer: () => Response = () =>
  new Response(JSON.stringify(ANSWER), { status: 200, headers: { 'Content-Type': 'application/json' } })): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) }, redirect: init.redirect });
    return answer();
  }));
  return calls;
}
/** A 30x the way Node's fetch returns it for `redirect: 'manual'`. */
const redirectTo = (status: number) => () => new Response(null, { status, headers: { Location: 'https://elsewhere.example/verify' } });
/** The opaque redirect a browser returns for `redirect: 'manual'`. */
const opaqueRedirect = () => ({ type: 'opaqueredirect', status: 0, ok: false, body: null, headers: new Headers() }) as unknown as Response;
const sent = (call: Call) => call.headers[STACK_KEY_HEADER];

/** Payment through `verify` + `settle`; returns what each carried. */
async function pay(client: FacilitatorClient, calls: Call[]) {
  const verified = await client.verify(HEADER, REQUIREMENTS);
  const settled = await client.settle(HEADER, REQUIREMENTS);
  return { verified, settled, calls: calls.map(sent) };
}

type Routes<C> = Array<[string, (c: C) => Promise<unknown>]>;

/** Every facilitator route of Erc8004Client that writes. */
const WRITES: Routes<Erc8004Client> = [
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
const READS: Routes<Erc8004Client> = [
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

/** FacilitatorClient beyond `/verify` and `/settle`. */
const FACILITATOR_OTHERS: Routes<FacilitatorClient> = [
  ['healthCheck', (c) => c.healthCheck()],
  ['getVersion', (c) => c.getVersion()],
  ['getSupported', (c) => c.getSupported()],
  ['getStats', (c) => c.getStats()],
  ['getTransactions', (c) => c.getTransactions({ limit: 5 })],
  ['getBlacklist', (c) => c.getBlacklist()],
  ['accepts', (c) => c.accepts([REQUIREMENTS])],
];

const BAZAAR: Routes<BazaarClient> = [
  ['listResources', (c) => c.listResources()],
  ['iterateResources', (c) => c.iterateResources().next()],
  ['getResourceByUrl', (c) => c.getResourceByUrl(RESOURCE)],
  ['registerResource', (c) => c.registerResource({ url: RESOURCE } as never)],
  ['getStats', (c) => c.getStats()],
  ['healthCheck', (c) => c.healthCheck()],
  ['discover', (c) => c.discover()],
];

const ESCROW: Routes<EscrowClient> = [
  ['createEscrow', (c) => c.createEscrow({ paymentHeader: PAYMENT, requirements: REQUIREMENTS } as never)],
  ['getEscrow', (c) => c.getEscrow('e1')],
  ['release', (c) => c.release('e1')],
  ['requestRefund', (c) => c.requestRefund({ escrowId: 'e1', reason: 'r' } as never)],
  ['approveRefund', (c) => c.approveRefund('r1')],
  ['rejectRefund', (c) => c.rejectRefund('r1', 'no')],
  ['getRefund', (c) => c.getRefund('r1')],
  ['openDispute', (c) => c.openDispute('e1', 'reason' as never)],
  ['submitEvidence', (c) => c.submitEvidence('d1', 'evidence')],
  ['getDispute', (c) => c.getDispute('d1')],
  ['listEscrows', (c) => c.listEscrows({})],
  ['getEscrowState', (c) => c.getEscrowState({} as never)],
  ['healthCheck', (c) => c.healthCheck()],
];

const ADVANCED_ESCROW: Routes<AdvancedEscrowClient> = [
  ['authorize', (c) => c.authorize(PI)],
  ['releaseViaFacilitator', (c) => c.releaseViaFacilitator(PI)],
  ['refundViaFacilitator', (c) => c.refundViaFacilitator(PI, '250000')],
  ['queryEscrowState', (c) => c.queryEscrowState(PI)],
];

/** Call each route once; the answer does not matter, only what went out. */
async function callEach<C>(client: C, routes: Routes<C>, calls: Call[]) {
  const out: Array<[string, string | undefined]> = [];
  for (const [name, call] of routes) {
    const before = calls.length;
    await call(client).catch(() => undefined);
    expect(calls.length, `${name} made no request`).toBe(before + 1);
    out.push([name, sent(calls[before])]);
  }
  return out;
}
const everyOne = <C>(routes: Routes<C>, key: string | undefined) => routes.map(([name]) => [name, key]);

/** One facilitator call per client class, each built with `options`. */
async function oneCallPerClient(options: { baseUrl: string; stackKey?: string; stackKeyHosts?: string[] }, calls: Call[]) {
  const { baseUrl, ...key } = options;
  return [
    ...(await callEach(new FacilitatorClient({ baseUrl, retries: 0, ...key }), [['verify', (c) => c.verify(HEADER, REQUIREMENTS)]], calls)),
    ...(await callEach(new Erc8004Client({ baseUrl, retries: 0, ...key }), [READS[0], WRITES[0]], calls)),
    ...(await callEach(new BazaarClient({ baseUrl, ...key }), [BAZAAR[4]], calls)),
    ...(await callEach(new EscrowClient({ baseUrl, ...key }), [ESCROW[1]], calls)),
    ...(await callEach(escrowClient({ facilitatorUrl: baseUrl, ...key }), [ADVANCED_ESCROW[1], ADVANCED_ESCROW[3]], calls)),
  ];
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
    expect(out).toEqual(everyOne(WRITES, KEY));
  });

  it('every ERC-8004 facilitator read carries the key', async () => {
    const calls = stubFetch();
    const out = await callEach(new Erc8004Client({ stackKey: KEY }), READS, calls);
    expect(out).toEqual(everyOne(READS, KEY));
  });

  it('resolveAgentUri never carries it: that URI is not the facilitator', async () => {
    const calls = stubFetch();
    const client = new Erc8004Client({ stackKey: KEY });
    await client.resolveAgentUri('https://agent.example/registration.json');
    // Not even when the agent's file happens to live on the house host: the
    // gate would let the key through, so what keeps it off is this call.
    await client.resolveAgentUri(`${HOUSE}/agents/1/registration.json`);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect([STACK_KEY_HEADER in call.headers, call.redirect]).toEqual([false, undefined]);
  });

  it('no key configured: no header, anywhere', async () => {
    const calls = stubFetch();
    await pay(new FacilitatorClient({ retries: 0 }), calls);
    await callEach(new FacilitatorClient({ retries: 0 }), FACILITATOR_OTHERS, calls);
    await callEach(new Erc8004Client({ retries: 0 }), [...WRITES, ...READS], calls);
    await callEach(new BazaarClient(), BAZAAR, calls);
    await callEach(new EscrowClient({ baseUrl: HOUSE }), ESCROW, calls);
    await callEach(escrowClient(), ADVANCED_ESCROW, calls);
    expect(calls).toHaveLength(2 + FACILITATOR_OTHERS.length + WRITES.length + READS.length
      + BAZAAR.length + ESCROW.length + ADVANCED_ESCROW.length);
    for (const call of calls) expect(STACK_KEY_HEADER in call.headers).toBe(false);
  });

  it('a key read with a trailing \\r\\n (or other surrounding whitespace) goes out trimmed', async () => {
    for (const raw of [`${KEY}\r\n`, `${KEY}\n`, `  ${KEY}\t`, `\uFEFF${KEY}\r\n`]) {
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
    expect(() => fresh.bindStackKey(a, { stackKey: `uvdsk_${BODY.slice(0, 20)}\r\n${BODY.slice(20)}` })).not.toThrow();
    expect(() => fresh.bindStackKey(b, { stackKey: `sk_${OTHER_BODY}` })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expectNoKey(...warn.mock.calls.flat());
    expect(String(warn.mock.calls[0][0])).toContain('stackKey option');
    const calls = stubFetch();
    await fresh.stackKeyFetch(a, `${HOUSE}/verify`, { headers: { Accept: 'application/json' } });
    await fresh.stackKeyFetch(b, `${HOUSE}/verify`);
    expect(calls.map((c) => c.headers)).toEqual([{ Accept: 'application/json' }, {}]);
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
    // The double is listed, so what keeps the broken key off the wire is the
    // format check and nothing else.
    const local = { baseUrl: double.baseUrl, retries: 0, stackKeyHosts: ['127.0.0.1'] };
    try {
      // Node's fetch throws on this value -- with the value in the message --
      // before anything is sent. The SDK must never hand it over.
      const broken = `uvdsk_${BODY.slice(0, 20)}\n${BODY.slice(20)}`;
      const client = new FacilitatorClient({ ...local, stackKey: broken });
      const result = await client.verifyAndSettle(HEADER, REQUIREMENTS);
      expect(result).toMatchObject({ verified: true, settled: true, transactionHash: TX });
      expectNoKey(result);
      expect(double.received).toEqual([undefined, undefined]);

      // A trailing \r\n reaches the wire as the key itself.
      double.received.length = 0;
      const trimmed = new FacilitatorClient({ ...local, stackKey: `${KEY}\r\n` });
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
      new BazaarClient({ stackKey: KEY }),
      new EscrowClient({ baseUrl: HOUSE, stackKey: KEY }),
      escrowClient({ stackKey: KEY }),
      new FacilitatorClient(),
      new Erc8004Client(),
      new BazaarClient(),
      new EscrowClient({ baseUrl: HOUSE }),
      escrowClient(),
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

describe('the key only travels to a house facilitator', () => {
  it('the key reaches https://facilitator.ultravioletadao.xyz', async () => {
    const calls = stubFetch();
    for (const baseUrl of [undefined, HOUSE, `${HOUSE}/`, 'https://FACILITATOR.ultravioletadao.xyz', `${HOUSE}:443`]) {
      const before = calls.length;
      expect((await pay(new FacilitatorClient({ baseUrl, retries: 0, stackKey: KEY }), calls)).calls.slice(before))
        .toEqual([KEY, KEY]);
    }
    expect(new Set(calls.map((c) => new URL(c.url).hostname))).toEqual(new Set(['facilitator.ultravioletadao.xyz']));
    // Every client class, built the same way.
    expect(await oneCallPerClient({ baseUrl: HOUSE, stackKey: KEY }, calls)).toEqual(
      ['verify', 'getIdentity', 'submitFeedback', 'getStats', 'getEscrow', 'releaseViaFacilitator', 'queryEscrowState'].map((name) => [name, KEY]),
    );
  });

  it('the key never reaches another host, neither from the option nor from UVD_STACK_KEY', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const others = [
      'https://facilitator.example',
      'https://facilitator.ultravioletadao.xyz.evil.example', // the house host as a prefix
      'https://evilfacilitator.ultravioletadao.xyz', // ... and as a suffix
      'https://ultravioletadao.xyz',
      'https://escrow.ultravioletadao.xyz', // a house domain, not the facilitator
      'https://127.0.0.1:8443', // not listed
      'not a url',
    ];
    for (const baseUrl of others) {
      const fromOption = stubFetch();
      expect(await oneCallPerClient({ baseUrl, stackKey: KEY }, fromOption)).toEqual(
        ['verify', 'getIdentity', 'submitFeedback', 'getStats', 'getEscrow', 'releaseViaFacilitator', 'queryEscrowState'].map((name) => [name, undefined]),
      );
      process.env[ENV] = KEY;
      const fromEnv = stubFetch();
      for (const [, key] of await oneCallPerClient({ baseUrl }, fromEnv)) expect(key, baseUrl).toBeUndefined();
      delete process.env[ENV];
    }
  });

  it('the key never goes over plain http to the house host', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls = stubFetch();
    for (const stackKeyHosts of [undefined, ['facilitator.ultravioletadao.xyz']]) {
      for (const [, key] of await oneCallPerClient({ baseUrl: 'http://facilitator.ultravioletadao.xyz', stackKey: KEY, stackKeyHosts }, calls)) {
        expect(key).toBeUndefined();
      }
    }
  });

  it('plain http only to 127.0.0.1 or localhost listed in stackKeyHosts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cases: Array<[string, string[] | undefined, string | undefined]> = [
      ['http://127.0.0.1:4021', undefined, undefined], // loopback, not listed
      ['http://localhost:4021', ['127.0.0.1'], undefined], // the other loopback listed
      ['http://127.0.0.1:4021', ['127.0.0.1'], KEY],
      ['http://localhost:4021', [' LocalHost '], KEY],
      ['http://10.0.0.7:4021', ['10.0.0.7'], undefined], // listed, but not loopback
      ['http://facilitator.internal', ['facilitator.internal'], undefined],
    ];
    for (const [baseUrl, stackKeyHosts, expected] of cases) {
      const calls = stubFetch();
      for (const [, key] of await oneCallPerClient({ baseUrl, stackKey: KEY, stackKeyHosts }, calls)) {
        expect(key, `${baseUrl} ${JSON.stringify(stackKeyHosts)}`).toBe(expected);
      }
    }
  });

  it('stackKeyHosts adds hosts: the listed one receives the key and the house facilitator still does', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const staging = 'https://facilitator-staging.example.org';
    const listed = ['  Facilitator-Staging.example.org ', 42, null] as unknown as string[];
    const calls = stubFetch();
    for (const [, key] of await oneCallPerClient({ baseUrl: staging, stackKey: KEY, stackKeyHosts: listed }, calls)) {
      expect(key).toBe(KEY);
    }
    for (const [, key] of await oneCallPerClient({ baseUrl: HOUSE, stackKey: KEY, stackKeyHosts: ['facilitator-staging.example.org'] }, calls)) {
      expect(key).toBe(KEY);
    }
    // Listing a host is not a wildcard: a sibling of it still gets nothing.
    for (const [, key] of await oneCallPerClient({ baseUrl: 'https://staging.example.org', stackKey: KEY, stackKeyHosts: listed }, calls)) {
      expect(key).toBeUndefined();
    }
    // Junk in the list is dropped, never thrown.
    expect(() => new FacilitatorClient({ stackKey: KEY, stackKeyHosts: 'facilitator.example' as never })).not.toThrow();
  });

  it('the host warning comes once, names the host and never the key', async () => {
    vi.resetModules();
    const fresh = await import('./index');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls = stubFetch();

    // No key, no warning: a third party pointed anywhere hears nothing.
    await pay(new fresh.FacilitatorClient({ baseUrl: 'https://facilitator.example', retries: 0 }), calls);
    expect(warn).not.toHaveBeenCalled();

    // Credentials in the base URL stay out of the warning too.
    const withCredentials = 'https://svc:secret-password@facilitator.example/v1?token=secret-token';
    await pay(new fresh.FacilitatorClient({ baseUrl: withCredentials, retries: 0, stackKey: KEY }), calls);
    process.env[ENV] = OTHER_KEY;
    await pay(new fresh.FacilitatorClient({ baseUrl: 'http://facilitator.ultravioletadao.xyz', retries: 0 }), calls);
    new fresh.Erc8004Client({ baseUrl: 'https://other.example' });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('stack key not sent: https://facilitator.example is not a house facilitator');
    expect(message).not.toContain('secret');
    expectNoKey(...warn.mock.calls.flat());
    expect(calls.some((c) => STACK_KEY_HEADER in c.headers)).toBe(false);
  });
});

describe('every client of the facilitator carries the key', () => {
  it('every other FacilitatorClient call carries the key', async () => {
    const calls = stubFetch();
    expect(await callEach(new FacilitatorClient({ stackKey: KEY }), FACILITATOR_OTHERS, calls))
      .toEqual(everyOne(FACILITATOR_OTHERS, KEY));
  });

  it('every BazaarClient call carries the key', async () => {
    const calls = stubFetch();
    expect(await callEach(new BazaarClient({ stackKey: KEY }), BAZAAR, calls)).toEqual(everyOne(BAZAAR, KEY));
  });

  it('every EscrowClient call carries the key, and its default escrow host only when listed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls = stubFetch();
    expect(await callEach(new EscrowClient({ baseUrl: HOUSE, stackKey: KEY, apiKey: 'api-key' }), ESCROW, calls))
      .toEqual(everyOne(ESCROW, KEY));
    // The Authorization header of an authenticated call is still there.
    expect(calls[0].headers.Authorization).toBe('Bearer api-key');

    const defaultHost = stubFetch();
    expect(await callEach(new EscrowClient({ stackKey: KEY }), ESCROW, defaultHost)).toEqual(everyOne(ESCROW, undefined));
    expect(new URL(defaultHost[0].url).hostname).toBe('escrow.ultravioletadao.xyz');
    const listed = stubFetch();
    expect(await callEach(new EscrowClient({ stackKey: KEY, stackKeyHosts: ['escrow.ultravioletadao.xyz'] }), ESCROW, listed))
      .toEqual(everyOne(ESCROW, KEY));
  });

  it('every AdvancedEscrowClient facilitator call carries the key', async () => {
    const calls = stubFetch();
    expect(await callEach(escrowClient({ stackKey: KEY }), ADVANCED_ESCROW, calls)).toEqual(everyOne(ADVANCED_ESCROW, KEY));
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/settle', '/settle', '/settle', '/escrow/state']);
  });
});

/** Every call of every facilitator client, once: 52 requests. */
async function everyCall(key: { stackKey?: string }, calls: Call[]) {
  await pay(new FacilitatorClient({ retries: 0, ...key }), calls);
  await callEach(new FacilitatorClient({ retries: 0, ...key }), FACILITATOR_OTHERS, calls);
  await callEach(new Erc8004Client({ retries: 0, ...key }), [...WRITES, ...READS], calls);
  await callEach(new BazaarClient(key), BAZAAR, calls);
  await callEach(new EscrowClient({ baseUrl: HOUSE, ...key }), ESCROW, calls);
  await callEach(escrowClient(key), ADVANCED_ESCROW, calls);
}

describe('the key never follows a redirect', () => {
  it('every request that carries the key goes out with redirect: manual; without a key, nothing changes', async () => {
    const keyed = stubFetch();
    await everyCall({ stackKey: KEY }, keyed);
    expect(keyed).toHaveLength(52);
    for (const call of keyed) expect([call.url, sent(call), call.redirect]).toEqual([call.url, KEY, 'manual']);

    const plain = stubFetch();
    await everyCall({}, plain);
    for (const call of plain) expect([call.url, STACK_KEY_HEADER in call.headers, call.redirect]).toEqual([call.url, false, undefined]);
  });

  it('a redirect answered to the key is a clear SDK error, and the key goes out once', async () => {
    const answers: Array<[number, () => Response]> = [
      [301, redirectTo(301)], [302, redirectTo(302)], [303, redirectTo(303)], [307, redirectTo(307)], [308, redirectTo(308)],
      [0, opaqueRedirect],
    ];
    for (const [status, answer] of answers) {
      const calls = stubFetch(answer);
      const client = new FacilitatorClient({ retries: 2, stackKey: KEY });
      const thrown = await client.getSupported().catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(StackKeyRedirectError);
      expect((thrown as StackKeyRedirectError).status).toBe(status);
      expect((thrown as Error).message).toContain('the stack key does not follow redirects');

      const verified = await client.verify(HEADER, REQUIREMENTS);
      expect(verified.isValid).toBe(false);
      expect(verified.invalidReason).toContain('the stack key does not follow redirects');
      const settled = await client.settle(HEADER, REQUIREMENTS);
      expect(settled.success).toBe(false);
      expect(settled.error).toContain('the stack key does not follow redirects');
      const feedback = await new Erc8004Client({ retries: 2, stackKey: KEY }).submitFeedback(
        { x402Version: 1, network: 'base', feedback: { agentId: 1, value: 1 } } as never,
      );
      expect(feedback.success).toBe(false);
      const release = await escrowClient({ retries: 2, stackKey: KEY }).releaseViaFacilitator(PI);
      expect(release.success).toBe(false);

      // One request each: no retry, no second attempt, no follow.
      expect(calls).toHaveLength(5);
      expectNoKey(thrown, (thrown as Error).message, verified, settled, feedback, release);
    }
  });

  it('without a key a 3xx is not intercepted: the request is exactly what it was', async () => {
    const calls = stubFetch(redirectTo(302));
    const thrown = await new FacilitatorClient({ retries: 0 }).getSupported().catch((e: unknown) => e);
    expect(thrown).not.toBeInstanceOf(StackKeyRedirectError);
    expect(calls.map((c) => c.redirect)).toEqual([undefined]);
  });

  it('the gate runs on the URL of every request, not once per client', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const owner = {};
    bindStackKey(owner, { stackKey: KEY });
    const calls = stubFetch();
    await stackKeyFetch(owner, `${HOUSE}/verify`, { method: 'POST' });
    await stackKeyFetch(owner, 'https://elsewhere.example/verify', { method: 'POST' });
    await stackKeyFetch(owner, `${HOUSE}/settle`);
    expect(calls.map((c) => [c.url, sent(c), c.redirect])).toEqual([
      [`${HOUSE}/verify`, KEY, 'manual'],
      ['https://elsewhere.example/verify', undefined, undefined],
      [`${HOUSE}/settle`, KEY, 'manual'],
    ]);
  });

  it('before the check: one leading BOM, then spaces, tabs, CR and LF at the edges; nothing else', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sentWith = async (raw: string) => {
      const calls = stubFetch();
      await new FacilitatorClient({ retries: 0, stackKey: raw }).verify(HEADER, REQUIREMENTS);
      return sent(calls[0]);
    };
    for (const raw of [`\uFEFF${KEY}`, `\uFEFF${KEY}\r\n`, ` \t${KEY}\r\n `, `${KEY}\n`, `\r\n${KEY}`]) {
      expect(await sentWith(raw), JSON.stringify(raw.slice(0, 3))).toBe(KEY);
    }
    // A second BOM, a BOM anywhere but first, and other whitespace stay -- and fail the check.
    for (const raw of [`\uFEFF\uFEFF${KEY}`, `${KEY}\uFEFF`, ` \uFEFF${KEY}`, `\u00A0${KEY}`, `${KEY}\u2028`, `\v${KEY}`, `\f${KEY}`]) {
      expect(await sentWith(raw), JSON.stringify(raw.slice(0, 3))).toBeUndefined();
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

  it('both middlewares pass stackKeyHosts to their client', async () => {
    const calls = stubFetch();
    const facilitatorUrl = 'https://facilitator-staging.example.org';
    const middleware = createPaymentMiddleware(
      () => ({ amount: '1.00', recipient: PAY_TO, resource: RESOURCE, chainName: 'base' }),
      { retries: 0, facilitatorUrl, stackKey: KEY, stackKeyHosts: ['facilitator-staging.example.org'] },
    );
    const res = {
      headersSent: false,
      getHeader: () => undefined,
      set: () => undefined,
      status: () => ({ json: () => undefined, set: () => ({ json: () => undefined }) }),
    };
    await middleware({ headers: { 'x-payment': PAYMENT }, method: 'GET', originalUrl: '/data' }, res as never, vi.fn());
    const app = new Hono();
    app.use('/data', createHonoMiddleware({
      accepts: [{ network: 'base', asset: REQUIREMENTS.asset, amount: '1000000', payTo: PAY_TO }],
      retries: 0,
      facilitatorUrl,
      stackKey: KEY,
      stackKeyHosts: ['facilitator-staging.example.org'],
    }) as never);
    app.get('/data', (c) => c.json({ premium: true }));
    expect((await app.request(RESOURCE, { headers: { 'X-PAYMENT': PAYMENT } })).status).toBe(200);
    expect(calls.map(sent)).toEqual([KEY, KEY, KEY, KEY]);
  });
});
