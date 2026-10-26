/**
 * The outbox: one row per thing that may earn a rating, keyed by its
 * deterministic ref, moved through a state machine that never repeats an
 * irreversible step.
 *
 *     queued -> paying(signed tx) -> paid(proof) -> submitting(nonce, deadline, signature)
 *            -> submitted(tx) -> confirmed
 *     any active state -> failed(reason)       (needs a human)
 *     queued | paid    -> local_only(reason)   (never anchored: a cap, a forget)
 *
 * Every write is a compare-and-set on the row's status (`transition`), and
 * the rules of what may follow what live in ONE function, `applyTransition`,
 * that both adapters call. So, in any adapter:
 *
 * - a second enqueue of the same ref is a `duplicate`, never a second row;
 * - a payment, once signed and stored, is never replaced (a retry
 *   re-broadcasts the same bytes);
 * - `submitting` keeps its nonce, deadline and signature; the only way back
 *   to `paid` (and a new prepare) clears them, and `submitWithReconcile` takes
 *   it only once the deadline has passed and the chain shows no rating;
 * - two workers racing on one row: the second compare-and-set fails and that
 *   worker sends nothing.
 *
 * Adapters: {@link MemoryRatingOutbox} here, `SqliteRatingOutbox` in
 * `sqlite-outbox.ts`. Any other store implements {@link RatingOutbox} and
 * delegates to `applyTransition` and `forgetRow`.
 */

import type { ProofOfPayment } from '../backend';
import { reputationChain } from './constants';
import { ReputationError } from './errors';
import type { SignedPayment } from './payment';
import type { RelayAuthorization } from './sign';
import { CONTROL, bytes32Of, int128Of, isAddress, isRecord, safeUint, uintOf } from './values';

export type RatingStatus =
  | 'queued'
  | 'paying'
  | 'paid'
  | 'submitting'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'local_only';

/** Statuses a worker still has something to do for. */
export const ACTIVE_STATUSES: readonly RatingStatus[] = Object.freeze([
  'paying',
  'submitting',
  'submitted',
  'paid',
  'queued',
]);

/** The feedback fields besides `value`, fixed once the evidence is published. */
export interface FeedbackInput {
  agentId: string;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackUri: string;
  /** 32 bytes, lowercase `0x` hex: the evidence document's `contentHash`. */
  feedbackHash: string;
}

/** What a signed submission needs to be re-sent unchanged or reconciled. */
export interface Submission {
  /** The rater that signed, checksummed: the `clientAddress` the registry will record. */
  rater: string;
  nonce: string;
  deadline: number;
  signature: string;
  authorization: RelayAuthorization | null;
  /** First block that could hold the rating. */
  scanFromBlock: number;
  /** Next block the reconciliation scan reads from. */
  scanCursor: number;
  submittedAt: number;
  /** Submit requests sent with this nonce. */
  sends: number;
  /** What the last send came back with. `accepted` moves the row to `submitted`. */
  lastOutcome: 'retryable' | 'uncertain' | 'refused' | null;
}

export interface RatingRow {
  ref: string;
  network: string;
  /** The program's own id for the viewer, used only by `forget`. `null` once forgotten. */
  viewerId: string | null;
  /** The rated wallet, lowercase. */
  subject: string;
  /** The subject's ERC-8004 agent, when known at enqueue: checked against `ownerOf` before paying. */
  agentId: string | null;
  streamId: string;
  value: number;
  /** Anchor payment in USDC base units. */
  amount: string;
  status: RatingStatus;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  /** When the row was admitted by the governor: it counts against the caps from then on. */
  startedAt: number | null;
  updatedAt: number;
  /** Last error code, never a message. */
  error: string | null;
  payment: SignedPayment | null;
  proof: ProofOfPayment | null;
  feedback: FeedbackInput | null;
  submission: Submission | null;
  transaction: string | null;
  feedbackIndex: number | null;
  confirmedAt: number | null;
  forgotten: boolean;
  /** The program's own local data for the row (JSON). Dropped by `forget`. */
  payload: Record<string, unknown> | null;
}

export interface NewRating {
  /** A {@link messageRef}: 64 lowercase hex digits. */
  ref: string;
  network: string;
  subject: string;
  streamId: string;
  value: number;
  amount: string | number | bigint;
  /** The subject's agent, if already known: lets the owner be checked before any money moves. */
  agentId?: string | number | bigint | null;
  viewerId?: string | null;
  payload?: Record<string, unknown> | null;
}

