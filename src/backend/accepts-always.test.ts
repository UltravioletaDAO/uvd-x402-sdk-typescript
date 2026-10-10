import { Wallet } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { create402Response, createHonoMiddleware, createPaymentMiddleware } from './index';
import { X402Client } from '../client/X402Client';
import { CHAIN_ALIASES, SUPPORTED_CHAINS, getChainByName } from '../chains';
import { CAIP2_IDENTIFIERS } from '../types';
import { decodeX402Header, detectX402Version } from '../utils/x402';

/**
 * Every 402 this SDK builds carries `accepts`, also when there is one way to
 * pay, and in v1 as well as v2.
 *
 * `createHonoMiddleware` advertised v1 for a lone accept named without CAIP-2
 * (`skale-base`, the README setup) and wrote that requirement flat at the top
 * of the body, with no `accepts`. A reader that looks for `accepts`, as x402
 * says to, found no terms in it. A lone accept in v2 had no `accepts` either
 * (the list was written only for two or more), and no v1 402 had one, though
 * the x402 v1 402 is `{ x402Version: 1, accepts: [...] }` too.
 *
 * Nothing here leaves the machine: the facilitator is a `fetch` double.
 */

const PAY_TO = '0x000000000000000000000000000000000000dEaD';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SKALE_USDC = '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20';
const RESOURCE = 'https://api.example.com/premium';

/** The networks with no CAIP-2 form: a v2 body cannot name them. */
const NO_CAIP2 = ['xrpl', 'xrpl-testnet', 'xrpl-mainnet'];

type Reply = { body: Record<string, unknown>; status: number };
type HonoOptions = Parameters<typeof createHonoMiddleware>[0];

/** The 402 the middleware answers a request that carries no payment. */
async function challengeOf(options: HonoOptions): Promise<Reply> {
  const middleware = createHonoMiddleware(options);
  return (await middleware(
    { req: { header: () => undefined, url: RESOURCE }, json: (body, status) => ({ body, status }) },
    async () => {}
  )) as Reply;
}

function acceptsOf(body: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  return body.accepts as Array<Record<string, unknown>> | undefined;
}

function oneAccept(network: string, asset = BASE_USDC) {
  return { network, asset, amount: '1000000', payTo: PAY_TO };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createHonoMiddleware: the 402 for one accept', () => {
  it('the README setup, one skale-base accept, answers v2 with that accept in accepts', async () => {
    const extra = { name: 'Bridged USDC (SKALE Bridge)', version: '2' };
    const { status, body } = await challengeOf({
      accepts: [{ ...oneAccept('skale-base', SKALE_USDC), extra }],
    });

    expect(status).toBe(402);
    expect(body.x402Version).toBe(2);
    expect(acceptsOf(body)).toEqual([
      {
        scheme: 'exact',
        network: 'eip155:1187947933',
        asset: SKALE_USDC,
        amount: '1000000',
        payTo: PAY_TO,
        resource: RESOURCE,
        description: 'Payment required',
        mimeType: 'application/json',
        maxTimeoutSeconds: 300,
        extra,
      },
    ]);
    // The flat fields stay beside it, written in the version the body declares:
    // the network is the CAIP-2 id, no longer the plain name.
    expect(body.network).toBe('eip155:1187947933');
    expect(body.maxAmountRequired).toBe('1000000');
    expect(body.payTo).toBe(PAY_TO);
    expect(body.paymentRequirements).toBeUndefined();
  });

  it('an accept already in CAIP-2 was v2 without accepts; it now has them', async () => {
    const { body } = await challengeOf({ accepts: [oneAccept('eip155:8453')] });

    expect(body.x402Version).toBe(2);
    expect(acceptsOf(body)).toHaveLength(1);
    expect(acceptsOf(body)?.[0]?.network).toBe('eip155:8453');
  });

  it('every registered network with a CAIP-2 form goes out in v2, in CAIP-2, in accepts', async () => {
    const names = [...Object.keys(SUPPORTED_CHAINS), ...Object.keys(CHAIN_ALIASES), 'BASE', 'Skale-Base'];
    const checked: string[] = [];
    for (const name of names) {
      if (NO_CAIP2.includes(name)) continue;
      const { body } = await challengeOf({ accepts: [oneAccept(name)] });
      const accepts = acceptsOf(body);

      expect(body.x402Version, name).toBe(2);
      expect(accepts, name).toHaveLength(1);
      // The registry's id for the chain, read from the table itself.
      expect(accepts?.[0]?.network, name).toBe(CAIP2_IDENTIFIERS[getChainByName(name)!.name]);
      expect(String(accepts?.[0]?.network), name).toContain(':');
      expect(accepts?.[0]?.network, name).toBe(body.network);
      checked.push(name);
    }
    // Hedera's aliases included; a list that shrank to nothing would pass the loop.
    expect(checked).toEqual(expect.arrayContaining(['base', 'skale-base', 'solana', 'stellar', 'hedera', 'BASE']));
    expect(checked.length).toBeGreaterThan(25);
  });

  it('a lone XRPL accept stays v1, since v2 cannot name the network, and carries accepts in the v1 shape', async () => {
    for (const name of NO_CAIP2) {
      const { body } = await challengeOf({ accepts: [oneAccept(name, 'XRP')] });

      expect(body.x402Version, name).toBe(1);
      expect(body.network, name).toBe(name);
      expect(acceptsOf(body), name).toEqual([
        {
          scheme: 'exact',
          network: name,
          maxAmountRequired: '1000000',
          resource: RESOURCE,
          description: 'Payment required',
          mimeType: 'application/json',
          payTo: PAY_TO,
          asset: 'XRP',
          maxTimeoutSeconds: 300,
        },
      ]);
    }
  });

  it('x402Version: 1, pinned, stays v1 and carries in accepts the requirement the body already had', async () => {
    const { body } = await challengeOf({
      accepts: [oneAccept('base'), { ...oneAccept('eip155:137'), amount: '500000' }],
      x402Version: 1,
    });
    const { x402Version, accepts, ...flat } = body;

    expect(x402Version).toBe(1);
    expect(flat.network).toBe('base');
    // Only the flat one, as the v1 body showed before: listing the cheaper
    // polygon accept would move a buyer that picks the cheapest offer to it.
    expect(accepts).toEqual([flat]);
  });

  it('two accepts stay v2 whatever their networks, as before', async () => {
    for (const networks of [['xrpl', 'base'], ['xrpl', 'xrpl-testnet']]) {
      const { body } = await challengeOf({ accepts: networks.map((network) => oneAccept(network, 'XRP')) });

      expect(body.x402Version, networks.join()).toBe(2);
      expect(acceptsOf(body), networks.join()).toHaveLength(2);
    }
  });
});

