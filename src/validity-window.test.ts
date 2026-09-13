import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';

import { X402Client } from './client/X402Client';
import { EVMProvider } from './providers/evm';
import { getChainByName } from './chains';
import { decodeX402Header } from './utils/x402';
import { DEFAULT_VALIDITY_SECONDS, MAX_VALIDITY_SECONDS } from './utils';
import type { PaymentInfo } from './types';

/**
 * The EIP-3009 validity window: `validBefore = now + validitySeconds`.
 *
 * It used to be 300 s on Base and 60 s everywhere else, written twice — once in
 * `X402Client.createEVMPayment`, once in `EVMProvider.signPayment` — and
 * reachable from neither a config nor a call. A seller that settles async
 * (verify → hand over the resource → settle) then had 60 s on eleven of the
 * twelve EVM networks to land a settlement, minus the facilitator's 6 s
 * clock-skew grace, and an expired authorization makes it revoke access that
 * was genuinely paid for. That is MeshRelay Turnstile's flow, and the payer's
 * SDK was the one deciding the number.
 *
 * These tests pin the three things that fix it:
 *   - the default is 300 s on EVERY network, the same timeout this SDK's own
 *     seller side announces by default;
 *   - it is overridable per client and per payment, the payment winning, and a
 *     client configured with an unsignable window refuses to be built;
 *   - both signing paths read the SAME parameter, so the two surfaces cannot
 *     drift apart again;
 *   - `fetch()` signs the `maxTimeoutSeconds` the seller's 402 declares, clamped
 *     to the payer's ceiling, because signing less than the seller asked for is
 *     an authorization that dies before its settle.
 *
 * La llave se genera en memoria en cada corrida: lo unico que se mide aca son
 * timestamps, ninguna asercion depende de una direccion concreta, y asi el repo
 * no suma otro literal de 64 hex. Nunca escribir una llave en este archivo.
 */
const PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;

const PAY_TO = '0x000000000000000000000000000000000000dEaD';

/** A payment on a network that is NOT Base, which is where 60 s used to live. */
function payment(over: Partial<PaymentInfo> = {}): PaymentInfo {
  return { recipient: PAY_TO, amount: '1.00', ...over };
}

async function connectedClient(
  chain: string,
  config: ConstructorParameters<typeof X402Client>[0] = {}
) {
  const client = new X402Client({ defaultChain: chain, ...config });
  await client.connectWithPrivateKey(PRIVATE_KEY, chain);
  return client;
}

/**
 * `EVMProvider` connects through `window.ethereum`, which no test has. The
 * wallet it would end up holding is an `ethers.Signer` plus its address, and
 * signing typed data needs neither a browser nor a network.
 */
function providerWithWallet(): EVMProvider {
  const provider = new EVMProvider();
  const wallet = new ethers.Wallet(PRIVATE_KEY);
  Object.assign(provider, { signer: wallet, address: wallet.address });
  return provider;
}

/**
 * Seconds between "now" and the `validBefore` that was just signed.
 *
 * Measured against the clock instead of a frozen time so the assertion sees the
 * real arithmetic; a signature takes milliseconds, hence the 1 s slack.
 */
function windowOf(validBefore: number | string): number {
  return Number(validBefore) - Math.floor(Date.now() / 1000);
}

function expectWindow(validBefore: number | string, seconds: number): void {
  const actual = windowOf(validBefore);
  // 3 s of slack, not 1: signing is local and takes milliseconds, but a slow
  // tick on a loaded CI runner must not paint this red. The gaps this test
  // discriminates (60 vs 300, 300 vs 900) are two orders of magnitude wider.
  expect(actual).toBeGreaterThanOrEqual(seconds - 3);
  expect(actual).toBeLessThanOrEqual(seconds);
}

/** `validBefore` out of an X-PAYMENT header the client just built. */
function signedValidBefore(paymentHeader: string): string {
  const decoded = decodeX402Header(paymentHeader) as {
    payload: { authorization: { validBefore: string } };
  };
  return decoded.payload.authorization.validBefore;
}

