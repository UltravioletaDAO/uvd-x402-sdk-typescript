/**
 * Test doubles for the reputation module: a chain (JSON-RPC) and a
 * facilitator (HTTP, behind `fetch`), with nothing reaching a network.
 *
 * The facilitator double does what x402-rs does on `/feedback/evm/prepare`
 * and `/submit` (`src/handlers.rs`, `src/erc8004/relay_v4.rs`): it builds the
 * v4 typed data with numbers as strings and checksummed addresses, and on
 * submit it REBUILDS the digest from the submitted fields, recovers the
 * signature, checks the nonce was issued and unused, the deadline, and the
 * EIP-7702 authorization on a first rating. Only then does a rating land on
 * the chain double, as a `NewFeedback` log the module must find.
 *
 * Scripted answers are consumed in order; `assertConsumed()` throws when one
 * was never used, so a test whose double went unused is red.
 *
 * Keys are derived at run time from a public seed (`sha256(seed)`); no key is
 * written in this repository.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ethers } from 'ethers';
import {
  Erc8004Client,
} from '../../src/backend';
import {
  Governor,
  MemoryRatingOutbox,
  NEW_FEEDBACK_TOPIC,
  signerFromEthers,
  type EvmRpc,
  type ProcessDeps,
  type RatingOutbox,
  type ReputationCaps,
  type ReputationLogger,
  type ReputationSigner,
} from '../../src/reputation';

/**
 * `usedNonce[nonce]` of the v4 FeedbackDelegate, computed here and not
 * imported, so the module's own formula is checked against something else
 * (and pinned against Base in `submit.test.ts`).
 */
export function delegateNonceSlot(nonce: string): string {
  const layout = '0x516978a8649c68efcdb528ed7ae5a061ff0ca5a183b9df4fd233934a8da02a00';
  return ethers.keccak256(ethers.concat([ethers.zeroPadValue(nonce, 32), layout])).toLowerCase();
}

export const BASE_CHAIN_ID = 8453;
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
export const IDENTITY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const DELEGATE = '0x260D3D0258680aA458D0EBB8BcAE8A2f68bf6163';
export const TRANSFER = ethers.id('Transfer(address,address,uint256)');
export const ZERO32 = '0x' + '00'.repeat(32);
export const FACILITATOR = 'http://facilitator.test';
export const GENESIS_TIME = 1_793_000_000;

/** A private key from a public seed: `sha256(utf8(seed))`. */
export function seedKey(seed: string): string {
  return '0x' + bytesToHex(sha256(new TextEncoder().encode(seed)));
}

export function seededSigner(seed: string): ReputationSigner {
  return signerFromEthers(new ethers.SigningKey(seedKey(seed)));
}

export function seededAddress(seed: string): string {
  return ethers.computeAddress(new ethers.SigningKey(seedKey(seed)).publicKey);
}

const pad = (value: string | bigint): string =>
  '0x' + (typeof value === 'bigint' ? value.toString(16) : value.toLowerCase().replace(/^0x/, '')).padStart(64, '0');
const hex = (n: number | bigint): string => '0x' + BigInt(n).toString(16);

const DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];
const GIVE_FEEDBACK_FIELDS = [
  { name: 'registry', type: 'address' },
  { name: 'agentId', type: 'uint256' },
  { name: 'value', type: 'int128' },
  { name: 'valueDecimals', type: 'uint8' },
  { name: 'tag1', type: 'string' },
  { name: 'tag2', type: 'string' },
  { name: 'endpoint', type: 'string' },
  { name: 'feedbackURI', type: 'string' },
  { name: 'feedbackHash', type: 'bytes32' },
  { name: 'deadline', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
];

type Log = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  removed: boolean;
};

type Pending =
  | { kind: 'raw'; hash: string; from: string; nonce: number; tx: ethers.Transaction; revert: boolean }
  | { kind: 'relay'; hash: string; logs: Omit<Log, 'blockNumber' | 'transactionHash' | 'logIndex' | 'removed'>[]; revert: boolean };