describe('create402Response and createPaymentMiddleware', () => {
  const requirement = {
    amount: '1.00',
    recipient: PAY_TO,
    resource: RESOURCE,
    chainName: 'base',
  };

  it('v2 with one requirement carries it in accepts', () => {
    const { body } = create402Response({ ...requirement, x402Version: 2 });

    expect(body.x402Version).toBe(2);
    expect(acceptsOf(body)).toHaveLength(1);
    expect(acceptsOf(body)?.[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '1000000',
      payTo: PAY_TO,
    });
  });

  it('keeps its version rule: unpinned it is still v1, now with the requirement in accepts', () => {
    const { body } = create402Response(requirement);
    const { x402Version, accepts, ...flat } = body;

    expect(x402Version).toBe(1);
    expect(flat.network).toBe('base');
    expect(flat.maxAmountRequired).toBe('1000000');
    expect(accepts).toEqual([flat]);
  });

  it('the Express middleware answers with that 402', async () => {
    const middleware = createPaymentMiddleware(() => requirement);
    const sent: { status?: number; body?: Record<string, unknown> } = {};
    const res = {
      status: (code: number) => {
        sent.status = code;
        const json = (body: unknown) => {
          sent.body = body as Record<string, unknown>;
        };
        return { json, set: () => ({ json }) };
      },
    };

    await middleware({ headers: {} }, res, () => {});

    expect(sent.status).toBe(402);
    expect(sent.body?.x402Version).toBe(1);
    expect(acceptsOf(sent.body ?? {})).toHaveLength(1);
    expect(acceptsOf(sent.body ?? {})?.[0]).toMatchObject({ network: 'base', maxAmountRequired: '1000000', payTo: PAY_TO });
  });
});

describe('detectX402Version reads the declared version of a v1 402 with accepts', () => {
  const v1Spec = {
    x402Version: 1,
    accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '1000000', payTo: PAY_TO, asset: BASE_USDC }],
  };

  it('a declared 1 with accepts is 1, as body and as PAYMENT-REQUIRED header', () => {
    expect(detectX402Version(v1Spec)).toBe(1);
    expect(detectX402Version(Buffer.from(JSON.stringify(v1Spec), 'utf8').toString('base64'))).toBe(1);
  });

  it("this SDK's own 402s read as the version they declare", async () => {
    expect(detectX402Version(create402Response({ amount: '1.00', recipient: PAY_TO, resource: RESOURCE }).body)).toBe(1);
    expect(detectX402Version((await challengeOf({ accepts: [oneAccept('xrpl', 'XRP')] })).body)).toBe(1);
    expect(detectX402Version((await challengeOf({ accepts: [oneAccept('base')] })).body)).toBe(2);
  });

  it('accepts with no declared version, or a declared 1 with a CAIP-2 network, still reads as 2, as before', () => {
    expect(detectX402Version({ accepts: v1Spec.accepts })).toBe(2);
    expect(detectX402Version({ ...v1Spec, network: 'eip155:999999' })).toBe(2);
  });
});