describe('X402Client — EIP-3009 validity window', () => {
  it('signs 300 s on a network that is not Base', async () => {
    // RED before this change: avalanche got 60.
    const client = await connectedClient('avalanche');

    const result = await client.createPayment(payment());

    expectWindow(signedValidBefore(result.paymentHeader), 300);
  });

  it('keeps the 300 s Base already had', async () => {
    const client = await connectedClient('base');

    const result = await client.createPayment(payment());

    expectWindow(signedValidBefore(result.paymentHeader), 300);
  });

  it('exports the default it signs with, so a consumer need not re-type 300', async () => {
    const client = await connectedClient('avalanche');

    const result = await client.createPayment(payment());

    expectWindow(signedValidBefore(result.paymentHeader), DEFAULT_VALIDITY_SECONDS);
  });

  it('signs the window the client was configured with', async () => {
    const client = await connectedClient('avalanche', { validitySeconds: 900 });

    const result = await client.createPayment(payment());

    expectWindow(signedValidBefore(result.paymentHeader), 900);
  });

  it('lets one payment override the client default', async () => {
    const client = await connectedClient('avalanche', { validitySeconds: 900 });

    const result = await client.createPayment(payment({ validitySeconds: 1800 }));

    expectWindow(signedValidBefore(result.paymentHeader), 1800);
  });

  it('refuses a window that is not a positive whole number of seconds', async () => {
    const client = await connectedClient('avalanche');

    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        client.createPayment(payment({ validitySeconds: bad }))
      ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }
  });

  it('refuses to BUILD a client configured with an unsignable window, not on its first payment', () => {
    for (const bad of [-300, 0, 1.5, Number.NaN, MAX_VALIDITY_SECONDS + 1]) {
      let thrown: unknown;
      try {
        new X402Client({ validitySeconds: bad });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'INVALID_CONFIG' });
    }

    expect(() => new X402Client({ validitySeconds: MAX_VALIDITY_SECONDS })).not.toThrow();
    expect(() => new X402Client({})).not.toThrow();
  });

  it('signs the longest window it allows', async () => {
    const client = await connectedClient('avalanche');

    const result = await client.createPayment(
      payment({ validitySeconds: MAX_VALIDITY_SECONDS })
    );

    expectWindow(signedValidBefore(result.paymentHeader), MAX_VALIDITY_SECONDS);
  });

  it('refuses a window longer than the ceiling, so a seller cannot ask for a standing claim', async () => {
    // `PaymentInfo` is shaped like a parsed 402, and an integrator that feeds
    // one straight in would hand the SELLER this field. A year-long window is
    // an authorization the payer believes expired, settleable months later.
    const client = await connectedClient('avalanche');

    for (const tooLong of [MAX_VALIDITY_SECONDS + 1, 31_536_000, 1e30]) {
      await expect(
        client.createPayment(payment({ validitySeconds: tooLong }))
      ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }
  });
});

