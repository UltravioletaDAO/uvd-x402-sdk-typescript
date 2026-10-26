/**
 * `Governor(caps, health)`: decides whether a NEW rating may start, and
 * stops everything when the facilitator, the chain or the module's own state
 * says so. Work already started (a payment in flight, a submission) is never
 * stopped by it: reconciling is always allowed.
 *
 * CAPS are parameters, never constants of this module: every program passes
 * its own (`ReputationCaps`). Counted over admitted rows (`startedAt` set),
 * whether or not they ended on-chain, so a failure never frees a slot early:
 *
 * | cap                  | counts                              | when reached |
 * |----------------------|-------------------------------------|--------------|
 * | `perViewerPerStream` | rows for the wallet in this stream  | local_only   |
 * | `perViewerPerDay`    | rows for the wallet this UTC day    | next UTC day |
 * | `perViewerLifetime`  | rows for the wallet, ever           | local_only   |
 * | `perStream`          | rows in this stream                 | local_only   |
 * | `perDay`             | rows this UTC day                   | next UTC day |
 * | `lifetime`           | rows, ever                          | local_only   |
 *
 * "Viewer" is the rated WALLET, not a login: describe.net counts a campaign
 * per (rater, wallet), and two logins sharing a wallet share its caps.
 *
 * Two more caps are checked on the row itself, and both end it `local_only`:
 * `maxAmountPerRating` (so `perDay * maxAmountPerRating` bounds the day's
 * spend) and `maxValue`.
 *
 * HEALTH is a live source of describe.net's `reading_policy.campaign_per_rater`
 * (`GET /health`). The effective per-wallet lifetime cap is
 * `min(perViewerLifetime, campaign_per_rater - campaignMargin)`, read from
 * there and never copied. A health source that fails or answers nonsense
 * refuses (fail-closed); pass `null` to run without one, on purpose.
 *
 * THE BREAKER (persisted in the outbox's state, so a restart does not reset
 * it; a store it cannot read refuses everything):
 * - the facilitator's daily write limit (429 `erc8004_daily_write_limit`):
 *   open until the next 00:00 UTC;
 * - any other 429, and a 503 (the writer lease): open for `Retry-After`, at
 *   least `minRateLimitSeconds`;
 * - writes switched off (`ENABLE_ERC8004_WRITES=false` unmounts the routes:
 *   404/405), a proof refused while the facilitator enforces proofs, the
 *   rater's ETH or USDC below what a payment needs: open for `openSeconds`;
 * - `failureThreshold` transient failures in a row (502/504, no answer): open
 *   for `openSeconds`.
 *
 * An open breaker also holds back the facilitator work of rows already
 * admitted (a prepare, a re-send: `blockedUntil`), but never the chain reads
 * that reconcile them.
 *
 * Single worker: `admit` counts, then the caller's compare-and-set admits.
 * Two workers admitting at once could each pass a cap by one; run one worker
 * per rater (the outbox keeps its writes safe either way).
 */

import { ReputationError } from './errors';
import { log, type ReputationLogger } from './redact';
import type { CountFilter, RatingOutbox } from './outbox';
import { int128Of, isRecord, uintOf } from './values';

export interface ReputationCaps {
  perViewerPerStream: number;
  perViewerPerDay: number;
  perViewerLifetime: number;
  perStream: number;
  perDay: number;
  lifetime: number;
  /**
   * The largest anchor payment one rating may make, in token base units. With
   * `perDay` it bounds what leaves the rater wallet in a day:
   * `perDay * maxAmountPerRating`, plus gas.
   */
  maxAmountPerRating: string | number | bigint;
  /** The highest rating value written. A value of 100 from a single rater reads as wash trading. */
  maxValue: number;
}

export interface HealthSnapshot {
  /** describe.net's `reading_policy.campaign_per_rater`. */
  campaignPerRater: number;
}

export type HealthSource = () => HealthSnapshot | Promise<HealthSnapshot>;

export type BreakerFailureKind =
  | 'daily_cap'
  | 'rate_limited'
  | 'writes_disabled'
  | 'proof_enforced'
  | 'balance_low'
  | 'unavailable'
  | 'transient';

