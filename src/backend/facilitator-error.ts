/**
 * Reading a facilitator refusal as DATA instead of prose.
 *
 * # Why this file exists
 *
 * `402` and `503` say opposite things and the SDK used to collapse both into
 * `success: false` plus an English sentence.
 *
 * - **402** means the payment was REJECTED. The credential is spent; sign a new
 *   authorization.
 * - **503** means NO VERDICT WAS REACHED. Nothing was rejected and nothing was
 *   executed; retry the SAME credential.
 *
 * Turning a 503 into a 402 makes the buyer sign and send a second payment for a
 * money movement that was never refused — they pay twice. That is the most
 * expensive mistake this SDK can make, so every facilitator edge now reports the
 * status, the facilitator's own `reason`, and whether the request may be
 * replayed.
 *
 * # The writer lease
 *
 * The facilitator serialises every EVM write through the one process that holds
 * the EVM writer lease, because they all spend gas from the same EOA and the
 * nonce for it is allocated in memory. A task that does not hold the lease
 * forwards the request to the one that does; when it cannot, it answers
 * `503` + `Retry-After: 5` + `{"error": "...", "reason": "<why>"}`.
 *
 * The five reasons do NOT share retry semantics, which is the whole point of
 * surfacing them:
 *
 * | reason                     | did the write run? | replay? |
 * |----------------------------|--------------------|---------|
 * | `holder_unknown`           | no                 | yes     |
 * | `forwarding_disabled`      | no                 | yes     |
 * | `forwarded_but_not_writer` | no                 | yes     |
 * | `body_unreadable`          | no                 | yes     |
 * | `forward_failed`           | **maybe**          | **no**  |
 *
 * `forward_failed` is emitted after the forward was attempted: the holder may
 * have executed the write and the response been lost on the way back. It is a
 * timeout wearing a status code. Replaying a `/register` on it is exactly the
 * sequence that once minted five duplicate agents — reconcile with
 * `GET /identity/{network}/owner/{recipient}` or `getRegisterStatus` instead.
 *
 * # The two `502`s of `/settle`, which mean opposite things
 *
 * | body `error`               | `Retry-After` | did the money move? | retry?    |
 * |----------------------------|---------------|---------------------|-----------|
 * | `upstream_rpc_unavailable` | `30`          | no, never broadcast | **yes**   |
 * | `settlement_unconfirmed`   | **absent**    | **maybe — mined?**  | **NEVER** |
 *
 * `settlement_unconfirmed` is answered after the transaction was broadcast and
 * no receipt ever arrived, so it MAY be mined. Retrying re-signs a new
 * authorization with a fresh nonce, which the chain accepts as a second,
 * perfectly valid payment for the same purchase — the buyer pays twice, in
 * exactly the case the facilitator emits it to prevent. The `transaction` hash
 * and `paymentId` travel in the body so the caller can LOOK AT THE CHAIN; they
 * are not an invitation to send it again.
 *
 * The status cannot tell the two apart, which is why this file used to get it
 * wrong: every `502` was retryable, and until `settlement_unconfirmed` existed
 * that was correct. **Branch on the body.**
 *
 * Source of the shape: x402-rs `src/handlers.rs` `writer_lease_unavailable()`
 * and `require_writer_lease()`; `SettlementUnconfirmedResponse` in
 * `src/types.rs`, built in the `IntoResponse` of `FacilitatorLocalError`.
 */

/**
 * A `reason` the facilitator attaches to a writer-lease 503.
 *
 * Typed as a union for discrimination but never used to VALIDATE: the fields
 * that carry it are plain `string`, so a reason added on the server does not
 * break compilation here.
 */
export type WriterLeaseReason =
  | 'holder_unknown'
  | 'forwarding_disabled'
  | 'forwarded_but_not_writer'
  | 'body_unreadable'
  | 'forward_failed';

/** Every writer-lease reason the facilitator emits today. */
export const WRITER_LEASE_REASONS: readonly WriterLeaseReason[] = [
  'holder_unknown',
  'forwarding_disabled',
  'forwarded_but_not_writer',
  'body_unreadable',
  'forward_failed',
];

/**
 * The reasons returned BEFORE the write is handed to anyone.
 *
 * The facilitator refuses these in its router, so the request provably did not
 * execute and re-sending the identical body is safe — including a mint.
 */
export const REPLAYABLE_LEASE_REASONS: readonly WriterLeaseReason[] = [
  'holder_unknown',
  'forwarding_disabled',
  'forwarded_but_not_writer',
  'body_unreadable',
];

/**
 * The reason that is ambiguous: the write may already have happened.
 *
 * Still `retryable` — the credential was not rejected — but never replayed
 * automatically. Resolve it by reading state, not by re-POSTing.
 */
