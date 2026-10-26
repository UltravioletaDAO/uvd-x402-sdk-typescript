/**
 * `submitWithReconcile`: prepare, check, sign, store, send, and then read
 * the chain until the rating is confirmed. `processRating`: one tick of a
 * worker for one row, from `queued` to `confirmed`.
 *
 * THE RULE: once a row is `submitting`, it is never prepared again while the
 * signed rating could still land. Two prepares are two nonces, and two
 * nonces are two identical ratings on-chain, forever. A send that failed, a
 * timeout, a 503 or a 200 with no transaction hash are all answered the same
 * way: read `NewFeedback` from the registry. Only when the chain has been read
 * up to a block past the deadline and holds no matching rating does the row
 * go back to `paid` (the payment stays good for 7 days) for a new prepare.
 * Within the deadline, a send whose outcome was retryable or uncertain is
 * re-sent with the SAME nonce and signature: at most one can land.
 *
 * "Holds no matching rating" is not taken from the logs alone: a node behind
 * a balancer can answer `eth_getLogs` with a partial range and no error. Before
 * a row goes back to `paid`, the delegate's `usedNonce[nonce]` cell is read
 * from the rater's storage (`usedNonceSlot`) at a block past the deadline,
 * where the contract refuses the signature (`block.timestamp > deadline`).
 * Spent: the rating landed and the scan starts over from its first block (a
 * day later, still unseen, the row goes to a human). Unreadable: the row
 * waits. Only an unspent nonce sends the row back.
 *
 * One process never works on one row twice at once (a lock per outbox and
 * ref), and across processes the compare-and-sets decide.
 *
 * The signed submission (nonce, deadline, signature, authorization) is
 * stored BEFORE it is sent, by a compare-and-set from `paid`; a worker that
 * loses that race sends nothing.
 *
 * Ported from Karma Hello's `services/reputation/live_worker.py`
 * (`process`, `reconcile`, `matching_feedback`), with the identity check of
 * its `identity()` (the agent must be owned by the rated wallet).
 */

import { ethers } from 'ethers';
import type {
  Erc8004Network,
  PrepareRelayFeedbackRequest,
  SubmitRelayFeedbackRequest,
} from '../backend';
import { NEW_FEEDBACK_TOPIC, PROOF_MAX_AGE_SECS, ZERO_BYTES32, reputationChain, type ReputationChain } from './constants';
import { ReputationError, errorCode } from './errors';
import type { BreakerFailure, Governor } from './governor';
import type { FeedbackInput, RatingOutbox, RatingRow, RatingStatus, Submission } from './outbox';
import { payAndProve, type EvmRpc, type GasLimits } from './payment';
import { log, type ReputationLogger } from './redact';
import { buildRelayAuthorization, signRelayedFeedback, type ReputationSigner } from './sign';
import { validatePreparation, type RelayedFeedbackParams } from './validate';
import {
  CONTROL,
  bytes32Of,
  int128Of,
  isAddress,
  isRecord,
  quantityOf,
  safeUint,
  sameAddress,
  topicOf,
  uintOf,
} from './values';

/** The two facilitator calls of the rail. `Erc8004Client` from `uvd-x402-sdk/backend` is one. */
export interface RelayFeedbackClient {
  prepareRelayedFeedback(request: PrepareRelayFeedbackRequest): Promise<unknown>;
  submitRelayedFeedback(request: SubmitRelayFeedbackRequest): Promise<unknown>;
}

/** What `buildFeedback` returns: the rating's fields once its evidence is published. */
export interface FeedbackBuild {
  agentId: string | number | bigint;
  valueDecimals?: number;
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  feedbackUri?: string;
  feedbackHash?: string | null;
}

export interface SubmitDeps {
  outbox: RatingOutbox;
  client: RelayFeedbackClient;
  signer: ReputationSigner;
  rpc: EvmRpc;
  /** Told about facilitator failures and successes, so the breaker can open. */
  governor?: Governor;
  /**
   * Called once for a `paid` row with no feedback yet: resolve the agent,
   * publish the evidence (its `contentHash` is the `feedbackHash`) and return
   * the fields. They are stored before the prepare and never rebuilt.
   */
  buildFeedback?: (row: RatingRow) => FeedbackBuild | Promise<FeedbackBuild>;
  /** Blocks a rating needs before it is confirmed. Default 2. */
  confirmations?: number;
  /** Most blocks read per `eth_getLogs`. Default 2000. */
  scanBlocks?: number;
  maxDeadlineAheadSecs?: number;
  /**
   * The facilitator's proof freshness window (`ERC8004_PROOF_MAX_AGE_SECS`).
   * Default 7 days, its production value; a payment within an hour of it is
   * not spent on a new prepare.
   */
  proofMaxAgeSecs?: number;
  now?: () => number;
  logger?: ReputationLogger;
}