interface Scripted {
  method: string;
  error?: Error;
  result?: unknown;
}

/** A chain double: deterministic blocks, real transaction parsing, logs and receipts. */
export class FakeChain implements EvmRpc {
  readonly chainId: number;
  head: number;
  readonly blockTime = 2;
  readonly calls: Array<{ method: string; params: readonly unknown[] }> = [];
  readonly sentRaw: string[] = [];
  readonly balances = new Map<string, bigint>();
  readonly usdcBalances = new Map<string, bigint>();
  readonly owners = new Map<string, string>();
  /** Account code: an EIP-7702 delegation is `0xef0100` + the delegate. */
  readonly code = new Map<string, string>();
  /**
   * Account storage, `account -> slot -> [block, 32-byte value]` in the order
   * written. Under EIP-7702 the delegate writes the rater's own storage, and it
   * stays when the delegation is removed. `eth_getStorageAt` answers for the
   * block it is asked about: a cell written at block N reads 0 before N.
   */
  readonly storage = new Map<string, Map<string, Array<[number, string]>>>();
  readonly logs: Log[] = [];
  autoMine = true;
  baseFee = 5_000_000n;
  priority = 1_000_000n;
  estimate = 55_000n;
  /** The next mined raw transaction reverts. */
  revertNextRaw = false;
  private readonly receipts = new Map<string, Record<string, unknown>>();
  private readonly known = new Set<string>();
  private readonly minedNonce = new Map<string, number>();
  private pending: Pending[] = [];
  private scripted: Scripted[] = [];
  private fork = 0;
  private relays = 0;

  constructor(options: { chainId?: number; head?: number } = {}) {
    this.chainId = options.chainId ?? BASE_CHAIN_ID;
    this.head = options.head ?? 1000;
  }

  header(n: number): { hash: string; timestamp: number } {
    return {
      hash: ethers.keccak256(ethers.toUtf8Bytes(`block:${n}:${this.fork}`)),
      timestamp: GENESIS_TIME + n * this.blockTime,
    };
  }

  /** Unix seconds of the head block: the one clock of a test. */
  now(): number {
    return this.header(this.head).timestamp;
  }

  /** Reorg every block from here on: their hashes change. */
  reorg(): void {
    this.fork += 1;
  }

  nonceOf(address: string): number {
    return this.minedNonce.get(address.toLowerCase()) ?? 0;
  }

  /** Another transaction of `address` was mined: its nonce moves on. */
  consumeNonce(address: string): void {
    this.minedNonce.set(address.toLowerCase(), this.nonceOf(address) + 1);
  }

  /** A relay ran on `rater`'s account: delegated to `DELEGATE`, `usedNonce[nonce]` set in its storage. */
  spend(rater: string, nonce: string): void {
    this.code.set(rater.toLowerCase(), '0xef0100' + DELEGATE.slice(2).toLowerCase());
    this.setStorage(rater, delegateNonceSlot(nonce), pad(1n));
  }

  /** Write a cell as of the head block. */
  setStorage(account: string, slot: string, value: string): void {
    const cells = this.storage.get(account.toLowerCase()) ?? new Map<string, Array<[number, string]>>();
    const writes = cells.get(slot.toLowerCase()) ?? [];
    writes.push([this.head, value]);
    cells.set(slot.toLowerCase(), writes);
    this.storage.set(account.toLowerCase(), cells);
  }

  /** The cell as of `block` (`latest`: the head). A block past the head is unknown to the node. */
  storageAt(account: string, slot: string, block: unknown): string {
    const n = block === 'latest' ? this.head : Number(BigInt(String(block)));
    if (n > this.head) throw new Error(`FakeChain: header not found for block ${n}`);
    const writes = this.storage.get(account.toLowerCase())?.get(slot.toLowerCase()) ?? [];
    let value = pad(0n);
    for (const [at, v] of writes) if (at <= n) value = v;
    return value;
  }