export interface BreakerFailure {
  kind: BreakerFailureKind;
  /** Seconds the facilitator asked to wait, when it said. */
  retryAfterSeconds?: number;
}

export interface BreakerState {
  openUntil: number;
  cause: BreakerFailureKind | null;
  consecutive: number;
}

export type Admission =
  | { ok: true }
  | {
      ok: false;
      /** `cap_*`, `breaker_open`, `health_unreadable`, `state_unreadable`. */
      reason: string;
      /** When to look again (unix seconds); absent when `final`. */
      retryAt?: number;
      /** The row will never be admitted: mark it local_only. */
      final: boolean;
    };

export interface GovernorOptions {
  /** Where the breaker and the counts live: the outbox. */
  store: Pick<RatingOutbox, 'count' | 'getState' | 'setState'>;
  /** Kept below describe.net's campaign cut. Default 5. */
  campaignMargin?: number;
  /** How long one health reading is reused. Default 600. */
  healthTtlSeconds?: number;
  /** Transient failures in a row that open the breaker. Default 2. */
  failureThreshold?: number;
  /** How long the breaker stays open. Default 3600. */
  openSeconds?: number;
  /** Shortest wait after a 429. Default 60. */
  minRateLimitSeconds?: number;
  /** Wait before asking again when the state or health cannot be read. Default 60. */
  unreadableRetrySeconds?: number;
  now?: () => number;
  logger?: ReputationLogger;
}

const BREAKER_KEY = 'uvd_reputation.breaker';
const CAP_NAMES: ReadonlyArray<keyof ReputationCaps> = [
  'perViewerPerStream',
  'perViewerPerDay',
  'perViewerLifetime',
  'perStream',
  'perDay',
  'lifetime',
];

/** The next 00:00 UTC after `now`, in unix seconds. */
export function nextUtcMidnight(now: number): number {
  return (Math.floor(now / 86400) + 1) * 86400;
}

function startOfUtcDay(now: number): number {
  return Math.floor(now / 86400) * 86400;
}

function positiveInt(value: unknown, name: string, fallback: number): number {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || (v as number) < 0) {
    throw new ReputationError('invalid_input', `${name} must be a non-negative integer`);
  }
  return v as number;
}

export class Governor {
  private readonly caps: Readonly<ReputationCaps>;
  private readonly maxAmount: bigint;
  private readonly health: HealthSource | null;
  private readonly store: GovernorOptions['store'];
  private readonly margin: number;
  private readonly healthTtl: number;
  private readonly threshold: number;
  private readonly openSeconds: number;
  private readonly minRateLimit: number;
  private readonly unreadableRetry: number;
  private readonly now: () => number;
  private readonly logger?: ReputationLogger;
  private cached: { at: number; snapshot: HealthSnapshot } | null = null;