/** Retry waits, in seconds: 15 s, 2 min, then 10 min. */
export const RETRY_SCHEDULE_SECS: readonly number[] = Object.freeze([15, 120, 600]);
/** Blocks re-read at the end of each scan, for shallow reorgs. */
export const REORG_OVERLAP_BLOCKS = 12;
/** A rating is proven absent only once the chain is this far past its deadline. */
export const DEADLINE_GRACE_SECS = 120;
/** No re-send this close to the deadline. */
const RESEND_MARGIN_SECS = 30;
const MAX_SENDS = 3;
const POLL_SECS = 15;
/** A proof this close to the facilitator's freshness window is not spent on a new prepare. */
const PROOF_SAFETY_SECS = 3600;
/** How long a payment's nonce must look consumed by another transaction before the row fails. */
export const NONCE_CONSUMED_GRACE_SECS = 3600;
const X402_VERSION = 1;

export function retryDelay(attempts: number): number {
  const i = Math.min(Math.max(attempts - 1, 0), RETRY_SCHEDULE_SECS.length - 1);
  return RETRY_SCHEDULE_SECS[i];
}

/** The failure body behind the SDK's flattened `Facilitator error: <status> - <body>`. */
function failureBody(resp: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof resp.error !== 'string') return null;
  const m = /^Facilitator error: \d{3} - ([\s\S]*)$/.exec(resp.error);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function proofEnforcedRefusal(proof: unknown): boolean {
  return isRecord(proof) && proof.enforced === true && proof.rejection !== undefined && proof.rejection !== null;
}

/**
 * Map a facilitator answer to what the breaker must hear, or `null` for a
 * refusal of this one request (a bad field, a signature the facilitator would
 * not accept) that says nothing about the next.
 */
export function classifyFailure(resp: unknown): BreakerFailure | null {
  if (!isRecord(resp)) return { kind: 'transient' };
  const body = failureBody(resp);
  if (proofEnforcedRefusal(resp.proof) || proofEnforcedRefusal(body?.proof)) return { kind: 'proof_enforced' };
  const status = typeof resp.status === 'number' ? resp.status : undefined;
  const retryAfterSeconds = typeof resp.retryAfterSeconds === 'number' ? resp.retryAfterSeconds : undefined;
  if (status === 429) {
    const daily = body?.code === 'erc8004_daily_write_limit' || String(resp.error ?? '').includes('erc8004_daily_write_limit');
    return daily ? { kind: 'daily_cap' } : { kind: 'rate_limited', retryAfterSeconds };
  }
  if (status === 404 || status === 405) return { kind: 'writes_disabled' };
  if (status === 503) return { kind: 'unavailable', retryAfterSeconds };
  if (status === 502 || status === 504) return { kind: 'transient' };
  if (status === undefined && resp.retryable === true) return { kind: 'transient' };
  return null;
}

function feedbackOf(build: FeedbackBuild): FeedbackInput {
  if (!isRecord(build)) throw new ReputationError('invalid_input', 'buildFeedback must return an object');
  const agentId = uintOf(build.agentId);
  if (agentId === null) throw new ReputationError('invalid_input', 'buildFeedback gave no uint256 agentId');
  const valueDecimals = build.valueDecimals ?? 0;
  if (!Number.isSafeInteger(valueDecimals) || valueDecimals < 0 || valueDecimals > 18) {
    throw new ReputationError('invalid_input', 'buildFeedback gave valueDecimals outside 0..18');
  }
  const text = (v: unknown, name: string): string => {
    if (v === undefined) return '';
    if (typeof v !== 'string' || CONTROL.test(v)) {
      throw new ReputationError('invalid_input', `buildFeedback gave a ${name} that is not a plain string`);
    }
    return v;
  };
  let feedbackHash = ZERO_BYTES32;
  if (build.feedbackHash !== undefined && build.feedbackHash !== null) {
    const h = bytes32Of(build.feedbackHash);
    if (h === null) throw new ReputationError('invalid_input', 'buildFeedback gave a feedbackHash that is not 32 bytes');
    feedbackHash = h;
  }
  return {
    agentId: agentId.toString(),
    valueDecimals,
    tag1: text(build.tag1, 'tag1'),
    tag2: text(build.tag2, 'tag2'),
    endpoint: text(build.endpoint, 'endpoint'),
    feedbackUri: text(build.feedbackUri, 'feedbackUri'),
    feedbackHash,
  };
}

function paramsOf(row: RatingRow, feedback: FeedbackInput): RelayedFeedbackParams {
  return {
    network: row.network,
    agentId: feedback.agentId,
    value: row.value,
    valueDecimals: feedback.valueDecimals,
    tag1: feedback.tag1,
    tag2: feedback.tag2,
    endpoint: feedback.endpoint,
    feedbackUri: feedback.feedbackUri,
    feedbackHash: feedback.feedbackHash,
  };
}

function wireFeedback(row: RatingRow, feedback: FeedbackInput, rater: string) {
  const agentId = BigInt(feedback.agentId);
  return {
    agentId: agentId <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(agentId) : feedback.agentId,
    value: row.value,
    valueDecimals: feedback.valueDecimals,
    tag1: feedback.tag1,
    tag2: feedback.tag2,
    endpoint: feedback.endpoint,
    feedbackUri: feedback.feedbackUri,
    feedbackHash: feedback.feedbackHash,
    ...(row.proof ? { proof: row.proof } : {}),
    rater,
  };
}