  /** Mine `blocks` blocks; pending transactions go in the first. */
  advance(blocks = 1): void {
    for (let i = 0; i < blocks; i++) {
      if (this.pending.length === 0) {
        // Nothing to mine: the rest are empty blocks.
        this.head += blocks - i;
        return;
      }
      this.head += 1;
      const block = this.head;
      const { hash: blockHash } = this.header(block);
      const pending = this.pending;
      this.pending = [];
      for (const p of pending) {
        let logs: Log[] = [];
        if (p.kind === 'raw') {
          this.minedNonce.set(p.from.toLowerCase(), p.nonce + 1);
          const tx = p.tx;
          if (!p.revert && tx.to && tx.to.toLowerCase() === USDC.toLowerCase() && tx.data.startsWith('0xa9059cbb')) {
            const [to, amount] = new ethers.Interface(['function transfer(address,uint256)']).decodeFunctionData(
              'transfer',
              tx.data
            );
            logs = [
              {
                address: USDC,
                topics: [TRANSFER, pad(p.from), pad(to as string)],
                data: pad(amount as bigint),
                blockNumber: block,
                transactionHash: p.hash,
                logIndex: 0,
                removed: false,
              },
            ];
          }
        } else if (!p.revert) {
          logs = p.logs.map((l, logIndex) => ({ ...l, blockNumber: block, transactionHash: p.hash, logIndex, removed: false }));
        }
        this.logs.push(...logs);
        this.receipts.set(p.hash, {
          transactionHash: p.hash,
          blockNumber: hex(block),
          blockHash,
          status: p.revert ? '0x0' : '0x1',
          gasUsed: hex(50_000),
          effectiveGasPrice: hex(this.baseFee + this.priority),
          logs: logs.map((l) => ({ ...l, blockNumber: hex(l.blockNumber), logIndex: hex(l.logIndex) })),
        });
      }
    }
  }

  /** Advance at least `seconds` of chain time. */
  advanceTime(seconds: number): void {
    this.advance(Math.max(1, Math.ceil(seconds / this.blockTime)));
  }

  /** A transaction the facilitator sends: mined with these logs. */
  relay(
    logs: Array<{ address: string; topics: string[]; data: string }>,
    options: { revert?: boolean; hash?: string } = {}
  ): string {
    this.relays += 1;
    const hash = (options.hash ?? ethers.keccak256(ethers.toUtf8Bytes(`relay:${this.relays}:${this.head}`))).toLowerCase();
    this.known.add(hash);
    this.pending.push({ kind: 'relay', hash, logs, revert: options.revert === true });
    if (this.autoMine) this.advance(1);
    return hash;
  }

  /** The next call of `method` answers this instead. */
  script(method: string, outcome: { error?: Error; result?: unknown }): void {
    this.scripted.push({ method, ...outcome });
  }