describe('a buyer pays the one-accept 402', () => {
  type Ctx = Parameters<ReturnType<typeof createHonoMiddleware>>[0];

  /** A facilitator double that admits everything and records what it was sent. */
  function facilitatorDouble() {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        const answer = String(url).endsWith('/verify')
          ? { isValid: true }
          : { success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'base' };
        return new Response(JSON.stringify(answer), { status: 200 });
      })
    );
    return calls;
  }

  /** Serve `middleware` to the buyer's fetch, then a 200 from the handler. */
  function serve(middleware: ReturnType<typeof createHonoMiddleware>) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const ctx: Ctx = {
        req: { header: (name) => headers.get(name) ?? undefined, url: String(url), method: 'GET' },
        json: (body, status) =>
          new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
        set: () => {},
      };
      let served: Response | undefined;
      const answered = await middleware(ctx, async () => {
        served = new Response(JSON.stringify({ data: 'paid' }), { status: 200 });
      });
      return (answered as Response | undefined) ?? served;
    }) as typeof globalThis.fetch;
  }

  it('the SDK client reads accepts, pays in v2, and the seller verifies in the v2 envelope', async () => {
    const calls = facilitatorDouble();
    const middleware = createHonoMiddleware({
      accepts: [{ network: 'base', asset: BASE_USDC, amount: '10000', payTo: PAY_TO }],
      retries: 0,
    });
    const client = new X402Client({ defaultChain: 'base' });
    // A key made for this run: it signs for a facilitator double, nothing else.
    await client.connectWithPrivateKey(Wallet.createRandom().privateKey, 'base');

    const seen: Array<Record<string, string>> = [];
    const fetchImpl = serve(middleware);
    const res = await client.fetch(RESOURCE, {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
        return fetchImpl(url, init);
      }) as typeof globalThis.fetch,
    });

    expect(res.status).toBe(200);
    const paid = decodeX402Header(seen[1]['x-payment']);
    expect(paid.x402Version).toBe(2);
    expect(paid.network).toBe('eip155:8453');

    const verify = calls.find((call) => call.url.endsWith('/verify'))?.body;
    expect(verify?.paymentRequirements).toBeUndefined();
    expect(verify?.accepted).toMatchObject({
      scheme: 'exact',
      network: 'eip155:8453',
      asset: BASE_USDC,
      amount: '10000',
      payTo: PAY_TO,
    });
  });

  it('the SDK client pays a pinned v1 402 in v1, on the accept it paid before, verified in the v1 envelope', async () => {
    const calls = facilitatorDouble();
    // A cheaper second accept on another chain: the v1 402 never showed it, and
    // the client, which takes the cheapest offer listed, must not move to it.
    const middleware = createHonoMiddleware({
      accepts: [
        { network: 'base', asset: BASE_USDC, amount: '10000', payTo: PAY_TO },
        { network: 'polygon', asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', amount: '5000', payTo: PAY_TO },
      ],
      x402Version: 1,
      retries: 0,
    });
    const client = new X402Client({ defaultChain: 'base' });
    await client.connectWithPrivateKey(Wallet.createRandom().privateKey, 'base');

    const seen: Array<Record<string, string>> = [];
    const fetchImpl = serve(middleware);
    const res = await client.fetch(RESOURCE, {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
        return fetchImpl(url, init);
      }) as typeof globalThis.fetch,
    });

    expect(res.status).toBe(200);
    const paid = decodeX402Header(seen[1]['x-payment']);
    expect(paid.x402Version).toBe(1);
    expect(paid.network).toBe('base');
    const verify = calls.find((call) => call.url.endsWith('/verify'))?.body;
    expect(verify?.x402Version).toBe(1);
    expect(verify?.paymentRequirements).toMatchObject({ network: 'base', maxAmountRequired: '10000', payTo: PAY_TO });
  });

  it('a v1 payment to a one-accept seller now advertised in v2 is verified in the v1 envelope, as before', async () => {
    const calls = facilitatorDouble();
    const middleware = createHonoMiddleware({
      accepts: [{ network: 'base', asset: BASE_USDC, amount: '10000', payTo: PAY_TO }],
      retries: 0,
    });
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'base',
        payload: {
          signature: '0xdead',
          authorization: {
            from: '0x0000000000000000000000000000000000000001',
            to: PAY_TO,
            value: '10000',
            validAfter: '0',
            validBefore: '9999999999',
            nonce: `0x${'11'.repeat(32)}`,
          },
        },
      }),
      'utf8'
    ).toString('base64');

    const res = await serve(middleware)(RESOURCE, { headers: { 'X-PAYMENT': header } });

    expect(res.status).toBe(200);
    const verify = calls.find((call) => call.url.endsWith('/verify'))?.body;
    expect(verify?.x402Version).toBe(1);
    expect(verify?.paymentRequirements).toMatchObject({ network: 'base', maxAmountRequired: '10000', payTo: PAY_TO });
  });
});
