/**
 * Nano (XNO) on `nano:mainnet`.
 *
 * Nano has no fee and no facilitator settlement: the buyer publishes a send
 * block to the merchant and pays with its hash. The merchant reads that block
 * from its own node (`block_info`) and accepts it once it is confirmed, sends
 * at least the price to the merchant, is bound to the order it was issued for,
 * was made inside the order's time window, and was not used before.
 *
 * A block has no memo and its hash is public, so "a confirmed send to payTo
 * nobody claimed" would let anyone who watches the ledger take the resource.
 * Every payment is therefore bound to ONE issued requirement: the 402 carries
 * an order id, and the buyer's own send block commits to it in its
 * `representative` field (option C of the XNO binding standard,
 * github.com/dhyabi2/xno-call-binding/blob/main/docs/BINDING-STANDARD.md).
 * The commitment covers order, payTo and price, and only the paying key can
 * sign it, so a hash seen on the ledger cannot be presented for another order.
 * The replay store is mandatory and must be persistent.
 *
 * Amounts are raw: 1 XNO = 10^30 raw. XNO is not a dollar and the SDK has no
 * rate, so the operator sets the price in raw.
 *
 * @example
 * ```ts
 * import Database from 'better-sqlite3';
 * import { createNanoVerifier, createNanoOrderIssuer, createNanoRpc, SqliteNanoReplayStore } from 'uvd-x402-sdk/nano';
 *
 * const db = new Database('nano-claims.db');
 * db.pragma('synchronous = FULL');
 * const issuer = createNanoOrderIssuer({ secret: process.env.NANO_ORDER_SECRET! });
 * // In getRequirements: put issuer.issue({ payTo, amountRaw, resource }) in the nano entry's `extra.nano`.
 * const paywall = createPaymentMiddleware(getRequirements, {
 *   localVerifiers: {
 *     nano: createNanoVerifier({
 *       issuer,
 *       rpc: createNanoRpc('http://127.0.0.1:7076'),
 *       replayStore: new SqliteNanoReplayStore(db),
 *     }),
 *   },
 * });
 * ```
 */
import type { PaymentRequirements } from '../../backend';
import type { ChainConfig, PaymentInfo, WalletAdapter, X402Header, X402HeaderV2 } from '../../types';
import { X402Error } from '../../types';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { toAtomicUnits } from '../../utils/amount';
import { encodeBase64Json } from '../../utils/base64';
import { decodeNanoAddress, encodeNanoAddress, isValidNanoAddress } from '../../utils/validation';

export const NANO_NETWORK = 'nano:mainnet';
/** Raw per XNO. */
export const NANO_RAW_PER_XNO = 10n ** 30n;
const NANO_DECIMALS = 30;
const BLOCK_HASH = /^[0-9A-Fa-f]{64}$/;
const RAW = /^(0|[1-9][0-9]*)$/;
/** The largest balance a Nano account can hold (128 bits). */
const MAX_RAW = (1n << 128n) - 1n;

/** One Nano node RPC call: the request body in, the parsed JSON answer out. */
export type NanoRpc = (request: Record<string, string>) => Promise<unknown>;

/**
 * Publishes a send block of `amountRaw` raw to `to` and resolves with its hash.
 * `options.representative` is the `nano_` account the block must carry in its
 * `representative` field: it is the order commitment and the send is refused by
 * the seller without it.
 */
export type NanoSend = (to: string, amountRaw: string, options: { representative: string }) => Promise<string>;

/**
 * Accepted blocks. `claim` returns true only when NEITHER the block hash NOR
 * the order id was seen before, and records both as one atomic step: a store
 * shared by several servers must make that atomic (a database UNIQUE
 * constraint, `SET NX`). `persistent` must be true: a restart that forgets
 * claims lets every old block be presented again. `expiresAt` (unix seconds)
 * is the end of the order's window, after which the block is refused on time
 * alone, so the row may be pruned from then on.
 */
export interface NanoReplayStore {
  readonly persistent: boolean;
  claim(blockHash: string, orderId: string, expiresAt: number): boolean | Promise<boolean>;
}

/** What the seller issued for one request, and what the payment is checked against. */
export interface NanoRequirement {
  /** Opaque order id from {@link NanoOrderIssuer.issue}. */
  orderId: string;
  payTo: string;
  amountRaw: bigint | string;
  /** Unix seconds: the earliest and the latest `local_timestamp` the block may have. */
  issuedAt: number;
  expiresAt: number;
}