  assertConsumed(): void {
    if (this.scripted.length > 0) {
      throw new Error(`FakeChain: scripted answers never used: ${this.scripted.map((s) => s.method).join(', ')}`);
    }
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  async request({ method, params = [] }: { method: string; params?: readonly unknown[] }): Promise<unknown> {
    this.calls.push({ method, params });
    const i = this.scripted.findIndex((s) => s.method === method);
    if (i >= 0) {
      const [s] = this.scripted.splice(i, 1);
      if (s.error) throw s.error;
      return s.result;
    }
    const p = params as any[];
    switch (method) {
      case 'eth_chainId':
        return hex(this.chainId);
      case 'eth_blockNumber':
        return hex(this.head);
      case 'eth_getBlockByNumber': {
        const n = p[0] === 'latest' ? this.head : Number(BigInt(p[0]));
        if (n > this.head) return null;
        const h = this.header(n);
        return { number: hex(n), hash: h.hash, timestamp: hex(h.timestamp), baseFeePerGas: hex(this.baseFee) };
      }
      case 'eth_getTransactionCount': {
        const address = String(p[0]).toLowerCase();
        const mined = this.nonceOf(address);
        if (p[1] === 'pending') {
          return hex(mined + this.pending.filter((x) => x.kind === 'raw' && x.from.toLowerCase() === address).length);
        }
        return hex(mined);
      }
      case 'eth_maxPriorityFeePerGas':
        return hex(this.priority);
      case 'eth_estimateGas':
        return hex(this.estimate);
      case 'eth_getBalance':
        return hex(this.balances.get(String(p[0]).toLowerCase()) ?? 10n ** 18n);
      case 'eth_sendRawTransaction': {
        const raw = String(p[0]);
        const tx = ethers.Transaction.from(raw);
        if (Number(tx.chainId) !== this.chainId) throw new Error('invalid chain id');
        const hash = (tx.hash as string).toLowerCase();
        const from = tx.from as string;
        if (this.known.has(hash)) throw new Error('already known');
        if (tx.nonce < this.nonceOf(from)) throw new Error('nonce too low');
        this.known.add(hash);
        this.sentRaw.push(raw);
        this.pending.push({ kind: 'raw', hash, from, nonce: tx.nonce, tx, revert: this.revertNextRaw });
        this.revertNextRaw = false;
        if (this.autoMine) this.advance(1);
        return hash;
      }
      case 'eth_getTransactionReceipt':
        return this.receipts.get(String(p[0]).toLowerCase()) ?? null;
      case 'eth_getTransactionByHash': {
        const hash = String(p[0]).toLowerCase();
        return this.known.has(hash) ? { hash } : null;
      }
      case 'eth_getCode':
        return this.code.get(String(p[0]).toLowerCase()) ?? '0x';
      case 'eth_getStorageAt':
        return this.storageAt(String(p[0]), String(p[1]), p[2]);
      case 'eth_getLogs': {
        const f = p[0] as { address: string; fromBlock: string; toBlock: string; topics: Array<string | null> };
        const from = Number(BigInt(f.fromBlock));
        const to = Number(BigInt(f.toBlock));
        return this.logs
          .filter(
            (l) =>
              l.address.toLowerCase() === f.address.toLowerCase() &&
              l.blockNumber >= from &&
              l.blockNumber <= to &&
              f.topics.every((t, k) => t === null || (l.topics[k] ?? '').toLowerCase() === t.toLowerCase())
          )
          .map((l) => ({ ...l, blockNumber: hex(l.blockNumber), logIndex: hex(l.logIndex) }));
      }
      case 'eth_call': {
        const call = p[0] as { to: string; data: string };
        const to = call.to.toLowerCase();
        if (to === USDC.toLowerCase() && call.data.startsWith(ethers.id('balanceOf(address)').slice(0, 10))) {
          const owner = '0x' + call.data.slice(-40);
          return pad(this.usdcBalances.get(owner) ?? 10n ** 12n);
        }
        if (to === IDENTITY.toLowerCase() && call.data.startsWith(ethers.id('ownerOf(uint256)').slice(0, 10))) {
          const agentId = BigInt('0x' + call.data.slice(10)).toString();
          const owner = this.owners.get(agentId);
          if (!owner) throw new Error('execution reverted: ERC721NonexistentToken');
          return pad(owner);
        }
        throw new Error(`FakeChain: unexpected eth_call to ${call.to}`);
      }
      default:
        throw new Error(`FakeChain: unexpected method ${method}`);
    }
  }
}

export interface ScriptedAnswer {
  route: 'prepare' | 'submit';
  /** Answer this HTTP status with `body` instead of the real answer. */
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** `fetch` rejects, as on a timeout or a dropped connection. */
  throws?: boolean;
  /** Submit only: the rating lands on-chain even though the answer is an error or a throw. */
  land?: boolean;
  /** Prepare only: edit the correct answer before it goes out. */
  tamper?: (answer: any) => void;
  /** Submit only: answer 200 with a transaction hash that never mines, and land nothing. */
  phantom?: boolean;
}

/** The v4 message x402-rs builds from a prepare request (`relay_v4.rs::give_feedback_typed_data`). */
export function facilitatorMessage(f: any, deadline: number, nonce: string) {
  return {
    registry: REGISTRY,
    agentId: String(f.agentId),
    value: String(f.value),
    valueDecimals: f.valueDecimals ?? 0,
    tag1: f.tag1 ?? '',
    tag2: f.tag2 ?? '',
    endpoint: f.endpoint ?? '',
    feedbackURI: f.feedbackUri ?? '',
    feedbackHash: String(f.feedbackHash ?? ZERO32).toLowerCase(),
    deadline: String(deadline),
    nonce,
  };
}

export function facilitatorDigest(rater: string, message: Record<string, unknown>, chainId = BASE_CHAIN_ID): string {
  return ethers.TypedDataEncoder.hash(
    { name: 'FeedbackDelegate', version: '1', chainId, verifyingContract: rater },
    { RelayedGiveFeedback: GIVE_FEEDBACK_FIELDS },
    message
  );
}

/** A correct `/feedback/evm/prepare` answer, as x402-rs writes it. */
export function prepareAnswer(input: {
  rater: string;
  feedback: any;
  deadline: number;
  nonce: string;
  delegated: boolean;
  accountNonce?: number;
}): any {
  const rater = ethers.getAddress(input.rater.toLowerCase());
  const message = facilitatorMessage(input.feedback, input.deadline, input.nonce);
  const answer: any = {
    success: true,
    delegate: DELEGATE,
    data: '0x',
    digest: facilitatorDigest(rater, message),
    typedData: {
      domain: { name: 'FeedbackDelegate', version: '1', chainId: BASE_CHAIN_ID, verifyingContract: rater },
      primaryType: 'RelayedGiveFeedback',
      types: {
        EIP712Domain: DOMAIN_FIELDS.map((f) => ({ ...f })),
        RelayedGiveFeedback: GIVE_FEEDBACK_FIELDS.map((f) => ({ ...f })),
      },
      message,
    },
    deadline: input.deadline,
    nonce: input.nonce,
    delegated: input.delegated,
    chainId: BASE_CHAIN_ID,
    network: 'base',
  };
  if (!input.delegated) answer.accountNonce = input.accountNonce ?? 0;
  return answer;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** The facilitator's `/feedback/evm/prepare` and `/submit`, behind `fetch`. */
export class FakeFacilitator {
  prepares = 0;
  submits = 0;
  readonly submitBodies: any[] = [];
  readonly prepareBodies: any[] = [];
  readonly landed: Array<{ rater: string; agentId: string; nonce: string; tx: string }> = [];
  readonly delegated = new Set<string>();
  proofReport: unknown = { anchor: 'not_declared', enforced: false };
  private readonly issued = new Map<string, { rater: string; deadline: number }>();
  private readonly used = new Set<string>();
  private script: ScriptedAnswer[] = [];
  private counter = 0;
  private readonly indexes = new Map<string, number>();

  constructor(readonly chain: FakeChain) {}

  queue(...answers: ScriptedAnswer[]): void {
    this.script.push(...answers);
  }

  assertConsumed(): void {
    if (this.script.length > 0) {
      throw new Error(`FakeFacilitator: scripted answers never used: ${this.script.map((s) => s.route).join(', ')}`);
    }
  }

  private take(route: 'prepare' | 'submit'): ScriptedAnswer | undefined {
    const i = this.script.findIndex((s) => s.route === route);
    return i >= 0 ? this.script.splice(i, 1)[0] : undefined;
  }

  readonly fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === `${FACILITATOR}/feedback/evm/prepare`) return this.prepare(JSON.parse(String(init?.body)));
    if (url === `${FACILITATOR}/feedback/evm/submit`) return this.submit(JSON.parse(String(init?.body)));
    throw new Error(`network is closed in this test: ${url}`);
  };