describe('EVMProvider.signPayment — EIP-3009 validity window', () => {
  it('signs 300 s on a network that is not Base', async () => {
    // RED before this change: avalanche got 60.
    const provider = providerWithWallet();
    const chain = getChainByName('avalanche')!;

    const payload = JSON.parse(await provider.signPayment(payment(), chain));

    expectWindow(payload.validBefore, 300);
  });

  it('honours the window the payment asked for', async () => {
    const provider = providerWithWallet();
    const chain = getChainByName('avalanche')!;

    const payload = JSON.parse(
      await provider.signPayment(payment({ validitySeconds: 1800 }), chain)
    );

    expectWindow(payload.validBefore, 1800);
  });

  it('refuses a window that is not a positive whole number of seconds', async () => {
    const provider = providerWithWallet();
    const chain = getChainByName('avalanche')!;

    await expect(
      provider.signPayment(payment({ validitySeconds: 0 }), chain)
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('refuses a window longer than the ceiling, exactly like the client does', async () => {
    const provider = providerWithWallet();
    const chain = getChainByName('avalanche')!;

    await expect(
      provider.signPayment(
        payment({ validitySeconds: MAX_VALIDITY_SECONDS + 1 }),
        chain
      )
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});

describe('the two signing paths read the same parameter', () => {
  /**
   * The bug was one number written twice. This is the test that stays red if
   * somebody edits one site and not the other.
   */
  it('agree on the default and on an override, chain by chain', async () => {
    for (const chainName of ['base', 'avalanche', 'polygon']) {
      const chain = getChainByName(chainName)!;
      const provider = providerWithWallet();
      const client = await connectedClient(chainName);

      for (const seconds of [DEFAULT_VALIDITY_SECONDS, 45]) {
        const info =
          seconds === DEFAULT_VALIDITY_SECONDS
            ? payment()
            : payment({ validitySeconds: seconds });

        const viaProvider = JSON.parse(await provider.signPayment(info, chain));
        const viaClient = await client.createPayment(info);

        expectWindow(viaProvider.validBefore, seconds);
        expectWindow(signedValidBefore(viaClient.paymentHeader), seconds);
      }
    }
  });
});

describe('X402Client.fetch — the window the seller declares in its 402', () => {
  /**
   * The facilitator never rejects a window for being long (`assert_time` only
   * refuses `valid_before < now + 6 s`), so the failure that bites is signing
   * LESS than the seller declared: an authorization that dies before its settle.
   * The seller's `maxTimeoutSeconds` therefore wins over the client's window,
   * clamped to the payer's ceiling.
   *
   * `validAfter` is always 0 in this SDK, so "the window" is measured as
   * `validBefore - now`.
   */
  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  /** Pay a 402 on avalanche that carries `declared`, return the signed `validBefore`. */
  async function paidValidBefore(
    declared: Record<string, unknown>,
    config: ConstructorParameters<typeof X402Client>[0] = {}
  ): Promise<string> {
    const client = await connectedClient('avalanche', config);
    const responses = [
      jsonResponse(402, {
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'avalanche',
            maxAmountRequired: '10000', // 0.01 USDC
            payTo: PAY_TO,
            ...declared,
          },
        ],
      }),
      jsonResponse(200, { ok: true }),
    ];
    const inits: Array<RequestInit | undefined> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init);
      const next = responses.shift();
      if (!next) throw new Error('unexpected extra call');
      return next;
    }) as unknown as typeof globalThis.fetch;

    await client.fetch('https://api.example.com/data', { maxAmount: '1.00', fetchImpl });

    expect(inits).toHaveLength(2);
    const headers = inits[1]?.headers as Record<string, string>;
    return signedValidBefore(headers['X-PAYMENT']);
  }

  it('signs the 120 s the seller declared, not the 300 s default', async () => {
    expectWindow(await paidValidBefore({ maxTimeoutSeconds: 120 }), 120);
  });

  it('signs the 900 s the seller declared: signing 300 would expire before its settle', async () => {
    expectWindow(await paidValidBefore({ maxTimeoutSeconds: 900 }), 900);
  });

  it('signs the 300 s default when the 402 declares no window', async () => {
    expectWindow(await paidValidBefore({}), DEFAULT_VALIDITY_SECONDS);
  });

  it("uses the client's configured window only when the 402 declares none", async () => {
    expectWindow(await paidValidBefore({}, { validitySeconds: 900 }), 900);
    expectWindow(
      await paidValidBefore({ maxTimeoutSeconds: 120 }, { validitySeconds: 900 }),
      120
    );
  });

  it("clamps a declaration above the payer's ceiling instead of refusing to pay", async () => {
    expectWindow(await paidValidBefore({ maxTimeoutSeconds: 7200 }), MAX_VALIDITY_SECONDS);
  });

  it('treats a declaration that is not a number as not declared', async () => {
    expectWindow(await paidValidBefore({ maxTimeoutSeconds: 'soon' }), DEFAULT_VALIDITY_SECONDS);
  });
});
