/**
 * The anchor payment: a USDC transfer from the rater to the rated wallet, and
 * the `ProofOfPayment` the facilitator checks against the chain.
 *
 * Why a payment at all: the facilitator verifies a rating's proof with
 * `payer == rater`, `payee == owner or wallet of agentId`, a fresh block, a
 * recomputed `paymentHash`, and one rating per (payment, agentId) pair
 * (x402-rs `src/erc8004/proof.rs`). So each anchored rating needs its own
 * transfer from the rater's own wallet.
 *
 * MONEY RULES
 * - The signed transaction is handed to `onSigned` BEFORE it is broadcast.
 *   Persist it there. A retry re-broadcasts the SAME bytes and never signs a
 *   second transfer; if `onSigned` throws, nothing is sent.
 * - A transaction that never mines is not replaced here. When the account's
 *   nonce moves past it with no receipt, it is `payment_nonce_consumed`, for
 *   a human, not a retry.
 * - Gas has a ceiling (`maxFeePerGasWei`, `maxGasLimit`) and the wallet's ETH
 *   a floor (`minNativeBalanceWei`): past either, nothing is signed.
 * - The proof takes its timestamp from the BLOCK and its `paymentHash` from
 *   the fields it commits to, never from a caller.
 */

import { ethers } from 'ethers';
import type { ProofOfPayment } from '../backend';
import { getChainByName } from '../chains';
import { PROOF_MAX_AGE_SECS, TRANSFER_TOPIC, reputationChain } from './constants';
import { ReputationError } from './errors';
import { log, redactText, type ReputationLogger } from './redact';
import { checkSignature, type ReputationSigner } from './sign';
import {
  MAX_UINT64,
  bytes32Of,
  isAddress,
  isRecord,
  quantityOf,
  sameAddress,
  topicOf,
  uintOf,
} from './values';

export type { ProofOfPayment };

/** An EIP-1193-style JSON-RPC connection: the only way this module reads or writes a chain. */
export interface EvmRpc {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

/** The node answered a JSON-RPC error. `rpcMessage` is shortened like every message here. */
export class JsonRpcError extends ReputationError {
  readonly rpcCode: number | undefined;
  readonly rpcMessage: string;

  constructor(method: string, rpcCode: number | undefined, rpcMessage: string) {
    const short = redactText(rpcMessage).slice(0, 200);
    super('rpc_failed', `${method} failed: ${short}`);
    this.name = 'JsonRpcError';
    this.rpcCode = rpcCode;
    this.rpcMessage = short;
  }
}

/**
 * A JSON-RPC connection over `fetch`. The URL may carry an API key, so it
 * never appears in an error or a log.
 */
export function jsonRpc(
  url: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): EvmRpc {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  let id = 0;
  return {
    async request({ method, params = [] }) {
      id += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: controller.signal,
        });
      } catch (error) {
        throw new ReputationError('rpc_failed', `${method}: the RPC could not be reached (${(error as Error)?.name ?? 'Error'})`);
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new ReputationError('rpc_failed', `${method}: the RPC answered HTTP ${response.status}`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ReputationError('rpc_failed', `${method}: the RPC answered something that is not JSON`);
      }
      if (!isRecord(body)) throw new ReputationError('rpc_failed', `${method}: malformed JSON-RPC answer`);
      if (isRecord(body.error)) {
        const code = typeof body.error.code === 'number' ? body.error.code : undefined;
        throw new JsonRpcError(method, code, String(body.error.message ?? ''));
      }
      return body.result;
    },
  };
}

async function call(rpc: EvmRpc, method: string, params: readonly unknown[]): Promise<unknown> {
  try {
    return await rpc.request({ method, params });
  } catch (error) {
    if (error instanceof ReputationError) throw error;
    throw new ReputationError('rpc_failed', `${method} failed: ${redactText(String((error as Error)?.message ?? error)).slice(0, 200)}`);
  }
}

