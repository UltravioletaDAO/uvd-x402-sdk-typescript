/**
 * The whole rail, one row at a time: admit, pay, prove, prepare, check, sign,
 * store, send, reconcile, confirm. Against a chain double and a facilitator
 * double that verifies what x402-rs verifies (`test/reputation/doubles.ts`);
 * no network, no key but ones derived from public seeds.
 *
 * Each case names the failure it is about: a double enqueue, a restart in
 * the middle, a 429, a 503 or an answer that never came, a rating that landed
 * although the answer said otherwise, a deadline that passed with nothing on
 * the chain, a prepare that asks for something else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Erc8004Client } from '../backend';
import { Governor, messageRef, processRating, type RatingRow } from './index';
import {
  FACILITATOR,
  OPEN_CAPS,
  RATER_SEED,
  seedKey,
  seededSigner,
  world,
  type World,
} from '../../test/reputation/doubles';

let w: World;

beforeEach(() => {
  w = world();
  vi.stubGlobal('fetch', w.facilitator.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // A scripted answer nobody consumed means the case did not exercise what it claims.
  w.facilitator.assertConsumed();
  w.chain.assertConsumed();
});

const TERMINAL = new Set(['confirmed', 'failed', 'local_only']);

async function enqueue(n: number, viewer = 0, stream = 'stream-1', value = 90): Promise<string> {
  const ref = messageRef('test:v1', stream, `msg-${n}`);
  await w.outbox.enqueue({
    ref,
    network: 'base',
    subject: w.viewers[viewer],
    streamId: stream,
    value,
    amount: 1000,
    viewerId: `viewer-${viewer}`,
  });
  return ref;
}

/** Tick until the row is terminal, letting chain time pass between ticks. */
async function drive(ref: string, maxTicks = 40): Promise<RatingRow> {
  let row: RatingRow | null = null;
  for (let i = 0; i < maxTicks; i++) {
    row = await processRating(ref, w.deps);
    if (row && TERMINAL.has(row.status)) return row;
    w.chain.advanceTime(16);
  }
  throw new Error(`row did not finish: ${JSON.stringify(row)}`);
}

describe('processRating: the happy path', () => {
  it('pays, signs, relays and confirms one rating, with the authorization only the first time', async () => {
    const first = await drive(await enqueue(1));
    expect(first.status).toBe('confirmed');
    expect(first.feedbackIndex).toBe(1);
    expect(w.chain.sentRaw).toHaveLength(1);
    expect(w.facilitator.prepares).toBe(1);
    expect(w.facilitator.submits).toBe(1);
    expect(w.facilitator.landed).toHaveLength(1);
    expect(w.facilitator.submitBodies[0].authorization).toBeDefined();
    expect(first.proof?.payer.toLowerCase()).toBe(w.signer.address.toLowerCase());
    expect(first.proof?.payee.toLowerCase()).toBe(w.viewers[0].toLowerCase());
    expect(first.proof?.amount).toBe('1000');
    // The submit carried the proof, with the rater declared.
    expect(w.facilitator.submitBodies[0].feedback.proof.transactionHash).toBe(first.proof?.transactionHash);
    expect(w.facilitator.submitBodies[0].feedback.rater).toBe(w.signer.address);

    const second = await drive(await enqueue(2));
    expect(second.status).toBe('confirmed');
    expect(w.facilitator.submitBodies[1].authorization).toBeUndefined();
    expect(w.chain.sentRaw).toHaveLength(2);
  });

  it('never prints the rater key, a full address or a signature in its logs', async () => {
    await drive(await enqueue(1));
    const text = w.logger.lines.join('\n');
    expect(w.logger.lines.length).toBeGreaterThan(0);
    expect(text).not.toContain(seedKey(RATER_SEED).slice(2));
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(text).not.toMatch(/[0-9a-fA-F]{64}/);
  });
});

