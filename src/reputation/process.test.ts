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
import { ethers } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Erc8004Client } from '../backend';
import { Governor, messageRef, processRating, type RatingRow } from './index';
import {
  FACILITATOR,
  OPEN_CAPS,
  RATER_SEED,
  delegateNonceSlot,
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

  it('one anchor payment in flight at a time: a second row waits instead of racing for the same account nonce', async () => {
    const first = await enqueue(1);
    w.chain.script('eth_sendRawTransaction', { error: new Error('socket hang up') });
    await processRating(first, w.deps);
    const stored = await w.outbox.get(first);
    expect(stored?.status).toBe('paying');
    const second = await enqueue(2);
    const waiting = await processRating(second, w.deps);
    expect(waiting?.status).toBe('queued');
    expect(waiting?.error).toBe('payment_in_flight');
    expect(waiting?.payment).toBeNull();
    expect(w.chain.sentRaw).toHaveLength(0);
    // Once the first payment is through, the second pays with the next nonce.
    w.chain.advanceTime(200);
    expect((await drive(first)).status).toBe('confirmed');
    expect((await drive(second)).status).toBe('confirmed');
    expect(w.chain.sentRaw).toEqual([stored?.payment?.rawTransaction, expect.any(String)]);
    expect(ethers.Transaction.from(w.chain.sentRaw[1]).nonce).toBe(stored!.payment!.nonce + 1);
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

describe('processRating: the logs are not the only witness', () => {
  it('a lagging log node past the deadline: the spent nonce keeps the row from a second prepare', async () => {
    const ref = await enqueue(1);
    // The rating lands, the answer never comes, and the next three log reads come back empty.
    w.facilitator.queue({ route: 'submit', throws: true, land: true });
    for (let i = 0; i < 3; i++) w.chain.script('eth_getLogs', { result: [] });
    await processRating(ref, w.deps);
    expect((await w.outbox.get(ref))?.status).toBe('submitting');
    w.chain.advanceTime(1200); // past the deadline and its grace
    const unseen = await processRating(ref, w.deps);
    expect(unseen?.status).toBe('submitting');
    expect(unseen?.error).toBe('relay_landed_unseen');
    expect(unseen?.submission?.scanCursor).toBe(unseen?.submission?.scanFromBlock);
    const row = await drive(ref);
    expect(row.status).toBe('confirmed');
    expect(w.facilitator.prepares).toBe(1);
    expect(w.facilitator.landed).toHaveLength(1);
  });

  it('a delegation revoked after the rating landed: the storage still says spent, so no second prepare', async () => {
    const ref = await enqueue(1);
    w.facilitator.queue({ route: 'submit', throws: true, land: true });
    for (let i = 0; i < 3; i++) w.chain.script('eth_getLogs', { result: [] });
    await processRating(ref, w.deps);
    // The emergency exit: an authorization to address(0) removes the code; the storage stays.
    w.chain.code.delete(w.signer.address.toLowerCase());
    w.chain.advanceTime(1200);
    const unseen = await processRating(ref, w.deps);
    expect(unseen).toMatchObject({ status: 'submitting', error: 'relay_landed_unseen' });
    expect((await drive(ref)).status).toBe('confirmed');
    expect(w.facilitator.prepares).toBe(1);
    expect(w.facilitator.landed).toHaveLength(1);
  });

  it('a nonce cell holding neither 0 nor 1: the row waits, it is never prepared again', async () => {
    const ref = await enqueue(1);
    w.facilitator.queue({ route: 'submit', phantom: true });
    await processRating(ref, w.deps);
    const nonce = (await w.outbox.get(ref))!.submission!.nonce;
    w.chain.setStorage(w.signer.address, delegateNonceSlot(nonce), '0x' + '00'.repeat(31) + '02');
    w.chain.advanceTime(1200);
    for (let i = 0; i < 3; i++) {
      await processRating(ref, w.deps);
      w.chain.advanceTime(16);
    }
    const row = await w.outbox.get(ref);
    expect(row).toMatchObject({ status: 'submitted', error: 'relay_outcome_unknown' });
    expect(w.facilitator.prepares).toBe(1);
  });

  it('a spent nonce whose rating the logs never show goes to a human after a day, never to a new prepare', async () => {
    const ref = await enqueue(1);
    w.facilitator.queue({ route: 'submit', throws: true, land: true });
    // A provider that does not serve the logs (or a nonce cancelled by hand): the log is not there.
    w.chain.script('eth_getLogs', { result: [] });
    const before = w.chain.logs.length;
    await processRating(ref, w.deps);
    w.chain.logs.splice(before);
    w.chain.advanceTime(1200);
    expect(await processRating(ref, w.deps)).toMatchObject({ status: 'submitting', error: 'relay_landed_unseen' });
    w.chain.advanceTime(86_400);
    // The rescan walks the day's blocks again from the first one, then gives up.
    expect(await drive(ref)).toMatchObject({ status: 'failed', error: 'relay_landed_unseen' });
    expect(w.facilitator.prepares).toBe(1);
  });
});

describe('processRating: one feedback per signature', () => {
  it('two workers building the feedback at once: one is stored, and it is the one signed and sent', async () => {
    const ref = await enqueue(1);
    let calls = 0;
    const flaky = {
      ...w.deps,
      buildFeedback: async (row: RatingRow) => {
        calls += 1;
        if (calls === 1) throw new Error('storage not ready');
        await new Promise((r) => setTimeout(r, 5));
        return { ...(await w.deps.buildFeedback!(row)), feedbackUri: `https://evidence.test/${ref}/${calls}.json` };
      },
    };
    expect((await processRating(ref, flaky))?.feedback).toBeNull(); // paid, no feedback yet
    w.chain.advanceTime(200);
    // A second outbox object over the same rows: what another process would be.
    const other = { ...flaky, outbox: Object.create(w.outbox) };
    await Promise.all([processRating(ref, flaky), processRating(ref, other)]);
    const row = await drive(ref);
    expect(row.status).toBe('confirmed');
    expect(w.facilitator.submits).toBe(1);
    expect(w.facilitator.submitBodies[0].feedback.feedbackUri).toBe(row.feedback?.feedbackUri);
    expect(w.facilitator.landed).toHaveLength(1);
  });

  it('one process never ticks one row twice at once: the second and third calls do nothing', async () => {
    const ref = await enqueue(1);
    let resolved = 0;
    const counting = { ...w.deps, resolveAgent: (row: RatingRow) => (resolved++, w.deps.resolveAgent!(row)) };
    const [first, second, third] = await Promise.all([
      processRating(ref, counting),
      processRating(ref, counting),
      processRating(ref, counting),
    ]);
    expect(resolved).toBe(1);
    expect(w.chain.sentRaw).toHaveLength(1);
    expect(first?.status).toBe('submitted');
    // The two that found the row busy did nothing: they answered with the row as it was.
    expect(second?.status).toBe('queued');
    expect(third?.status).toBe('queued');
  });

  it('a feedback naming another agent than the one resolved is refused, never prepared', async () => {
    const ref = await enqueue(1);
    w.chain.owners.set('1001', w.viewers[0].toLowerCase()); // the wallet owns two agents
    const other = { ...w.deps, buildFeedback: async (row: RatingRow) => ({ ...(await w.deps.buildFeedback!(row)), agentId: 1001 }) };
    const row = await processRating(ref, other);
    expect(row).toMatchObject({ status: 'paid', error: 'invalid_input', agentId: '1000' });
    expect(row?.feedback).toBeNull();
    expect(w.facilitator.prepares).toBe(0);
  });
});

describe('processRating: nobody is paid who cannot be rated', () => {
  it('no agent at enqueue and no resolveAgent: the row waits, nothing is paid', async () => {
    const ref = await enqueue(1);
    const row = await processRating(ref, { ...w.deps, resolveAgent: undefined });
    expect(row?.status).toBe('queued');
    expect(row?.error).toBe('agent_unknown');
    expect(w.chain.sentRaw).toHaveLength(0);
  });

  it('a wallet with no agent ends local_only, unpaid', async () => {
    const ref = await enqueue(1);
    const row = await processRating(ref, { ...w.deps, resolveAgent: () => null });
    expect(row?.status).toBe('local_only');
    expect(row?.error).toBe('no_agent');
    expect(w.chain.sentRaw).toHaveLength(0);
  });

  it('an amount above maxAmountPerRating, or a value above maxValue, is never paid', async () => {
    const big = messageRef('test:v1', 'stream-1', 'big');
    await w.outbox.enqueue({ ref: big, network: 'base', subject: w.viewers[0], streamId: 'stream-1', value: 90, amount: 10_001 });
    expect(await processRating(big, w.deps)).toMatchObject({ status: 'local_only', error: 'cap_maxAmountPerRating' });
    const hundred = messageRef('test:v1', 'stream-1', 'hundred');
    await w.outbox.enqueue({ ref: hundred, network: 'base', subject: w.viewers[0], streamId: 'stream-1', value: 100, amount: 1000 });
    expect(await processRating(hundred, w.deps)).toMatchObject({ status: 'local_only', error: 'cap_maxValue' });
    expect(w.chain.sentRaw).toHaveLength(0);
  });

  it('a first rating\'s authorization in flight holds the next payment, which would void it', async () => {
    const first = await enqueue(1);
    w.facilitator.queue({ route: 'submit', throws: true });
    await processRating(first, w.deps);
    const pending = await w.outbox.get(first);
    expect(pending?.status).toBe('submitting');
    expect(pending?.submission?.authorization).not.toBeNull();
    const second = await enqueue(2);
    const held = await processRating(second, w.deps);
    expect(held).toMatchObject({ status: 'queued', error: 'authorization_in_flight' });
    expect(w.chain.sentRaw).toHaveLength(1);
    // The re-send lands with the authorization; then the second pays.
    expect((await drive(first)).status).toBe('confirmed');
    expect((await drive(second)).status).toBe('confirmed');
    expect(w.facilitator.landed).toHaveLength(2);
  });
});

describe('processRating: a payment\'s nonce taken by another transaction', () => {
  it('is waited out for an hour from the first time it is seen, then fails the row for a human', async () => {
    const ref = await enqueue(1);
    w.chain.script('eth_sendRawTransaction', { error: new Error('socket hang up') });
    await processRating(ref, w.deps);
    // Another transaction of the rater mines with that nonce; ours is unknown to the node.
    w.chain.consumeNonce(w.signer.address);
    // A restart well over an hour after the signature: the hour starts now, not at signing.
    w.chain.advanceTime(5000);
    const waiting = await processRating(ref, w.deps);
    expect(waiting).toMatchObject({ status: 'paying', error: 'payment_nonce_consumed', consumedSince: w.chain.now() });
    w.chain.advanceTime(1800);
    expect(await processRating(ref, w.deps)).toMatchObject({ status: 'paying' });
    w.chain.advanceTime(1800);
    expect(await processRating(ref, w.deps)).toMatchObject({ status: 'failed', error: 'payment_nonce_consumed' });
  });
});

describe('processRating: a first rating and a payment never share the account nonce', () => {
  it('a first rating is not prepared while a payment is in flight', async () => {
    const first = await enqueue(1);
    w.facilitator.queue({ route: 'prepare', status: 400, body: { success: false, error: 'not now' } });
    expect((await processRating(first, w.deps))?.status).toBe('paid'); // never delegated yet
    const second = await enqueue(2);
    w.chain.script('eth_sendRawTransaction', { error: new Error('socket hang up') });
    expect((await processRating(second, w.deps))?.status).toBe('paying');
    w.chain.advanceTime(200);
    const held = await processRating(first, w.deps);
    expect(held).toMatchObject({ status: 'paid', error: 'payment_in_flight' });
    expect(w.facilitator.prepares).toBe(1);
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
    w = world({ caps: { ...OPEN_CAPS, perViewerPerStream: 1 } });
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
    // paid: the prepare answered 400
    const paid = await enqueue(3);
    w.facilitator.queue({ route: 'prepare', status: 400, body: { success: false, error: 'not now' } });
    await processRating(paid, w.deps);
    // paying: the broadcast failed
    const paying = await enqueue(4);
    w.chain.script('eth_sendRawTransaction', { error: new Error('socket hang up') });
    await processRating(paying, w.deps);
    // queued
    const queued = await enqueue(5);
    expect((await w.outbox.get(sending))?.status).toBe('submitting');
    expect((await w.outbox.get(paid))?.status).toBe('paid');
    expect((await w.outbox.get(paying))?.error).toBe('payment_broadcast_failed');
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
