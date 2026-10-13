/**
 * Nano (XNO) on `nano:mainnet`.
 *
 * Nano has no fee and no facilitator settlement: the buyer publishes a send
 * block to the merchant and pays with its hash. The merchant reads that block
 * from its own node (`block_info`) and accepts it once it is confirmed, sends
 * at least the price to the merchant, and was not used before.
 *
 * Amounts are raw: 1 XNO = 10^30 raw. XNO is not a dollar and the SDK has no
 * rate, so the operator sets the price in raw.
 *
 * @example
 * ```ts
 * import { createNanoVerifier, createNanoRpc } from 'uvd-x402-sdk/nano';
 *
 * const paywall = createPaymentMiddleware(getRequirements, {
 *   localVerifiers: {
 *     nano: createNanoVerifier({
 *       payTo: 'nano_...',
 *       amountRaw: 10n ** 27n, // 0.001 XNO
 *       rpc: createNanoRpc('http://127.0.0.1:7076'),
 *     }),
 *   },
 * });
 * ```
 */
import type { ChainConfig, PaymentInfo, WalletAdapter, X402Header, X402HeaderV2 } from '../../types';
import { X402Error } from '../../types';
import { toAtomicUnits } from '../../utils/amount';
import { encodeBase64Json } from '../../utils/base64';
import { decodeNanoAddress, isValidNanoAddress } from '../../utils/validation';

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

/** Publishes a send block of `amountRaw` raw to `to` and resolves with its hash. */
export type NanoSend = (to: string, amountRaw: string) => Promise<string>;

/**
 * Block hashes already accepted. `claim` returns true only the first time it
 * sees a hash; a store shared by several servers must make that atomic.
 */
export interface NanoReplayStore {
  claim(blockHash: string): boolean | Promise<boolean>;
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

/** A process-local replay store. Use a shared one when several servers take payments. */
export function createMemoryNanoReplayStore(): NanoReplayStore {
  const used = new Set<string>();
  return {
    claim(blockHash) {
      if (used.has(blockHash)) return false;
      used.add(blockHash);
      return true;
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
 * Verify that `blockHash` is a confirmed send of at least `amountRaw` raw to
 * `payTo`, read with `block_info` from `rpc`, and claim it in `replayStore`.
 *
 * The hash is claimed only once every other check has passed, so a block that
 * was not yet confirmed can be presented again.
 */
export async function verifyNanoPayment(options: {
  blockHash: string;
  payTo: string;
  amountRaw: bigint | string;
  rpc: NanoRpc;
  replayStore: NanoReplayStore;
}): Promise<NanoVerifyResult> {
  const network = NANO_NETWORK;
  const merchant = decodeNanoAddress(options.payTo);
  if (!merchant) throw new X402Error('payTo must be a nano_ address with a valid checksum', 'INVALID_RECIPIENT');
  const required = rawAmount(options.amountRaw, 'amountRaw');
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
    error?: unknown; confirmed?: unknown; subtype?: unknown; amount?: unknown;
    block_account?: unknown; contents?: { link_as_account?: unknown };
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
  // The node answers the string "true"; anything else is not (yet) confirmed.
  if (block.confirmed !== 'true' && block.confirmed !== true) {
    return { isValid: false, invalidReason: 'nano_block_unconfirmed', retryable: true, payer, network, amountRaw };
  }
  if (!(await options.replayStore.claim(blockHash))) {
    return { isValid: false, invalidReason: 'nano_block_already_used', payer, network, amountRaw };
  }
  return { isValid: true, payer, network, amountRaw };
}

/**
 * A verifier for `localVerifiers.nano` of the backend middleware: every Nano
 * payment must send at least `amountRaw` raw to `payTo`. One replay store is
 * kept for the verifier unless one is passed.
 */
export function createNanoVerifier(options: {
  payTo: string;
  amountRaw: bigint | string;
  rpc: NanoRpc;
  replayStore?: NanoReplayStore;
}): (payment: X402Header) => Promise<NanoVerifyResult> {
  if (!isValidNanoAddress(options.payTo)) {
    throw new X402Error('payTo must be a nano_ address with a valid checksum', 'INVALID_RECIPIENT');
  }
  rawAmount(options.amountRaw, 'amountRaw');
  const replayStore = options.replayStore ?? createMemoryNanoReplayStore();
  return async (payment) => {
    const payload = payment?.payload as { blockHash?: unknown } | undefined;
    if (!payload || typeof payload.blockHash !== 'string') {
      return { isValid: false, invalidReason: 'nano_malformed_block_hash', network: NANO_NETWORK };
    }
    return verifyNanoPayment({ ...options, blockHash: payload.blockHash, replayStore });
  };
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
   * recipient and returns the payload `{ blockHash }` as JSON.
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
    const blockHash = await this.send(recipient, amountRaw.toString());
    if (typeof blockHash !== 'string' || !BLOCK_HASH.test(blockHash)) {
      throw new X402Error('send did not return a 64-hex block hash', 'PAYMENT_FAILED');
    }
    return JSON.stringify({ blockHash: blockHash.toUpperCase() });
  }

  /** The X-PAYMENT value (x402 v2) for a payload from {@link signPayment}. */
  encodePaymentHeader(paymentPayload: string): string {
    const { blockHash } = JSON.parse(paymentPayload) as { blockHash: string };
    if (typeof blockHash !== 'string' || !BLOCK_HASH.test(blockHash)) {
      throw new X402Error('Nano payload must carry a 64-hex blockHash', 'INVALID_CONFIG');
    }
    const header: X402HeaderV2 = { x402Version: 2, scheme: 'exact', network: NANO_NETWORK, payload: { blockHash } };
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