  private async prepare(body: any): Promise<Response> {
    this.prepares += 1;
    this.prepareBodies.push(body);
    const scripted = this.take('prepare');
    if (scripted?.throws) throw new TypeError('fetch failed');
    if (scripted?.status) return json(scripted.status, scripted.body ?? {}, scripted.headers);
    const f = body.feedback;
    const rater = ethers.getAddress(String(f.rater).toLowerCase());
    const delegated = this.delegated.has(rater.toLowerCase());
    const deadline = this.chain.now() + 900;
    this.counter += 1;
    const nonce = ethers.keccak256(ethers.toUtf8Bytes(`facilitator-nonce:${this.counter}`));
    const answer = prepareAnswer({ rater, feedback: f, deadline, nonce, delegated, accountNonce: this.chain.nonceOf(rater) });
    scripted?.tamper?.(answer);
    this.issued.set(nonce, { rater, deadline });
    return json(200, answer);
  }

  private land(body: any, rater: string): { tx: string; index: number } {
    const f = body.feedback;
    const key = `${f.agentId}:${rater.toLowerCase()}`;
    const index = (this.indexes.get(key) ?? 0) + 1;
    this.indexes.set(key, index);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint64', 'int128', 'uint8', 'string', 'string', 'string', 'string', 'bytes32'],
      [index, f.value, f.valueDecimals ?? 0, f.tag1 ?? '', f.tag2 ?? '', f.endpoint ?? '', f.feedbackUri ?? '', f.feedbackHash ?? ZERO32]
    );
    const tx = this.chain.relay([
      {
        address: REGISTRY,
        topics: [NEW_FEEDBACK_TOPIC, pad(BigInt(f.agentId)), pad(rater), ethers.id(f.tag1 ?? '')],
        data,
      },
    ]);
    this.used.add(String(body.nonce).toLowerCase());
    this.chain.spend(rater, String(body.nonce));
    this.landed.push({ rater, agentId: String(f.agentId), nonce: String(body.nonce).toLowerCase(), tx });
    return { tx, index };
  }

  private refuse(error: string): Response {
    return json(400, { success: false, error, network: 'base' });
  }

  private async submit(body: any): Promise<Response> {
    this.submits += 1;
    this.submitBodies.push(body);
    const scripted = this.take('submit');
    const issued = this.issued.get(String(body.nonce).toLowerCase());
    if (!issued) return this.refuse('relay_unknown_nonce');
    const rater = issued.rater;
    if (this.used.has(String(body.nonce).toLowerCase())) return this.refuse('relay_nonce_used');
    if (this.chain.now() > issued.deadline) return this.refuse('relay_expired');
    const digest = facilitatorDigest(rater, facilitatorMessage(body.feedback, body.deadline, String(body.nonce).toLowerCase()));
    if (ethers.recoverAddress(digest, body.signature).toLowerCase() !== rater.toLowerCase()) {
      return this.refuse('relay_bad_signature');
    }
    if (!this.delegated.has(rater.toLowerCase())) {
      const a = body.authorization;
      if (!a || a.chainId !== BASE_CHAIN_ID || a.address.toLowerCase() !== DELEGATE.toLowerCase() || a.nonce !== this.chain.nonceOf(rater)) {
        return this.refuse('relay_bad_authorization');
      }
      const authDigest = ethers.hashAuthorization({ chainId: BigInt(a.chainId), address: a.address, nonce: BigInt(a.nonce) });
      if (ethers.recoverAddress(authDigest, { r: a.r, s: a.s, yParity: a.yParity }).toLowerCase() !== rater.toLowerCase()) {
        return this.refuse('relay_bad_authorization');
      }
    }
    if (scripted?.phantom) {
      return json(200, { success: true, transaction: ethers.keccak256(ethers.toUtf8Bytes(`phantom:${this.submits}`)), network: 'base' });
    }
    if (scripted && (scripted.status || scripted.throws)) {
      if (scripted.land) {
        this.delegated.add(rater.toLowerCase());
        this.land(body, rater);
      }
      if (scripted.throws) throw new TypeError('fetch failed');
      return json(scripted.status as number, scripted.body ?? {}, scripted.headers);
    }
    this.delegated.add(rater.toLowerCase());
    const { tx, index } = this.land(body, rater);
    return json(200, { success: true, transaction: tx, feedbackIndex: index, network: 'base', proof: this.proofReport });
  }
}

