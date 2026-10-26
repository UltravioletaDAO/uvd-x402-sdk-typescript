/**
 * The governor: caps are parameters, the campaign cut is read live, the
 * breaker opens on what the plan names and survives a restart, and anything
 * it cannot read refuses.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  Governor,
  MemoryRatingOutbox,
  ReputationError,
  describeNetHealth,
  messageRef,
  nextUtcMidnight,
  type RatingOutbox,
  type ReputationCaps,
} from './index';
import { seededAddress } from '../../test/reputation/doubles';

const T0 = 1_793_000_000; // 2026-10-26T... UTC, mid-day
const A = seededAddress('governor viewer a');
const B = seededAddress('governor viewer b');
const CAPS: ReputationCaps = {
  perViewerPerStream: 3,
  perViewerPerDay: 3,
  perViewerLifetime: 15,
  perStream: 25,
  perDay: 60,
  lifetime: 74_000,
};
const PAYMENT = {
  network: 'base',
  chainId: 8453,
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payer: seededAddress('rater'),
  payee: A,
  amount: '1000',
  nonce: 0,
  rawTransaction: '0x02',
  transactionHash: '0x' + 'ab'.repeat(32),
};

let n = 0;
async function admitted(o: RatingOutbox, subject: string, streamId: string): Promise<void> {
  n += 1;
  const ref = messageRef('governor-test', n);
  await o.enqueue({ ref, network: 'base', subject, streamId, value: 90, amount: 1000 });
  await o.transition(ref, 'queued', { status: 'paying', payment: PAYMENT });
}

function setup(caps: Partial<ReputationCaps> = {}, health: (() => any) | null = () => ({ campaignPerRater: 20 })) {
  let clock = T0;
  const now = () => clock;
  const outbox = new MemoryRatingOutbox({ now });
  const governor = new Governor({ ...CAPS, ...caps }, health, { store: outbox, now });
  return { outbox, governor, tick: (s: number) => (clock += s), now };
}

describe('Governor caps', () => {
  it('takes every cap as a parameter and refuses a missing or negative one', () => {
    const store = new MemoryRatingOutbox();
    const { lifetime: _lifetime, ...missing } = CAPS;
    expect(() => new Governor(missing as ReputationCaps, null, { store })).toThrow(ReputationError);
    expect(() => new Governor({ ...CAPS, perDay: -1 }, null, { store })).toThrow(ReputationError);
    expect(() => new Governor({ ...CAPS, perDay: 1.5 }, null, { store })).toThrow(ReputationError);
    expect(() => new Governor(CAPS, 'yes' as any, { store })).toThrow(ReputationError);
    expect(() => new Governor(CAPS, null, {} as any)).toThrow(ReputationError);
  });

  it.each<[keyof ReputationCaps, boolean]>([
    ['perViewerPerStream', true],
    ['perViewerLifetime', true],
    ['perStream', true],
    ['lifetime', true],
    ['perViewerPerDay', false],
    ['perDay', false],
  ])('%s: final=%s', async (cap, final) => {
    const { outbox, governor, now } = setup({ [cap]: 2 });
    await admitted(outbox, A, 'stream-1');
    expect(await governor.admit({ subject: A, streamId: 'stream-1' })).toEqual({ ok: true });
    await admitted(outbox, A, 'stream-1');
    const refusal = await governor.admit({ subject: A, streamId: 'stream-1' });
    expect(refusal).toEqual(
      final ? { ok: false, reason: `cap_${cap}`, final: true } : { ok: false, reason: `cap_${cap}`, retryAt: nextUtcMidnight(now()), final: false }
    );
  });

  it('counts the wallet, not the login, and other wallets and streams separately', async () => {
    const { outbox, governor } = setup({ perViewerPerStream: 1, perStream: 2 });
    await admitted(outbox, A, 'stream-1');
    expect((await governor.admit({ subject: A.toLowerCase(), streamId: 'stream-1' })).ok).toBe(false);
    expect((await governor.admit({ subject: B, streamId: 'stream-1' })).ok).toBe(true);
    expect((await governor.admit({ subject: A, streamId: 'stream-2' })).ok).toBe(true);
    await admitted(outbox, B, 'stream-1');
    expect(await governor.admit({ subject: seededAddress('c'), streamId: 'stream-1' })).toMatchObject({ reason: 'cap_perStream' });
  });

  it('the per-day caps start over at 00:00 UTC', async () => {
    const { outbox, governor, tick, now } = setup({ perDay: 1 });
    await admitted(outbox, A, 'stream-1');
    expect((await governor.admit({ subject: B, streamId: 'stream-2' })).ok).toBe(false);
    tick(nextUtcMidnight(now()) - now());
    expect((await governor.admit({ subject: B, streamId: 'stream-2' })).ok).toBe(true);
  });

  it('keeps each wallet under describe.net\'s campaign cut, read live: campaign_per_rater - 5', async () => {
    const { outbox, governor } = setup({}, () => ({ campaignPerRater: 7 }));
    await admitted(outbox, A, 's1');
    await admitted(outbox, A, 's2');
    expect(await governor.admit({ subject: A, streamId: 's3' })).toEqual({ ok: false, reason: 'cap_perViewerLifetime', final: true });
  });

  it('reads the health source once per TTL', async () => {
    const health = vi.fn(() => ({ campaignPerRater: 20 }));
    const { governor, tick } = setup({}, health);
    await governor.admit({ subject: A, streamId: 's' });
    await governor.admit({ subject: A, streamId: 's' });
    expect(health).toHaveBeenCalledTimes(1);
    tick(600);
    await governor.admit({ subject: A, streamId: 's' });
    expect(health).toHaveBeenCalledTimes(2);
  });

  it.each<[string, () => any]>([
    ['throws', () => {
      throw new Error('describe.net down');
    }],
    ['answers zero', () => ({ campaignPerRater: 0 })],
    ['answers text', () => ({ campaignPerRater: '20' })],
    ['answers nothing', () => undefined],
  ])('refuses when the health source %s', async (_name, health) => {
    const { governor, now } = setup({}, health);
    expect(await governor.admit({ subject: A, streamId: 's' })).toEqual({
      ok: false,
      reason: 'health_unreadable',
      retryAt: now() + 60,
      final: false,
    });
  });

  it('runs without a health source only when told so (null)', async () => {
    const { outbox, governor } = setup({ perViewerLifetime: 100, perViewerPerDay: 100 }, null);
    for (let i = 0; i < 30; i++) await admitted(outbox, A, `s${i}`);
    expect((await governor.admit({ subject: A, streamId: 'new' })).ok).toBe(true);
  });

  it('refuses when it cannot read its own state', async () => {
    const outbox = new MemoryRatingOutbox({ now: () => T0 });
    const failing = (what: 'getState' | 'count') =>
      new Governor(CAPS, null, {
        store: {
          count: what === 'count' ? () => Promise.reject(new Error('db locked')) : outbox.count.bind(outbox),
          getState: what === 'getState' ? () => Promise.reject(new Error('db locked')) : outbox.getState.bind(outbox),
          setState: outbox.setState.bind(outbox),
        },
        now: () => T0,
      });
    for (const what of ['getState', 'count'] as const) {
      expect(await failing(what).admit({ subject: A, streamId: 's' })).toEqual({
        ok: false,
        reason: 'state_unreadable',
        retryAt: T0 + 60,
        final: false,
      });
    }
    await outbox.setState('uvd_reputation.breaker', '{"openUntil":"soon"}');
    const corrupt = new Governor(CAPS, null, { store: outbox, now: () => T0 });
    expect(await corrupt.admit({ subject: A, streamId: 's' })).toMatchObject({ reason: 'state_unreadable' });
    expect(await corrupt.blockedUntil()).toBe(T0 + 60);
  });
});

describe('Governor breaker', () => {
  it('the daily write limit: open until the next 00:00 UTC', async () => {
    const { governor, now } = setup();
    const state = await governor.recordFailure({ kind: 'daily_cap', retryAfterSeconds: 15 });
    expect(state.openUntil).toBe(nextUtcMidnight(now()));
    expect(await governor.admit({ subject: A, streamId: 's' })).toEqual({
      ok: false,
      reason: 'breaker_open:daily_cap',
      retryAt: nextUtcMidnight(now()),
      final: false,
    });
    expect(await governor.blockedUntil()).toBe(nextUtcMidnight(now()));
  });

  it('a 429: Retry-After, at least a minute', async () => {
    const { governor, now } = setup();
    expect((await governor.recordFailure({ kind: 'rate_limited', retryAfterSeconds: 15 })).openUntil).toBe(now() + 60);
    expect((await governor.recordFailure({ kind: 'rate_limited', retryAfterSeconds: 3600 })).openUntil).toBe(now() + 3600);
    // Never shortened by a later, shorter answer.
    expect((await governor.recordFailure({ kind: 'rate_limited', retryAfterSeconds: 1 })).openUntil).toBe(now() + 3600);
  });

  it.each(['writes_disabled', 'proof_enforced', 'balance_low'] as const)('%s: open for an hour', async (kind) => {
    const { governor, now } = setup();
    const state = await governor.recordFailure({ kind });
    expect(state).toEqual({ openUntil: now() + 3600, cause: kind, consecutive: 0 });
  });

  it('two transient failures in a row open it; a success in between starts over', async () => {
    const { governor, now } = setup();
    await governor.recordFailure({ kind: 'transient' });
    await governor.recordSuccess();
    expect((await governor.recordFailure({ kind: 'unavailable' })).openUntil).toBe(0);
    const state = await governor.recordFailure({ kind: 'transient' });
    expect(state.openUntil).toBe(now() + 3600);
    expect(state.cause).toBe('transient');
  });

  it('survives a restart: a new governor on the same store is still open', async () => {
    const { outbox, governor, now } = setup();
    await governor.recordFailure({ kind: 'writes_disabled' });
    const restarted = new Governor(CAPS, null, { store: outbox, now });
    expect(await restarted.admit({ subject: A, streamId: 's' })).toMatchObject({ reason: 'breaker_open:writes_disabled' });
  });

  it('closes on its own when the time passes', async () => {
    const { governor, tick } = setup();
    await governor.recordFailure({ kind: 'balance_low' });
    tick(3600);
    expect(await governor.blockedUntil()).toBeNull();
    expect((await governor.admit({ subject: A, streamId: 's' })).ok).toBe(true);
  });

  it('refuses an unknown failure kind', async () => {
    const { governor } = setup();
    await expect(governor.recordFailure({ kind: 'oops' as any })).rejects.toBeInstanceOf(ReputationError);
  });
});

describe('describeNetHealth', () => {
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('reads reading_policy.campaign_per_rater from GET /health', async () => {
    const seen: string[] = [];
    const fetch = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ reading_policy: { campaign_per_rater: 20, min_raters: 3 } }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    expect(await describeNetHealth({ fetch })()).toEqual({ campaignPerRater: 20 });
    expect(seen).toEqual(['https://api.describe.net/health']);
  });

  it.each<[string, typeof fetch]>([
    ['a 503', answer(503, {})],
    ['no reading_policy', answer(200, { status: 'ok' })],
    ['a zero', answer(200, { reading_policy: { campaign_per_rater: 0 } })],
    ['a fraction', answer(200, { reading_policy: { campaign_per_rater: 2.5 } })],
  ])('fails on %s, so the governor refuses', async (_name, fetch) => {
    await expect(describeNetHealth({ fetch })()).rejects.toBeInstanceOf(ReputationError);
  });
});
