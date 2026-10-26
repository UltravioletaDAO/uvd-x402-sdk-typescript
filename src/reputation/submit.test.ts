/**
 * submitWithReconcile in the corners: how a facilitator answer is classified
 * for the breaker, which `NewFeedback` log is THIS rating, a scan that has to
 * walk the chain in pieces, and a relay transaction that reverted while the
 * rating landed under another one.
 */
import { ethers } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NEW_FEEDBACK_TOPIC,
  REPUTATION_CHAINS,
  classifyFailure,
  matchFeedbackLog,
  messageRef,
  processRating,
  retryDelay,
  submitWithReconcile,
  type RatingRow,
} from './index';
import { REGISTRY, seededSigner, world, type World } from '../../test/reputation/doubles';

const BASE = REPUTATION_CHAINS[0];
const RATER = '0x' + '12'.repeat(20);
const PARAMS = {
  network: 'base',
  agentId: '1000',
  value: 90,
  valueDecimals: 0,
  tag1: 't1',
  tag2: 't2',
  endpoint: 'e',
  feedbackUri: 'u',
  feedbackHash: '0x' + '33'.repeat(32),
};
const pad = (v: string | bigint) => '0x' + (typeof v === 'bigint' ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, '0');

function log(overrides: Record<string, unknown> = {}, data: unknown[] = [4, 90, 0, 't1', 't2', 'e', 'u', PARAMS.feedbackHash]) {
  return {
    address: REGISTRY,
    topics: [NEW_FEEDBACK_TOPIC, pad(1000n), pad(RATER), ethers.id('t1')],
    data: ethers.AbiCoder.defaultAbiCoder().encode(['uint64', 'int128', 'uint8', 'string', 'string', 'string', 'string', 'bytes32'], data),
    removed: false,
    ...overrides,
  };
}

describe('classifyFailure', () => {
  it.each<[string, unknown, unknown]>([
    ['the daily write limit', { status: 429, error: 'Facilitator error: 429 - {"code":"erc8004_daily_write_limit"}' }, { kind: 'daily_cap' }],
    ['another 429', { status: 429, error: 'Facilitator error: 429 - slow down', retryAfterSeconds: 7 }, { kind: 'rate_limited', retryAfterSeconds: 7 }],
    ['a 404 (writes switched off)', { status: 404, error: 'x' }, { kind: 'writes_disabled' }],
    ['a 405', { status: 405 }, { kind: 'writes_disabled' }],
    ['a 503', { status: 503, retryAfterSeconds: 5 }, { kind: 'unavailable', retryAfterSeconds: 5 }],
    ['a 502', { status: 502 }, { kind: 'transient' }],
    ['a 504', { status: 504 }, { kind: 'transient' }],
    ['no answer (timeout)', { success: false, retryable: true }, { kind: 'transient' }],
    ['not even an object', undefined, { kind: 'transient' }],
    ['an enforced proof refusal in the body', { status: 400, error: 'Facilitator error: 400 - {"proof":{"rejection":"expired","enforced":true}}' }, { kind: 'proof_enforced' }],
    ['an enforced proof refusal on a 200', { success: true, proof: { rejection: 'payer_is_not_rater', enforced: true } }, { kind: 'proof_enforced' }],
    ['a proof refusal only measured', { status: 400, error: 'Facilitator error: 400 - {"proof":{"rejection":"expired","enforced":false}}' }, null],
    ['a plain 400', { status: 400, error: 'Facilitator error: 400 - relay_bad_signature' }, null],
  ])('%s', (_name, resp, expected) => {
    expect(classifyFailure(resp)).toEqual(expected);
  });
});

describe('matchFeedbackLog', () => {
  it('returns the feedback index of exactly this rating', () => {
    expect(matchFeedbackLog(log(), BASE, RATER, PARAMS)).toBe(4);
  });

  it.each<[string, Record<string, unknown>, unknown[] | undefined]>([
    ['another registry', { address: '0x8004B663056A597Dffe9eCcC1965A193B7388713' }, undefined],
    ['a removed log', { removed: true }, undefined],
    ['another agent', { topics: [NEW_FEEDBACK_TOPIC, pad(1001n), pad(RATER), ethers.id('t1')] }, undefined],
    ['another rater', { topics: [NEW_FEEDBACK_TOPIC, pad(1000n), pad('0x' + '34'.repeat(20)), ethers.id('t1')] }, undefined],
    ['another event', { topics: [ethers.id('FeedbackRevoked(uint256,address,uint64)'), pad(1000n), pad(RATER), ethers.id('t1')] }, undefined],
    ['three topics', { topics: [NEW_FEEDBACK_TOPIC, pad(1000n), pad(RATER)] }, undefined],
    ['garbage data', { data: '0x1234' }, undefined],
    ['another value', {}, [4, 91, 0, 't1', 't2', 'e', 'u', PARAMS.feedbackHash]],
    ['other decimals', {}, [4, 90, 1, 't1', 't2', 'e', 'u', PARAMS.feedbackHash]],
    ['another tag2', {}, [4, 90, 0, 't1', 'x', 'e', 'u', PARAMS.feedbackHash]],
    ['another endpoint', {}, [4, 90, 0, 't1', 't2', 'x', 'u', PARAMS.feedbackHash]],
    ['another URI', {}, [4, 90, 0, 't1', 't2', 'e', 'x', PARAMS.feedbackHash]],
    ['another hash', {}, [4, 90, 0, 't1', 't2', 'e', 'u', '0x' + '44'.repeat(32)]],
  ])('ignores %s', (_name, overrides, data) => {
    expect(matchFeedbackLog(log(overrides, data), BASE, RATER, PARAMS)).toBeNull();
  });
});