const NEW_FEEDBACK_DATA = ['uint64', 'int128', 'uint8', 'string', 'string', 'string', 'string', 'bytes32'];

/** The feedback index when `entry` is the `NewFeedback` of exactly this rating, else `null`. */
export function matchFeedbackLog(
  entry: unknown,
  chain: ReputationChain,
  rater: string,
  params: RelayedFeedbackParams
): number | null {
  if (!isRecord(entry) || entry.removed === true || !sameAddress(entry.address, chain.reputationRegistry)) return null;
  const topics = entry.topics;
  const agentId = uintOf(params.agentId);
  if (!Array.isArray(topics) || topics.length !== 4 || agentId === null) return null;
  const want = [NEW_FEEDBACK_TOPIC, topicOf(agentId), topicOf(rater)];
  if (!want.every((t, i) => typeof topics[i] === 'string' && (topics[i] as string).toLowerCase() === t)) return null;
  if (typeof entry.data !== 'string') return null;
  let decoded: ethers.Result;
  try {
    decoded = ethers.AbiCoder.defaultAbiCoder().decode(NEW_FEEDBACK_DATA, entry.data);
  } catch {
    return null;
  }
  const same =
    decoded[1] === int128Of(params.value) &&
    decoded[2] === BigInt(params.valueDecimals ?? 0) &&
    decoded[3] === (params.tag1 ?? '') &&
    decoded[4] === (params.tag2 ?? '') &&
    decoded[5] === (params.endpoint ?? '') &&
    decoded[6] === (params.feedbackUri ?? '') &&
    String(decoded[7]).toLowerCase() === (bytes32Of(params.feedbackHash ?? ZERO_BYTES32) ?? '');
  return same ? safeUint(decoded[0]) : null;
}

async function rpcCall(rpc: EvmRpc, method: string, params: readonly unknown[]): Promise<unknown> {
  try {
    return await rpc.request({ method, params });
  } catch (error) {
    if (error instanceof ReputationError) throw error;
    throw new ReputationError('rpc_failed', `${method} failed`);
  }
}

async function blockNumber(rpc: EvmRpc): Promise<number> {
  const n = safeUint(quantityOf(await rpcCall(rpc, 'eth_blockNumber', [])) ?? -1);
  if (n === null) throw new ReputationError('rpc_failed', 'eth_blockNumber answered no block');
  return n;
}

async function blockTimestamp(rpc: EvmRpc, block: number): Promise<number> {
  const header = await rpcCall(rpc, 'eth_getBlockByNumber', ['0x' + block.toString(16), false]);
  const ts = isRecord(header) ? safeUint(quantityOf(header.timestamp) ?? -1) : null;
  if (ts === null) throw new ReputationError('rpc_failed', 'the block has no timestamp');
  return ts;
}

const OWNER_OF = ethers.id('ownerOf(uint256)').slice(0, 10);

async function ownerOf(rpc: EvmRpc, chain: ReputationChain, agentId: string): Promise<string> {
  const data = OWNER_OF + BigInt(agentId).toString(16).padStart(64, '0');
  const raw = await rpcCall(rpc, 'eth_call', [{ to: chain.identityRegistry, data }, 'latest']);
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ReputationError('rpc_failed', 'ownerOf answered no address');
  }
  return '0x' + raw.slice(26).toLowerCase();
}

interface Context {
  deps: SubmitDeps;
  chain: ReputationChain;
  now: number;
}

async function move(
  ctx: Context,
  row: RatingRow,
  from: RatingStatus,
  patch: Parameters<RatingOutbox['transition']>[2]
): Promise<RatingRow> {
  const next = await ctx.deps.outbox.transition(row.ref, from, patch);
  if (next) return next;
  const current = await ctx.deps.outbox.get(row.ref);
  if (!current) throw new ReputationError('row_missing', 'the row disappeared');
  return current;
}

function later(ctx: Context, row: RatingRow, error: string, delay?: number) {
  return move(ctx, row, row.status, {
    error,
    attempts: row.attempts + 1,
    nextAttemptAt: ctx.now + (delay ?? retryDelay(row.attempts + 1)),
  });
}

/** The breaker's reopening time when it holds facilitator work back, else `null`. */
async function blocked(ctx: Context): Promise<number | null> {
  return ctx.deps.governor ? ctx.deps.governor.blockedUntil() : null;
}

async function tellBreaker(ctx: Context, resp: unknown): Promise<void> {
  const failure = classifyFailure(resp);
  if (failure && ctx.deps.governor) await ctx.deps.governor.recordFailure(failure);
}

/**
 * The v4 FeedbackDelegate keeps its state in one ERC-7201 slot
 * (`FeedbackDelegate.sol` `LAYOUT_SLOT`), and `usedNonce` is the first member
 * of that struct.
 */
export const FEEDBACK_DELEGATE_LAYOUT_SLOT = '0x516978a8649c68efcdb528ed7ae5a061ff0ca5a183b9df4fd233934a8da02a00';

/**
 * The storage cell of `usedNonce[nonce]` on a rater's account:
 * `keccak256(abi.encode(nonce, LAYOUT_SLOT))`. Checked against Base mainnet
 * (`submit.test.ts`): it holds 1 exactly where the deployed delegate's
 * `nonceUsed(nonce)` answers true.
 */