/** The fields a transition may write. */
export type RatingPatch = Partial<
  Pick<
    RatingRow,
    | 'status'
    | 'attempts'
    | 'nextAttemptAt'
    | 'startedAt'
    | 'error'
    | 'payment'
    | 'proof'
    | 'feedback'
    | 'submission'
    | 'transaction'
    | 'feedbackIndex'
    | 'confirmedAt'
  >
>;

export interface CountFilter {
  /** Lowercased before comparing. */
  subject?: string;
  streamId?: string;
  /** Only rows admitted at or after this unix second. */
  since?: number;
  /** Only rows the governor admitted (`startedAt` set). */
  admitted?: boolean;
  statuses?: readonly RatingStatus[];
}

export interface ForgetReport {
  /** Rows removed: nothing about them had reached the chain. */
  deleted: number;
  /** Rows kept with the viewer id and payload dropped (the payment or the rating is on-chain). */
  scrubbed: number;
  /** Of those, rows whose outcome is still settling and that will finish without the viewer's data. */
  inFlight: number;
}

/** The storage port. Every method may be async; each adapter decides how it persists. */
export interface RatingOutbox {
  /** Insert a new row, or report the ref is already there. Never overwrites. */
  enqueue(rating: NewRating): Promise<'inserted' | 'duplicate'>;
  get(ref: string): Promise<RatingRow | null>;
  /** Active rows due at `now`: in-flight payments first, then submissions, then new work. */
  due(now: number, limit: number): Promise<RatingRow[]>;
  /**
   * Compare-and-set: apply `patch` only if the row is in `from`. Returns the
   * new row, or `null` when it was not (another worker moved it). Throws
   * `invalid_transition` for a move the state machine forbids.
   */
  transition(ref: string, from: RatingStatus, patch: RatingPatch): Promise<RatingRow | null>;
  count(filter: CountFilter): Promise<number>;
  /** `!forgetme`: drop everything local about `viewerId`. See {@link forgetRow}. */
  forget(viewerId: string): Promise<ForgetReport>;
  getState(key: string): Promise<string | null>;
  setState(key: string, value: string): Promise<void>;
}

const ALLOWED: Record<RatingStatus, readonly RatingStatus[]> = {
  queued: ['queued', 'paying', 'local_only', 'failed'],
  paying: ['paying', 'paid', 'failed'],
  paid: ['paid', 'submitting', 'failed', 'local_only'],
  submitting: ['submitting', 'submitted', 'paid', 'failed'],
  submitted: ['submitted', 'confirmed', 'paid', 'failed'],
  confirmed: [],
  failed: [],
  local_only: [],
};

const REF = /^[0-9a-f]{64}$/;
const PATCH_KEYS = new Set<string>([
  'status',
  'attempts',
  'nextAttemptAt',
  'startedAt',
  'error',
  'payment',
  'proof',
  'feedback',
  'submission',
  'transaction',
  'feedbackIndex',
  'confirmedAt',
]);

function invalid(message: string): never {
  throw new ReputationError('invalid_transition', message);
}

function samePayment(a: SignedPayment, b: SignedPayment | null | undefined): boolean {
  return (
    !!b &&
    a.transactionHash === b.transactionHash &&
    a.rawTransaction === b.rawTransaction &&
    a.nonce === b.nonce
  );
}