/** What goes into the 402 entry's `extra.nano`, and what the buyer needs to pay. */
export interface NanoOrderExtra {
  orderId: string;
  /** The `nano_` account the send block must carry as its representative. */
  representative: string;
  issuedAt: number;
  expiresAt: number;
}

/** The answer of {@link verifyNanoPayment}, in the shape of the backend's `VerifyResponse`. */
export interface NanoVerifyResult {
  isValid: boolean;
  invalidReason?: string;
  /** True when no verdict was reached (node unreachable, block not yet confirmed): retry the same hash. */
  retryable?: boolean;
  payer?: string;
  network: typeof NANO_NETWORK;
  /** Raw amount the block sent, when it was read. */
  amountRaw?: string;
}

/**
 * A process-local replay store, for tests and single-use scripts ONLY: it
 * forgets everything on restart, so {@link createNanoVerifier} refuses it
 * unless `allowVolatileReplayStore` is set.
 */
export function createVolatileNanoReplayStore(): NanoReplayStore {
  const blocks = new Set<string>();
  const orders = new Set<string>();
  return {
    persistent: false,
    claim(blockHash, orderId) {
      if (blocks.has(blockHash) || orders.has(orderId)) return false;
      blocks.add(blockHash);
      orders.add(orderId);
      return true;
    },
  };
}

/** The subset of a `better-sqlite3` database {@link SqliteNanoReplayStore} uses. */
export interface NanoSqliteDatabase {
  exec(sql: string): unknown;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown };
}

/**
 * The persistent replay store on SQLite, through a `better-sqlite3` database
 * the program opens and passes in (the SDK never loads it itself, like the
 * reputation outbox). One table, `uvd_nano_claims`, with the block hash as
 * PRIMARY KEY and the order id UNIQUE, so one block credits one order once and
 * one order is credited once, even across processes sharing the file. The
 * connection must run with `PRAGMA synchronous = FULL` (or `EXTRA`): a commit
 * a power cut can undo is a block accepted twice.
 */
export class SqliteNanoReplayStore implements NanoReplayStore {
  readonly persistent = true;
  private readonly insert;

  constructor(private readonly db: NanoSqliteDatabase) {
    const sync = Number(this.db.pragma('synchronous', { simple: true }));
    if (!(sync >= 2)) {
      throw new X402Error('Nano replay store needs PRAGMA synchronous = FULL or EXTRA', 'INVALID_CONFIG');
    }
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS uvd_nano_claims (' +
      'block_hash TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL)',
    );
    this.insert = this.db.prepare('INSERT INTO uvd_nano_claims (block_hash, order_id, expires_at) VALUES (?, ?, ?)');
  }

  claim(blockHash: string, orderId: string, expiresAt: number): boolean {
    try {
      this.insert.run(blockHash, orderId, expiresAt);
      return true;
    } catch (error) {
      if (String((error as { code?: unknown })?.code ?? '').startsWith('SQLITE_CONSTRAINT')) return false;
      throw error;
    }
  }

  /** Delete claims whose window ended before `beforeUnixSeconds`: those blocks are refused on time alone. */
  prune(beforeUnixSeconds: number): void {
    this.db.prepare('DELETE FROM uvd_nano_claims WHERE expires_at < ?').run(beforeUnixSeconds);
  }
}

/** Raw hex of a byte array. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The order commitment: `SHA256("xno-binding/v1/rep|" + orderId + "|" + payTo + "|" + amountRaw)`
 * as a `nano_` account, the value the paying block carries as its
 * representative (test vector in docs/networks/nano.md).
 */
export function nanoCommitmentAccount(orderId: string, payTo: string, amountRaw: bigint | string): string {
  const digest = sha256(new TextEncoder().encode(`xno-binding/v1/rep|${orderId}|${payTo}|${amountRaw.toString()}`));
  return encodeNanoAddress(digest);
}

export interface NanoOrderIssuer {
  /** A fresh order for one request: put the result in the 402 entry's `extra.nano`. */
  issue(request: { payTo: string; amountRaw: bigint | string; resource: string }): NanoOrderExtra;
  /**
   * Check an order id presented with a payment against the requirement the
   * server rebuilt for this request. Returns the requirement or the reason.
   */
  check(orderId: unknown, request: { payTo: string; amountRaw: bigint | string; resource: string }):
    { ok: true; requirement: NanoRequirement } | { ok: false; reason: string };
}