export const AMBIGUOUS_LEASE_REASONS: readonly WriterLeaseReason[] = ['forward_failed'];

/**
 * The facilitator's `error` code for a settle it broadcast and could not confirm.
 *
 * The transaction may be mined. This is the one upstream failure that must
 * never be retried; reconcile with `transaction` / `paymentId` instead.
 */
export const SETTLEMENT_UNCONFIRMED = 'settlement_unconfirmed';

/**
 * Ceiling, in seconds, on how long an automatic retry will wait.
 *
 * `Retry-After` is a hint from a server that may be misconfigured. Honouring a
 * literal `Retry-After: 3600` would hang the caller's request for an hour
 * inside a function documented as returning promptly, so the header is honoured
 * only up to this bound.
 */
export const MAX_RETRY_AFTER_SECONDS = 15;

/** Wait used when a 503 carries no usable `Retry-After`. */
export const DEFAULT_RETRY_AFTER_SECONDS = 5;

/** How many EXTRA attempts a retryable facilitator refusal gets by default. */
export const DEFAULT_FACILITATOR_RETRIES = 2;

/**
 * A non-2xx answer from the facilitator, kept structured.
 *
 * `error` is byte-identical to the string this SDK has always produced, so
 * callers matching on it keep working; everything else is new and optional.
 */
export interface FacilitatorErrorInfo {
  /** Legacy flattened message: `Facilitator error: <status> - <body>`. */
  error: string;
  /** HTTP status the facilitator answered with. */
  status: number;
  /** The facilitator's own `reason`, when the body carried one. */
  reason?: string;
  /**
   * The facilitator's machine-readable `error` code, verbatim.
   *
   * Some codes carry a `(ref: <uuid>)` suffix, so compare with care —
   * {@link SETTLEMENT_UNCONFIRMED} is emitted bare. Branch on this rather than
   * on the status: `/settle` has two `502`s that mean opposite things.
   */
  errorCode?: string;
  /**
   * The hash of a transaction that WAS broadcast, in that chain's own encoding.
   *
   * Present on {@link SETTLEMENT_UNCONFIRMED}. Not always `0x`-prefixed:
   * Algorand prints base32 and Solana base58, and reformatting it makes it
   * unpasteable in an explorer — which is the entire remedy on offer.
   */
  transaction?: string;
  /** `keccak256(caip2 ‖ txHash)`, the same id a successful settle would print. */
  paymentId?: string;
  /**
   * Seconds to wait before retrying, already clamped to
   * {@link MAX_RETRY_AFTER_SECONDS}. Absent when the answer is not retryable.
   */
  retryAfterSeconds?: number;
  /**
   * The request reached no verdict; the credential is untouched and the SAME
   * request may be sent again. Never surface this as a payment rejection.
   */
  retryable: boolean;
  /**
   * The facilitator NAMED a reason that proves it executed nothing, so an
   * automatic replay cannot double-write.
   *
   * False for `forward_failed`, whose write may already have landed, and false
   * for an unattributed 5xx from a proxy — "something in front answered" is not
   * evidence that nothing ran.
   */
  safeToReplay: boolean;
  /** Raw response body, for logs. */
  body: string;
}

/** Fields every facilitator response type gained so a 503 stops looking terminal. */
export interface FacilitatorFailureFields {
  /** HTTP status, when the failure was transport-level rather than a verdict. */
  status?: number;
  /** The facilitator's `reason` for the refusal (see {@link WriterLeaseReason}). */
  reason?: string;
  /** The facilitator's machine-readable `error` code (see {@link FacilitatorErrorInfo.errorCode}). */
  errorCode?: string;
  /**
   * A transaction that WAS broadcast and could not be confirmed. Look it up on
   * chain; do NOT send the payment again. See {@link SETTLEMENT_UNCONFIRMED}.
   */
  transaction?: string;
  /** The payment id for that transaction, identical to the one a settle prints. */
  paymentId?: string;
  /** True when the same request may be sent again without re-signing anything. */
  retryable?: boolean;
  /** Seconds to wait before retrying, clamped to {@link MAX_RETRY_AFTER_SECONDS}. */
  retryAfterSeconds?: number;
  /** True when the facilitator provably executed nothing. */
  safeToReplay?: boolean;
}

/** A 503/429 that carries a reason known to be pre-execution. */
export function isReplayableLeaseReason(reason?: string): boolean {
  return REPLAYABLE_LEASE_REASONS.includes(reason as WriterLeaseReason);
}

