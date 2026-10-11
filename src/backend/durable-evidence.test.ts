/**
 * `durable`: the paywalls anchor DX402 evidence of the paid response themselves.
 *
 * The facilitator (verify, settle, `/dx402/anchor`) is a double on 127.0.0.1,
 * the bring-your-own-storage sink is a double in memory, and the network is
 * closed: `fetch` refuses every host but loopback, and each test checks that
 * nothing tried one. The payer's key is synthetic, generated per run, and each
 * anchored envelope is opened with it to compare the bytes with the body
 * served. Nothing is signed, settled or stored anywhere.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { secp256k1 } from '@noble/curves/secp256k1';
import { TypedDataEncoder, Wallet, getBytes, hexlify } from 'ethers';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFetchPaywall, createHonoMiddleware, createPaymentMiddleware, DURABLE_DEFAULT_TIMEOUT_MS } from './index';
import type { DurableEvidenceContext, DurableEvidenceOptions, FetchPaywallOptions, VerifiedPaymentState } from './index';
import { settledForEvidence } from './durable';
import { getChainByName } from '../chains';
import { caip2ToChain } from '../utils';
import vectors from '../fixtures/facilitator-receipts-v1.json';
import {
  ANCHOR_MAX_REQUEST_BYTES,
  EVIDENCE_HEADER,
  EvidenceSkipped,
  contentHash,
  evidenceFromHeaders,
  evidenceHeader,
  parseSealed,
  payerKeyFromEvmSignature,
  paymentId,
  unseal,
} from '../dx402';

const PAYER = '0x1111111111111111111111111111111111111111';
const PAY_TO = '0x2222222222222222222222222222222222222222';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TX = '0x' + '22'.repeat(32);
const ACCEPTS = [{ network: 'base', asset: USDC_BASE, amount: '10000', payTo: PAY_TO }];
const URL_PAID = 'https://shop.example/api/premium';
const PAYMENT_ID = paymentId('eip155:8453', TX);
const PROOF = { transactionHash: TX, blockNumber: 1, network: 'base', payer: PAYER, payee: PAY_TO, amount: '10000', token: USDC_BASE, timestamp: 1, paymentHash: '0x' + '33'.repeat(32) };

/** The payer's synthetic key pair: the evidence is sealed to the public half. */
const PAYER_PRIVATE = secp256k1.utils.randomPrivateKey();
const PAYER_PUBLIC = secp256k1.getPublicKey(PAYER_PRIVATE, true);

function xPayment(payload?: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: payload ?? {
      signature: '0x' + 'ab'.repeat(65),
      authorization: { from: PAYER, to: PAY_TO, value: '10000', validAfter: '0', validBefore: '9999999999', nonce: '0x' + '11'.repeat(32) },
    },
  })).toString('base64');
}

/** Open an anchored envelope with the payer's synthetic private key. */
function open(sealed: Uint8Array, id: string = PAYMENT_ID): string {
  return new TextDecoder().decode(unseal(parseSealed(sealed), PAYER_PRIVATE, new TextEncoder().encode(id)));
}

// ---------------------------------------------------------------------------
// The facilitator double, the sink double and the closed network
// ---------------------------------------------------------------------------

type Answer = { status?: number; body: Record<string, unknown> };
type Call = { path: string; body: any };
const sealedOf = (call: Call) => Uint8Array.from(Buffer.from(call.body.sealed, 'base64'));

const SETTLED: Answer = { body: { success: true, transaction: TX, network: 'base', payer: PAYER, proofOfPayment: PROOF } };
const facilitator = {
  url: '',
  calls: [] as Call[],
  settle: SETTLED as Answer | ((body: any) => Answer),
  anchor: undefined as Answer | undefined,
};
const anchors = () => facilitator.calls.filter((call) => call.path === 'dx402/anchor');
const settles = () => facilitator.calls.filter((call) => call.path === 'settle');
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '').slice(1);
      const body = JSON.parse(Buffer.concat(chunks).toString() || 'null');
      facilitator.calls.push({ path, body });
      const answer: Answer = path === 'verify' ? { body: { isValid: true, payer: PAYER } }
        : path === 'settle' ? (typeof facilitator.settle === 'function' ? facilitator.settle(body) : facilitator.settle)
          : path === 'dx402/anchor' ? facilitator.anchor ?? {
            body: {
              v: 1, paymentId: body.paymentId, pointer: body.pointer ?? 's3+https://store.example/hosted',
              backend: body.backend, contentHash: body.contentHash, cipher: 'AES-256-GCM',
              keyAlg: body.keyAlg, mode: 'direct', retention: body.retention, verified: true,
            },
          }
            : { status: 404, body: { error: 'no such route' } };
      res.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json' });
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
  facilitator.settle = SETTLED;
  facilitator.anchor = undefined;
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

const durable = (extra: Partial<DurableEvidenceOptions> = {}): DurableEvidenceOptions => ({
  payerKey: () => PAYER_PUBLIC,
  ...extra,
});

const options = (extra: Partial<FetchPaywallOptions> = {}): FetchPaywallOptions => ({
  accepts: ACCEPTS, facilitatorUrl: facilitator.url, retries: 0, ...extra,
});

const paid = (init: RequestInit = {}) =>
  new Request(URL_PAID, { ...init, headers: { 'X-PAYMENT': xPayment(), ...(init.headers as Record<string, string>) } });

const BODY = JSON.stringify({ premium: 'the paid answer', n: 42 });

