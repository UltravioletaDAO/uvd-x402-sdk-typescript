/**
 * The `502` that must NOT be retried, told apart from the `502` that must.
 *
 * `POST /settle` has exactly two `502`s and they mean opposite things:
 *
 * | body `error`               | `Retry-After` | did the money move?  | retry?    |
 * |----------------------------|---------------|----------------------|-----------|
 * | `upstream_rpc_unavailable` | `30`          | no, never broadcast  | **yes**   |
 * | `settlement_unconfirmed`   | **absent**    | **maybe — mined?**   | **NEVER** |
 *
 * `settlement_unconfirmed` is emitted after the transaction was broadcast and
 * no receipt ever arrived. The transfer MAY be mined. Retrying re-signs a new
 * authorization with a fresh nonce, which the chain accepts as a second,
 * perfectly valid payment for the same purchase — the buyer pays twice, in
 * exactly the case the facilitator change exists to prevent.
 *
 * Branching on the STATUS cannot tell them apart, which is why this SDK used to
 * get it wrong: both are `502`, and the only `502` that existed before carried
 * `Retry-After`, so calling every `502` retryable was reasonable. It is not any
 * more. Branch on the body.
 *
 * Shapes pinned byte-for-byte from x402-rs on branch `0xultravioleta/x4-hash`:
 * `SettlementUnconfirmedResponse` (`src/types.rs:1838` — `error` /
 * `transaction` / `paymentId` / `retryable`) as built at `src/handlers.rs:5119`,
 * and `upstream_rpc_unavailable` + `HeaderValue::from_static("30")` at
 * `src/handlers.rs:5043`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  Erc8004Client,
  Erc8004LookupError,
  FacilitatorClient,
  createHonoMiddleware,
  createPaymentMiddleware,
  facilitatorFetch,
  isSettlementUnconfirmed,
  readFacilitatorError,
  MAX_RETRY_AFTER_SECONDS,
  SETTLEMENT_UNCONFIRMED,
} from './index';
import type { PaymentRequirements } from './index';
import type { X402Header } from '../types';

const TX = '0x' + 'ab'.repeat(32);
const PAYMENT_ID = '0x411fe7c2e9a1b4fbecf94b48cc628d9c69c0752b90bfd313965a3607d322d466';

const HEADER = {
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
} as unknown as X402Header;

const REQUIREMENTS = {
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '1000000',
  resource: 'https://example.test/thing',
  payTo: '0x0000000000000000000000000000000000000002',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
} as unknown as PaymentRequirements;

function encodeHeader(): string {
  return Buffer.from(JSON.stringify(HEADER)).toString('base64');
}

/**
 * The broadcast-but-unconfirmed `502`. No `Retry-After`: deliberate, and the
 * only signal a status-only client would ever have had.
 */
function unconfirmedSettle(transaction = TX, paymentId = PAYMENT_ID) {
  const body = JSON.stringify({
    error: 'settlement_unconfirmed',
    transaction,
    paymentId,
    retryable: false,
  });
  return {
    ok: false,
    status: 502,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** The OTHER `502`: the node never answered, nothing was ever broadcast. */
function upstreamRpcUnavailable() {
  const body = JSON.stringify({
    error: 'upstream_rpc_unavailable (ref: 4f1c8f2e-0d3a-4c1b-9f77-2f4b8a1e6c00)',
  });
  return {
    ok: false,
    status: 502,
    headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? '30' : null) },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readFacilitatorError tells the two 502s apart', () => {
  it('refuses to call an unconfirmed settlement retryable, and keeps its hash', async () => {
    const info = await readFacilitatorError(unconfirmedSettle() as never);

    // THE defect. `true` here is the double-charge: it travels to the
    // middleware, goes out as 503 + Retry-After, and the buyer signs again.
    expect(info.retryable).toBe(false);
    expect(info.safeToReplay).toBe(false);
    // No wait is advertised for something that must never be waited out.
    expect(info.retryAfterSeconds).toBeUndefined();

    // An error that swallows the hash is the same defect one layer up: the
    // hash is the ONLY way the caller can find out whether the money moved.
    expect(info.transaction).toBe(TX);
    expect(info.paymentId).toBe(PAYMENT_ID);
    expect(info.errorCode).toBe(SETTLEMENT_UNCONFIRMED);
    expect(isSettlementUnconfirmed(info)).toBe(true);
  });

  it('CONTROL: the transient 502 stays retryable, with its clamped wait', async () => {
    const info = await readFacilitatorError(upstreamRpcUnavailable() as never);

    // Break this and the happy path is broken: a genuine RPC outage would
    // become a terminal failure on a payment that was never broadcast.
    expect(info.retryable).toBe(true);
    // 30 from the facilitator, clamped — the clamp is the pre-existing rule.
    expect(info.retryAfterSeconds).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(isSettlementUnconfirmed(info)).toBe(false);
  });

  it('stops on the flag alone, even if the code were ever renamed', async () => {
    const body = JSON.stringify({ error: 'something_new', retryable: false });
    const info = await readFacilitatorError({
      status: 502,
      headers: { get: () => null },
      text: async () => body,
    } as never);

    // Two independent reasons to stop: the named code and the explicit flag.
    // A facilitator that states `retryable: false` is answering the question.
    expect(info.retryable).toBe(false);
  });

  it('never UPGRADES a refusal the SDK considers terminal', async () => {
    // A 402 is a rejection. A body claiming otherwise must not make this SDK
    // resend a credential the facilitator refused.
    const body = JSON.stringify({ error: 'invalid_signature', retryable: true });
    const info = await readFacilitatorError({
      status: 402,
      headers: { get: () => null },
      text: async () => body,
    } as never);

    expect(info.retryable).toBe(false);
  });

  it('carries a non-hex hash verbatim', async () => {
    // Algorand prints base32, Solana base58. A client that assumes `0x` makes
    // the hash unpasteable in an explorer, and pasting it is the whole remedy.
    const algorand = 'ZGVBLKQ4KJ2VQKAKWJHNRHM4VJDVYAFTQEBAHK3VLXG5WPTFRRHQ';
    const info = await readFacilitatorError(unconfirmedSettle(algorand, PAYMENT_ID) as never);
    expect(info.transaction).toBe(algorand);
  });
});