async function quantity(rpc: EvmRpc, method: string, params: readonly unknown[]): Promise<bigint> {
  const n = quantityOf(await call(rpc, method, params));
  if (n === null) throw new ReputationError('rpc_failed', `${method} answered no quantity`);
  return n;
}

/** The payment a proof describes. */
export interface PaymentFacts {
  transactionHash: string;
  blockNumber: number | bigint;
  payer: string;
  payee: string;
  amount: string | number | bigint;
}

/**
 * The facilitator's `paymentHash` (x402-rs `ProofOfPayment::compute_payment_hash`):
 *
 *     keccak256(txHash[32] || blockNumber as u64 big-endian[8] ||
 *               utf8(checksum(payer)) || utf8(checksum(payee)) || amount as u256 big-endian[32])
 *
 * The addresses go in as their EIP-55 TEXT, because that is how alloy's
 * `Address` displays (alloy-primitives 1.5.7, x402-rs `Cargo.lock`), and the
 * Rust formats them with `{}`. `network`, `token` and `timestamp` are not in
 * it; they are checked against the chain instead.
 */
export function computePaymentHash(p: PaymentFacts): string {
  const tx = bytes32Of(p.transactionHash);
  const block = uintOf(p.blockNumber, MAX_UINT64);
  const amount = uintOf(p.amount);
  if (tx === null || block === null || amount === null || !isAddress(p.payer) || !isAddress(p.payee)) {
    throw new ReputationError('invalid_input', 'a payment hash needs a tx hash, a u64 block, two addresses and a uint256 amount');
  }
  return ethers
    .keccak256(
      ethers.concat([
        tx,
        ethers.zeroPadValue(ethers.toBeArray(block), 8),
        ethers.toUtf8Bytes(ethers.getAddress(p.payer.toLowerCase())),
        ethers.toUtf8Bytes(ethers.getAddress(p.payee.toLowerCase())),
        ethers.zeroPadValue(ethers.toBeArray(amount), 32),
      ])
    )
    .toLowerCase();
}

/** A signed, not necessarily broadcast, anchor payment. Persist it before broadcasting. */
export interface SignedPayment {
  network: string;
  chainId: number;
  token: string;
  payer: string;
  payee: string;
  /** Token base units, decimal. */
  amount: string;
  /** The payer's account nonce the transaction uses. */
  nonce: number;
  rawTransaction: string;
  transactionHash: string;
}

export interface PaymentRequest {
  /** Facilitator network name; must be a chain with a FeedbackDelegate and USDC. */
  network: string;
  /** The rated wallet. */
  payee: string;
  /** USDC base units (`1000` = 0.001 USDC). */
  amount: string | number | bigint;
}

export interface GasLimits {
  /** Ceiling on `maxFeePerGas`, in wei. Default 1 gwei. Above it nothing is signed. */
  maxFeePerGasWei?: bigint;
  /** Ceiling on the gas limit. Default 150000 (a USDC transfer uses about 40000-65000). */
  maxGasLimit?: number;
  /** ETH the wallet must keep beyond this transfer's worst-case fee. Default 0. */
  minNativeBalanceWei?: bigint;
}

export const DEFAULT_MAX_FEE_PER_GAS_WEI = 1_000_000_000n;
export const DEFAULT_MAX_GAS_LIMIT = 150_000;
/** Used when a node does not implement `eth_maxPriorityFeePerGas`: 0.001 gwei. */
const FALLBACK_PRIORITY_FEE_WEI = 1_000_000n;
const ERC20 = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);

/** The chain and token a payment on `network` uses, or throw. */
function paymentChain(network: string): { chainId: number; network: string; token: string } {
  const chain = reputationChain(network);
  const config = chain ? getChainByName(chain.network) : undefined;
  const token = config?.usdc?.address;
  if (!chain || !config || config.chainId !== chain.chainId || !isAddress(token)) {
    throw new ReputationError('unsupported_token', `no USDC is known for a rating on ${network}`);
  }
  return { chainId: chain.chainId, network: chain.network, token: ethers.getAddress(token) };
}