export function usedNonceSlot(nonce: string): string {
  return ethers
    .keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [nonce, FEEDBACK_DELEGATE_LAYOUT_SLOT]))
    .toLowerCase();
}

/**
 * Was `nonce` spent on the rater's account, as of `block`? Read from the
 * STORAGE cell, not through `nonceUsed()`: under EIP-7702 the delegate's
 * storage is the rater's own, and it outlives the delegation. A rater whose
 * delegation was revoked (the emergency exit) has no code to call, yet the
 * spent nonce is still there. `null` when the cell holds anything but 0 or 1.
 */
async function nonceSpent(ctx: Context, rater: string, nonce: string, block: number): Promise<boolean | null> {
  const raw = await rpcCall(ctx.deps.rpc, 'eth_getStorageAt', [rater, usedNonceSlot(nonce), '0x' + block.toString(16)]);
  const value = quantityOf(raw);
  if (value === 0n) return false;
  if (value === 1n) return true;
  return null;
}

/**
 * A spent nonce whose rating the logs still do not show a day after the send
 * goes to a human: the nonce may have been cancelled (`cancelNonce`), or the
 * provider may not serve logs that old. It is never prepared again either way.
 */
export const LANDED_UNSEEN_LIMIT_SECS = 86_400;

function unseenTooLong(ctx: Context, s: Submission, step: Scan): boolean {
  return step.note === 'relay_landed_unseen' && ctx.now - s.submittedAt > LANDED_UNSEEN_LIMIT_SECS;
}

interface Scan {
  found: { tx: string } | null;
  /** The chain was read past the deadline and the nonce is unspent: the signature can never land. */
  absent: boolean;
  cursor: number;
  /** Why the row waits when neither found nor absent. */
  note: string | null;
}

/** One step of the chain scan for a submitted rating. */
async function scanStep(ctx: Context, row: RatingRow): Promise<Scan> {
  const s = row.submission as Submission;
  const params = paramsOf(row, row.feedback as FeedbackInput);
  const head = await blockNumber(ctx.deps.rpc);
  const span = Math.max(1, ctx.deps.scanBlocks ?? 2000);
  const from = s.scanCursor;
  const to = Math.min(from + span - 1, head);
  if (to >= from) {
    const logs = await rpcCall(ctx.deps.rpc, 'eth_getLogs', [
      {
        address: ctx.chain.reputationRegistry,
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
        topics: [NEW_FEEDBACK_TOPIC, topicOf(BigInt(params.agentId as string)), topicOf(s.rater)],
      },
    ]);
    if (!Array.isArray(logs)) throw new ReputationError('rpc_failed', 'eth_getLogs answered no list');
    for (const entry of logs) {
      if (matchFeedbackLog(entry, ctx.chain, s.rater, params) !== null) {
        const tx = bytes32Of((entry as Record<string, unknown>).transactionHash);
        if (tx) return { found: { tx }, absent: false, cursor: from, note: null };
      }
    }
  }
  // A range that stops short of the head moves on, whatever the span; once
  // the head is reached, the last few blocks (what a shallow reorg could
  // still replace) are read again next time.
  const cursor = to === head ? Math.max(from, head + 1 - REORG_OVERLAP_BLOCKS) : to + 1;
  if (!(to === head && to >= from) || (await blockTimestamp(ctx.deps.rpc, head)) <= s.deadline + DEADLINE_GRACE_SECS) {
    return { found: null, absent: false, cursor, note: null };
  }
  // The logs show nothing up to a block past the deadline. Logs can be
  // incomplete without an error, so the state decides.
  const spent = await nonceSpent(ctx, s.rater, s.nonce, head);
  if (spent === false) return { found: null, absent: true, cursor, note: null };
  if (spent === true) {
    // It landed and the logs missed it: read them again from the first block.
    return { found: null, absent: false, cursor: s.scanFromBlock, note: 'relay_landed_unseen' };
  }
  return { found: null, absent: false, cursor, note: 'relay_outcome_unknown' };
}