describe('facilitatorFetch retry loop', () => {
  it('does not re-POST a settle that may already be mined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(unconfirmedSettle());

    const { error } = await facilitatorFetch(
      'https://facilitator.test/settle',
      { method: 'POST' },
      {
        timeoutMs: 1000,
        retries: 2,
        // Even asked to replay anything, this one must not be replayed: the
        // transfer may be mining right now.
        canReplay: () => true,
        fetchImpl: fetchMock as never,
        sleepImpl: async () => {},
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error?.retryable).toBe(false);
  });

  it('CONTROL: still re-POSTs the transient 502 exactly as before', async () => {
    const fetchMock = vi.fn().mockResolvedValue(upstreamRpcUnavailable());

    await facilitatorFetch(
      'https://facilitator.test/settle',
      { method: 'POST' },
      {
        timeoutMs: 1000,
        retries: 2,
        canReplay: () => true,
        fetchImpl: fetchMock as never,
        sleepImpl: async () => {},
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('FacilitatorClient.settle', () => {
  it('hands the caller the hash and paymentId instead of a retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(unconfirmedSettle());
    vi.stubGlobal('fetch', fetchMock);

    const result = await new FacilitatorClient({ retries: 5 }).settle(HEADER, REQUIREMENTS);

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.retryable).toBe(false);
    expect(result.safeToReplay).toBe(false);
    // What the caller does INSTEAD of retrying: look these up on chain.
    expect(result.transaction).toBe(TX);
    expect(result.paymentId).toBe(PAYMENT_ID);
    expect(result.errorCode).toBe(SETTLEMENT_UNCONFIRMED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: a transient 502 is still reported as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstreamRpcUnavailable()));

    const result = await new FacilitatorClient({ retries: 0 }).settle(HEADER, REQUIREMENTS);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.retryAfterSeconds).toBe(MAX_RETRY_AFTER_SECONDS);
  });
});

/** Minimal Express `res` double that records what was sent. */
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

const requirements = () => ({
  amount: '1.00',
  recipient: '0x0000000000000000000000000000000000000002',
  resource: 'https://example.test/thing',
  network: 'base' as const,
});

/** A verify that passes, so the middleware reaches the settle. */
const verifyOk = { ok: true, status: 200, json: async () => ({ isValid: true }) };

describe('Express middleware', () => {
  it('does NOT answer 503 + Retry-After on an unconfirmed settlement', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(verifyOk)
      .mockResolvedValue(unconfirmedSettle());
    vi.stubGlobal('fetch', fetchMock);
    const { res, sent } = expressRes();

    await createPaymentMiddleware(requirements, { retries: 0 })(
      { headers: { 'x-payment': encodeHeader() } },
      res as never,
      () => {
        throw new Error('handler must not run');
      },
    );

    // 503 + Retry-After is an instruction to send the payment again. Here it
    // would be an instruction to pay twice.
    expect(sent.code).toBe(500);
    expect(sent.headers?.['Retry-After']).toBeUndefined();
    expect(sent.body.retryable).toBe(false);
    // The buyer's client is the one that has to reconcile, so the hash has to
    // survive this hop too.
    expect(sent.body.transaction).toBe(TX);
    expect(sent.body.paymentId).toBe(PAYMENT_ID);
  });

  it('CONTROL: still answers 503 + Retry-After on the transient 502', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(verifyOk)
      .mockResolvedValue(upstreamRpcUnavailable());
    vi.stubGlobal('fetch', fetchMock);
    const { res, sent } = expressRes();

    await createPaymentMiddleware(requirements, { retries: 0 })(
      { headers: { 'x-payment': encodeHeader() } },
      res as never,
      () => {
        throw new Error('handler must not run');
      },
    );

    expect(sent.code).toBe(503);
    expect(sent.headers?.['Retry-After']).toBe(String(MAX_RETRY_AFTER_SECONDS));
    expect(sent.body.retryable).toBe(true);
  });
});