function positiveAmount(value: unknown): bigint {
  const amount = uintOf(value);
  if (amount === null || amount === 0n) {
    throw new ReputationError('invalid_input', 'the payment amount must be a positive integer of base units');
  }
  return amount;
}

/** Build and sign the transfer. Broadcasts nothing. */
export async function signPayment(
  options: PaymentRequest & GasLimits & { signer: ReputationSigner; rpc: EvmRpc }
): Promise<SignedPayment> {
  const { signer, rpc } = options;
  const { chainId, network, token } = paymentChain(options.network);
  if (!isAddress(options.payee)) throw new ReputationError('invalid_input', 'the payee is not an address');
  const amount = positiveAmount(options.amount);
  if (!signer || !isAddress(signer.address) || typeof signer.signHash !== 'function') {
    throw new ReputationError('signer_unavailable', 'paying needs a signer with an address and signHash');
  }
  const payer = ethers.getAddress(signer.address.toLowerCase());
  const payee = ethers.getAddress(options.payee.toLowerCase());
  if (sameAddress(payer, payee)) throw new ReputationError('invalid_input', 'the rater cannot pay itself');

  if ((await quantity(rpc, 'eth_chainId', [])) !== BigInt(chainId)) {
    throw new ReputationError('unexpected_chain', `the RPC is not chain ${chainId}`);
  }
  const nonce = await quantity(rpc, 'eth_getTransactionCount', [payer, 'pending']);
  const latest = await call(rpc, 'eth_getBlockByNumber', ['latest', false]);
  const baseFee = isRecord(latest) ? quantityOf(latest.baseFeePerGas) : null;
  if (baseFee === null) throw new ReputationError('rpc_failed', 'the latest block has no base fee');
  let priority: bigint;
  try {
    priority = await quantity(rpc, 'eth_maxPriorityFeePerGas', []);
  } catch {
    priority = FALLBACK_PRIORITY_FEE_WEI;
  }
  const maxFeePerGas = baseFee * 2n + priority;
  const feeCap = options.maxFeePerGasWei ?? DEFAULT_MAX_FEE_PER_GAS_WEI;
  if (maxFeePerGas > feeCap) {
    throw new ReputationError('gas_too_expensive', `maxFeePerGas ${maxFeePerGas} is above the ceiling ${feeCap}`);
  }
  const data = ERC20.encodeFunctionData('transfer', [payee, amount]);
  let estimate: bigint;
  try {
    estimate = await quantity(rpc, 'eth_estimateGas', [{ from: payer, to: token, data }]);
  } catch {
    throw new ReputationError('payment_estimate_failed', 'the transfer does not estimate (is there enough USDC?)');
  }
  const gasLimit = (estimate * 5n + 3n) / 4n;
  const maxGas = BigInt(options.maxGasLimit ?? DEFAULT_MAX_GAS_LIMIT);
  if (gasLimit > maxGas) {
    throw new ReputationError('gas_too_expensive', `the transfer needs ${gasLimit} gas, above the ceiling ${maxGas}`);
  }
  const balance = await quantity(rpc, 'eth_getBalance', [payer, 'latest']);
  if (balance < gasLimit * maxFeePerGas + (options.minNativeBalanceWei ?? 0n)) {
    throw new ReputationError('balance_low', 'the rater wallet does not hold the ETH floor plus this transfer\'s fee');
  }

  const tx = ethers.Transaction.from({
    type: 2,
    chainId: BigInt(chainId),
    nonce: Number(nonce),
    to: token,
    data,
    value: 0n,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: priority,
  });
  const digest = tx.unsignedHash;
  const sig = checkSignature(await signer.signHash(digest), digest, payer);
  tx.signature = ethers.Signature.from(sig.serialized);
  return Object.freeze({
    network,
    chainId,
    token,
    payer,
    payee,
    amount: amount.toString(),
    nonce: Number(nonce),
    rawTransaction: tx.serialized,
    transactionHash: (tx.hash as string).toLowerCase(),
  });
}