  constructor(caps: ReputationCaps, health: HealthSource | null, options: GovernorOptions) {
    if (!isRecord(caps)) throw new ReputationError('invalid_input', 'caps must be an object');
    for (const name of CAP_NAMES) {
      const v: unknown = caps[name];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
        throw new ReputationError('invalid_input', `caps.${name} must be a non-negative integer (a parameter, never a default)`);
      }
    }
    const maxAmount = uintOf(caps.maxAmountPerRating);
    if (maxAmount === null || maxAmount === 0n) {
      throw new ReputationError('invalid_input', 'caps.maxAmountPerRating must be a positive integer of base units');
    }
    if (!Number.isSafeInteger(caps.maxValue) || int128Of(caps.maxValue) === null) {
      throw new ReputationError('invalid_input', 'caps.maxValue must be an integer');
    }
    this.maxAmount = maxAmount;
    if (health !== null && typeof health !== 'function') {
      throw new ReputationError('invalid_input', 'health must be a function, or null to run without one');
    }
    if (!options || !options.store) throw new ReputationError('invalid_input', 'the governor needs the outbox as its store');
    this.caps = Object.freeze({ ...caps });
    this.health = health;
    this.store = options.store;
    this.margin = positiveInt(options.campaignMargin, 'campaignMargin', 5);
    this.healthTtl = positiveInt(options.healthTtlSeconds, 'healthTtlSeconds', 600);
    this.threshold = Math.max(1, positiveInt(options.failureThreshold, 'failureThreshold', 2));
    this.openSeconds = positiveInt(options.openSeconds, 'openSeconds', 3600);
    this.minRateLimit = positiveInt(options.minRateLimitSeconds, 'minRateLimitSeconds', 60);
    this.unreadableRetry = Math.max(1, positiveInt(options.unreadableRetrySeconds, 'unreadableRetrySeconds', 60));
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.logger = options.logger;
  }

  /** The breaker as stored. Throws when the store cannot be read. */
  async breaker(): Promise<BreakerState> {
    const raw = await this.store.getState(BREAKER_KEY);
    if (raw === null) return { openUntil: 0, cause: null, consecutive: 0 };
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      !Number.isSafeInteger(parsed.openUntil) ||
      !Number.isSafeInteger(parsed.consecutive) ||
      (parsed.cause !== null && typeof parsed.cause !== 'string')
    ) {
      throw new ReputationError('invalid_input', 'the stored breaker state is malformed');
    }
    return parsed as unknown as BreakerState;
  }

  private async save(state: BreakerState): Promise<void> {
    await this.store.setState(BREAKER_KEY, JSON.stringify(state));
  }

  private async campaignCap(now: number): Promise<number> {
    if (this.health === null) return Number.POSITIVE_INFINITY;
    if (!this.cached || now - this.cached.at >= this.healthTtl) {
      const snapshot = await this.health();
      if (!isRecord(snapshot) || !Number.isSafeInteger(snapshot.campaignPerRater) || snapshot.campaignPerRater <= 0) {
        throw new ReputationError('invalid_input', 'the health source gave no positive campaignPerRater');
      }
      this.cached = { at: now, snapshot: { campaignPerRater: snapshot.campaignPerRater } };
    }
    return this.cached.snapshot.campaignPerRater - this.margin;
  }

  /**
   * When the facilitator must not be asked for new work (a prepare, a
   * re-send): the breaker's `openUntil`, or `null` when it is closed. An
   * unreadable breaker blocks too. Reading the chain is never blocked.
   */
  async blockedUntil(): Promise<number | null> {
    const now = this.now();
    try {
      const state = await this.breaker();
      return state.openUntil > now ? state.openUntil : null;
    } catch {
      return now + this.unreadableRetry;
    }
  }

  /** May a new rating for `row` start now? Never throws for a store or health failure: it refuses. */
  async admit(row: { subject: string; streamId: string; amount: string | number | bigint; value: number }): Promise<Admission> {
    const now = this.now();
    const amount = uintOf(row.amount);
    if (amount === null || amount > this.maxAmount) {
      return { ok: false, reason: 'cap_maxAmountPerRating', final: true };
    }
    if (typeof row.value !== 'number' || !Number.isSafeInteger(row.value) || row.value > this.caps.maxValue) {
      return { ok: false, reason: 'cap_maxValue', final: true };
    }
    let breaker: BreakerState;
    try {
      breaker = await this.breaker();
    } catch {
      log(this.logger, 'warn', 'reputation: governor cannot read its breaker; refusing');
      return { ok: false, reason: 'state_unreadable', retryAt: now + this.unreadableRetry, final: false };
    }
    if (breaker.openUntil > now) {
      return { ok: false, reason: `breaker_open:${breaker.cause ?? 'unknown'}`, retryAt: breaker.openUntil, final: false };
    }

    let campaign: number;
    try {
      campaign = await this.campaignCap(now);
    } catch {
      log(this.logger, 'warn', 'reputation: governor cannot read the health source; refusing');
      return { ok: false, reason: 'health_unreadable', retryAt: now + this.unreadableRetry, final: false };
    }

    const subject = String(row.subject).toLowerCase();
    const day = startOfUtcDay(now);
    const checks: Array<[keyof ReputationCaps, CountFilter, number, boolean]> = [
      ['lifetime', { admitted: true }, this.caps.lifetime, true],
      ['perStream', { admitted: true, streamId: row.streamId }, this.caps.perStream, true],
      ['perViewerLifetime', { admitted: true, subject }, Math.min(this.caps.perViewerLifetime, campaign), true],
      ['perViewerPerStream', { admitted: true, subject, streamId: row.streamId }, this.caps.perViewerPerStream, true],
      ['perDay', { since: day }, this.caps.perDay, false],
      ['perViewerPerDay', { since: day, subject }, this.caps.perViewerPerDay, false],
    ];
    for (const [name, filter, cap, final] of checks) {
      let n: number;
      try {
        n = await this.store.count(filter);
      } catch {
        log(this.logger, 'warn', 'reputation: governor cannot count the outbox; refusing');
        return { ok: false, reason: 'state_unreadable', retryAt: now + this.unreadableRetry, final: false };
      }
      if (!Number.isSafeInteger(n) || n < 0) {
        return { ok: false, reason: 'state_unreadable', retryAt: now + this.unreadableRetry, final: false };
      }
      if (n >= cap) {
        return final
          ? { ok: false, reason: `cap_${name}`, final: true }
          : { ok: false, reason: `cap_${name}`, retryAt: nextUtcMidnight(now), final: false };
      }
    }
    return { ok: true };
  }

  /** A write went through: the transient counter starts over. */
  async recordSuccess(): Promise<void> {
    const state = await this.breaker();
    if (state.consecutive !== 0) await this.save({ ...state, consecutive: 0 });
  }

  /** Something failed in a way that says "stop for a while". */
  async recordFailure(failure: BreakerFailure): Promise<BreakerState> {
    const now = this.now();
    const state = await this.breaker();
    let next: BreakerState = state;
    const open = (until: number): BreakerState => ({
      openUntil: Math.max(state.openUntil, until),
      cause: failure.kind,
      consecutive: 0,
    });
    switch (failure.kind) {
      case 'daily_cap':
        next = open(nextUtcMidnight(now));
        break;
      case 'rate_limited':
      case 'unavailable': {
        const wait = Number.isFinite(failure.retryAfterSeconds) ? Math.max(0, Math.floor(failure.retryAfterSeconds as number)) : 0;
        next = open(now + Math.max(wait, this.minRateLimit));
        break;
      }
      case 'writes_disabled':
      case 'proof_enforced':
      case 'balance_low':
        next = open(now + this.openSeconds);
        break;
      case 'transient': {
        const consecutive = state.consecutive + 1;
        next = consecutive >= this.threshold ? open(now + this.openSeconds) : { ...state, consecutive };
        break;
      }
      default:
        throw new ReputationError('invalid_input', 'unknown breaker failure kind');
    }
    await this.save(next);
    if (next.openUntil > now && next.openUntil !== state.openUntil) {
      log(this.logger, 'warn', `reputation: breaker open (${failure.kind}) until ${next.openUntil}`);
    }
    return next;
  }
}

/**
 * Read describe.net's `reading_policy.campaign_per_rater` from `GET /health`.
 * One request per call; the governor caches it for `healthTtlSeconds`.
 */
export function describeNetHealth(
  options: { url?: string; fetch?: typeof fetch; timeoutMs?: number } = {}
): HealthSource {
  const url = options.url ?? 'https://api.describe.net/health';
  const doFetch = options.fetch ?? fetch;
  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    try {
      const response = await doFetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new ReputationError('rpc_failed', `describe.net /health answered HTTP ${response.status}`);
      const body = (await response.json()) as unknown;
      const policy = isRecord(body) ? body.reading_policy : undefined;
      const value = isRecord(policy) ? policy.campaign_per_rater : undefined;
      if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new ReputationError('rpc_failed', 'describe.net /health has no positive reading_policy.campaign_per_rater');
      }
      return { campaignPerRater: value as number };
    } finally {
      clearTimeout(timer);
    }
  };
}