/** Every line a logger received, as text. */
export class CapturingLogger implements ReputationLogger {
  readonly lines: string[] = [];
  private push(level: string, message: string, fields?: Record<string, unknown>) {
    this.lines.push(`${level} ${message} ${fields === undefined ? '' : JSON.stringify(fields)}`);
  }
  debug(m: string, f?: Record<string, unknown>) {
    this.push('debug', m, f);
  }
  info(m: string, f?: Record<string, unknown>) {
    this.push('info', m, f);
  }
  warn(m: string, f?: Record<string, unknown>) {
    this.push('warn', m, f);
  }
  error(m: string, f?: Record<string, unknown>) {
    this.push('error', m, f);
  }
}

export const RATER_SEED = 'uvd-x402 reputation test rater';
export const VIEWER_SEEDS = ['uvd-x402 reputation test viewer 1', 'uvd-x402 reputation test viewer 2', 'uvd-x402 reputation test viewer 3'];

export const OPEN_CAPS: ReputationCaps = {
  perViewerPerStream: 100,
  perViewerPerDay: 100,
  perViewerLifetime: 100,
  perStream: 100,
  perDay: 100,
  lifetime: 74_000,
  maxAmountPerRating: 10_000,
  maxValue: 95,
};

export interface World {
  chain: FakeChain;
  facilitator: FakeFacilitator;
  outbox: RatingOutbox;
  governor: Governor;
  signer: ReputationSigner;
  logger: CapturingLogger;
  deps: ProcessDeps;
  viewers: string[];
}