/** A stream of `parts`, counting the chunks pulled from it. */
function counted(parts: string[]) {
  const state = { pulls: 0 };
  const queue = parts.map((part) => new TextEncoder().encode(part));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      const next = queue.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
  return { stream, state };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves for every caller once `n` have arrived: the handlers of concurrent requests overlap. */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let open_: () => void = () => {};
  const all = new Promise<void>((resolve) => { open_ = resolve; });
  return () => {
    arrived += 1;
    if (arrived === n) open_();
    return all;
  };
}

const TX_A = '0x' + 'aa'.repeat(32);
const TX_B = '0x' + 'bb'.repeat(32);

/** Each settle answers the next transaction hash. */
function settlesInTurn(txs: string[]): (body: any) => Answer {
  let n = 0;
  return () => ({ body: { success: true, transaction: txs[n++], network: 'base', payer: PAYER } });
}

/** Each response carries the evidence of its own payment, and its anchor opens to its own bytes. */
async function expectOwnAnchors(responses: Response[], txs: string[]): Promise<void> {
  expect(anchors()).toHaveLength(responses.length);
  const served = await Promise.all(responses.map((response) => response.text()));
  const ids = responses.map((response) => evidenceFromHeaders(response.headers).paymentId as string);
  expect([...ids].sort()).toEqual(txs.map((tx) => paymentId('eip155:8453', tx)).sort());
  ids.forEach((id, i) => {
    const anchor = anchors().find((call) => call.body.paymentId === id);
    expect(anchor, id).toBeDefined();
    expect(open(sealedOf(anchor!), id)).toBe(served[i]);
  });
  expect(new Set(served).size).toBe(responses.length);
}

const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
};

/** The README's EVM `payerKey`, as written there. */
const evmPayerKey = ({ payment }: DurableEvidenceContext) => {
  const payload = payment.payment.payload;
  if (!('authorization' in payload)) return undefined;
  const network = payment.requirements.network;
  const chain = getChainByName(caip2ToChain(network) ?? network);
  if (!chain) return undefined;
  const digest = TypedDataEncoder.hash(
    { name: chain.usdc.name, version: chain.usdc.version, chainId: chain.chainId, verifyingContract: payment.requirements.asset },
    TRANSFER_WITH_AUTHORIZATION,
    payload.authorization,
  );
  return payerKeyFromEvmSignature(payload.signature, getBytes(digest));
};

/** The skip reason in the response's evidence header. */
function skipped(headers: Headers): string {
  try {
    evidenceFromHeaders(headers);
  } catch (error) {
    if (error instanceof EvidenceSkipped) return error.reason;
    throw error;
  }
  throw new Error('the header carries evidence, not a skip notice');
}

// ---------------------------------------------------------------------------
// createFetchPaywall
// ---------------------------------------------------------------------------