describe('processRating: idempotency', () => {
  it('a second enqueue of the same moment is a duplicate, and pays and rates once', async () => {
    const ref = await enqueue(1);
    const again = await w.outbox.enqueue({
      ref,
      network: 'base',
      subject: w.viewers[0],
      streamId: 'stream-1',
      value: 90,
      amount: 1000,
    });
    expect(again).toBe('duplicate');
    await drive(ref);
    await processRating(ref, w.deps);
    expect(w.chain.sentRaw).toHaveLength(1);
    expect(w.facilitator.landed).toHaveLength(1);
  });

  it('two workers on one queued row: one payment is broadcast, the other is never sent', async () => {
    const ref = await enqueue(1);
    await Promise.all([processRating(ref, w.deps), processRating(ref, w.deps)]);
    expect(w.chain.sentRaw).toHaveLength(1);
    expect((await drive(ref)).status).toBe('confirmed');
    expect(w.chain.sentRaw).toHaveLength(1);
    expect(w.facilitator.landed).toHaveLength(1);
  });

  it('two workers on one paid row: both may prepare, only one signature is ever submitted', async () => {
    const ref = await enqueue(1);
    // Hold the row at `paid`: the first prepare answers 503.
    w.facilitator.queue({ route: 'prepare', status: 503, body: { success: false, error: 'busy', reason: 'lease_busy' } });
    await processRating(ref, w.deps);
    expect((await w.outbox.get(ref))?.status).toBe('paid');
    w.chain.advanceTime(200);
    await Promise.all([processRating(ref, w.deps), processRating(ref, w.deps)]);
    expect(w.facilitator.submits).toBe(1);
    expect((await drive(ref)).status).toBe('confirmed');
    expect(w.facilitator.landed).toHaveLength(1);
  });
});