/**
 * A chain, a facilitator, an outbox and a governor sharing one clock (the
 * chain's), the rater's anchor payments and the viewers' agents in place.
 * The caller stubs `fetch` with `world.facilitator.fetch`.
 */
export function world(
  options: {
    outbox?: RatingOutbox;
    caps?: ReputationCaps;
    health?: (() => { campaignPerRater: number }) | null;
    failureThreshold?: number;
  } = {}
): World {
  const chain = new FakeChain();
  const facilitator = new FakeFacilitator(chain);
  const now = () => chain.now();
  const outbox = options.outbox ?? new MemoryRatingOutbox({ now });
  const logger = new CapturingLogger();
  const governor = new Governor(options.caps ?? OPEN_CAPS, options.health === undefined ? () => ({ campaignPerRater: 20 }) : options.health, {
    store: outbox,
    now,
    logger,
    failureThreshold: options.failureThreshold,
  });
  const signer = seededSigner(RATER_SEED);
  const viewers = VIEWER_SEEDS.map(seededAddress);
  viewers.forEach((v, i) => chain.owners.set(String(1000 + i), v.toLowerCase()));
  const client = new Erc8004Client({ baseUrl: FACILITATOR, retries: 0 });
  const agentOf = (subject: string) => 1000 + viewers.findIndex((v) => v.toLowerCase() === subject);
  const deps: ProcessDeps = {
    outbox,
    client,
    signer,
    rpc: chain,
    governor,
    now,
    logger,
    resolveAgent: (row) => agentOf(row.subject),
    buildFeedback: (row) => ({
      agentId: agentOf(row.subject),
      tag1: 'moment:idea',
      tag2: 'credits-roll',
      endpoint: 'https://www.twitch.tv/example',
      feedbackUri: `https://evidence.test/${row.ref}.json`,
      feedbackHash: ethers.keccak256(ethers.toUtf8Bytes(`evidence:${row.ref}`)),
    }),
    payment: { pollIntervalMs: 0, sleep: async () => chain.advance(1), maxPolls: 10 },
  };
  return { chain, facilitator, outbox, governor, signer, logger, deps, viewers };
}
