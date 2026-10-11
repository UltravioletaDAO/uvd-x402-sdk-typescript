/**
 * DX402 evidence attached by the paywalls themselves: opt-in, after the handler.
 *
 * With `durable` set, {@link createFetchPaywall}, {@link createHonoMiddleware}
 * and {@link createPaymentMiddleware} read the body the handler answered with,
 * once and up to `maxBodyBytes`, seal and anchor it through
 * {@link anchorEvidence}, and add `X-Durable-Evidence` to that response.
 *
 * Evidence is an addition to the payment, never a gate in front of it: nothing
 * here changes a status, a body byte or a payment header. A response that is
 * too large, a stream that cannot be captured, a timeout or a failed anchor
 * goes out as the handler wrote it, with a skip notice in the header. Nothing
 * is anchored, and no header is added, unless the payment of THIS request
 * settled with a transaction hash before the response was complete.
 */
import { ANCHOR_MAX_REQUEST_BYTES, EVIDENCE_HEADER, anchorEvidence, evidenceHeader, paymentId } from '../dx402';
import type { AnchorOptions } from '../dx402';
import { chainToCAIP2 } from '../utils';
import type { StackKeyOptions } from './stack-key';
import type { SettleResponse, VerifiedPaymentState } from './index';

/** What {@link DurableEvidenceOptions.payerKey} receives: the settled payment of the request. */
export interface DurableEvidenceContext {
  payment: VerifiedPaymentState;
  settle: SettleResponse;
}

/**
 * `durable` of the paywall options. Every field but `payerKey` is optional.
 *
 * `sign`, `upload`, `sellerEncryptionKey`, `backend`, `retention`, `storage`
 * and `fetch` are passed to {@link anchorEvidence} as they are. `facilitator`
 * defaults to the paywall's own facilitator, and the paywall's stack key
 * options apply.
 */
export interface DurableEvidenceOptions
  extends Pick<AnchorOptions, 'sellerEncryptionKey' | 'sign' | 'upload' | 'backend' | 'retention' | 'storage' | 'fetch'> {
  /**
   * The buyer's encryption key for this payment (`payerKeyFromEvmSignature`,
   * `payerKeyFromSolanaAddress`). `undefined`, an empty key or a throw skips
   * the evidence of that response with `no_payer_key`: the sale goes on.
   */
  payerKey: (context: DurableEvidenceContext) => Uint8Array | undefined | Promise<Uint8Array | undefined>;
  /** Where the anchor goes. Defaults to the paywall's facilitator. */
  facilitator?: string;
  /**
   * Largest body captured, in bytes. Defaults to {@link ANCHOR_MAX_REQUEST_BYTES}.
   * A larger body is streamed through untouched, never held whole.
   */
  maxBodyBytes?: number;
  /**
   * Budget from the moment the handler's response is available to the anchor's
   * answer, capture included, in milliseconds. Defaults to
   * {@link DURABLE_DEFAULT_TIMEOUT_MS}. Past it the response goes out without
   * evidence and the anchor request is aborted, never sent late.
   */
  timeoutMs?: number;
}

export const DURABLE_DEFAULT_TIMEOUT_MS = 5000;
/** Largest `timeoutMs`: what `setTimeout` takes before it fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** A skip notice, as {@link anchorEvidence} writes its own. */
type Evidence = Record<string, unknown>;
const skip = (reason: string): Evidence => ({ v: 1, skipped: reason });

export interface DurableAnchorer {
  maxBodyBytes: number;
  timeoutMs: number;
  /** Seal and anchor `body` for this settled payment. Never throws. */
  anchor: (body: Uint8Array, payment: VerifiedPaymentState, settle: SettleResponse, signal: AbortSignal) => Promise<Evidence>;
}

/**
 * Validate `durable` once, when the paywall is built: a misconfiguration is
 * the integrator's to fix, not something to discover on a paid request.
 */