describe('createFetchPaywall with durable', () => {
  it('settled payment and a capturable body: one anchor, a valid header, and the envelope opens to the served bytes', async () => {
    const route = createFetchPaywall(options({ durable: durable() }))(async () =>
      new Response(BODY, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private' } }));
    const response = await route(paid());

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private');
    expect(await response.text()).toBe(BODY);
    expect(settles()).toHaveLength(1);
    expect(anchors()).toHaveLength(1);

    const evidence = evidenceFromHeaders(response.headers);
    const served = new TextEncoder().encode(BODY);
    expect(evidence.paymentId).toBe(PAYMENT_ID);
    expect(evidence.contentHash).toBe(contentHash(served));
    expect(evidence.pointer).toBe('s3+https://store.example/hosted');

    const request = anchors()[0].body;
    expect(request).toMatchObject({
      paymentId: PAYMENT_ID, network: 'eip155:8453', txHash: TX, payer: PAYER, payee: PAY_TO,
      contentHash: contentHash(served), keyAlg: 'ECIES-secp256k1', mode: 'direct', proofOfPayment: PROOF,
    });
    expect(request.pointer).toBeUndefined();
    expect(open(Uint8Array.from(Buffer.from(request.sealed, 'base64')))).toBe(BODY);
  });

  it('bring-your-own sink: the sink gets the sealed bytes once, the anchor carries its pointer, and the bytes open with the payer key', async () => {
    const sunk: Uint8Array[] = [];
    const route = createFetchPaywall(options({
      durable: durable({ upload: (sealed) => { sunk.push(sealed); return 'ipfs://bafy-sink'; } }),
    }))(async () => new Response(BODY));
    const response = await route(paid());

    expect(await response.text()).toBe(BODY);
    expect(sunk).toHaveLength(1);
    expect(anchors()).toHaveLength(1);
    expect(anchors()[0].body).toMatchObject({ pointer: 'ipfs://bafy-sink', backend: 'ipfs' });
    expect(anchors()[0].body.sealed).toBeUndefined();
    expect(evidenceFromHeaders(response.headers).pointer).toBe('ipfs://bafy-sink');
    expect(open(sunk[0])).toBe(BODY);
    // Sealed once: the plaintext is not in what the sink stored.
    expect(Buffer.from(sunk[0]).includes(Buffer.from('the paid answer'))).toBe(false);
  });

  it('off: zero anchors and no header', async () => {
    const route = createFetchPaywall(options())(async () => new Response(BODY));
    const response = await route(paid());
    expect(await response.text()).toBe(BODY);
    expect(settles()).toHaveLength(1);
    expect(anchors()).toHaveLength(0);
    expect(response.headers.has(EVIDENCE_HEADER)).toBe(false);
  });

  it('a refused anchor keeps the response and the payment, with a skip notice', async () => {
    facilitator.anchor = { status: 500, body: { error: 'store_down' } };
    const route = createFetchPaywall(options({ durable: durable() }))(async () => new Response(BODY, { status: 201 }));
    const response = await route(paid());
    expect(response.status).toBe(201);
    expect(await response.text()).toBe(BODY);
    expect(settles()).toHaveLength(1);
    expect(anchors()).toHaveLength(1);
    expect(skipped(response.headers)).toBe('anchor_failed');
  });

  it('a body over maxBodyBytes streams through whole, with too_large and zero anchors', async () => {
    const parts = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
    const { stream } = counted(parts);
    const route = createFetchPaywall(options({ durable: durable({ maxBodyBytes: 64 }) }))(async () => new Response(stream));
    const response = await route(paid());
    expect(await response.text()).toBe(parts.join(''));
    expect(skipped(response.headers)).toBe('too_large');
    expect(anchors()).toHaveLength(0);
  });

  it('a declared Content-Length over the cap is not read at all', async () => {
    const { stream, state } = counted(['x'.repeat(100)]);
    const route = createFetchPaywall(options({ durable: durable({ maxBodyBytes: 64 }) }))(async () =>
      new Response(stream, { headers: { 'Content-Length': '100' } }));
    const response = await route(paid());
    expect(skipped(response.headers)).toBe('too_large');
    // Pulled only to fill the stream's own queue, never read past it by the hook.
    expect(state.pulls).toBeLessThanOrEqual(1);
    expect(await response.text()).toBe('x'.repeat(100));
    expect(anchors()).toHaveLength(0);
  });

  it('an event stream is not captured: it passes through with not_capturable and zero anchors', async () => {
    const route = createFetchPaywall(options({ durable: durable() }))(async () =>
      new Response('data: one\n\n', { headers: { 'Content-Type': 'Text/Event-Stream; charset=utf-8' } }));
    const response = await route(paid());
    expect(await response.text()).toBe('data: one\n\n');
    expect(skipped(response.headers)).toBe('not_capturable');
    expect(anchors()).toHaveLength(0);
  });

  it('a stream that stalls past the deadline goes out whole, chunk in flight included, with timeout and zero anchors', async () => {
    const encoder = new TextEncoder();
    let step = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        step += 1;
        if (step === 1) controller.enqueue(encoder.encode('first,'));
        else if (step === 2) { await sleep(150); controller.enqueue(encoder.encode('late,')); }
        else if (step === 3) controller.enqueue(encoder.encode('last'));
        else controller.close();
      },
    });
    const route = createFetchPaywall(options({ durable: durable({ timeoutMs: 40 }) }))(async () => new Response(stream));
    const response = await route(paid());
    expect(skipped(response.headers)).toBe('timeout');
    expect(await response.text()).toBe('first,late,last');
    expect(anchors()).toHaveLength(0);
  });

  it('a sink slower than the deadline: timeout, and no anchor is sent once it answers', async () => {
    const sent: string[] = [];
    // A fetch that ignores AbortSignal: the deadline alone must stop the late anchor.
    const deaf: typeof fetch = (input, init) => {
      sent.push(String(input));
      const { signal: _signal, ...rest } = init ?? {};
      return loopbackFetch(input, rest);
    };
    const route = createFetchPaywall(options({
      durable: durable({ timeoutMs: 40, fetch: deaf, upload: async () => { await sleep(120); return 's3+https://late.example/x'; } }),
    }))(async () => new Response(BODY));
    const response = await route(paid());
    expect(skipped(response.headers)).toBe('timeout');
    expect(await response.text()).toBe(BODY);
    await sleep(200);
    expect(sent).toEqual([]);
    expect(anchors()).toHaveLength(0);
  });

  it('a stream that errors delivers the bytes read before its error, then the error, with not_capturable and zero anchors', async () => {
    let step = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        step += 1;
        if (step === 1) controller.enqueue(new TextEncoder().encode('partial'));
        else controller.error(new Error('upstream broke'));
      },
    });
    const route = createFetchPaywall(options({ durable: durable() }))(async () => new Response(stream));
    const response = await route(paid());
    expect(skipped(response.headers)).toBe('not_capturable');
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('partial');
    await expect(reader.read()).rejects.toThrow('upstream broke');
    expect(anchors()).toHaveLength(0);
  });

  it("'manual' mode: nothing without a settle, one anchor after a settle that resolved", async () => {
    const unsettled = createFetchPaywall(options({ settlementStrategy: 'manual', durable: durable() }))(async () => new Response(BODY));
    const plain = await unsettled(paid());
    expect(plain.headers.has(EVIDENCE_HEADER)).toBe(false);
    expect(settles()).toHaveLength(0);
    expect(anchors()).toHaveLength(0);

    const settledRoute = createFetchPaywall(options({ settlementStrategy: 'manual', durable: durable() }))(async (_request: Request, x402: VerifiedPaymentState) => {
      await x402.settle();
      return new Response(BODY);
    });
    const response = await settledRoute(paid());
    expect(evidenceFromHeaders(response.headers).paymentId).toBe(PAYMENT_ID);
    expect(anchors()).toHaveLength(1);
  });

  it('a settle with no transaction hash anchors nothing', async () => {
    facilitator.settle = { body: { success: true, network: 'base', payer: PAYER } };
    const route = createFetchPaywall(options({ durable: durable() }))(async () => new Response(BODY));
    const response = await route(paid());
    expect(await response.text()).toBe(BODY);
    expect(response.headers.has(EVIDENCE_HEADER)).toBe(false);
    expect(anchors()).toHaveLength(0);
  });

  it('a failed settle never reaches the handler, and anchors nothing', async () => {
    facilitator.settle = { body: { success: false, errorReason: 'reverted' } };
    const handler = vi.fn(async () => new Response(BODY));
    const response = await createFetchPaywall(options({ durable: durable() }))(handler)(paid());
    expect(response.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
    expect(anchors()).toHaveLength(0);
  });

  it('a non-2xx answer, a HEAD and a response the handler anchored itself get no anchor', async () => {
    const own = evidenceHeader({ v: 1, skipped: 'handler_did_it' });
    const route = createFetchPaywall(options({ durable: durable() }));
    const notFound = await route(async () => new Response('missing', { status: 404 }))(paid());
    const head = await route(async () => new Response(BODY))(paid({ method: 'HEAD' }));
    const anchored = await route(async () => new Response(BODY, { headers: { [EVIDENCE_HEADER]: own } }))(paid());
    expect(notFound.status).toBe(404);
    expect(await notFound.text()).toBe('missing');
    expect(notFound.headers.has(EVIDENCE_HEADER)).toBe(false);
    expect(head.headers.has(EVIDENCE_HEADER)).toBe(false);
    expect(anchored.headers.get(EVIDENCE_HEADER)).toBe(own);
    expect(await anchored.text()).toBe(BODY);
    expect(anchors()).toHaveLength(0);
  });

  it('payerKey undefined, empty or throwing: the sale goes on with a skip notice and zero anchors', async () => {
    const none = await createFetchPaywall(options({ durable: durable({ payerKey: () => undefined }) }))(async () => new Response(BODY))(paid());
    const empty = await createFetchPaywall(options({ durable: durable({ payerKey: () => new Uint8Array() }) }))(async () => new Response(BODY))(paid());
    expect(skipped(empty.headers)).toBe('no_payer_key');
    expect(await empty.text()).toBe(BODY);
    const thrown = await createFetchPaywall(options({ durable: durable({ payerKey: () => { throw new Error('no key'); } }) }))(async () => new Response(BODY))(paid());
    expect(skipped(none.headers)).toBe('no_payer_key');
    expect(skipped(thrown.headers)).toBe('anchor_failed');
    expect(await none.text()).toBe(BODY);
    expect(await thrown.text()).toBe(BODY);
    expect(settles()).toHaveLength(3);
    expect(anchors()).toHaveLength(0);
  });

  it('a payerKey slower than the deadline: timeout, and nothing is uploaded or anchored after it', async () => {
    const upload = vi.fn(async () => 's3+https://late.example/x');
    const route = createFetchPaywall(options({
      durable: durable({ timeoutMs: 40, upload, payerKey: async () => { await sleep(120); return PAYER_PUBLIC; } }),
    }))(async () => new Response(BODY));
    const response = await route(paid());
    expect(skipped(response.headers)).toBe('timeout');
    expect(await response.text()).toBe(BODY);
    await sleep(200);
    expect(upload).not.toHaveBeenCalled();
    expect(anchors()).toHaveLength(0);
  });

  it('the anchor request still in flight at the deadline is aborted', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const hanging: typeof fetch = (_input, init) => {
      signals.push(init?.signal);
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const route = createFetchPaywall(options({ durable: durable({ timeoutMs: 40, fetch: hanging }) }))(async () => new Response(BODY));
    const response = await route(paid());
    expect(skipped(response.headers)).toBe('timeout');
    expect(await response.text()).toBe(BODY);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(anchors()).toHaveLength(0);
  });

  it("one paywall, request after request: a 'manual' request that did not settle, or whose settle failed, anchors nothing after one that did", async () => {
    const route = createFetchPaywall(options({ settlementStrategy: 'manual', durable: durable() }))(async (request: Request, x402: VerifiedPaymentState) => {
      if (request.headers.get('X-Settle')) await x402.settle().catch(() => undefined);
      return new Response(BODY);
    });
    const first = await route(paid({ headers: { 'X-Settle': '1' } }));
    expect(evidenceFromHeaders(first.headers).paymentId).toBe(PAYMENT_ID);
    const unsettled = await route(paid());
    facilitator.settle = { body: { success: false, errorReason: 'reverted' } };
    const failed = await route(paid({ headers: { 'X-Settle': '1' } }));
    for (const response of [unsettled, failed]) {
      expect(await response.text()).toBe(BODY);
      expect(response.headers.has(EVIDENCE_HEADER)).toBe(false);
    }
    expect(anchors()).toHaveLength(1);
  });

  it('one paywall, two concurrent requests: each anchored with its own paymentId and its own bytes', async () => {
    facilitator.settle = settlesInTurn([TX_A, TX_B]);
    const meet = barrier(2);
    const route = createFetchPaywall(options({ durable: durable() }))(async (request: Request) => {
      await meet();
      return new Response(`answer ${request.headers.get('X-Req')}`);
    });
    const responses = await Promise.all(['a', 'b'].map((id) => route(paid({ headers: { 'X-Req': id } }))));
    await expectOwnAnchors(responses, [TX_A, TX_B]);
  });

  it('a settle whose receipt is still pending anchors nothing, though it answered success', async () => {
    facilitator.settle = {
      body: { ...SETTLED.body, receipt: { ...vectors.cases[0].receipt, operation: 'settle', status: 'pending', proof: null, settlement: null } },
    };
    const route = createFetchPaywall(options({ durable: durable() }))(async () => new Response(BODY));
    const response = await route(paid());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY);
    expect(response.headers.has(EVIDENCE_HEADER)).toBe(false);
    expect(anchors()).toHaveLength(0);
  });

  it("the README's EVM payerKey: the buyer's own signature seals the evidence to the buyer's key", async () => {
    const wallet = new Wallet(hexlify(PAYER_PRIVATE));
    const chain = getChainByName('base')!;
    const authorization = { from: wallet.address, to: PAY_TO, value: '10000', validAfter: '0', validBefore: '9999999999', nonce: '0x' + '44'.repeat(32) };
    const signature = await wallet.signTypedData(
      { name: chain.usdc.name, version: chain.usdc.version, chainId: chain.chainId, verifyingContract: USDC_BASE },
      TRANSFER_WITH_AUTHORIZATION,
      authorization,
    );
    const route = createFetchPaywall(options({ durable: durable({ payerKey: evmPayerKey }) }))(async () => new Response(BODY));
    const response = await route(paid({ headers: { 'X-PAYMENT': xPayment({ signature, authorization }) } }));
    expect(evidenceFromHeaders(response.headers).paymentId).toBe(PAYMENT_ID);
    expect(anchors()).toHaveLength(1);
    expect(open(sealedOf(anchors()[0]))).toBe(BODY);
  });

  it('a misconfigured durable is refused when the paywall is built', () => {
    expect(DURABLE_DEFAULT_TIMEOUT_MS).toBe(5000);
    for (const bad of [
      { payerKey: undefined },
      { maxBodyBytes: 0 }, { maxBodyBytes: -1 }, { maxBodyBytes: 1.5 }, { maxBodyBytes: Infinity }, { maxBodyBytes: NaN },
      { timeoutMs: 0 }, { timeoutMs: -5 }, { timeoutMs: 2 ** 31 }, { timeoutMs: Infinity },
    ]) {
      expect(() => createFetchPaywall(options({ durable: { ...durable(), ...bad } as DurableEvidenceOptions })), JSON.stringify(bad)).toThrow(TypeError);
    }
    expect(() => createFetchPaywall(options({ durable: durable({ maxBodyBytes: ANCHOR_MAX_REQUEST_BYTES, timeoutMs: 2 ** 31 - 1 }) }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createHonoMiddleware
// ---------------------------------------------------------------------------

describe('createHonoMiddleware with durable', () => {
  const app = (extra: Partial<FetchPaywallOptions>, body: () => Response | string = () => BODY) => {
    const hono = new Hono();
    hono.get('/api/premium', createHonoMiddleware(options(extra)) as never, (c) => {
      const answer = body();
      return typeof answer === 'string' ? c.text(answer) : answer;
    });
    return hono;
  };
  const request = () => ({ headers: { 'X-PAYMENT': xPayment() } });

  it('settled: one anchor, a valid header, the envelope opens to the served bytes', async () => {
    const response = await app({ durable: durable() }).request(URL_PAID, request());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY);
    expect(anchors()).toHaveLength(1);
    expect(evidenceFromHeaders(response.headers).contentHash).toBe(contentHash(new TextEncoder().encode(BODY)));
    expect(open(Uint8Array.from(Buffer.from(anchors()[0].body.sealed, 'base64')))).toBe(BODY);
  });

  it('off: zero anchors and no header', async () => {
    const response = await app({}).request(URL_PAID, request());
    expect(await response.text()).toBe(BODY);
    expect(response.headers.has(EVIDENCE_HEADER)).toBe(false);
    expect(anchors()).toHaveLength(0);
  });

  it('over the cap: the whole body, too_large, zero anchors', async () => {
    const big = 'z'.repeat(500);
    const response = await app({ durable: durable({ maxBodyBytes: 100 }) }, () => big).request(URL_PAID, request());
    expect(await response.text()).toBe(big);
    expect(skipped(response.headers)).toBe('too_large');
    expect(anchors()).toHaveLength(0);
  });

  const honoWith = (extra: Partial<FetchPaywallOptions>, handler: (c: any) => Response | Promise<Response>) => {
    const hono = new Hono();
    hono.get('/api/premium', createHonoMiddleware(options(extra)) as never, handler as never);
    return hono;
  };

  it("one app, request after request: a 'manual' request that did not settle anchors nothing after one that did", async () => {
    const hono = honoWith({ settlementStrategy: 'manual', durable: durable() }, async (c) => {
      if (c.req.header('X-Settle')) await c.get('x402').settle();
      return c.text(BODY);
    });
    const first = await hono.request(URL_PAID, { headers: { 'X-PAYMENT': xPayment(), 'X-Settle': '1' } });
    expect(evidenceFromHeaders(first.headers).paymentId).toBe(PAYMENT_ID);
    const second = await hono.request(URL_PAID, request());
    expect(await second.text()).toBe(BODY);
    expect(second.headers.has(EVIDENCE_HEADER)).toBe(false);
    expect(anchors()).toHaveLength(1);
  });

  it('one app, two concurrent requests: each anchored with its own paymentId and its own bytes', async () => {
    facilitator.settle = settlesInTurn([TX_A, TX_B]);
    const meet = barrier(2);
    const hono = honoWith({ durable: durable() }, async (c) => {
      await meet();
      return c.text(`answer ${c.req.header('X-Req')}`);
    });
    const responses = await Promise.all(['a', 'b'].map((id) =>
      hono.request(URL_PAID, { headers: { 'X-PAYMENT': xPayment(), 'X-Req': id } })));
    await expectOwnAnchors(responses, [TX_A, TX_B]);
  });

  it('a handler that throws: the error answer, no anchor', async () => {
    const response = await app({ durable: durable() }, () => { throw new Error('boom'); }).request(URL_PAID, request());
    expect(response.status).toBe(500);
    expect(response.headers.has(EVIDENCE_HEADER)).toBe(false);
    expect(anchors()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createPaymentMiddleware (Express): a Node ServerResponse with Express's res.status/set/json
// ---------------------------------------------------------------------------

type ExpressRes = http.ServerResponse & {
  status: (code: number) => ExpressRes;
  set: (headers: Record<string, string>) => ExpressRes;
  json: (body: unknown) => void;
  send: (body: string | Buffer) => void;
};

type ExpressReq = { headers: Record<string, string | string[] | undefined>; method?: string; url?: string; socket: http.IncomingMessage['socket']; x402?: VerifiedPaymentState };
type ExpressInit = { method?: string; headers?: Record<string, string> };

async function express(
  extra: Partial<FetchPaywallOptions>,
  handler: (res: ExpressRes, req: ExpressReq) => void | Promise<void>,
  init: ExpressInit = {},
): Promise<Response> {
  const server = await expressServer(extra, handler);
  try {
    return await server.request(init);
  } finally {
    await server.close();
  }
}

/** One Express middleware instance behind a loopback server, for several requests. */
async function expressServer(
  extra: Partial<FetchPaywallOptions>,
  handler: (res: ExpressRes, req: ExpressReq) => void | Promise<void>,
): Promise<{ request: (init?: ExpressInit) => Promise<Response>; close: () => Promise<void> }> {
  const middleware = createPaymentMiddleware(
    () => ({ amount: '0.01', recipient: PAY_TO, resource: URL_PAID, chainName: 'base' }),
    { facilitatorUrl: facilitator.url, retries: 0, ...extra },
  );
  const app = http.createServer((req, raw) => {
    const res = raw as ExpressRes;
    res.status = (code) => { res.statusCode = code; return res; };
    res.set = (headers) => { for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); return res; };
    // Express's res.send: Content-Length, then a single end(chunk, encoding).
    res.send = (body) => {
      const bytes = typeof body === 'string' ? Buffer.from(body) : body;
      res.setHeader('Content-Length', String(bytes.length));
      res.end(bytes);
    };
    res.json = (body) => { res.setHeader('Content-Type', 'application/json'); res.send(JSON.stringify(body)); };
    const xreq: ExpressReq = { headers: req.headers as Record<string, string | string[] | undefined>, method: req.method, url: req.url, socket: req.socket };
    void middleware(xreq as never, res as never, () => { void handler(res, xreq); });
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  const port = (app.address() as AddressInfo).port;
  return {
    request: async (init: ExpressInit = {}) => {
      const response = await loopbackFetch(`http://127.0.0.1:${port}/api/premium`, {
        method: init.method ?? 'GET',
        headers: { 'X-PAYMENT': xPayment(), ...init.headers },
      });
      const text = init.method === 'HEAD' ? '' : await response.text();
      return new Response(init.method === 'HEAD' ? null : text, { status: response.status, headers: response.headers });
    },
    close: () => new Promise<void>((resolve) => app.close(() => resolve())),
  };
}

describe('createPaymentMiddleware (Express) with durable', () => {
  it('settled res.json: one anchor, a valid header, the envelope opens to the served bytes', async () => {
    const response = await express({ durable: durable() }, (res) => res.json(JSON.parse(BODY)));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY);
    expect(settles()).toHaveLength(1);
    expect(anchors()).toHaveLength(1);
    expect(evidenceFromHeaders(response.headers).paymentId).toBe(PAYMENT_ID);
    expect(anchors()[0].body).toMatchObject({ payee: PAY_TO, txHash: TX, network: 'eip155:8453' });
    expect(open(Uint8Array.from(Buffer.from(anchors()[0].body.sealed, 'base64')))).toBe(BODY);
  });

  it('several writes then end: captured whole, one anchor', async () => {
    const response = await express({ durable: durable() }, (res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.write('one,');
      res.write(Buffer.from('two,'));
      res.end('three', 'utf8');
    });
    expect(await response.text()).toBe('one,two,three');
    expect(anchors()).toHaveLength(1);
    expect(open(Uint8Array.from(Buffer.from(anchors()[0].body.sealed, 'base64')))).toBe('one,two,three');
  });

  it('off: zero anchors and no header', async () => {
    const response = await express({}, (res) => res.json(JSON.parse(BODY)));
    expect(await response.text()).toBe(BODY);
    expect(response.headers.has(EVIDENCE_HEADER.toLowerCase())).toBe(false);
    expect(anchors()).toHaveLength(0);
  });

  it('over the cap: the whole body, too_large, zero anchors', async () => {
    const response = await express({ durable: durable({ maxBodyBytes: 10 }) }, (res) => {
      res.write('0123456');
      res.write('789abcdef');
      res.end('!');
    });
    expect(await response.text()).toBe('0123456789abcdef!');
    expect(skipped(response.headers)).toBe('too_large');
    expect(anchors()).toHaveLength(0);
  });

  it('an event stream passes through with not_capturable and zero anchors', async () => {
    const response = await express({ durable: durable() }, (res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: one\n\n');
      res.end();
    });
    expect(await response.text()).toBe('data: one\n\n');
    expect(skipped(response.headers)).toBe('not_capturable');
    expect(anchors()).toHaveLength(0);
  });

  it('a slow stream past the deadline: flushed with timeout, the rest follows, zero anchors', async () => {
    const response = await express({ durable: durable({ timeoutMs: 40 }) }, async (res) => {
      res.write('early,');
      await sleep(120);
      res.end('late');
    });
    expect(await response.text()).toBe('early,late');
    expect(skipped(response.headers)).toBe('timeout');
    expect(anchors()).toHaveLength(0);
  });

  it('a refused anchor keeps the response and the payment, with a skip notice', async () => {
    facilitator.anchor = { status: 422, body: { error: 'dx402_signature_not_verified' } };
    const response = await express({ durable: durable() }, (res) => res.status(201).json(JSON.parse(BODY)));
    expect(response.status).toBe(201);
    expect(await response.text()).toBe(BODY);
    expect(settles()).toHaveLength(1);
    expect(anchors()).toHaveLength(1);
    expect(skipped(response.headers)).toBe('anchor_failed');
  });

  it('send then a second end() and a late write: the paid body whole, once, and the anchor is of those bytes', async () => {
    let lateEnd = false;
    const late: { wrote?: boolean; error?: string } = {};
    const response = await express({ durable: durable() }, (res) => {
      res.send(BODY);
      res.end(() => { lateEnd = true; });
      late.wrote = res.write('late', (error?: Error | null) => { late.error = (error as { code?: string } | null)?.code; });
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY);
    expect(settles()).toHaveLength(1);
    expect(anchors()).toHaveLength(1);
    expect(evidenceFromHeaders(response.headers).contentHash).toBe(contentHash(new TextEncoder().encode(BODY)));
    expect(open(sealedOf(anchors()[0]))).toBe(BODY);
    await vi.waitFor(() => expect(lateEnd).toBe(true));
    expect(late).toEqual({ wrote: false, error: 'ERR_STREAM_WRITE_AFTER_END' });
  });

  it('a fallback that checks headersSent after send leaves the paid answer alone, and late headers are refused', async () => {
    const seen: { headersSent?: boolean; writableEnded?: boolean; lateHeader?: string; lateRemove?: string; lateWriteHead?: string } = {};
    const response = await express({ durable: durable() }, (res) => {
      res.send(BODY);
      seen.headersSent = res.headersSent;
      seen.writableEnded = res.writableEnded;
      if (!res.headersSent) res.status(404).send('Cannot GET /api/premium');
      // Express's res.status does not look at headersSent: the status that went out stands.
      res.status(500);
      try {
        res.setHeader('X-Late', '1');
      } catch (error) {
        seen.lateHeader = (error as { code?: string }).code;
      }
      try {
        res.removeHeader('Content-Length');
      } catch (error) {
        seen.lateRemove = (error as { code?: string }).code;
      }
      try {
        res.writeHead(500);
      } catch (error) {
        seen.lateWriteHead = (error as { code?: string }).code;
      }
    });
    expect(seen).toEqual({
      headersSent: true,
      writableEnded: true,
      lateHeader: 'ERR_HTTP_HEADERS_SENT',
      lateRemove: 'ERR_HTTP_HEADERS_SENT',
      lateWriteHead: 'ERR_HTTP_HEADERS_SENT',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY);
    expect(response.headers.has('x-late')).toBe(false);
    expect(settles()).toHaveLength(1);
    expect(anchors()).toHaveLength(1);
    expect(open(sealedOf(anchors()[0]))).toBe(BODY);
  });

  it.each(['socket', 'res'] as const)(
    'an error after send, closed through %s.destroy() as Express\'s final handler does once headersSent: the paid body arrives whole first',
    async (via) => {
      let closed = false;
      const response = await express({ durable: durable() }, (res, req) => {
        res.send(BODY);
        // finalhandler, on next(err) with res.headersSent: req.socket.destroy()
        if (res.headersSent) {
          if (via === 'socket') req.socket.destroy();
          else res.destroy();
          closed = true;
        }
      });
      expect(closed).toBe(true);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(BODY);
      expect(settles()).toHaveLength(1);
      expect(anchors()).toHaveLength(1);
      expect(open(sealedOf(anchors()[0]))).toBe(BODY);
    },
  );

  it('a single send over the cap: the whole body, too_large, zero anchors', async () => {
    const big = 'y'.repeat(500);
    const response = await express({ durable: durable({ maxBodyBytes: 100 }) }, (res) => res.send(big));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(big);
    expect(skipped(response.headers)).toBe('too_large');
    expect(anchors()).toHaveLength(0);
  });

  it('a single end(chunk) of an event stream: the whole body, not_capturable, zero anchors', async () => {
    const response = await express({ durable: durable() }, (res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end('data: only\n\n');
    });
    expect(await response.text()).toBe('data: only\n\n');
    expect(skipped(response.headers)).toBe('not_capturable');
    expect(anchors()).toHaveLength(0);
  });

  it("one middleware, request after request: a 'manual' request that did not settle anchors nothing after one that did", async () => {
    const server = await expressServer({ settlementStrategy: 'manual', durable: durable() }, async (res, req) => {
      if (req.headers['x-settle']) await req.x402!.settle();
      res.send(BODY);
    });
    try {
      const first = await server.request({ headers: { 'X-Settle': '1' } });
      expect(evidenceFromHeaders(first.headers).paymentId).toBe(PAYMENT_ID);
      const second = await server.request();
      expect(await second.text()).toBe(BODY);
      expect(second.headers.has(EVIDENCE_HEADER.toLowerCase())).toBe(false);
    } finally {
      await server.close();
    }
    expect(anchors()).toHaveLength(1);
  });

  it('one middleware, two concurrent requests: each anchored with its own paymentId and its own bytes', async () => {
    facilitator.settle = settlesInTurn([TX_A, TX_B]);
    const meet = barrier(2);
    const server = await expressServer({ durable: durable() }, async (res, req) => {
      await meet();
      res.send(`answer ${req.headers['x-req']}`);
    });
    try {
      const responses = await Promise.all(['a', 'b'].map((id) => server.request({ headers: { 'X-Req': id } })));
      await expectOwnAnchors(responses, [TX_A, TX_B]);
    } finally {
      await server.close();
    }
  });

  it("a non-2xx answer and 'manual' without a settle anchor nothing", async () => {
    const error = await express({ durable: durable() }, (res) => res.status(404).json({ error: 'missing' }));
    expect(error.status).toBe(404);
    expect(error.headers.has(EVIDENCE_HEADER.toLowerCase())).toBe(false);
    const manual = await express({ settlementStrategy: 'manual', durable: durable() }, (res) => res.json(JSON.parse(BODY)));
    expect(await manual.text()).toBe(BODY);
    expect(manual.headers.has(EVIDENCE_HEADER.toLowerCase())).toBe(false);
    expect(anchors()).toHaveLength(0);
  });
});

describe('durable: the edges the surfaces share', () => {
  it("'manual' with a settle that failed: the handler answered anyway, and nothing is anchored", async () => {
    facilitator.settle = { body: { success: false, errorReason: 'reverted' } };
    const route = createFetchPaywall(options({ settlementStrategy: 'manual', durable: durable() }))(async (_request: Request, x402: VerifiedPaymentState) => {
      await x402.settle().catch(() => undefined);
      return new Response(BODY);
    });
    const response = await route(paid());
    expect(await response.text()).toBe(BODY);
    expect(response.headers.has(EVIDENCE_HEADER)).toBe(false);
    expect(anchors()).toHaveLength(0);
  });

  it("'manual' with a settle that answered success: false but named a transaction: nothing is anchored", async () => {
    facilitator.settle = { body: { success: false, transaction: TX, network: 'base', payer: PAYER, errorReason: 'reverted' } };
    const route = createFetchPaywall(options({ settlementStrategy: 'manual', durable: durable() }))(async (_request: Request, x402: VerifiedPaymentState) => {
      await x402.settle().catch(() => undefined);
      return new Response(BODY);
    });
    const response = await route(paid());
    expect(await response.text()).toBe(BODY);
    expect(response.headers.has(EVIDENCE_HEADER)).toBe(false);
    expect(anchors()).toHaveLength(0);
  });

  it('a body the handler already locked is returned untouched, not read a second time', async () => {
    const { stream } = counted([BODY]);
    const locked = new Response(stream);
    const reader = locked.body!.getReader();
    const route = createFetchPaywall(options({ durable: durable() }))(async () => locked);
    const response = await route(paid());
    expect(response).toBe(locked);
    expect(response.headers.has(EVIDENCE_HEADER)).toBe(false);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(BODY);
    expect(anchors()).toHaveLength(0);
  });

  it('Express: past the deadline the held bytes are flushed while the handler is still writing', async () => {
    let sentBeforeEnd: boolean | undefined;
    const response = await express({ durable: durable({ timeoutMs: 40 }) }, async (res) => {
      res.write('early,');
      await sleep(150);
      sentBeforeEnd = res.headersSent;
      res.end('late');
    });
    expect(sentBeforeEnd).toBe(true);
    expect(await response.text()).toBe('early,late');
    expect(skipped(response.headers)).toBe('timeout');
    expect(anchors()).toHaveLength(0);
  });
});

describe('settledForEvidence', () => {
  it('only a successful, first-time settle with a transaction hash and no unconfirmed receipt', () => {
    expect(settledForEvidence({ success: true, transactionHash: TX })).toBe(true);
    expect(settledForEvidence({ success: true, transactionHash: TX, replayed: false })).toBe(true);
    expect(settledForEvidence({ success: true, transactionHash: TX, receipt: null })).toBe(true);
    expect(settledForEvidence({ success: true, transactionHash: TX, receipt: { status: 'confirmed' } as never })).toBe(true);
    for (const settle of [
      undefined,
      { success: false, transactionHash: TX },
      { success: true },
      { success: true, transactionHash: '' },
      { success: true, transactionHash: TX, replayed: true },
      { success: 'true', transactionHash: TX },
      { success: true, transactionHash: 42 },
      { success: true, transactionHash: TX, receipt: { status: 'pending' } },
      { success: true, transactionHash: TX, receipt: { status: 'unknown' } },
      { success: true, transactionHash: TX, receipt: { status: 'rejected' } },
    ]) {
      expect(settledForEvidence(settle as never), JSON.stringify(settle)).toBe(false);
    }
  });
});