export interface ProveOptions {
  rpc: EvmRpc;
  /** The payment to prove. `nonce` lets a missing receipt be told apart from a consumed nonce. */
  payment: Omit<SignedPayment, 'rawTransaction' | 'chainId' | 'nonce'> & { nonce?: number };
  /** Blocks including the payment's. Default 2. */
  confirmations?: number;
  /** Unix seconds; default the system clock. */
  now?: number;
}

/** Read the payment back from the chain and build its proof. Throws a retryable code while it is not final. */
export async function provePayment(options: ProveOptions): Promise<ProofOfPayment> {
  const { rpc, payment } = options;
  const { chainId, network, token } = paymentChain(payment.network);
  const txHash = bytes32Of(payment.transactionHash);
  const amount = positiveAmount(payment.amount);
  if (txHash === null || !isAddress(payment.payer) || !isAddress(payment.payee)) {
    throw new ReputationError('invalid_input', 'the payment needs a tx hash and two addresses');
  }
  if (payment.token !== undefined && !sameAddress(payment.token, token)) {
    throw new ReputationError('unsupported_token', 'the payment is not in this chain\'s USDC');
  }
  const confirmations = options.confirmations ?? 2;
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) {
    throw new ReputationError('invalid_input', 'confirmations must be a positive integer');
  }
  if ((await quantity(rpc, 'eth_chainId', [])) !== BigInt(chainId)) {
    throw new ReputationError('unexpected_chain', `the RPC is not chain ${chainId}`);
  }

  const receipt = await call(rpc, 'eth_getTransactionReceipt', [txHash]);
  if (receipt === null || receipt === undefined) {
    if (payment.nonce !== undefined) {
      const mined = await quantity(rpc, 'eth_getTransactionCount', [payment.payer, 'latest']);
      if (mined > BigInt(payment.nonce)) {
        throw new ReputationError('payment_nonce_consumed', 'another transaction used this payment\'s nonce');
      }
    }
    throw new ReputationError('payment_pending', 'the payment has no receipt yet');
  }
  if (!isRecord(receipt)) throw new ReputationError('rpc_failed', 'malformed receipt');
  if (bytes32Of(receipt.transactionHash) !== txHash) {
    throw new ReputationError('rpc_failed', 'the receipt is for another transaction');
  }
  if (quantityOf(receipt.status) !== 1n) throw new ReputationError('payment_reverted', 'the payment reverted');
  const block = quantityOf(receipt.blockNumber);
  const blockHash = bytes32Of(receipt.blockHash);
  if (block === null || blockHash === null || block > MAX_UINT64) {
    throw new ReputationError('rpc_failed', 'the receipt has no block');
  }
  const want = [TRANSFER_TOPIC, topicOf(payment.payer), topicOf(payment.payee)];
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const transferred = logs.some(
    (l) =>
      isRecord(l) &&
      l.removed !== true &&
      sameAddress(l.address, token) &&
      Array.isArray(l.topics) &&
      l.topics.length === 3 &&
      l.topics.every((t, i) => typeof t === 'string' && t.toLowerCase() === want[i]) &&
      quantityOf(l.data) === amount
  );
  if (!transferred) {
    throw new ReputationError('payment_transfer_missing', 'the receipt has no exact USDC transfer from the rater to the payee');
  }
  const head = await quantity(rpc, 'eth_blockNumber', []);
  if (head - block + 1n < BigInt(confirmations)) {
    throw new ReputationError('payment_awaiting_confirmations', `the payment has ${head - block + 1n} of ${confirmations} confirmations`);
  }
  const header = await call(rpc, 'eth_getBlockByNumber', ['0x' + block.toString(16), false]);
  if (!isRecord(header) || bytes32Of(header.hash) !== blockHash) {
    throw new ReputationError('payment_block_hash_mismatch', 'the payment\'s block is not on the chain the RPC serves now');
  }
  const timestamp = quantityOf(header.timestamp);
  if (timestamp === null) throw new ReputationError('rpc_failed', 'the block has no timestamp');
  const now = BigInt(options.now ?? Math.floor(Date.now() / 1000));
  if (now - timestamp > BigInt(PROOF_MAX_AGE_SECS)) {
    throw new ReputationError('proof_expired', 'the payment is older than the facilitator accepts');
  }
  const facts = {
    transactionHash: txHash,
    blockNumber: Number(block),
    payer: ethers.getAddress(payment.payer.toLowerCase()),
    payee: ethers.getAddress(payment.payee.toLowerCase()),
    amount: amount.toString(),
  };
  return {
    ...facts,
    network,
    token,
    timestamp: Number(timestamp),
    paymentHash: computePaymentHash(facts),
  };
}