describe('Hono middleware', () => {
  function honoContext() {
    const sent: { code?: number; body?: any; headers: Record<string, string> } = { headers: {} };
    return {
      c: {
        req: { header: () => encodeHeader(), url: 'https://example.test/thing' },
        json: (body: unknown, status?: number) => {
          sent.body = body;
          sent.code = status;
          return body;
        },
        header: (name: string, value: string) => {
          sent.headers[name] = value;
        },
        set: () => {},
      },
      sent,
    };
  }

  const accepts = [
    {
      network: 'base',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1000000',
      payTo: '0x0000000000000000000000000000000000000002',
    },
  ];

  it('does NOT answer 503 + Retry-After on an unconfirmed settlement', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(verifyOk)
      .mockResolvedValue(unconfirmedSettle());
    vi.stubGlobal('fetch', fetchMock);
    const { c, sent } = honoContext();

    await createHonoMiddleware({ accepts: accepts as never, retries: 0 })(c as never, async () => {
      throw new Error('handler must not run');
    });

    expect(sent.code).toBe(500);
    expect(sent.headers['Retry-After']).toBeUndefined();
    expect(sent.body.transaction).toBe(TX);
    expect(sent.body.paymentId).toBe(PAYMENT_ID);
  });

  it('CONTROL: still answers 503 + Retry-After on the transient 502', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(verifyOk)
      .mockResolvedValue(upstreamRpcUnavailable());
    vi.stubGlobal('fetch', fetchMock);
    const { c, sent } = honoContext();

    await createHonoMiddleware({ accepts: accepts as never, retries: 0 })(c as never, async () => {
      throw new Error('handler must not run');
    });

    expect(sent.code).toBe(503);
    expect(sent.headers['Retry-After']).toBe(String(MAX_RETRY_AFTER_SECONDS));
  });
});

describe('Erc8004LookupError', () => {
  it('is not retryable when the body says the write may already be mined', () => {
    // `POST /register` goes through the same EVM `send_transaction_from` as a
    // settle, so it can answer `settlement_unconfirmed` too — and retrying a
    // mint that may already have landed is what minted five duplicate agents.
    const body = JSON.stringify({
      error: 'settlement_unconfirmed',
      transaction: TX,
      paymentId: PAYMENT_ID,
      retryable: false,
    });
    const err = new Erc8004LookupError('ERC-8004 API error: 502 - ' + body, 502, body);

    expect(err.retryable).toBe(false);
    expect(err.notFound).toBe(false);
    expect(err.safeToReplay).toBe(false);
    expect(err.transaction).toBe(TX);
    expect(err.paymentId).toBe(PAYMENT_ID);
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it('CONTROL: a 502 with no such body stays retryable', () => {
    const body = JSON.stringify({ error: 'upstream_rpc_unavailable (ref: abc)' });
    const err = new Erc8004LookupError('ERC-8004 API error: 502 - ' + body, 502, body, 15);

    expect(err.retryable).toBe(true);
    expect(err.retryAfterSeconds).toBe(15);
  });
});

describe('Erc8004Client write routes', () => {
  it('does not replay a register that may already be mined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(unconfirmedSettle());
    vi.stubGlobal('fetch', fetchMock);

    const result = await new Erc8004Client({ retries: 3 }).registerAgent({
      x402Version: 1,
      network: 'base',
      agentUri: 'ipfs://QmAgent',
      recipient: '0x0000000000000000000000000000000000000003',
    } as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.transaction).toBe(TX);
  });
});