/** Validate a new rating and build its first row. */
export function newRow(rating: NewRating, now: number): RatingRow {
  if (!isRecord(rating)) throw new ReputationError('invalid_input', 'enqueue needs an object');
  if (typeof rating.ref !== 'string' || !REF.test(rating.ref)) {
    throw new ReputationError('invalid_input', 'ref must be a messageRef (64 lowercase hex digits)');
  }
  const chain = reputationChain(String(rating.network));
  if (!chain) throw new ReputationError('unknown_chain', `no FeedbackDelegate is known for ${String(rating.network)}`);
  if (!isAddress(rating.subject)) throw new ReputationError('invalid_input', 'subject must be an address');
  if (typeof rating.streamId !== 'string' || rating.streamId === '' || rating.streamId.length > 200 || CONTROL.test(rating.streamId)) {
    throw new ReputationError('invalid_input', 'streamId must be a non-empty short string');
  }
  if (typeof rating.value !== 'number' || int128Of(rating.value) === null) {
    throw new ReputationError('invalid_input', 'value must be a safe integer');
  }
  const amount = uintOf(rating.amount);
  if (amount === null || amount === 0n) throw new ReputationError('invalid_input', 'amount must be a positive integer of base units');
  let agentId: string | null = null;
  if (rating.agentId !== undefined && rating.agentId !== null) {
    const id = uintOf(rating.agentId);
    if (id === null) throw new ReputationError('invalid_input', 'agentId must be a uint256');
    agentId = id.toString();
  }
  const viewerId = rating.viewerId ?? null;
  if (viewerId !== null && (typeof viewerId !== 'string' || viewerId === '')) {
    throw new ReputationError('invalid_input', 'viewerId must be a non-empty string or null');
  }
  let payload: Record<string, unknown> | null = null;
  if (rating.payload !== undefined && rating.payload !== null) {
    if (!isRecord(rating.payload)) throw new ReputationError('invalid_input', 'payload must be a JSON object');
    payload = JSON.parse(JSON.stringify(rating.payload)) as Record<string, unknown>;
  }
  return {
    ref: rating.ref,
    network: chain.network,
    viewerId,
    subject: rating.subject.toLowerCase(),
    agentId,
    streamId: rating.streamId,
    value: rating.value,
    amount: amount.toString(),
    status: 'queued',
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    error: null,
    payment: null,
    proof: null,
    feedback: null,
    submission: null,
    transaction: null,
    feedbackIndex: null,
    confirmedAt: null,
    forgotten: false,
    payload,
  };
}

/**
 * The state machine. `null` when `row` is not in `from` (the compare-and-set
 * lost); throws `invalid_transition` for a move that is never allowed.
 */
export function applyTransition(
  row: RatingRow,
  from: RatingStatus,
  patch: RatingPatch,
  now: number
): RatingRow | null {
  if (row.status !== from) return null;
  if (!isRecord(patch)) invalid('a patch must be an object');
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.has(key)) invalid(`a transition cannot write ${key}`);
  }
  const to = patch.status ?? from;
  if (!ALLOWED[from].includes(to)) invalid(`${from} -> ${to} is not allowed`);

  const next: RatingRow = { ...row, ...patch, status: to, updatedAt: now };

  if (row.payment !== null && 'payment' in patch && !samePayment(row.payment, patch.payment)) {
    invalid('a signed payment is never replaced');
  }
  if (row.proof !== null && 'proof' in patch && patch.proof !== row.proof) {
    if (JSON.stringify(patch.proof) !== JSON.stringify(row.proof)) invalid('a proof is never replaced');
  }
  if (from === 'queued' && to === 'paying') {
    if (!patch.payment) invalid('paying needs the signed payment');
    next.startedAt = row.startedAt ?? patch.startedAt ?? now;
  }
  if (to === 'paid' && next.proof === null) invalid('paid needs the proof');
  if (to === 'paid' && (from === 'submitting' || from === 'submitted')) {
    if (patch.submission !== null || patch.transaction !== null) {
      invalid('going back to paid must clear the submission and the transaction');
    }
  }
  if (from === 'paid' && to === 'submitting') {
    if (row.forgotten) invalid('a forgotten row is never submitted');
    if (!patch.submission || !next.feedback) invalid('submitting needs the feedback and the signed submission');
  }
  const signedStates: readonly RatingStatus[] = ['submitting', 'submitted'];
  if (signedStates.includes(from) && signedStates.includes(to) && 'submission' in patch) {
    const a = row.submission;
    const b = patch.submission;
    if (
      !a ||
      !b ||
      a.rater !== b.rater ||
      a.nonce !== b.nonce ||
      a.deadline !== b.deadline ||
      a.signature !== b.signature ||
      JSON.stringify(a.authorization) !== JSON.stringify(b.authorization)
    ) {
      invalid('a submission keeps its rater, nonce, deadline, signature and authorization');
    }
  }
  if (to === 'submitting' || to === 'submitted') {
    if (!next.submission) invalid(`${to} needs the submission`);
  }
  if (to === 'submitted' && bytes32Of(next.transaction) === null) invalid('submitted needs the transaction hash');
  if (to === 'confirmed' && (bytes32Of(next.transaction) === null || safeUint(next.feedbackIndex) === null)) {
    invalid('confirmed needs the transaction and the feedback index');
  }
  return next;
}