/** A 503 whose write may already have run. Reconcile, do not re-POST. */
export function isAmbiguousLeaseReason(reason?: string): boolean {
  return AMBIGUOUS_LEASE_REASONS.includes(reason as WriterLeaseReason);
}

/**
 * Read `Retry-After` and clamp it.
 *
 * Tolerates a `Response`-shaped object with no `headers` at all: test doubles
 * and non-standard fetch polyfills routinely omit it, and throwing there would
 * turn a readable refusal into an unreadable crash.
 */
export function parseRetryAfterSeconds(response: {
  headers?: { get?: (name: string) => string | null };
}): number | undefined {
  let raw: string | null | undefined;
  try {
    raw = response?.headers?.get?.('retry-after');
  } catch {
    return undefined;
  }
  if (raw === null || raw === undefined || raw === '') return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/** Everything this SDK reads out of a facilitator error body. */
export interface ParsedFacilitatorErrorBody {
  /** The `error` code, verbatim. */
  errorCode?: string;
  /** The writer-lease `reason`. */
  reason?: string;
  /** A broadcast transaction hash, in its own chain's encoding. */
  transaction?: string;
  /** The payment id for that hash. */
  paymentId?: string;
  /**
   * The facilitator's OWN retry verdict, when it stated one.
   *
   * `undefined` on every body that does not carry the field — which is most of
   * them, so absence means "the facilitator did not say", never "no".
   */
  retryable?: boolean;
}

/** A body field is only usable when it is a non-empty string. */
function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Read a JSON error body, tolerating anything that is not one.
 *
 * Exported so {@link FacilitatorErrorInfo} and `Erc8004LookupError` read the
 * SAME fields the same way. Two subtly different parses of the same body is how
 * one code path stops honouring a `retryable: false` the other one honours.
 */
export function parseFacilitatorErrorBody(body: string): ParsedFacilitatorErrorBody {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    /* an HTML 503 from a load balancer is still a 503 */
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  return {
    errorCode: stringField(parsed, 'error'),
    reason: stringField(parsed, 'reason'),
    transaction: stringField(parsed, 'transaction'),
    paymentId: stringField(parsed, 'paymentId'),
    retryable: typeof parsed.retryable === 'boolean' ? parsed.retryable : undefined,
  };
}

/**
 * The facilitator said this refusal must not be retried.
 *
 * Two independent signals, because the consequence of missing it is a second
 * payment: the named code, and an explicit `retryable: false`. Either alone is
 * enough.
 */
function isDeclaredUnretryable(parsed: ParsedFacilitatorErrorBody): boolean {
  return parsed.retryable === false || parsed.errorCode === SETTLEMENT_UNCONFIRMED;
}

/**
 * This refusal reports a transaction that may already be mined.
 *
 * The caller's move is to look up `transaction` / `paymentId` on chain. Sending
 * the payment again is the double-charge.
 */
export function isSettlementUnconfirmed(failure: {
  errorCode?: string;
}): boolean {
  return failure.errorCode === SETTLEMENT_UNCONFIRMED;
}

/**
 * Turn a non-2xx facilitator response into {@link FacilitatorErrorInfo}.
 *
 * Reads the body exactly once. The `error` string keeps the historical format
 * verbatim; reformatting it would break callers that match on it.
 */
export async function readFacilitatorError(response: {
  status: number;
  text: () => Promise<string>;
  headers?: { get?: (name: string) => string | null };
}): Promise<FacilitatorErrorInfo> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  const status = response.status;
  const parsed = parseFacilitatorErrorBody(body);
  const reason = parsed.reason;
  // 429 is admission control and 502/503/504 are "no verdict". None of them is
  // a rejection of the payment, so none of them may be reported as one.
  const transportRetryable =
    status === 429 || status === 502 || status === 503 || status === 504;
  // ...unless the facilitator SAID otherwise in the body. `settlement_unconfirmed`
  // is a 502 whose transaction was already broadcast and may be mined: retrying
  // signs a second authorization, with a fresh nonce, that the chain will
  // happily accept as another payment for the same purchase.
  //
  // Only ever DOWNGRADES. A body claiming `retryable: true` on a 402 must not
  // make this SDK resend a credential the facilitator genuinely refused, so the
  // status stays the ceiling and the body is only allowed to lower it.
  const retryable = transportRetryable && !isDeclaredUnretryable(parsed);
  const retryAfterSeconds = retryable
    ? (parseRetryAfterSeconds(response) ?? DEFAULT_RETRY_AFTER_SECONDS)
    : undefined;
  // Replay only what the facilitator SAID it did not execute.
  //
  // A 429 is admission control: the request was counted, never handled. A 503
  // that names one of the pre-execution writer-lease reasons is refused in the
  // router before any signing. Everything else — an unattributed 503 from a
  // load balancer, a 502, a 504, `forward_failed` — is merely retryable: the
  // caller may resend after reconciling, but this SDK will not do it for them,
  // because "a proxy answered" is not evidence that nothing ran.
  //
  // Gated on `retryable` so the two can never disagree: a refusal this SDK will
  // not even retry must never be described as safe to replay automatically.
  const safeToReplay =
    retryable && (status === 429 || (status === 503 && isReplayableLeaseReason(reason)));

  return {
    error: `Facilitator error: ${status} - ${body}`,
    status,
    reason,
    errorCode: parsed.errorCode,
    transaction: parsed.transaction,
    paymentId: parsed.paymentId,
    retryAfterSeconds,
    retryable,
    safeToReplay,
    body,
  };
}