async function reconcileSubmitted(ctx: Context, row: RatingRow): Promise<RatingRow> {
  const s = row.submission as Submission;
  const params = paramsOf(row, row.feedback as FeedbackInput);
  const receipt = await rpcCall(ctx.deps.rpc, 'eth_getTransactionReceipt', [row.transaction]);
  const reverted = isRecord(receipt) && quantityOf(receipt.status) !== 1n;
  if (!isRecord(receipt) || reverted) {
    if (!reverted && ctx.now <= s.deadline + DEADLINE_GRACE_SECS) {
      return move(ctx, row, 'submitted', { nextAttemptAt: ctx.now + POLL_SECS });
    }
    // Reverted, or never mined past the deadline: the chain decides what landed.
    const step = await scanStep(ctx, row);
    if (step.found) {
      return move(ctx, row, 'submitted', {
        transaction: step.found.tx,
        submission: { ...s, scanCursor: step.cursor },
        nextAttemptAt: ctx.now,
      });
    }
    if (step.absent) {
      return reverted
        ? move(ctx, row, 'submitted', { status: 'failed', error: 'relay_reverted' })
        : move(ctx, row, 'submitted', {
            status: 'paid',
            submission: null,
            transaction: null,
            error: 'relay_expired',
            nextAttemptAt: ctx.now,
          });
    }
    if (unseenTooLong(ctx, s, step)) {
      return move(ctx, row, 'submitted', { status: 'failed', error: 'relay_landed_unseen' });
    }
    return move(ctx, row, 'submitted', {
      submission: { ...s, scanCursor: step.cursor },
      ...(step.note ? { error: step.note } : {}),
      nextAttemptAt: ctx.now + POLL_SECS,
    });
  }
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  let index: number | null = null;
  for (const entry of logs) {
    index = matchFeedbackLog(entry, ctx.chain, s.rater, params);
    if (index !== null) break;
  }
  if (index === null) return move(ctx, row, 'submitted', { status: 'failed', error: 'feedback_event_mismatch' });
  const block = safeUint(quantityOf(receipt.blockNumber) ?? -1);
  if (block === null) throw new ReputationError('rpc_failed', 'the receipt has no block');
  const head = await blockNumber(ctx.deps.rpc);
  if (head - block + 1 < (ctx.deps.confirmations ?? 2)) {
    return move(ctx, row, 'submitted', { nextAttemptAt: ctx.now + POLL_SECS });
  }
  log(ctx.deps.logger, 'info', 'reputation: rating confirmed', { ref: row.ref, tx: row.transaction, feedbackIndex: index });
  return move(ctx, row, 'submitted', { status: 'confirmed', feedbackIndex: index, confirmedAt: ctx.now, error: null });
}

async function send(ctx: Context, row: RatingRow): Promise<RatingRow> {
  const s = row.submission as Submission;
  const feedback = row.feedback as FeedbackInput;
  const request: SubmitRelayFeedbackRequest = {
    x402Version: X402_VERSION,
    network: row.network as Erc8004Network,
    feedback: wireFeedback(row, feedback, s.rater),
    deadline: s.deadline,
    nonce: s.nonce,
    signature: s.signature,
    ...(s.authorization ? { authorization: s.authorization } : {}),
  };
  let resp: unknown;
  try {
    resp = await ctx.deps.client.submitRelayedFeedback(request);
  } catch {
    resp = { success: false, retryable: true, safeToReplay: false };
  }
  const sends = s.sends + 1;
  if (isRecord(resp) && resp.success === true && bytes32Of(resp.transaction) !== null) {
    if (isRecord(resp.proof) && resp.proof.rejection) {
      log(ctx.deps.logger, 'warn', 'reputation: the facilitator relayed the rating but did not verify its proof', {
        ref: row.ref,
        rejection: String(resp.proof.rejection),
      });
    }
    if (ctx.deps.governor) await ctx.deps.governor.recordSuccess();
    const next = await move(ctx, row, 'submitting', {
      status: 'submitted',
      transaction: bytes32Of(resp.transaction),
      submission: { ...s, sends, lastOutcome: null },
      error: null,
      nextAttemptAt: ctx.now + POLL_SECS,
    });
    return next.status === 'submitted' ? reconcileSubmitted(ctx, next) : next;
  }
  await tellBreaker(ctx, resp);
  const r = isRecord(resp) ? resp : {};
  const outcome: Submission['lastOutcome'] =
    r.success === true ? 'uncertain' : r.retryable === true ? (r.safeToReplay === true ? 'retryable' : 'uncertain') : 'refused';
  const status = typeof r.status === 'number' ? r.status : null;
  log(ctx.deps.logger, 'warn', 'reputation: the submit did not come back with a transaction; reconciling', {
    ref: row.ref,
    outcome,
    status,
  });
  const next = await move(ctx, row, 'submitting', {
    submission: { ...s, sends, lastOutcome: outcome },
    error: `submit_${status ?? outcome}`,
    attempts: row.attempts + 1,
    nextAttemptAt: ctx.now + retryDelay(sends),
  });
  return next.status === 'submitting' ? reconcileSubmitting(ctx, next, false) : next;
}

async function reconcileSubmitting(ctx: Context, row: RatingRow, mayResend: boolean): Promise<RatingRow> {
  const s = row.submission as Submission;
  const step = await scanStep(ctx, row);
  if (step.found) {
    const next = await move(ctx, row, 'submitting', {
      status: 'submitted',
      transaction: step.found.tx,
      submission: { ...s, scanCursor: step.cursor },
      error: null,
      nextAttemptAt: ctx.now,
    });
    return next.status === 'submitted' ? reconcileSubmitted(ctx, next) : next;
  }
  if (step.absent) {
    log(ctx.deps.logger, 'info', 'reputation: the deadline passed, the nonce is unspent; preparing again', { ref: row.ref });
    return move(ctx, row, 'submitting', {
      status: 'paid',
      submission: null,
      transaction: null,
      error: 'relay_expired',
      nextAttemptAt: ctx.now,
    });
  }
  if (step.note) log(ctx.deps.logger, 'warn', `reputation: ${step.note}`, { ref: row.ref });
  if (unseenTooLong(ctx, s, step)) {
    return move(ctx, row, 'submitting', { status: 'failed', error: 'relay_landed_unseen' });
  }
  const updated = await move(ctx, row, 'submitting', {
    submission: { ...s, scanCursor: step.cursor },
    ...(step.note ? { error: step.note } : {}),
  });
  const resend =
    mayResend &&
    updated.status === 'submitting' &&
    (s.lastOutcome === 'retryable' || s.lastOutcome === 'uncertain') &&
    s.sends < MAX_SENDS &&
    ctx.now < s.deadline - RESEND_MARGIN_SECS &&
    (await blocked(ctx)) === null;
  if (resend) return send(ctx, updated);
  if (updated.status !== 'submitting') return updated;
  return move(ctx, updated, 'submitting', {
    nextAttemptAt: Math.max(updated.nextAttemptAt, ctx.now + POLL_SECS),
  });
}