/**
 * What `forget(viewerId)` does to one of the viewer's rows: `'delete'` when
 * nothing about it reached the chain (`queued`), else the row with the viewer
 * id and payload dropped. A `paid` row is never submitted afterwards
 * (`local_only`); a row still settling (`paying`, `submitting`, `submitted`)
 * is marked `forgotten` and finishes without the viewer's data, because its
 * payment or rating may already be on-chain and the caps must still count it.
 */
export function forgetRow(row: RatingRow, now: number): 'delete' | RatingRow {
  if (row.status === 'queued') return 'delete';
  const scrubbed: RatingRow = { ...row, viewerId: null, payload: null, forgotten: true, updatedAt: now };
  if (row.status === 'paid') {
    scrubbed.status = 'local_only';
    scrubbed.error = 'forgotten';
  }
  return scrubbed;
}

/** Whether a row is still settling on-chain after a forget. */
export function settling(row: RatingRow): boolean {
  return row.status === 'paying' || row.status === 'submitting' || row.status === 'submitted';
}

export function matchesFilter(row: RatingRow, filter: CountFilter): boolean {
  if (filter.subject !== undefined && row.subject !== filter.subject.toLowerCase()) return false;
  if (filter.streamId !== undefined && row.streamId !== filter.streamId) return false;
  if ((filter.admitted || filter.since !== undefined) && row.startedAt === null) return false;
  if (filter.since !== undefined && (row.startedAt as number) < filter.since) return false;
  if (filter.statuses !== undefined && !filter.statuses.includes(row.status)) return false;
  return true;
}

export const DUE_ORDER: Record<RatingStatus, number> = {
  paying: 0,
  submitting: 1,
  submitted: 2,
  paid: 3,
  queued: 4,
  confirmed: 9,
  failed: 9,
  local_only: 9,
};

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** An in-process outbox. State is lost with the process: for tests and short-lived programs. */
export class MemoryRatingOutbox implements RatingOutbox {
  private readonly rows = new Map<string, RatingRow>();
  private readonly state = new Map<string, string>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async enqueue(rating: NewRating): Promise<'inserted' | 'duplicate'> {
    const row = newRow(rating, this.now());
    if (this.rows.has(row.ref)) return 'duplicate';
    this.rows.set(row.ref, row);
    return 'inserted';
  }

  async get(ref: string): Promise<RatingRow | null> {
    return clone(this.rows.get(ref) ?? null);
  }

  async due(now: number, limit: number): Promise<RatingRow[]> {
    return [...this.rows.values()]
      .filter((r) => ACTIVE_STATUSES.includes(r.status) && r.nextAttemptAt <= now)
      .sort(
        (a, b) =>
          DUE_ORDER[a.status] - DUE_ORDER[b.status] ||
          a.nextAttemptAt - b.nextAttemptAt ||
          a.createdAt - b.createdAt ||
          (a.ref < b.ref ? -1 : 1)
      )
      .slice(0, Math.max(0, limit))
      .map(clone);
  }

  async transition(ref: string, from: RatingStatus, patch: RatingPatch): Promise<RatingRow | null> {
    const row = this.rows.get(ref);
    if (!row) throw new ReputationError('row_missing', 'no outbox row has this ref');
    const next = applyTransition(row, from, clone(patch), this.now());
    if (next === null) return null;
    this.rows.set(ref, next);
    return clone(next);
  }

  async count(filter: CountFilter): Promise<number> {
    let n = 0;
    for (const row of this.rows.values()) if (matchesFilter(row, filter)) n++;
    return n;
  }

  async forget(viewerId: string): Promise<ForgetReport> {
    const report: ForgetReport = { deleted: 0, scrubbed: 0, inFlight: 0 };
    if (typeof viewerId !== 'string' || viewerId === '') return report;
    const now = this.now();
    for (const [ref, row] of [...this.rows.entries()]) {
      if (row.viewerId !== viewerId) continue;
      const result = forgetRow(row, now);
      if (result === 'delete') {
        this.rows.delete(ref);
        report.deleted++;
      } else {
        this.rows.set(ref, result);
        report.scrubbed++;
        if (settling(result)) report.inFlight++;
      }
    }
    return report;
  }

  async getState(key: string): Promise<string | null> {
    return this.state.get(key) ?? null;
  }

  async setState(key: string, value: string): Promise<void> {
    this.state.set(key, value);
  }
}