/**
 * Issues and checks order ids WITHOUT keeping state: the id carries its random
 * nonce, its window and a MAC (HMAC-SHA256 under `secret`) over those plus
 * payTo, price and resource, so an id minted for one resource or price cannot
 * be used for another and a forged id fails. `secret` is the server's own, at
 * least 16 bytes; it is never sent anywhere.
 */
export function createNanoOrderIssuer(options: {
  secret: Uint8Array | string;
  /** Length of the payment window in seconds (default 600, at most 86400). */
  ttlSeconds?: number;
  /** Clock in unix seconds, for tests. */
  now?: () => number;
}): NanoOrderIssuer {
  const secret = typeof options.secret === 'string' ? new TextEncoder().encode(options.secret) : options.secret;
  if (secret.length < 16) throw new X402Error('Nano order secret must be at least 16 bytes', 'INVALID_CONFIG');
  const ttl = options.ttlSeconds ?? 600;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) {
    throw new X402Error('ttlSeconds must be a whole number between 1 and 86400', 'INVALID_CONFIG');
  }
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const mac = (nonce: string, issuedAt: number, expiresAt: number, r: { payTo: string; amountRaw: bigint | string; resource: string }) =>
    toHex(hmac(sha256, secret, new TextEncoder().encode(
      `xno-order/v1|${nonce}|${issuedAt}|${expiresAt}|${r.payTo}|${r.amountRaw.toString()}|${r.resource}`,
    ))).slice(0, 32);
  return {
    issue(request) {
      rawAmount(request.amountRaw, 'amountRaw');
      if (!isValidNanoAddress(request.payTo)) {
        throw new X402Error('payTo must be a nano_ address with a valid checksum', 'INVALID_RECIPIENT');
      }
      const nonceBytes = new Uint8Array(16);
      crypto.getRandomValues(nonceBytes);
      const nonce = toHex(nonceBytes);
      const issuedAt = now();
      const expiresAt = issuedAt + ttl;
      const orderId = `${nonce}.${issuedAt}.${expiresAt}.${mac(nonce, issuedAt, expiresAt, request)}`;
      return { orderId, representative: nanoCommitmentAccount(orderId, request.payTo, request.amountRaw), issuedAt, expiresAt };
    },
    check(orderId, request) {
      if (typeof orderId !== 'string') return { ok: false, reason: 'nano_order_missing' };
      const match = /^([0-9a-f]{32})\.(\d{1,12})\.(\d{1,12})\.([0-9a-f]{32})$/.exec(orderId);
      if (!match) return { ok: false, reason: 'nano_order_malformed' };
      const issuedAt = Number(match[2]);
      const expiresAt = Number(match[3]);
      const expected = mac(match[1], issuedAt, expiresAt, request);
      // The MAC is public-input comparison of two server-computed strings; compare without early exit anyway.
      let diff = 0;
      for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ match[4].charCodeAt(i);
      if (diff !== 0) return { ok: false, reason: 'nano_order_not_issued_for_this_request' };
      return { ok: true, requirement: { orderId, payTo: request.payTo, amountRaw: request.amountRaw, issuedAt, expiresAt } };
    },
  };
}

/** A {@link NanoRpc} over HTTP to a node (or a public RPC) at `url`. */
export function createNanoRpc(url: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): NanoRpc {
  const doFetch = options.fetch ?? fetch;
  return async (request) => {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    });
    if (!response.ok) throw new Error(`Nano RPC HTTP ${response.status}`);
    return response.json();
  };
}

function rawAmount(value: bigint | string, what: string): bigint {
  const raw = typeof value === 'bigint' ? value : RAW.test(value) ? BigInt(value) : -1n;
  if (raw <= 0n || raw > MAX_RAW) throw new X402Error(`${what} must be a positive integer number of raw`, 'INVALID_AMOUNT');
  return raw;
}

function samePublicKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** XNO with up to 30 decimals, for display. */
export function formatNanoRaw(raw: bigint | string): string {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  const whole = value / NANO_RAW_PER_XNO;
  const fraction = (value % NANO_RAW_PER_XNO).toString().padStart(NANO_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Verify that `blockHash` is the payment for `requirement`: a confirmed send of
 * at least the price to `payTo`, whose representative is the order commitment,
 * made inside the order's window, read with `block_info` from `rpc`; then claim
 * it in `replayStore`.
 *
 * The hash is claimed only once every other check has passed, so a block that
 * was not yet confirmed can be presented again.
 */
export async function verifyNanoPayment(options: {
  blockHash: string;
  requirement: NanoRequirement;
  rpc: NanoRpc;
  replayStore: NanoReplayStore;
}): Promise<NanoVerifyResult> {
  const network = NANO_NETWORK;
  const { requirement } = options;
  const merchant = decodeNanoAddress(requirement.payTo);
  if (!merchant) throw new X402Error('payTo must be a nano_ address with a valid checksum', 'INVALID_RECIPIENT');
  const required = rawAmount(requirement.amountRaw, 'amountRaw');
  if (typeof requirement.orderId !== 'string' || !requirement.orderId
    || !Number.isInteger(requirement.issuedAt) || !Number.isInteger(requirement.expiresAt)
    || requirement.expiresAt <= requirement.issuedAt) {
    throw new X402Error('requirement needs an orderId and a window (issuedAt < expiresAt, unix seconds)', 'INVALID_CONFIG');
  }
  if (!options.replayStore || options.replayStore.persistent !== true) {
    throw new X402Error('a persistent replayStore is required to verify Nano payments', 'INVALID_CONFIG');
  }
  if (typeof options.blockHash !== 'string' || !BLOCK_HASH.test(options.blockHash)) {
    return { isValid: false, invalidReason: 'nano_malformed_block_hash', network };
  }
  const blockHash = options.blockHash.toUpperCase();

  let info: unknown;
  try {
    info = await options.rpc({ action: 'block_info', json_block: 'true', hash: blockHash });
  } catch {
    return { isValid: false, invalidReason: 'nano_rpc_error', retryable: true, network };
  }
  if (!info || typeof info !== 'object') {
    return { isValid: false, invalidReason: 'nano_rpc_error', retryable: true, network };
  }
  const block = info as {
    error?: unknown; confirmed?: unknown; subtype?: unknown; amount?: unknown; local_timestamp?: unknown;
    block_account?: unknown; contents?: { link_as_account?: unknown; representative?: unknown };
  };
  if (block.error !== undefined) {
    return block.error === 'Block not found'
      ? { isValid: false, invalidReason: 'nano_block_not_found', network }
      : { isValid: false, invalidReason: 'nano_rpc_error', retryable: true, network };
  }
  const payer = typeof block.block_account === 'string' ? block.block_account : undefined;
  if (block.subtype !== 'send') {
    return { isValid: false, invalidReason: 'nano_not_a_send_block', payer, network };
  }
  const destination = typeof block.contents?.link_as_account === 'string'
    ? decodeNanoAddress(block.contents.link_as_account)
    : null;
  if (!destination || !samePublicKey(destination, merchant)) {
    return { isValid: false, invalidReason: 'nano_wrong_destination', payer, network };
  }
  if (typeof block.amount !== 'string' || !RAW.test(block.amount)) {
    return { isValid: false, invalidReason: 'nano_rpc_error', retryable: true, payer, network };
  }
  const amountRaw = block.amount;
  if (BigInt(amountRaw) < required) {
    return { isValid: false, invalidReason: 'nano_insufficient_amount', payer, network, amountRaw };
  }
  // The order commitment: the paying key signed it, so it binds this block to this order.
  const representative = typeof block.contents?.representative === 'string'
    ? decodeNanoAddress(block.contents.representative)
    : null;
  const commitment = decodeNanoAddress(nanoCommitmentAccount(requirement.orderId, requirement.payTo, required));
  if (!representative || !commitment || !samePublicKey(representative, commitment)) {
    return { isValid: false, invalidReason: 'nano_block_not_bound_to_order', payer, network, amountRaw };
  }
  // The node answers the string "true"; anything else is not (yet) confirmed.
  if (block.confirmed !== 'true' && block.confirmed !== true) {
    return { isValid: false, invalidReason: 'nano_block_unconfirmed', retryable: true, payer, network, amountRaw };
  }
  // The node's own clock when it first saw the block, in seconds; "0" means unknown.
  const seenAt = typeof block.local_timestamp === 'string' && RAW.test(block.local_timestamp) ? Number(block.local_timestamp) : 0;
  if (!seenAt) {
    return { isValid: false, invalidReason: 'nano_block_time_unknown', payer, network, amountRaw };
  }
  if (seenAt < requirement.issuedAt || seenAt > requirement.expiresAt) {
    return { isValid: false, invalidReason: 'nano_block_outside_order_window', payer, network, amountRaw };
  }
  if (!(await options.replayStore.claim(blockHash, requirement.orderId, requirement.expiresAt))) {
    return { isValid: false, invalidReason: 'nano_block_already_used', payer, network, amountRaw };
  }
  return { isValid: true, payer, network, amountRaw };
}

/**
 * A verifier for `localVerifiers.nano` of the backend middleware. For each
 * payment it rebuilds the requirement from the request's own 402 requirements
 * (payTo, price, resource), checks the order id the buyer presented against
 * `issuer`, and verifies the block against it. The replay store is required
 * and must be persistent; the volatile one is refused unless
 * `allowVolatileReplayStore` is set (tests only).
 */
export function createNanoVerifier(options: {
  rpc: NanoRpc;
  issuer: NanoOrderIssuer;
  replayStore: NanoReplayStore;
  allowVolatileReplayStore?: boolean;
}): ((payment: X402Header, requirements: PaymentRequirements) => Promise<NanoVerifyResult>) & { issuer: NanoOrderIssuer } {
  if (!options.issuer || typeof options.issuer.check !== 'function') {
    throw new X402Error('issuer is required (createNanoOrderIssuer)', 'INVALID_CONFIG');
  }
  if (!options.replayStore || typeof options.replayStore.claim !== 'function') {
    throw new X402Error('replayStore is required: pass a persistent store such as SqliteNanoReplayStore', 'INVALID_CONFIG');
  }
  if (options.replayStore.persistent !== true && options.allowVolatileReplayStore !== true) {
    throw new X402Error('the replay store must be persistent: a restart would forget the blocks already used', 'INVALID_CONFIG');
  }
  // `verifyNanoPayment` also refuses a non-persistent store, so the test override is applied here.
  const replayStore: NanoReplayStore = options.replayStore.persistent === true
    ? options.replayStore
    : { persistent: true, claim: (...args) => options.replayStore.claim(...args) };
  const verifier = async (payment: X402Header, requirements: PaymentRequirements): Promise<NanoVerifyResult> => {
    const network = NANO_NETWORK;
    const payload = payment?.payload as { blockHash?: unknown; orderId?: unknown } | undefined;
    if (!payload || typeof payload.blockHash !== 'string') {
      return { isValid: false, invalidReason: 'nano_malformed_block_hash', network };
    }
    const amount = typeof requirements?.maxAmountRequired === 'string' ? requirements.maxAmountRequired : '';
    if (!RAW.test(amount) || !isValidNanoAddress(requirements?.payTo)) {
      return { isValid: false, invalidReason: 'nano_bad_requirements', network };
    }
    const checked = options.issuer.check(payload.orderId, { payTo: requirements.payTo, amountRaw: amount, resource: requirements.resource });
    if (!checked.ok) return { isValid: false, invalidReason: checked.reason, network };
    return verifyNanoPayment({ blockHash: payload.blockHash, requirement: checked.requirement, rpc: options.rpc, replayStore });
  };
  return Object.assign(verifier, { issuer: options.issuer });
}

/**
 * Buyer adapter. It holds no key: `send` is whatever wallet or node signs and
 * publishes the block, and the payment is the hash it returns.
 */
export class NanoProvider implements WalletAdapter {
  readonly id = 'nano';
  readonly name = 'Nano';
  readonly networkType = 'nano' as const;
  readonly address: string;
  private readonly send: NanoSend;
  private readonly rpc?: NanoRpc;
  private connected = false;

  constructor(options: { address: string; send: NanoSend; rpc?: NanoRpc }) {
    if (!isValidNanoAddress(options.address)) {
      throw new X402Error('address must be a nano_ address with a valid checksum', 'INVALID_RECIPIENT');
    }
    if (typeof options.send !== 'function') throw new X402Error('send is required', 'INVALID_CONFIG');
    this.address = options.address;
    this.send = options.send;
    this.rpc = options.rpc;
  }

  isAvailable(): boolean { return true; }

  async connect(chainName: string = NANO_NETWORK): Promise<string> {
    if (chainName !== NANO_NETWORK) {
      throw new X402Error(`Nano pays on ${NANO_NETWORK} only`, 'CHAIN_NOT_SUPPORTED');
    }
    this.connected = true;
    return this.address;
  }

  async disconnect(): Promise<void> { this.connected = false; }

  getAddress(): string | null { return this.connected ? this.address : null; }

  /**
   * Sends `paymentInfo.amount` XNO (whole units, converted to raw) to the Nano
   * recipient and returns the payload `{ blockHash, orderId }` as JSON.
   */
  async signPayment(paymentInfo: PaymentInfo, chainConfig: ChainConfig): Promise<string> {
    if (!this.connected) throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    if (chainConfig.name !== NANO_NETWORK) throw new X402Error(`Nano pays on ${NANO_NETWORK} only`, 'CHAIN_NOT_SUPPORTED');
    const recipient = paymentInfo.recipients?.nano || paymentInfo.recipient;
    if (!isValidNanoAddress(recipient)) {
      throw new X402Error('The recipient is not a nano_ address with a valid checksum', 'INVALID_RECIPIENT');
    }
    const self = decodeNanoAddress(this.address)!;
    if (samePublicKey(decodeNanoAddress(recipient)!, self)) {
      throw new X402Error('Buyer and merchant must be distinct', 'INVALID_RECIPIENT');
    }
    const amountRaw = rawAmount(toAtomicUnits(paymentInfo.amount, NANO_DECIMALS), 'amount');
    // The seller's order, from the accepted 402 entry (`extra.nano`). Without it the seller cannot bind the payment.
    const order = (paymentInfo.accepted?.extra as { nano?: Partial<NanoOrderExtra> } | undefined)?.nano;
    if (!order || typeof order.orderId !== 'string' || typeof order.representative !== 'string') {
      throw new X402Error('The 402 carries no Nano order (extra.nano.orderId); not paying', 'INVALID_CONFIG');
    }
    // Do not trust the seller's representative: recompute the commitment and refuse a mismatch.
    if (order.representative !== nanoCommitmentAccount(order.orderId, recipient, amountRaw)) {
      throw new X402Error('The Nano order commitment does not match payTo, price and order id; not paying', 'INVALID_CONFIG');
    }
    const blockHash = await this.send(recipient, amountRaw.toString(), { representative: order.representative });
    if (typeof blockHash !== 'string' || !BLOCK_HASH.test(blockHash)) {
      throw new X402Error('send did not return a 64-hex block hash', 'PAYMENT_FAILED');
    }
    return JSON.stringify({ blockHash: blockHash.toUpperCase(), orderId: order.orderId });
  }

  /** The X-PAYMENT value (x402 v2) for a payload from {@link signPayment}. */
  encodePaymentHeader(paymentPayload: string): string {
    const { blockHash, orderId } = JSON.parse(paymentPayload) as { blockHash: string; orderId: string };
    if (typeof blockHash !== 'string' || !BLOCK_HASH.test(blockHash) || typeof orderId !== 'string' || !orderId) {
      throw new X402Error('Nano payload must carry a 64-hex blockHash and the orderId', 'INVALID_CONFIG');
    }
    const header: X402HeaderV2 = { x402Version: 2, scheme: 'exact', network: NANO_NETWORK, payload: { blockHash, orderId } };
    return encodeBase64Json(header);
  }

  /** XNO balance of this account, read with `account_balance`. Needs `rpc`. */
  async getBalance(chainConfig: ChainConfig): Promise<string> {
    if (chainConfig.name !== NANO_NETWORK) throw new X402Error(`Nano pays on ${NANO_NETWORK} only`, 'CHAIN_NOT_SUPPORTED');
    if (!this.rpc) throw new X402Error('Pass rpc to read a Nano balance', 'INVALID_CONFIG');
    const answer = await this.rpc({ action: 'account_balance', account: this.address }) as { balance?: unknown };
    if (typeof answer?.balance !== 'string' || !RAW.test(answer.balance)) {
      throw new X402Error('Nano RPC returned no balance', 'NETWORK_ERROR');
    }
    return formatNanoRaw(answer.balance);
  }
}

export default NanoProvider;