async function prepareAndSend(ctx: Context, row: RatingRow): Promise<RatingRow> {
  const { deps } = ctx;
  if (row.forgotten) return move(ctx, row, 'paid', { status: 'local_only', error: 'forgotten' });
  if (!row.proof) throw new ReputationError('invalid_transition', 'a paid row has no proof');
  if (ctx.now - row.proof.timestamp > (deps.proofMaxAgeSecs ?? PROOF_MAX_AGE_SECS) - PROOF_SAFETY_SECS) {
    return move(ctx, row, 'paid', { status: 'failed', error: 'proof_expired' });
  }
  let current = row;
  if (!current.feedback) {
    if (!deps.buildFeedback) throw new ReputationError('feedback_missing', 'a paid row needs its feedback fields');
    const feedback = feedbackOf(await deps.buildFeedback(current));
    if (current.agentId !== null && feedback.agentId !== current.agentId) {
      throw new ReputationError('invalid_input', 'buildFeedback gave another agentId than the row was enqueued with');
    }
    current = await move(ctx, current, 'paid', { feedback });
    if (current.status !== 'paid' || !current.feedback) return current;
  }
  const feedback = current.feedback as FeedbackInput;
  const rater = ethers.getAddress(deps.signer.address.toLowerCase());
  if (!sameAddress(current.proof?.payer, rater)) {
    return move(ctx, current, 'paid', { status: 'failed', error: 'payer_is_not_rater' });
  }
  if ((await ownerOf(deps.rpc, ctx.chain, feedback.agentId)) !== current.subject) {
    return move(ctx, current, 'paid', { status: 'failed', error: 'identity_owner_mismatch' });
  }

  const until = await blocked(ctx);
  if (until !== null) return move(ctx, current, 'paid', { error: 'breaker_open', nextAttemptAt: until });
  // The other side of `authorization_in_flight`: a first rating's authorization
  // is signed over the account nonce, which a payment still in flight will use.
  if ((await deps.outbox.count({ statuses: ['paying'] })) > 0 && !(await raterDelegated(ctx))) {
    return move(ctx, current, 'paid', { error: 'payment_in_flight', nextAttemptAt: ctx.now + POLL_SECS });
  }

  const params = paramsOf(current, feedback);
  const prepRequest: PrepareRelayFeedbackRequest = {
    x402Version: X402_VERSION,
    network: current.network as Erc8004Network,
    feedback: wireFeedback(current, feedback, rater),
  };
  let prep: unknown;
  try {
    prep = await deps.client.prepareRelayedFeedback(prepRequest);
  } catch {
    prep = { success: false, retryable: true };
  }
  if (!isRecord(prep) || prep.success !== true) {
    await tellBreaker(ctx, prep);
    const status = isRecord(prep) && typeof prep.status === 'number' ? prep.status : 'failed';
    return later(ctx, current, `prepare_${status}`);
  }

  let validated;
  try {
    validated = validatePreparation(prep, params, rater, {
      now: ctx.now,
      maxDeadlineAheadSecs: deps.maxDeadlineAheadSecs,
    });
  } catch (error) {
    const code = errorCode(error);
    log(deps.logger, 'error', 'reputation: refused to sign a prepare', { ref: current.ref, code });
    // A deadline out of the window may be clock skew; anything else is a
    // prepare asking for something other than this rating.
    return code === 'deadline' ? later(ctx, current, code) : move(ctx, current, 'paid', { status: 'failed', error: code });
  }
  const signature = await signRelayedFeedback(validated, deps.signer);
  const authorization = validated.delegated ? null : await buildRelayAuthorization(validated, deps.signer);
  const scanFromBlock = Math.max(0, (await blockNumber(deps.rpc)) - REORG_OVERLAP_BLOCKS);
  const submission: Submission = {
    rater,
    nonce: validated.nonce,
    deadline: validated.deadline,
    signature,
    authorization,
    scanFromBlock,
    scanCursor: scanFromBlock,
    submittedAt: ctx.now,
    sends: 0,
    lastOutcome: null,
  };
  const moved = await deps.outbox.transition(current.ref, 'paid', {
    status: 'submitting',
    submission,
    attempts: current.attempts + 1,
    error: null,
    nextAttemptAt: ctx.now,
  });
  if (!moved) {
    // Another worker moved the row first. This signature is never sent.
    log(deps.logger, 'warn', 'reputation: lost the race to submit; sending nothing', { ref: current.ref });
    return (await deps.outbox.get(current.ref)) as RatingRow;
  }
  return send(ctx, moved);
}