describe('processRating: a restart in the middle', () => {
  it('a payment stored but never broadcast is broadcast as the same bytes, not signed again', async () => {
    const ref = await enqueue(1);
    w.chain.script('eth_sendRawTransaction', { error: new Error('socket hang up') });
    await processRating(ref, w.deps);
    const stored = await w.outbox.get(ref);
    expect(stored?.status).toBe('paying');
    expect(stored?.error).toBe('payment_broadcast_failed');
    expect(w.chain.sentRaw).toHaveLength(0);

    // A new process: the same outbox (and the same chain and facilitator,
    // which live outside it); the client, the governor and the signer rebuilt.
    const now = () => w.chain.now();
    const fresh = {
      ...w.deps,
      client: new Erc8004Client({ baseUrl: FACILITATOR, retries: 0 }),
      governor: new Governor(OPEN_CAPS, () => ({ campaignPerRater: 20 }), { store: w.outbox, now }),
      signer: seededSigner(RATER_SEED),
    };
    w.chain.advanceTime(200);
    let row: RatingRow | null = null;
    for (let i = 0; i < 30 && !(row && TERMINAL.has(row.status)); i++) {
      row = await processRating(ref, fresh);
      w.chain.advanceTime(16);
    }
    expect(row?.status).toBe('confirmed');
    expect(w.chain.sentRaw).toEqual([stored?.payment?.rawTransaction]);
    expect(w.chain.logs.filter((l) => l.address.toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toHaveLength(1);
  });

  it('a submission that never reached the facilitator is re-sent with the same nonce and signature, never re-prepared', async () => {
    const ref = await enqueue(1);
    w.facilitator.queue({ route: 'submit', throws: true });
    await processRating(ref, w.deps);
    const stuck = await w.outbox.get(ref);
    expect(stuck?.status).toBe('submitting');
    expect(stuck?.submission?.lastOutcome).toBe('uncertain');
    const row = await drive(ref);
    expect(row.status).toBe('confirmed');
    expect(w.facilitator.prepares).toBe(1);
    expect(w.facilitator.submits).toBe(2);
    expect(w.facilitator.submitBodies[1].nonce).toBe(w.facilitator.submitBodies[0].nonce);
    expect(w.facilitator.submitBodies[1].signature).toBe(w.facilitator.submitBodies[0].signature);
    expect(w.facilitator.landed).toHaveLength(1);
  });
});

describe('processRating: answers that are not a clean 200', () => {
  it('a 503 after the rating landed is found on-chain: confirmed, one rating, no second prepare', async () => {
    const ref = await enqueue(1);
    w.facilitator.queue({
      route: 'submit',
      status: 503,
      body: { success: false, error: 'writer lease lost', reason: 'forward_failed' },
      land: true,
    });
    const row = await drive(ref);
    expect(row.status).toBe('confirmed');
    expect(w.facilitator.prepares).toBe(1);
    expect(w.facilitator.submits).toBe(1);
    expect(w.facilitator.landed).toHaveLength(1);
    expect(row.transaction).toBe(w.facilitator.landed[0].tx);
  });

  it('an answer that never came, after the rating landed, is reconciled the same way', async () => {
    const ref = await enqueue(1);
    w.facilitator.queue({ route: 'submit', throws: true, land: true });
    const row = await drive(ref);
    expect(row.status).toBe('confirmed');
    expect(w.facilitator.submits).toBe(1);
    expect(w.facilitator.landed).toHaveLength(1);
  });

  it('a 200 with a transaction that never mines goes back to paid only after the deadline, and rates once', async () => {
    const ref = await enqueue(1);
    w.facilitator.queue({ route: 'submit', phantom: true });
    await processRating(ref, w.deps);
    expect((await w.outbox.get(ref))?.status).toBe('submitted');
    // Inside the deadline nothing is prepared again.
    w.chain.advanceTime(600);
    await processRating(ref, w.deps);
    expect(w.facilitator.prepares).toBe(1);
    const row = await drive(ref);
    expect(row.status).toBe('confirmed');
    expect(w.facilitator.prepares).toBe(2);
    expect(w.facilitator.landed).toHaveLength(1);
    expect(w.facilitator.landed[0].nonce).toBe(String(w.facilitator.submitBodies[1].nonce).toLowerCase());
  });

  it('the daily write limit (429) opens the breaker until 00:00 UTC; the row waits and rates once', async () => {
    const ref = await enqueue(1);
    w.facilitator.queue({
      route: 'submit',
      status: 429,
      body: {
        success: false,
        error: 'The daily ERC-8004 write limit for this network has been reached. It resets at 00:00 UTC.',
        code: 'erc8004_daily_write_limit',
        network: 'base',
      },
      headers: { 'Retry-After': '3600' },
    });
    await processRating(ref, w.deps);
    const breaker = await w.governor.breaker();
    expect(breaker.cause).toBe('daily_cap');
    expect(breaker.openUntil).toBe((Math.floor(w.chain.now() / 86400) + 1) * 86400);
    const other = await enqueue(2);
    const refused = await processRating(other, w.deps);
    expect(refused?.status).toBe('queued');
    expect(refused?.error).toBe('breaker_open:daily_cap');
    expect(w.chain.sentRaw).toHaveLength(1);

    // Past the deadline the first row goes back to paid, and waits for the breaker.
    w.chain.advanceTime(1200);
    await processRating(ref, w.deps);
    const waiting = await w.outbox.get(ref);
    expect(waiting?.status).toBe('paid');
    await processRating(ref, w.deps);
    expect(w.facilitator.prepares).toBe(1);

    w.chain.advanceTime(breaker.openUntil - w.chain.now() + 1);
    expect((await drive(ref)).status).toBe('confirmed');
    expect(w.facilitator.prepares).toBe(2);
    expect(w.facilitator.landed).toHaveLength(1);
  });

  it('a proof refused while the facilitator enforces proofs opens the breaker', async () => {
    const ref = await enqueue(1);
    w.facilitator.queue({
      route: 'submit',
      status: 400,
      body: {
        success: false,
        error: 'proof_payer_is_not_rater',
        proof: { rejection: 'payer_is_not_rater', anchor: 'not_declared', enforced: true },
      },
    });
    await processRating(ref, w.deps);
    expect((await w.governor.breaker()).cause).toBe('proof_enforced');
    const row = await w.outbox.get(ref);
    expect(row?.status).toBe('submitting');
    expect(row?.submission?.lastOutcome).toBe('refused');
  });

  it('writes switched off (the route answers 404) opens the breaker on the prepare', async () => {
    const ref = await enqueue(1);
    w.facilitator.queue({ route: 'prepare', status: 404, body: { error: 'not found' } });
    await processRating(ref, w.deps);
    expect((await w.governor.breaker()).cause).toBe('writes_disabled');
    expect((await w.outbox.get(ref))?.status).toBe('paid');
  });
});

describe('processRating: a prepare that asks for something else is never signed', () => {
  const cases: Array<[string, (a: any) => void, string]> = [
    ['a revoke instead of a rating', (a) => (a.typedData.primaryType = 'RelayedRevokeFeedback'), 'primary_type'],
    ['another delegate', (a) => (a.delegate = '0x000000000000000000000000000000000000dEaD'), 'delegate_mismatch'],
    ['another score', (a) => (a.typedData.message.value = '100'), 'field_mismatch'],
    ['another chain', (a) => (a.typedData.domain.chainId = 1), 'domain_chain_id'],
    ['a digest that is not the rating', (a) => (a.digest = '0x' + '5a'.repeat(32)), 'digest_mismatch'],
    ['the v3 opaque hash', (a) => delete a.typedData, 'typed_data_missing'],
  ];
  it.each(cases)('%s', async (_name, tamper, code) => {
    const ref = await enqueue(1);
    w.facilitator.queue({ route: 'prepare', tamper });
    const row = await processRating(ref, w.deps);
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe(code);
    expect(w.facilitator.submits).toBe(0);
    expect(w.logger.lines.some((l) => l.includes('refused to sign a prepare'))).toBe(true);
  });
});

describe('processRating: the subject', () => {
  it('a wallet that does not own the agent named at enqueue is never paid', async () => {
    w.chain.owners.set('1000', w.viewers[1].toLowerCase());
    const ref = messageRef('test:v1', 'stream-1', 'msg-x');
    await w.outbox.enqueue({ ref, network: 'base', subject: w.viewers[0], agentId: 1000, streamId: 'stream-1', value: 90, amount: 1000 });
    const row = await processRating(ref, w.deps);
    expect(row?.status).toBe('local_only');
    expect(row?.error).toBe('identity_owner_mismatch');
    expect(w.chain.sentRaw).toHaveLength(0);
  });

  it('two logins sharing a wallet share its caps', async () => {
    w = world({ caps: { ...worldCaps(), perViewerPerStream: 1 } });
    vi.stubGlobal('fetch', w.facilitator.fetch);
    const a = messageRef('test:v1', 'stream-1', 'a');
    const b = messageRef('test:v1', 'stream-1', 'b');
    for (const [ref, viewerId] of [[a, 'login-a'], [b, 'login-b']]) {
      await w.outbox.enqueue({ ref, network: 'base', subject: w.viewers[0], streamId: 'stream-1', value: 90, amount: 1000, viewerId });
    }
    expect((await drive(a)).status).toBe('confirmed');
    const second = await drive(b);
    expect(second.status).toBe('local_only');
    expect(second.error).toBe('cap_perViewerPerStream');
  });
});

describe('processRating: !forgetme', () => {
  it('deletes what never reached the chain and finishes the rest without the viewer', async () => {
    // Two of the setups below are facilitator failures in a row, which open
    // the breaker by design; this case is about forget, not the breaker.
    w = world({ failureThreshold: 10 });
    vi.stubGlobal('fetch', w.facilitator.fetch);
    // confirmed
    const done = await enqueue(1);
    await drive(done);
    // submitting: the submit never answered
    const sending = await enqueue(2);
    w.facilitator.queue({ route: 'submit', throws: true });
    await processRating(sending, w.deps);
    // paid: the prepare answered 503
    const paid = await enqueue(3);
    w.facilitator.queue({ route: 'prepare', status: 503, body: { success: false, error: 'busy' } });
    await processRating(paid, w.deps);
    // paying: the broadcast failed
    const paying = await enqueue(4);
    w.chain.script('eth_sendRawTransaction', { error: new Error('socket hang up') });
    await processRating(paying, w.deps);
    // queued
    const queued = await enqueue(5);
    expect((await w.outbox.get(sending))?.status).toBe('submitting');
    expect((await w.outbox.get(paid))?.status).toBe('paid');
    expect((await w.outbox.get(paying))?.status).toBe('paying');

    const report = await w.outbox.forget('viewer-0');
    expect(report).toEqual({ deleted: 1, scrubbed: 4, inFlight: 2 });
    expect(await w.outbox.get(queued)).toBeNull();
    expect((await w.outbox.get(paid))?.status).toBe('local_only');
    for (const ref of [done, sending, paid, paying]) {
      const row = await w.outbox.get(ref);
      expect(row?.viewerId).toBeNull();
      expect(row?.payload).toBeNull();
    }

    w.chain.advanceTime(200);
    const finishedPayment = await drive(paying);
    expect(finishedPayment.status).toBe('local_only');
    expect(finishedPayment.error).toBe('forgotten');
    const finishedRating = await drive(sending);
    expect(finishedRating.status).toBe('confirmed');
    // Ratings on-chain: the confirmed one and the one already signed. Nothing new.
    expect(w.facilitator.landed).toHaveLength(2);
  });
});

function worldCaps() {
  return { perViewerPerStream: 100, perViewerPerDay: 100, perViewerLifetime: 100, perStream: 100, perDay: 100, lifetime: 74_000 };
}