const ALREADY_SENT = /already known|known transaction|nonce too low|already imported|replacement transaction underpriced/i;

async function broadcast(rpc: EvmRpc, payment: SignedPayment, logger?: ReputationLogger): Promise<void> {
  try {
    await call(rpc, 'eth_sendRawTransaction', [payment.rawTransaction]);
  } catch (error) {
    const message = error instanceof JsonRpcError ? error.rpcMessage : String((error as Error)?.message ?? '');
    if (ALREADY_SENT.test(message)) {
      log(logger, 'debug', 'reputation: the node already has the payment', { tx: payment.transactionHash });
      return;
    }
    throw new ReputationError('payment_broadcast_failed', `the payment was not broadcast: ${redactText(message).slice(0, 160)}`);
  }
}

export interface PayAndProveOptions extends PaymentRequest, GasLimits {
  signer: ReputationSigner;
  rpc: EvmRpc;
  /**
   * Called with the signed transaction before it is broadcast. Persist it:
   * a retry passes it back as `resume`. If this throws, nothing is sent.
   */
  onSigned: (payment: SignedPayment) => void | Promise<void>;
  /** A payment signed earlier for this same rating: re-broadcast and proven, never re-signed. */
  resume?: SignedPayment | null;
  confirmations?: number;
  /** Receipt polls before giving up with a retryable error. Default 30. */
  maxPolls?: number;
  /** Milliseconds between polls. Default 2000. */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: ReputationLogger;
}

/**
 * Pay `amount` of USDC to `payee` from the signer's wallet and return the
 * proof. With `resume`, the stored transaction is re-broadcast (a node that
 * already has it is fine) and proven; nothing new is signed.
 */
export async function payAndProve(options: PayAndProveOptions): Promise<ProofOfPayment> {
  const { rpc, signer, logger } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));
  const maxPolls = options.maxPolls ?? 30;

  let payment: SignedPayment;
  if (options.resume) {
    payment = options.resume;
    const chain = paymentChain(options.network);
    if (
      payment.network !== chain.network ||
      !sameAddress(payment.payer, signer?.address) ||
      !sameAddress(payment.payee, options.payee) ||
      uintOf(payment.amount) !== uintOf(options.amount) ||
      !sameAddress(payment.token, chain.token)
    ) {
      throw new ReputationError('payment_mismatch', 'the stored payment is not this rating\'s payment');
    }
  } else {
    payment = await signPayment(options);
    await options.onSigned(payment);
    log(logger, 'info', 'reputation: anchor payment signed and stored', { tx: payment.transactionHash, payee: payment.payee });
  }

  // A resumed payment may already be mined: look before re-broadcasting it.
  if (!options.resume) await broadcast(rpc, payment, logger);
  for (let attempt = 1; ; attempt++) {
    try {
      return await provePayment({ rpc, payment, confirmations: options.confirmations, now: clock() });
    } catch (error) {
      if (!(error instanceof ReputationError) || !error.retryable || attempt >= maxPolls) throw error;
      if (attempt === 1 && options.resume && error.code === 'payment_pending') {
        await broadcast(rpc, payment, logger);
      }
      await sleep(options.pollIntervalMs ?? 2000);
    }
  }
}