export function createDurableAnchorer(
  durable: DurableEvidenceOptions | undefined,
  paywall: StackKeyOptions & { facilitator: string },
): DurableAnchorer | undefined {
  if (durable === undefined) return undefined;
  if (durable === null || typeof durable !== 'object' || typeof durable.payerKey !== 'function') {
    throw new TypeError('durable.payerKey must be a function');
  }
  const maxBodyBytes = durable.maxBodyBytes ?? ANCHOR_MAX_REQUEST_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new TypeError('durable.maxBodyBytes must be a positive integer');
  }
  const timeoutMs = durable.timeoutMs ?? DURABLE_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`durable.timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  const facilitator = durable.facilitator ?? paywall.facilitator;

  return {
    maxBodyBytes,
    timeoutMs,
    anchor: async (body, payment, settle, signal) => {
      try {
        const txHash = settle.transactionHash as string;
        const network = chainToCAIP2(settle.network || payment.requirements.network);
        let payerKey: Uint8Array | undefined;
        try {
          payerKey = await durable.payerKey({ payment, settle });
        } catch {
          return skip('no_payer_key');
        }
        if (!(payerKey instanceof Uint8Array) || payerKey.length === 0) return skip('no_payer_key');
        if (signal.aborted) return skip('timeout');
        const baseFetch = durable.fetch ?? fetch;
        // The anchor request carries the deadline: once it passes, a slow
        // `payerKey`, `sign` or `upload` can no longer send an anchor that no
        // response will ever point at.
        const boundFetch: typeof fetch = (input, init) => {
          if (signal.aborted) return Promise.reject(new Error('durable evidence deadline passed'));
          return baseFetch(input, { ...init, signal });
        };
        return await anchorEvidence(body, {
          paymentId: paymentId(network, txHash),
          network,
          txHash,
          payer: settle.payer || payment.verifyResult.payer || '',
          payee: payment.requirements.payTo,
          payerKey,
          sellerEncryptionKey: durable.sellerEncryptionKey,
          proofOfPayment: settle.proofOfPayment as unknown as Record<string, unknown> | undefined,
          sign: durable.sign,
          upload: durable.upload,
          backend: durable.backend,
          retention: durable.retention,
          storage: durable.storage,
          facilitator,
          stackKey: paywall.stackKey,
          stackKeyHosts: paywall.stackKeyHosts,
          fetch: boundFetch,
        });
      } catch {
        return skip('anchor_failed');
      }
    },
  };
}

/** Receipt states that do not confirm a settlement, even under `success: true`. */
const UNCONFIRMED_RECEIPT = new Set(['pending', 'unknown', 'rejected']);

/**
 * Whether this request's payment settled, with a transaction, and evidence can
 * name it. A replayed settle names a payment an earlier request already
 * anchored: a second anchor would be a second claim on it. A receipt that is
 * still pending, unknown or rejected does not confirm the transfer the anchor
 * would name.
 */
export function settledForEvidence(settle: SettleResponse | undefined): settle is SettleResponse {
  return settle?.success === true && settle.replayed !== true
    && typeof settle.transactionHash === 'string' && settle.transactionHash !== ''
    && !UNCONFIRMED_RECEIPT.has(String(settle.receipt?.status ?? ''));
}

/** A deadline: `signal` aborts after `ms`; `expired` resolves then. `clear()` releases the timer. */
function deadline(ms: number): { signal: AbortSignal; expired: Promise<void>; clear: () => void } {
  const controller = new AbortController();
  let release: () => void = () => {};
  const expired = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, ms);
    release = () => clearTimeout(timer);
  });
  return { signal: controller.signal, expired, clear: release };
}

/** Anchor under the deadline: `timeout` once it passes, whatever is still running. */
async function anchorWithin(
  anchorer: DurableAnchorer,
  body: Uint8Array,
  payment: VerifiedPaymentState,
  settle: SettleResponse,
  clock: ReturnType<typeof deadline>,
): Promise<Evidence> {
  if (clock.signal.aborted) return skip('timeout');
  return Promise.race([
    anchorer.anchor(body, payment, settle, clock.signal),
    clock.expired.then(() => skip('timeout')),
  ]);
}

function concat(chunks: Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function isEventStream(contentType: string | null | undefined): boolean {
  return (contentType ?? '').split(';')[0].trim().toLowerCase() === 'text/event-stream';
}

/** The response a paywall's handler answered, and the payment behind it. */
export interface DurableRun {
  anchorer: DurableAnchorer;
  payment: VerifiedPaymentState;
  /** The settle result of this request, if `settle()` resolved before the response. */
  settled: SettleResponse | undefined;
  method: string | undefined;
}

/** Only a settled, successful answer to a request that has a body carries evidence. */
function wantsEvidence(run: DurableRun, status: number, hasHeader: boolean): run is DurableRun & { settled: SettleResponse } {
  if (!settledForEvidence(run.settled)) return false;
  if (status < 200 || status > 299) return false;
  if ((run.method ?? '').toUpperCase() === 'HEAD') return false;
  // The handler anchored this response itself: a second anchor is a second
  // claim on the same payment.
  return !hasHeader;
}

function rebuilt(response: Response, body: BodyInit | null, evidence: Evidence): Response {
  const headers = new Headers(response.headers);
  headers.set(EVIDENCE_HEADER, evidenceHeader(evidence));
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * The chunks already read, then the rest of `reader`, as one stream: a body
 * that outgrew the cap or the deadline goes out whole without being held.
 * `pending` is a read already requested, whose chunk must not be lost.
 */
function resumed(
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined,
): ReadableStream<Uint8Array> {
  let next = pending;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const head = chunks.shift();
      if (head) {
        controller.enqueue(head);
        return;
      }
      const read = next ?? reader.read();
      next = undefined;
      try {
        const { done, value } = await read;
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * The Fetch and Hono post-hook: `response` with `X-Durable-Evidence` when the
 * payment settled and the body was captured, as it was otherwise. The body is
 * read once; it is never read twice and never held past `maxBodyBytes`.
 */
export async function withDurableEvidence(response: Response, run: DurableRun): Promise<Response> {
  if (!wantsEvidence(run, response.status, response.headers.has(EVIDENCE_HEADER))) return response;
  const { anchorer } = run;
  const body = response.body;
  if (body === null || response.bodyUsed || body.locked || isEventStream(response.headers.get('content-type'))) {
    return response.bodyUsed || body?.locked ? response : rebuilt(response, body, skip('not_capturable'));
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > anchorer.maxBodyBytes) {
    return rebuilt(response, body, skip('too_large'));
  }

  const clock = deadline(anchorer.timeoutMs);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const read = reader.read();
      const step = await Promise.race([read, clock.expired.then(() => 'timeout' as const)]);
      if (step === 'timeout') {
        return rebuilt(response, resumed(chunks, reader, read), skip('timeout'));
      }
      if (step.done) break;
      const chunk = step.value instanceof Uint8Array ? step.value : new Uint8Array(step.value as ArrayBuffer);
      chunks.push(chunk);
      size += chunk.length;
      if (size > anchorer.maxBodyBytes) {
        clock.clear();
        return rebuilt(response, resumed(chunks, reader, undefined), skip('too_large'));
      }
    }
  } catch (error) {
    // The handler's own stream failed: what was read goes out, then the same
    // error, as it would have without the hook.
    // Pulled one by one: an error raised with chunks still queued drops them.
    const failed = new ReadableStream<Uint8Array>({
      pull(controller) {
        const head = chunks.shift();
        if (head) controller.enqueue(head);
        else controller.error(error);
      },
    });
    clock.clear();
    return rebuilt(response, failed, skip('not_capturable'));
  }

  const bytes = concat(chunks, size);
  try {
    const evidence = await anchorWithin(anchorer, bytes, run.payment, run.settled, clock);
    return rebuilt(response, bytes, evidence);
  } finally {
    clock.clear();
  }
}

/** The slice of a Node `ServerResponse` (Express's `res`) the Express post-hook needs. */
export interface DurableNodeResponse {
  statusCode?: number;
  headersSent?: boolean;
  write: (...args: any[]) => any;
  end: (...args: any[]) => any;
  setHeader: (name: string, value: string) => unknown;
  getHeader: (name: string) => unknown;
}

export function isDurableNodeResponse(res: unknown): res is DurableNodeResponse {
  const r = res as Partial<DurableNodeResponse> | null;
  return !!r && typeof r.write === 'function' && typeof r.end === 'function'
    && typeof r.setHeader === 'function' && typeof r.getHeader === 'function';
}

const headersSentError = () =>
  Object.assign(new Error('Cannot set headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' });

interface SealedResponse {
  restore: () => void;
  /** A close asked for during the window, to run once the body is written. */
  close: () => (() => void) | undefined;
  /** Whether the connection can still take the body. */
  writable: () => boolean;
}

/**
 * While the anchor of an ended response runs, `res` reads as sent and its
 * headers as frozen, as they would be without the hook: a fallback that checks
 * `headersSent` leaves it alone and a late header cannot change the paid
 * answer. A close the server asks for in that window (`res.destroy()` or
 * `socket.destroy()` without an error, as Express's final handler does after
 * an error once headers are sent) waits for the body, and then closes the
connection; one with an error, or one once the connection can no longer
write, does not wait.
 */
function sealEnded(res: DurableNodeResponse): SealedResponse {
  const target = res as unknown as Record<string, unknown>;
  const refuse = { value: () => { throw headersSentError(); } };
  const overrides: Record<string, PropertyDescriptor> = {
    headersSent: { get: () => true },
    writableEnded: { get: () => true },
    setHeader: refuse,
    removeHeader: refuse,
    writeHead: refuse,
  };
  const saved: [string, PropertyDescriptor | undefined][] = [];
  for (const [key, descriptor] of Object.entries(overrides)) {
    const own = Object.getOwnPropertyDescriptor(target, key);
    try {
      Object.defineProperty(target, key, { ...descriptor, configurable: true });
      saved.push([key, own]);
    } catch {
      /* not overridable: left as it is */
    }
  }
  let close: (() => void) | undefined;
  const socket = (res as { socket?: unknown }).socket as Record<string, unknown> | null | undefined;
  const writable = () => !socket || (socket.destroyed !== true && socket.writable !== false);
  const destroySocket = socket && typeof socket.destroy === 'function'
    ? (socket.destroy as (...args: unknown[]) => unknown)
    : undefined;
  const closers: [Record<string, unknown>, PropertyDescriptor | undefined][] = [];
  for (const holder of [target, socket]) {
    if (!holder || typeof holder.destroy !== 'function') continue;
    const original = holder.destroy as (...args: unknown[]) => unknown;
    const own = Object.getOwnPropertyDescriptor(holder, 'destroy');
    try {
      Object.defineProperty(holder, 'destroy', {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
          if ((args[0] !== undefined && args[0] !== null) || !writable()) return original.apply(holder, args);
          if (!close) {
            let ran = false;
            // After `finish` Node has let go of `res.socket`: the socket is closed itself.
            close = () => {
              if (ran) return;
              ran = true;
              if (destroySocket) destroySocket.call(socket);
              else original.call(holder);
            };
          }
          return holder;
        },
      });
      closers.push([holder, own]);
    } catch {
      /* not overridable: left as it is */
    }
  }
  return {
    restore: () => {
      for (const [key, own] of saved) {
        if (own) Object.defineProperty(target, key, own);
        else delete target[key];
      }
      for (const [holder, own] of closers) {
        if (own) Object.defineProperty(holder, 'destroy', own);
        else delete holder.destroy;
      }
    },
    close: () => close,
    writable,
  };
}

function toBytes(chunk: unknown, encoding: unknown): Uint8Array | undefined {
  if (chunk === undefined || chunk === null) return new Uint8Array();
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
  }
  if (chunk instanceof Uint8Array) return chunk;
  return undefined;
}

/**
 * The Express post-hook: holds what the handler writes, up to `maxBodyBytes`
 * and the deadline, and on `end()` anchors it and sets the header before the
 * first byte goes out. Past either limit, or for an event stream or a chunk it
 * cannot read, everything held is written at once and the rest passes through.
 * `settled()` is read when the body is complete.
 */
export function captureNodeResponse(
  res: DurableNodeResponse,
  anchorer: DurableAnchorer,
  payment: VerifiedPaymentState,
  settled: () => SettleResponse | undefined,
  method: string | undefined,
): void {
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  let state: 'capturing' | 'passing' | 'ending' | 'done' = 'capturing';
  /** `end()` callbacks of calls made while the anchor ran. */
  const lateEnds: ((error?: Error | null) => void)[] = [];
  const chunks: Uint8Array[] = [];
  let size = 0;
  let clock: ReturnType<typeof deadline> | undefined;

  const run = (): DurableRun => ({ anchorer, payment, settled: settled(), method });
  const eligible = () => !res.headersSent && wantsEvidence(run(), res.statusCode ?? 200, res.getHeader(EVIDENCE_HEADER) !== undefined);
  const note = (reason: string) => {
    try {
      if (eligible()) res.setHeader(EVIDENCE_HEADER, evidenceHeader(skip(reason)));
    } catch {
      /* the response goes out without the notice */
    }
  };
  /** Stop holding: the notice, then everything held, then the caller's writes as they come. */
  const passThrough = (reason: string) => {
    if (state !== 'capturing') return;
    state = 'passing';
    clock?.clear();
    note(reason);
    if (size > 0) write(concat(chunks, size));
    chunks.length = 0;
  };
  const callbackOf = (args: unknown[]) => {
    const last = args[args.length - 1];
    return typeof last === 'function' ? (last as (error?: Error | null) => void) : undefined;
  };
  /** Hold `chunk`, or stop holding when it cannot be held. False when it was not held. */
  const hold = (chunk: unknown, encoding: unknown): boolean => {
    if (res.headersSent) {
      passThrough('not_capturable');
      return false;
    }
    if (isEventStream(String(res.getHeader('content-type') ?? ''))) {
      passThrough('not_capturable');
      return false;
    }
    const bytes = toBytes(chunk, encoding);
    if (bytes === undefined) {
      passThrough('not_capturable');
      return false;
    }
    if (size + bytes.length > anchorer.maxBodyBytes) {
      passThrough('too_large');
      return false;
    }
    if (!clock) {
      clock = deadline(anchorer.timeoutMs);
      void clock.expired.then(() => passThrough('timeout'));
    }
    if (bytes.length > 0) {
      chunks.push(bytes);
      size += bytes.length;
    }
    return true;
  };

  res.write = (...args: unknown[]) => {
    if (state === 'ending') {
      // The handler already ended the response: Node refuses a write after end.
      const cb = callbackOf(args.slice(1));
      const error = Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' });
      if (cb) queueMicrotask(() => cb(error));
      return false;
    }
    if (state === 'capturing' && hold(args[0], typeof args[1] === 'function' ? undefined : args[1])) {
      const cb = callbackOf(args.slice(1));
      if (cb) queueMicrotask(() => cb());
      return true;
    }
    return write(...args);
  };

  res.end = (...args: unknown[]) => {
    if (state === 'ending') {
      // Already ended: a second end() adds nothing; its callback runs once the first is done.
      const cb = callbackOf(args);
      if (cb) lateEnds.push(cb);
      return res;
    }
    if (state !== 'capturing') return end(...args);
    const chunk = typeof args[0] === 'function' ? undefined : args[0];
    const encoding = typeof args[1] === 'function' ? undefined : args[1];
    const cb = callbackOf(args);
    if (!hold(chunk, encoding)) return end(...args);
    const bytes = concat(chunks, size);
    chunks.length = 0;
    if (!eligible()) {
      state = 'done';
      clock?.clear();
      return cb ? end(bytes, cb) : end(bytes);
    }
    state = 'ending';
    const statusCode = res.statusCode;
    const sealed = sealEnded(res);
    const finish = (evidence: Evidence) => {
      clock?.clear();
      sealed.restore();
      if (statusCode !== undefined) res.statusCode = statusCode;
      try {
        if (!res.headersSent) res.setHeader(EVIDENCE_HEADER, evidenceHeader(evidence));
      } catch {
        /* the response goes out without the header */
      }
      state = 'done';
      const close = sealed.close();
      const done = close
        ? (error?: Error | null) => { if (cb) cb(error); close(); }
        : cb;
      const ended = done ? end(bytes, done) : end(bytes);
      for (const late of lateEnds.splice(0)) end(late);
      // A connection that can no longer write never finishes: nothing to wait for.
      if (close && !sealed.writable()) close();
      return ended;
    };
    const current = run();
    const timer = clock ?? deadline(anchorer.timeoutMs);
    clock = timer;
    anchorWithin(anchorer, bytes, payment, current.settled as SettleResponse, timer)
      .then(finish, () => finish(skip('anchor_failed')));
    return res;
  };
}
