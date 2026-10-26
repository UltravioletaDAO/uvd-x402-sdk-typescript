/**
 * One contract, two adapters: every rule of the outbox runs against
 * MemoryRatingOutbox and against SqliteRatingOutbox on a real better-sqlite3
 * database. The SQLite file case also reopens the file, which is what a
 * restart looks like.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MemoryRatingOutbox,
  ReputationError,
  SqliteRatingOutbox,
  messageRef,
  type NewRating,
  type RatingOutbox,
  type RatingRow,
  type SignedPayment,
  type Submission,
} from './index';
import { seededAddress } from '../../test/reputation/doubles';

const DIR = mkdtempSync(join(tmpdir(), 'uvd-reputation-outbox-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

let clock = 1_793_000_000;
const now = () => clock;
const SUBJECT = seededAddress('uvd-x402 reputation outbox viewer');
const TX = '0x' + 'ab'.repeat(32);

const PAYMENT: SignedPayment = {
  network: 'base',
  chainId: 8453,
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payer: seededAddress('rater'),
  payee: SUBJECT,
  amount: '1000',
  nonce: 0,
  rawTransaction: '0x02abcdef',
  transactionHash: TX,
};
const PROOF = {
  transactionHash: TX,
  blockNumber: 1,
  network: 'base',
  payer: PAYMENT.payer,
  payee: SUBJECT,
  amount: '1000',
  token: PAYMENT.token,
  timestamp: clock,
  paymentHash: '0x' + '11'.repeat(32),
};
const FEEDBACK = {
  agentId: '7',
  valueDecimals: 0,
  tag1: 't1',
  tag2: 't2',
  endpoint: 'e',
  feedbackUri: 'u',
  feedbackHash: '0x' + '22'.repeat(32),
};
const SUBMISSION: Submission = {
  rater: PAYMENT.payer,
  nonce: '0x' + '33'.repeat(32),
  deadline: clock + 900,
  signature: '0x' + '44'.repeat(65),
  authorization: null,
  scanFromBlock: 1,
  scanCursor: 1,
  submittedAt: clock,
  sends: 0,
  lastOutcome: null,
};

const rating = (n: number, extra: Partial<NewRating> = {}): NewRating => ({
  ref: messageRef('outbox-test', 's', n),
  network: 'base',
  subject: SUBJECT,
  streamId: 'stream-1',
  value: 90,
  amount: 1000,
  viewerId: 'viewer-1',
  payload: { kind: 'idea', quote: 'local only' },
  ...extra,
});

async function walk(o: RatingOutbox, ref: string, to: RatingRow['status']): Promise<RatingRow> {
  const steps: Array<[RatingRow['status'], Record<string, unknown>]> = [
    ['queued', { status: 'paying', payment: PAYMENT }],
    ['paying', { status: 'paid', proof: PROOF }],
    ['paid', { feedback: FEEDBACK }],
    ['paid', { status: 'submitting', submission: SUBMISSION }],
    ['submitting', { status: 'submitted', transaction: TX }],
    ['submitted', { status: 'confirmed', feedbackIndex: 1, confirmedAt: clock }],
  ];
  let row = (await o.get(ref)) as RatingRow;
  for (const [from, patch] of steps) {
    // `paid` is reached with its feedback set: `submitting` needs it.
    if (row.status === to && (to !== 'paid' || row.feedback !== null)) break;
    if (row.status !== from || (from === 'paid' && 'feedback' in patch && row.feedback !== null)) continue;
    row = (await o.transition(ref, from, patch as any)) as RatingRow;
    expect(row).not.toBeNull();
  }
  expect(row.status).toBe(to);
  return row;
}

const adapters: Array<[string, () => RatingOutbox]> = [
  ['MemoryRatingOutbox', () => new MemoryRatingOutbox({ now })],
  ['SqliteRatingOutbox', () => new SqliteRatingOutbox(new Database(':memory:'), { now })],
];

describe.each(adapters)('%s', (_name, make) => {
  it('enqueues once per ref', async () => {
    const o = make();
    expect(await o.enqueue(rating(1))).toBe('inserted');
    expect(await o.enqueue(rating(1, { value: 50 }))).toBe('duplicate');
    expect((await o.get(rating(1).ref))?.value).toBe(90);
    expect(await o.get(messageRef('outbox-test', 'nothing'))).toBeNull();
  });

  it('validates what it enqueues', async () => {
    const o = make();
    for (const bad of [
      { ref: 'not-a-message-ref' },
      { network: 'avalanche' },
      { subject: 'nope' },
      { streamId: '' },
      { value: 1.5 },
      { amount: 0 },
      { viewerId: '' },
      { agentId: -1 },
    ]) {
      await expect(o.enqueue(rating(2, bad as Partial<NewRating>))).rejects.toBeInstanceOf(ReputationError);
    }
  });

  it('moves a row through the whole machine, one compare-and-set at a time', async () => {
    const o = make();
    await o.enqueue(rating(1));
    const row = await walk(o, rating(1).ref, 'confirmed');
    expect(row.startedAt).toBe(clock);
    expect(row.subject).toBe(SUBJECT.toLowerCase());
    expect(row.feedbackIndex).toBe(1);
  });

  it('loses a compare-and-set quietly: null, and the row unchanged', async () => {
    const o = make();
    await o.enqueue(rating(1));
    await o.transition(rating(1).ref, 'queued', { status: 'paying', payment: PAYMENT });
    expect(await o.transition(rating(1).ref, 'queued', { status: 'paying', payment: { ...PAYMENT, nonce: 1 } })).toBeNull();
    expect((await o.get(rating(1).ref))?.payment?.nonce).toBe(0);
  });

  it.each<[string, RatingRow['status'], RatingRow['status'], Record<string, unknown>]>([
    ['back to queued from paying', 'paying', 'paying', { status: 'queued' }],
    ['paying without a payment', 'queued', 'queued', { status: 'paying' }],
    ['paid without a proof', 'paying', 'paying', { status: 'paid' }],
    ['submitting without a submission', 'paid', 'paid', { status: 'submitting' }],
    ['submitted without a transaction', 'submitting', 'submitting', { status: 'submitted' }],
    ['anything after confirmed', 'confirmed', 'confirmed', { status: 'failed' }],
    ['a field no transition writes', 'queued', 'queued', { viewerId: null }],
    ['submitted back to submitting', 'submitted', 'submitted', { status: 'submitting' }],
  ])('refuses %s', async (_name, at, from, patch) => {
    const o = make();
    await o.enqueue(rating(1));
    await walk(o, rating(1).ref, at);
    await expect(o.transition(rating(1).ref, from, patch as any)).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('never replaces a stored payment, proof or signed submission', async () => {
    const o = make();
    await o.enqueue(rating(1));
    const ref = rating(1).ref;
    await walk(o, ref, 'paying');
    await expect(o.transition(ref, 'paying', { payment: { ...PAYMENT, rawTransaction: '0x02ff' } })).rejects.toMatchObject({ code: 'invalid_transition' });
    await walk(o, ref, 'paid');
    await expect(o.transition(ref, 'paid', { proof: { ...PROOF, amount: '9' } })).rejects.toMatchObject({ code: 'invalid_transition' });
    await walk(o, ref, 'submitting');
    for (const change of [{ nonce: '0x' + '99'.repeat(32) }, { signature: '0x' + '55'.repeat(65) }, { deadline: clock + 1 }, { rater: SUBJECT }]) {
      await expect(o.transition(ref, 'submitting', { submission: { ...SUBMISSION, ...change } })).rejects.toMatchObject({ code: 'invalid_transition' });
    }
    // The scan cursor may move.
    expect((await o.transition(ref, 'submitting', { submission: { ...SUBMISSION, scanCursor: 9 } }))?.submission?.scanCursor).toBe(9);
  });

  it('stores the feedback and the agent once: a second value is refused', async () => {
    const o = make();
    await o.enqueue(rating(1));
    const ref = rating(1).ref;
    await expect(o.transition(ref, 'queued', { agentId: 7 as unknown as string })).rejects.toMatchObject({ code: 'invalid_transition' });
    expect((await o.transition(ref, 'queued', { agentId: '7' }))?.agentId).toBe('7');
    expect(await o.transition(ref, 'queued', { agentId: '7' })).not.toBeNull();
    await expect(o.transition(ref, 'queued', { agentId: '8' })).rejects.toMatchObject({ code: 'invalid_transition' });
    await walk(o, ref, 'paid');
    await expect(o.transition(ref, 'paid', { feedback: { ...FEEDBACK, feedbackUri: 'other' } })).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect((await o.transition(ref, 'paid', { feedback: { ...FEEDBACK } }))?.feedback).toEqual(FEEDBACK);
  });

  it('goes back to paid only by clearing the submission and the transaction', async () => {
    const o = make();
    await o.enqueue(rating(1));
    const ref = rating(1).ref;
    await walk(o, ref, 'submitting');
    await expect(o.transition(ref, 'submitting', { status: 'paid' })).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(o.transition(ref, 'submitting', { status: 'paid', submission: null })).rejects.toMatchObject({ code: 'invalid_transition' });
    const back = await o.transition(ref, 'submitting', { status: 'paid', submission: null, transaction: null, error: 'relay_expired' });
    expect(back?.status).toBe('paid');
    expect(back?.submission).toBeNull();
    expect(back?.payment?.transactionHash).toBe(TX);
  });

  it('counts by wallet, stream, day and admission', async () => {
    const o = make();
    await o.enqueue(rating(1));
    await o.enqueue(rating(2, { streamId: 'stream-2' }));
    await o.enqueue(rating(3, { subject: seededAddress('another viewer') }));
    await walk(o, rating(1).ref, 'paying');
    clock += 86400;
    await walk(o, rating(2).ref, 'paying');
    expect(await o.count({ admitted: true })).toBe(2);
    expect(await o.count({ admitted: true, subject: SUBJECT.toUpperCase().replace('0X', '0x') })).toBe(2);
    expect(await o.count({ admitted: true, streamId: 'stream-1' })).toBe(1);
    expect(await o.count({ since: clock })).toBe(1);
    expect(await o.count({ statuses: ['queued'] })).toBe(1);
    expect(await o.count({ statuses: [] })).toBe(0);
    expect(await o.count({})).toBe(3);
  });

  it('serves due rows in-flight first, then by time', async () => {
    const o = make();
    for (const n of [1, 2, 3]) await o.enqueue(rating(n));
    await walk(o, rating(3).ref, 'paying');
    await o.transition(rating(2).ref, 'queued', { nextAttemptAt: clock + 100 });
    const due = await o.due(clock, 10);
    expect(due.map((r) => r.ref)).toEqual([rating(3).ref, rating(1).ref]);
    expect((await o.due(clock + 100, 1)).map((r) => r.ref)).toEqual([rating(3).ref]);
    expect(await o.due(clock, 0)).toEqual([]);
  });

  it('forgets a viewer: deletes what never left, scrubs the rest, keeps the counts', async () => {
    const o = make();
    for (const n of [1, 2, 3, 4]) await o.enqueue(rating(n));
    await o.enqueue(rating(5, { viewerId: 'someone-else' }));
    await walk(o, rating(2).ref, 'paying');
    await walk(o, rating(3).ref, 'paid');
    await walk(o, rating(4).ref, 'confirmed');
    const before = await o.count({ admitted: true, subject: SUBJECT });
    expect(await o.forget('viewer-1')).toEqual({ deleted: 1, scrubbed: 3, inFlight: 1 });
    expect(await o.get(rating(1).ref)).toBeNull();
    const paying = await o.get(rating(2).ref);
    expect([paying?.status, paying?.forgotten, paying?.viewerId, paying?.payload]).toEqual(['paying', true, null, null]);
    expect((await o.get(rating(3).ref))?.status).toBe('local_only');
    expect((await o.get(rating(4).ref))?.status).toBe('confirmed');
    expect((await o.get(rating(5).ref))?.viewerId).toBe('someone-else');
    expect(await o.count({ admitted: true, subject: SUBJECT })).toBe(before);
    expect(await o.forget('viewer-1')).toEqual({ deleted: 0, scrubbed: 0, inFlight: 0 });
    expect(await o.forget('')).toEqual({ deleted: 0, scrubbed: 0, inFlight: 0 });
    // A forgotten paid row is never submitted.
    await expect(o.transition(rating(2).ref, 'paying', { status: 'paid', proof: PROOF })).resolves.not.toBeNull();
    await expect(
      o.transition(rating(2).ref, 'paid', { status: 'submitting', submission: SUBMISSION, feedback: FEEDBACK })
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('keeps a small key/value state', async () => {
    const o = make();
    expect(await o.getState('k')).toBeNull();
    await o.setState('k', 'v1');
    await o.setState('k', 'v2');
    expect(await o.getState('k')).toBe('v2');
  });

  it('hands out copies: editing a returned row changes nothing stored', async () => {
    const o = make();
    await o.enqueue(rating(1));
    const row = (await o.get(rating(1).ref)) as RatingRow;
    row.status = 'confirmed';
    (row.payload as Record<string, unknown>).kind = 'changed';
    expect((await o.get(rating(1).ref))?.status).toBe('queued');
    expect((await o.get(rating(1).ref))?.payload).toEqual({ kind: 'idea', quote: 'local only' });
  });
});

describe('SqliteRatingOutbox on a file', () => {
  it('survives a reopen: a restart sees every row and the state', async () => {
    const path = join(DIR, 'reopen.db');
    const first = new Database(path);
    const a = new SqliteRatingOutbox(first, { now });
    await a.enqueue(rating(1));
    await walk(a, rating(1).ref, 'paying');
    await a.setState('breaker', '{"x":1}');
    first.close();

    const second = new Database(path);
    const b = new SqliteRatingOutbox(second, { now });
    expect((await b.get(rating(1).ref))?.payment?.rawTransaction).toBe(PAYMENT.rawTransaction);
    expect(await b.enqueue(rating(1))).toBe('duplicate');
    expect(await b.getState('breaker')).toBe('{"x":1}');
    second.close();
  });

  it('two connections to one file: the second compare-and-set loses', async () => {
    const path = join(DIR, 'race.db');
    const one = new Database(path);
    const two = new Database(path);
    const a = new SqliteRatingOutbox(one, { now });
    const b = new SqliteRatingOutbox(two, { now });
    await a.enqueue(rating(1));
    expect(await a.transition(rating(1).ref, 'queued', { status: 'paying', payment: PAYMENT })).not.toBeNull();
    expect(await b.transition(rating(1).ref, 'queued', { status: 'paying', payment: { ...PAYMENT, nonce: 7 } })).toBeNull();
    expect((await b.get(rating(1).ref))?.payment?.nonce).toBe(0);
    one.close();
    two.close();
  });

  it('lives beside the program\'s own tables and leaves user_version alone', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE moments (id TEXT PRIMARY KEY); PRAGMA user_version = 5;');
    const o = new SqliteRatingOutbox(db, { now });
    await o.enqueue(rating(1));
    expect(db.pragma('user_version', { simple: true })).toBe(5);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'uvd_reputation_%' AND type = 'table'").get()).toEqual({ n: 2 });
  });

  it('refuses a connection whose commits a power cut could undo (synchronous below FULL)', () => {
    for (const level of ['OFF', 'NORMAL']) {
      const db = new Database(':memory:');
      db.pragma(`synchronous = ${level}`);
      expect(() => new SqliteRatingOutbox(db, { now })).toThrow(ReputationError);
    }
    const extra = new Database(':memory:');
    extra.pragma('synchronous = EXTRA');
    expect(() => new SqliteRatingOutbox(extra, { now })).not.toThrow();
  });

  it('refuses tables of another schema version', () => {
    const db = new Database(':memory:');
    new SqliteRatingOutbox(db, { now });
    db.prepare("UPDATE uvd_reputation_state SET value = '2' WHERE key = 'uvd_reputation.schema'").run();
    expect(() => new SqliteRatingOutbox(db, { now })).toThrow(ReputationError);
  });
});
