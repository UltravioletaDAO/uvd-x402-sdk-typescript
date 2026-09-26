/**
 * Stack key on the one-off calls to the facilitator that are functions, not
 * clients: anchorEvidence and availableBackends (DX402), streamTrafficEvents
 * and getFacilitatorReceipt. The same gate, the same check and the same
 * redirect guard as the clients.
 *
 * For each one: the key reaches the house facilitator, never a host outside
 * the list, and never a host a 30x points to. The 30x cases run against real
 * servers on this machine: "casa" (127.0.0.1, listed) redirects everything to
 * "ajeno" (localhost, not listed), which records whether the key arrived.
 * Every key is synthetic.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { x25519 } from '@noble/curves/ed25519';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { anchorEvidence, availableBackends } from '../dx402';
import { streamTrafficEvents } from '../events';
import { getFacilitatorReceipt } from '../receipts';
import { STACK_KEY_HEADER, StackKeyRedirectError } from './stack-key';

const BODY = 'synthetic-function-key_'.repeat(3);
const KEY = `uvdsk_${BODY}`;
const HOUSE_HOST = 'facilitator.ultravioletadao.xyz';
const OTHER = 'https://facilitator.example';
const RECEIPT_ID = '00000000-0000-4000-8000-000000000000';
const CONTEXT = { purchaseId: 'purchase-1', accessToken: 'synthetic-access-token' };

type Seen = { url: string; key: string | undefined; redirect: RequestRedirect | undefined; headers: Record<string, string> };

/** A `fetch` double that records what each request carried. */
function recorder(): { seen: Seen[]; fetch: typeof fetch } {
  const seen: Seen[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = { ...(init.headers as Record<string, string>) };
    seen.push({ url, key: headers[STACK_KEY_HEADER], redirect: init.redirect, headers });
    return new Response(JSON.stringify({ backends: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { seen, fetch: impl as unknown as typeof fetch };
}

const anchorOptions = () => ({
  paymentId: 'payment-1',
  network: 'base',
  txHash: '0x' + '33'.repeat(32),
  payer: '0x0000000000000000000000000000000000000001',
  payee: '0x0000000000000000000000000000000000000002',
  payerKey: x25519.getPublicKey(x25519.utils.randomPrivateKey()),
});
const body = () => new TextEncoder().encode('evidence');

/** Each function, called once against `facilitator` (undefined = its default). */
const CALLS: Array<[string, (facilitator: string | undefined, key: Record<string, unknown>, fetchImpl: typeof fetch) => Promise<unknown>]> = [
  ['anchorEvidence', (facilitator, key, fetchImpl) =>
    anchorEvidence(body(), { ...anchorOptions(), ...(facilitator ? { facilitator } : {}), ...key, fetch: fetchImpl })],
  ['availableBackends', (facilitator, key, fetchImpl) =>
    facilitator ? availableBackends(facilitator, { ...key, fetch: fetchImpl }) : availableBackends(undefined, { ...key, fetch: fetchImpl })],
  ['streamTrafficEvents', async (facilitator, key, fetchImpl) => {
    vi.stubGlobal('fetch', fetchImpl);
    try {
      return await streamTrafficEvents({ ...(facilitator ? { facilitatorUrl: facilitator } : {}), ...key }).next();
    } finally {
      vi.unstubAllGlobals();
    }
  }],
  ['getFacilitatorReceipt', (facilitator, key, fetchImpl) =>
    getFacilitatorReceipt(RECEIPT_ID, CONTEXT, { ...(facilitator ? { issuer: facilitator } : {}), ...key, fetchImpl })],
];

const ENV = 'UVD_STACK_KEY';
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env[ENV];
  delete process.env[ENV];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('stack key on the facilitator functions', () => {
  for (const [name, call] of CALLS) {
    it(`${name}: the key reaches the house facilitator, and only without redirects`, async () => {
      const { seen, fetch } = recorder();
      await call(undefined, { stackKey: KEY }, fetch).catch(() => undefined);
      expect(seen).toHaveLength(1);
      expect(new URL(seen[0].url).hostname).toBe(HOUSE_HOST);
      expect([seen[0].key, seen[0].redirect]).toEqual([KEY, 'manual']);
      // What the call already sent is still there.
      if (name === 'getFacilitatorReceipt') expect(seen[0].headers.Authorization).toBe(`Bearer ${CONTEXT.accessToken}`);

      // From the environment, the same.
      process.env[ENV] = `\uFEFF${KEY}\r\n`;
      const fromEnv = recorder();
      await call(undefined, {}, fromEnv.fetch).catch(() => undefined);
      expect([fromEnv.seen[0].key, fromEnv.seen[0].redirect]).toEqual([KEY, 'manual']);
    });

    it(`${name}: the key never reaches a host outside the list`, async () => {
      for (const key of [{ stackKey: KEY }, { stackKey: KEY, stackKeyHosts: ['other.example'] }]) {
        const { seen, fetch } = recorder();
        await call(OTHER, key, fetch).catch(() => undefined);
        expect(seen.map((s) => [s.key, s.redirect])).toEqual([[undefined, undefined]]);
      }
      process.env[ENV] = KEY;
      const fromEnv = recorder();
      await call(OTHER, {}, fromEnv.fetch).catch(() => undefined);
      expect(fromEnv.seen.map((s) => s.key)).toEqual([undefined]);
      // Without a key the request is exactly what it was.
      delete process.env[ENV];
      const none = recorder();
      await call(undefined, {}, none.fetch).catch(() => undefined);
      expect(none.seen.map((s) => [s.key, s.redirect])).toEqual([[undefined, undefined]]);
    });
  }
});

describe('stack key on the facilitator functions: redirects', () => {
  let casa: http.Server;
  let ajeno: http.Server;
  let casaUrl = '';
  let ajenoUrl = '';
  const atAjeno: boolean[] = [];

  beforeAll(async () => {
    ajeno = http.createServer((req, res) => {
      atAjeno.push(req.headers['x-uvd-stack-key'] === KEY);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ backends: [] }));
      });
    });
    await new Promise<void>((r) => ajeno.listen(0, '::', r));
    ajenoUrl = `http://localhost:${(ajeno.address() as AddressInfo).port}`;
    casa = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(307, { Location: `${ajenoUrl}${req.url}` });
        res.end();
      });
    });
    await new Promise<void>((r) => casa.listen(0, '127.0.0.1', r));
    casaUrl = `http://127.0.0.1:${(casa.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => casa.close(() => r()));
    await new Promise<void>((r) => ajeno.close(() => r()));
  });

  const listed = { stackKey: KEY, stackKeyHosts: ['127.0.0.1'] };

  it('control: called directly, ajeno is refused by the gate', async () => {
    atAjeno.length = 0;
    await anchorEvidence(body(), { ...anchorOptions(), facilitator: ajenoUrl, ...listed });
    await availableBackends(ajenoUrl, listed);
    await streamTrafficEvents({ facilitatorUrl: ajenoUrl, ...listed }).next().catch(() => undefined);
    await getFacilitatorReceipt(RECEIPT_ID, CONTEXT, { issuer: ajenoUrl, ...listed }).catch(() => undefined);
    expect(atAjeno).toEqual([false, false, false, false]);
  });

  it('anchorEvidence: a 307 from casa never carries the key, and the skip names it', async () => {
    atAjeno.length = 0;
    const result = await anchorEvidence(body(), { ...anchorOptions(), facilitator: casaUrl, ...listed });
    expect(result).toMatchObject({ v: 1, skipped: 'anchor_failed', status: 307 });
    expect(String(result.error)).toContain('the stack key does not follow redirects');
    expect(JSON.stringify(result)).not.toContain(BODY.slice(0, 12));
    expect(atAjeno).toEqual([]);
  });

  it('availableBackends: a 307 from casa never carries the key', async () => {
    atAjeno.length = 0;
    expect(await availableBackends(casaUrl, listed)).toEqual([]);
    expect(atAjeno).toEqual([]);
  });

  it('streamTrafficEvents: a 307 from casa never carries the key, and throws', async () => {
    atAjeno.length = 0;
    const thrown = await streamTrafficEvents({ facilitatorUrl: casaUrl, ...listed }).next().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(StackKeyRedirectError);
    expect(atAjeno).toEqual([]);
  });

  it('getFacilitatorReceipt: a 307 from casa never carries the key (nor the access token), and throws', async () => {
    atAjeno.length = 0;
    const thrown = await getFacilitatorReceipt(RECEIPT_ID, CONTEXT, { issuer: casaUrl, ...listed }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(StackKeyRedirectError);
    expect(atAjeno).toEqual([]);
  });
});