/** The subset of {@link FacilitatorErrorInfo} that is copied onto a response. */
export function failureFields(info: FacilitatorErrorInfo): Required<
  Pick<FacilitatorFailureFields, 'status' | 'retryable' | 'safeToReplay'>
> &
  FacilitatorFailureFields {
  return {
    status: info.status,
    retryable: info.retryable,
    safeToReplay: info.safeToReplay,
    ...(info.reason !== undefined ? { reason: info.reason } : {}),
    ...(info.errorCode !== undefined ? { errorCode: info.errorCode } : {}),
    // Without these the caller is told "do not retry" and given nothing to do
    // instead — an error that swallows the hash is the same defect one layer up.
    ...(info.transaction !== undefined ? { transaction: info.transaction } : {}),
    ...(info.paymentId !== undefined ? { paymentId: info.paymentId } : {}),
    ...(info.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: info.retryAfterSeconds }
      : {}),
  };
}

/**
 * Copy the failure fields off one response onto another.
 *
 * Used where a wrapper returns its own shape: without this the wrapper flattens
 * a `503` back into a bare failure and reintroduces, one level up, exactly the
 * ambiguity the fields exist to remove.
 */
export function carryFailureFields(
  source: FacilitatorFailureFields,
): FacilitatorFailureFields {
  return {
    ...(source.status !== undefined ? { status: source.status } : {}),
    ...(source.reason !== undefined ? { reason: source.reason } : {}),
    ...(source.errorCode !== undefined ? { errorCode: source.errorCode } : {}),
    ...(source.transaction !== undefined ? { transaction: source.transaction } : {}),
    ...(source.paymentId !== undefined ? { paymentId: source.paymentId } : {}),
    ...(source.retryable !== undefined ? { retryable: source.retryable } : {}),
    ...(source.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: source.retryAfterSeconds }
      : {}),
    ...(source.safeToReplay !== undefined ? { safeToReplay: source.safeToReplay } : {}),
  };
}

/** Options for {@link facilitatorFetch}. */
export interface FacilitatorFetchOptions {
  /** Abort the request after this many milliseconds. */
  timeoutMs: number;
  /** Extra attempts after the first. Default {@link DEFAULT_FACILITATOR_RETRIES}. */
  retries?: number;
  /**
   * Whether this particular refusal may be replayed.
   *
   * Default: only when the facilitator proved it executed nothing
   * (`info.safeToReplay`). Pass a stricter predicate on paths where even a
   * proven-safe replay is unwanted.
   */
  canReplay?: (info: FacilitatorErrorInfo) => boolean;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests, so a retry does not really sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST/GET the facilitator, replaying a refusal that provably executed nothing.
 *
 * Returns the response plus, when it was not ok, the structured refusal — the
 * body has already been consumed to build it, so callers must not read it
 * again.
 *
 * Network errors and timeouts still THROW, exactly as before: callers already
 * have `catch` blocks that turn them into `{ success: false }`, and an
 * `AbortError` on the escrow paths triggers an on-chain reconciliation that
 * must keep firing.
 */
export async function facilitatorFetch(
  url: string,
  init: RequestInit,
  options: FacilitatorFetchOptions,
): Promise<{ response: Response; error?: FacilitatorErrorInfo }> {
  const retries = options.retries ?? DEFAULT_FACILITATOR_RETRIES;
  const canReplay = options.canReplay ?? ((info: FacilitatorErrorInfo) => info.safeToReplay);
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? defaultSleep;

  let attempt = 0;
  for (;;) {
    // A fresh controller per attempt: an aborted signal stays aborted, so
    // reusing one would make every retry fail instantly.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.ok) return { response };

    const error = await readFacilitatorError(response);
    if (attempt >= retries || !error.retryable || !canReplay(error)) {
      return { response, error };
    }

    attempt += 1;
    await sleep((error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000);
  }
}