/** Rows a process is working on right now, per outbox: one tick per row at a time. */
const RUNNING = new WeakMap<object, Set<string>>();

async function exclusively<T>(outbox: RatingOutbox, ref: string, busy: () => Promise<T>, work: () => Promise<T>): Promise<T> {
  let refs = RUNNING.get(outbox);
  if (!refs) {
    refs = new Set();
    RUNNING.set(outbox, refs);
  }
  if (refs.has(ref)) return busy();
  refs.add(ref);
  try {
    return await work();
  } finally {
    refs.delete(ref);
  }
}

async function advance(ref: string, deps: SubmitDeps): Promise<RatingRow> {
  const row = await deps.outbox.get(ref);
  if (!row) throw new ReputationError('row_missing', 'no outbox row has this ref');
  const chain = reputationChain(row.network);
  if (!chain) throw new ReputationError('unknown_chain', `no FeedbackDelegate is known for ${row.network}`);
  if (!deps.signer || !isAddress(deps.signer.address)) {
    throw new ReputationError('signer_unavailable', 'submitWithReconcile needs the rater signer');
  }
  const ctx: Context = { deps, chain, now: (deps.now ?? (() => Math.floor(Date.now() / 1000)))() };
  switch (row.status) {
    case 'paid':
      return prepareAndSend(ctx, row);
    case 'submitting':
      return reconcileSubmitting(ctx, row, row.nextAttemptAt <= ctx.now);
    case 'submitted':
      return reconcileSubmitted(ctx, row);
    default:
      return row;
  }
}

/**
 * Advance a `paid`, `submitting` or `submitted` row. Returns the row as
 * stored afterwards. A row in any other status, or one this process is
 * already working on, is returned untouched.
 */
export async function submitWithReconcile(ref: string, deps: SubmitDeps): Promise<RatingRow> {
  return exclusively(
    deps.outbox,
    ref,
    async () => {
      const row = await deps.outbox.get(ref);
      if (!row) throw new ReputationError('row_missing', 'no outbox row has this ref');
      return row;
    },
    () => advance(ref, deps)
  );
}