describe('retryDelay', () => {
  it('waits 15 s, 2 min, then 10 min', () => {
    expect([1, 2, 3, 4, 10].map(retryDelay)).toEqual([15, 120, 600, 600, 600]);
    expect(retryDelay(0)).toBe(15);
  });
});

describe('submitWithReconcile on the chain', () => {
  let w: World;
  beforeEach(() => {
    w = world();
    vi.stubGlobal('fetch', w.facilitator.fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    w.facilitator.assertConsumed();
    w.chain.assertConsumed();
  });

  async function rowAt(ref: string, status: RatingRow['status']): Promise<RatingRow> {
    for (let i = 0; i < 20; i++) {
      const row = (await processRating(ref, w.deps)) as RatingRow;
      if (row.status === status) return row;
      w.chain.advanceTime(16);
    }
    throw new Error(`never reached ${status}`);
  }

  async function enqueue(): Promise<string> {
    const ref = messageRef('submit-test', 1);
    await w.outbox.enqueue({ ref, network: 'base', subject: w.viewers[0], streamId: 's', value: 90, amount: 1000 });
    return ref;
  }

  it('walks the chain in pieces, with an overlap, until it finds the rating', async () => {
    const ref = await enqueue();
    w.facilitator.queue({ route: 'submit', throws: true });
    const row = await rowAt(ref, 'submitting');
    const deps = { ...w.deps, scanBlocks: 5 };
    // The rating lands 40 blocks later, through someone else's relay of the same signature.
    w.chain.advance(40);
    const body = w.facilitator.submitBodies[0];
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint64', 'int128', 'uint8', 'string', 'string', 'string', 'string', 'bytes32'],
      [1, body.feedback.value, 0, body.feedback.tag1, body.feedback.tag2, body.feedback.endpoint, body.feedback.feedbackUri, body.feedback.feedbackHash]
    );
    const landed = w.chain.relay([{ address: REGISTRY, topics: [NEW_FEEDBACK_TOPIC, pad(BigInt(body.feedback.agentId)), pad(w.signer.address), ethers.id(body.feedback.tag1)], data }]);
    const cursors: number[] = [row.submission!.scanCursor];
    let current = row;
    // Within the deadline a re-send would also be allowed; hold the clock so only the scan runs.
    for (let i = 0; i < 30 && current.status === 'submitting'; i++) {
      current = await submitWithReconcile(ref, { ...deps, now: () => row.submission!.submittedAt });
      if (current.submission) cursors.push(current.submission.scanCursor);
    }
    expect(current.status).toBe('submitted');
    expect(current.transaction).toBe(landed);
    // Each step advanced by the span minus the overlap, never past what it had read.
    for (let i = 1; i < cursors.length - 1; i++) expect(cursors[i]).toBeGreaterThanOrEqual(cursors[i - 1]);
    expect(w.facilitator.prepares).toBe(1);
  });

  it('a relay that reverted while the rating landed under another transaction: follows the landed one', async () => {
    const ref = await enqueue();
    w.facilitator.queue({ route: 'submit', phantom: true });
    const row = await rowAt(ref, 'submitted');
    const body = w.facilitator.submitBodies[0];
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint64', 'int128', 'uint8', 'string', 'string', 'string', 'string', 'bytes32'],
      [1, body.feedback.value, 0, body.feedback.tag1, body.feedback.tag2, body.feedback.endpoint, body.feedback.feedbackUri, body.feedback.feedbackHash]
    );
    w.chain.relay([], { revert: true, hash: row.transaction as string });
    const landed = w.chain.relay([{ address: REGISTRY, topics: [NEW_FEEDBACK_TOPIC, pad(BigInt(body.feedback.agentId)), pad(w.signer.address), ethers.id(body.feedback.tag1)], data }]);
    w.chain.advance(3);
    let current = row;
    for (let i = 0; i < 5 && current.status !== 'confirmed'; i++) {
      current = await submitWithReconcile(ref, w.deps);
      w.chain.advance(1);
    }
    expect(current.status).toBe('confirmed');
    expect(current.transaction).toBe(landed);
    expect(w.facilitator.prepares).toBe(1);
  });

  it('a relay that reverted with nothing on-chain fails the row for a human, after the deadline', async () => {
    const ref = await enqueue();
    w.facilitator.queue({ route: 'submit', phantom: true });
    const row = await rowAt(ref, 'submitted');
    w.chain.relay([], { revert: true, hash: row.transaction as string });
    let current = await submitWithReconcile(ref, w.deps);
    expect(current.status).toBe('submitted');
    w.chain.advanceTime(1200);
    for (let i = 0; i < 5 && current.status === 'submitted'; i++) current = await submitWithReconcile(ref, w.deps);
    expect(current.status).toBe('failed');
    expect(current.error).toBe('relay_reverted');
    expect(w.facilitator.prepares).toBe(1);
  });

  it('waits for the confirmations before calling a rating confirmed', async () => {
    const ref = await enqueue();
    const first = (await processRating(ref, w.deps)) as RatingRow;
    expect(first.status).toBe('submitted'); // mined in one block: one confirmation of two
    expect(first.feedbackIndex).toBeNull();
    expect((await submitWithReconcile(ref, w.deps)).status).toBe('submitted');
    w.chain.advance(1);
    const done = await submitWithReconcile(ref, w.deps);
    expect(done.status).toBe('confirmed');
    expect(done.feedbackIndex).toBe(1);
  });

  it('a payment older than the facilitator accepts is never spent on a prepare', async () => {
    const ref = await enqueue();
    w.facilitator.queue({ route: 'prepare', status: 503, body: { success: false } });
    expect((await processRating(ref, w.deps))?.status).toBe('paid');
    w.chain.advanceTime(7 * 86400 - 3600 + 2);
    const row = await processRating(ref, w.deps);
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('proof_expired');
    expect(w.facilitator.prepares).toBe(1);
  });

  it('a payment made by another rater (the key changed) is never used for this rater\'s rating', async () => {
    const ref = await enqueue();
    w.facilitator.queue({ route: 'prepare', status: 503, body: { success: false } });
    expect((await processRating(ref, w.deps))?.status).toBe('paid');
    w.chain.advanceTime(200);
    const rotated = { ...w.deps, signer: seededSigner('uvd-x402 reputation rotated rater') };
    const row = await processRating(ref, rotated);
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('payer_is_not_rater');
    expect(w.facilitator.prepares).toBe(1);
  });

  it('an agent the rated wallet does not own fails the row before any prepare', async () => {
    const ref = await enqueue();
    w.chain.owners.set('1000', w.viewers[2].toLowerCase());
    const row = await processRating(ref, w.deps);
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('identity_owner_mismatch');
    expect(w.facilitator.prepares).toBe(0);
  });

  it('leaves a row it has nothing to do for untouched', async () => {
    const ref = await enqueue();
    expect((await submitWithReconcile(ref, w.deps)).status).toBe('queued');
    await expect(submitWithReconcile(messageRef('nothing', 1), w.deps)).rejects.toMatchObject({ code: 'row_missing' });
  });

  it('a paid row without its feedback and no way to build it waits with feedback_missing', async () => {
    const ref = await enqueue();
    const deps = { ...w.deps, buildFeedback: undefined };
    w.facilitator.queue({ route: 'prepare', status: 503, body: { success: false } });
    await processRating(ref, w.deps); // pays, builds the feedback, the prepare answers 503
    const row = await w.outbox.get(ref);
    expect(row?.status).toBe('paid');
    expect(row?.feedback).not.toBeNull();
    // A second row paid with no builder at all.
    const other = messageRef('submit-test', 2);
    await w.outbox.enqueue({ ref: other, network: 'base', subject: w.viewers[1], streamId: 's', value: 90, amount: 1000 });
    w.chain.advanceTime(200);
    const result = await processRating(other, deps);
    expect(result?.status).toBe('paid');
    expect(result?.error).toBe('feedback_missing');
  });
});

describe('the doubles go red when a scripted answer is never used', () => {
  it('FakeFacilitator', () => {
    const w = world();
    w.facilitator.queue({ route: 'submit', status: 503 });
    expect(() => w.facilitator.assertConsumed()).toThrow(/never used/);
  });

  it('FakeChain', () => {
    const w = world();
    w.chain.script('eth_getLogs', { result: [] });
    expect(() => w.chain.assertConsumed()).toThrow(/never used/);
  });
});