export interface ProcessDeps extends SubmitDeps {
  governor: Governor;
  /**
   * The rated wallet's ERC-8004 agent, for a row enqueued without one: run
   * BEFORE the payment, so nobody is paid who cannot be rated. `null` means
   * the wallet has no agent and the row ends `local_only`. Without this, a
   * row with no `agentId` is never paid (it waits with `agent_unknown`).
   */
  resolveAgent?: (row: RatingRow) => string | number | bigint | null | Promise<string | number | bigint | null>;
  /** Gas ceilings and receipt polling for the anchor payment. */
  payment?: GasLimits & {
    confirmations?: number;
    maxPolls?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
}

/** Payment errors that are final for the payment they were read about. */
const PAYMENT_DEFINITIVE: ReadonlySet<string> = new Set([
  'payment_reverted',
  'payment_transfer_missing',
  'payment_mismatch',
  'proof_expired',
]);

/** Whether the rater's account is delegated to this chain's delegate. */
async function raterDelegated(ctx: Context): Promise<boolean> {
  const code = await rpcCall(ctx.deps.rpc, 'eth_getCode', [ctx.deps.signer.address, 'latest']);
  return typeof code === 'string' && code.toLowerCase() === '0xef0100' + ctx.chain.delegate.slice(2).toLowerCase();
}

async function pay(
  ctx: Context & { deps: ProcessDeps },
  row: RatingRow,
  mine: { tx: string | null }
): Promise<RatingRow> {
  const { deps } = ctx;
  let current = row;
  if (current.status === 'queued') {
    const admission = await deps.governor.admit(current);
    if (!admission.ok) {
      if (admission.final) return move(ctx, current, 'queued', { status: 'local_only', error: admission.reason });
      return move(ctx, current, 'queued', { error: admission.reason, nextAttemptAt: admission.retryAt ?? ctx.now + POLL_SECS });
    }
    // Nobody is paid who cannot be rated: the agent is known, and owned by the wallet, first.
    if (current.agentId === null) {
      if (!deps.resolveAgent) return later(ctx, current, 'agent_unknown');
      const resolved = await deps.resolveAgent(current);
      if (resolved === null || resolved === undefined) {
        return move(ctx, current, 'queued', { status: 'local_only', error: 'no_agent' });
      }
      const agentId = uintOf(resolved);
      if (agentId === null) throw new ReputationError('invalid_input', 'resolveAgent gave no uint256 agentId');
      current = await move(ctx, current, 'queued', { agentId: agentId.toString() });
      if (current.status !== 'queued' || current.agentId === null) return current;
    }
    if ((await ownerOf(deps.rpc, ctx.chain, current.agentId)) !== current.subject) {
      return move(ctx, current, 'queued', { status: 'local_only', error: 'identity_owner_mismatch' });
    }
    // One anchor payment in flight per rater: two would race for one account nonce.
    if ((await deps.outbox.count({ statuses: ['paying'] })) > 0) {
      return move(ctx, current, 'queued', { error: 'payment_in_flight', nextAttemptAt: ctx.now + POLL_SECS });
    }
    // A first rating's EIP-7702 authorization is signed over the account's
    // nonce; a payment sent before it lands would use that nonce and void it.
    if ((await deps.outbox.count({ statuses: ['submitting', 'submitted'] })) > 0 && !(await raterDelegated(ctx))) {
      return move(ctx, current, 'queued', { error: 'authorization_in_flight', nextAttemptAt: ctx.now + POLL_SECS });
    }
  }
  const proof = await payAndProve({
    signer: deps.signer,
    rpc: deps.rpc,
    network: current.network,
    payee: current.subject,
    amount: current.amount,
    resume: current.status === 'paying' ? current.payment : null,
    onSigned: async (payment) => {
      const moved = await deps.outbox.transition(current.ref, 'queued', {
        status: 'paying',
        payment,
        startedAt: ctx.now,
        attempts: current.attempts + 1,
        error: null,
        nextAttemptAt: ctx.now + POLL_SECS,
      });
      if (!moved) {
        throw new ReputationError('invalid_transition', 'the row moved before its payment was stored; nothing was sent');
      }
      current = moved;
      mine.tx = payment.transactionHash;
    },
    confirmations: deps.payment?.confirmations,
    maxPolls: deps.payment?.maxPolls,
    pollIntervalMs: deps.payment?.pollIntervalMs,
    sleep: deps.payment?.sleep,
    maxFeePerGasWei: deps.payment?.maxFeePerGasWei,
    maxGasLimit: deps.payment?.maxGasLimit,
    minNativeBalanceWei: deps.payment?.minNativeBalanceWei,
    now: deps.now,
    logger: deps.logger,
  });
  const paid = await move(ctx, current, 'paying', { status: 'paid', proof, error: null, nextAttemptAt: ctx.now });
  if (paid.status === 'paid' && paid.forgotten) {
    return move(ctx, paid, 'paid', { status: 'local_only', error: 'forgotten' });
  }
  return paid;
}

/**
 * One worker tick for one row: admit and pay a `queued` row, finish a
 * `paying` one, then hand `paid` / `submitting` / `submitted` to
 * {@link submitWithReconcile}. An error is stored on the row as a code with a
 * retry time; an anchor payment that can never complete (reverted, or its
 * nonce used by another transaction for an hour) fails the row for a human.
 * A row this process is already working on is returned untouched.
 */
export async function processRating(ref: string, deps: ProcessDeps): Promise<RatingRow | null> {
  return exclusively(deps.outbox, ref, () => deps.outbox.get(ref), () => tick(ref, deps));
}

async function tick(ref: string, deps: ProcessDeps): Promise<RatingRow | null> {
  let row = await deps.outbox.get(ref);
  if (!row) return null;
  const chain = reputationChain(row.network);
  if (!chain) throw new ReputationError('unknown_chain', `no FeedbackDelegate is known for ${row.network}`);
  const ctx = { deps, chain, now: (deps.now ?? (() => Math.floor(Date.now() / 1000)))() };
  if (row.nextAttemptAt > ctx.now) return row;
  const mine: { tx: string | null } = {
    tx: row.status === 'paying' ? (row.payment?.transactionHash ?? null) : null,
  };
  try {
    if (row.status === 'queued' || row.status === 'paying') row = await pay(ctx, row, mine);
    if (row.status === 'paid' || row.status === 'submitting' || row.status === 'submitted') {
      row = await advance(ref, deps);
    }
    return row;
  } catch (error) {
    const code = errorCode(error);
    if (error instanceof ReputationError && error.code === 'balance_low') {
      await deps.governor.recordFailure({ kind: 'balance_low' });
    }
    const current = await deps.outbox.get(ref);
    if (!current) return null;
    log(deps.logger, 'warn', 'reputation: tick failed', { ref, status: current.status, code });
    // Only what the chain said about the payment THIS tick signed or resumed
    // fails the row.
    const ours =
      current.status === 'paying' &&
      error instanceof ReputationError &&
      mine.tx !== null &&
      current.payment?.transactionHash === mine.tx;
    if (ours && code === 'payment_nonce_consumed') {
      // A lagging node answers this way too: fail only after an hour of it,
      // counted from the first time it was seen, not from the signature.
      const since = current.consumedSince ?? ctx.now;
      if (ctx.now - since >= NONCE_CONSUMED_GRACE_SECS) {
        return move(ctx, current, 'paying', { status: 'failed', error: code });
      }
      return move(ctx, current, 'paying', {
        consumedSince: since,
        error: code,
        attempts: current.attempts + 1,
        nextAttemptAt: ctx.now + retryDelay(current.attempts + 1),
      });
    }
    if (ours && PAYMENT_DEFINITIVE.has(code)) return move(ctx, current, 'paying', { status: 'failed', error: code });
    if (current.status === 'confirmed' || current.status === 'failed' || current.status === 'local_only') return current;
    return later(ctx, current, code);
  }
}
