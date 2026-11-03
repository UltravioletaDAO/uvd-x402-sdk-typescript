/** Arras v1: offline, local-key NEP-366 signing. No RPC or transaction submission. */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { encodeBase58 } from 'ethers';
import { fullMatch, uint, account, concat, le, str, unbase58 } from './encoding';

export type NearEscrowNetwork = 'near:mainnet' | 'near:testnet';
/** Numbers must be safe integers; use decimal strings or bigint for nanoseconds and u128. */
export type NearUnsigned = string | bigint | number;
export interface EscrowMsgParams {
  operator_id: string;
  receiver: string;
  release_deadline: NearUnsigned;
  reclaim_after: NearUnsigned;
  fee_bps_max: number;
  terms_hash: string;
  salt: string;
}
export interface PaymentIdParams extends EscrowMsgParams {
  token: string;
  payer: string;
  amount: NearUnsigned;
}
export interface NearLocalSigner {
  readonly publicKey: Uint8Array;
  /** Sign the supplied SHA-256 digest directly. The calling helper supplies its domain prefix. */
  sign(digest: Uint8Array): Uint8Array | Promise<Uint8Array>;
}
export interface NearEscrowDelegateOptions {
  network: NearEscrowNetwork;
  signer: NearLocalSigner;
  senderId: string;
  escrowContract: string;
  /** The next access-key nonce, not the current nonce. */
  nonce: NearUnsigned;
  maxBlockHeight: NearUnsigned;
  /** Gas units (1 TGas = 10^12), not a floating point TGas count. */
  gas?: NearUnsigned;
}
export interface EscrowAuthorizationOptions extends NearEscrowDelegateOptions {
  token: string;
  amount: NearUnsigned;
  msg: EscrowMsgParams;
}
export interface NearEscrowPayment {
  x402Version: 2;
  scheme: 'escrow';
  network: NearEscrowNetwork;
  payload: { signedDelegateAction: string };
}
export interface NearEscrowFunctionCall {
  methodName: string;
  args: string;
  gas: NearUnsigned;
  deposit: NearUnsigned;
}
export interface NearEscrowDelegate {
  senderId: string;
  receiverId: string;
  actions: NearEscrowFunctionCall[];
  nonce: NearUnsigned;
  maxBlockHeight: NearUnsigned;
}

export const NEAR_ESCROW_MIN_GAS = 38_000_000_000_000n;
export const NEAR_ESCROW_MAX_GAS = 100_000_000_000_000n;
export const NEAR_ESCROW_TOKENS: Readonly<Record<NearEscrowNetwork, string>> = Object.freeze({
  'near:mainnet': '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  'near:testnet': '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
});
/**
 * The Arras escrow deployments this SDK signs for, per network. Any other escrowContract is refused before the
 * signer is called, for authorization and lifecycle alike: a signed delegate can be relayed by anyone, so a 402
 * server must not be able to point it at its own account. Only deployed Arras v1 contracts are registered.
 */
export const NEAR_ESCROW_CONTRACTS: Readonly<Record<NearEscrowNetwork, readonly string[]>> = Object.freeze({
  'near:testnet': Object.freeze(['arras-v1b-1101.testnet']),
  'near:mainnet': Object.freeze(['v1.arras-escrow.near']),
});
/** NEAR's ACCESS_KEY_NONCE_RANGE_MULTIPLIER: a delegate needs nonce < block height * 10^6. */
const NONCE_RANGE_MULTIPLIER = 1_000_000n;

function hex(value: string, size: number, name: string): Uint8Array {
  if (typeof value !== 'string' || value.length !== size * 2 || !fullMatch(/^[0-9a-f]+$/, value)) {
    throw new Error(`${name}: expected ${size} bytes of lowercase hex without 0x`);
  }
  return Uint8Array.from(value.match(/../g)!, (v) => parseInt(v, 16));
}
function msgValues(p: EscrowMsgParams) {
  if (typeof p.operator_id !== 'string' || !fullMatch(/^[a-z0-9_-]{1,32}$/, p.operator_id)) {
    throw new Error('operator_id: expected [a-z0-9_-]{1,32}');
  }
  account(p.receiver, 'receiver');
  const release = uint(p.release_deadline, 64, 'release_deadline');
  const reclaim = uint(p.reclaim_after, 64, 'reclaim_after');
  if (release >= reclaim) throw new Error('release_deadline must precede reclaim_after');
  if (typeof p.fee_bps_max !== 'number') throw new Error('fee_bps_max: expected a number');
  const fee = uint(p.fee_bps_max, 16, 'fee_bps_max');
  return { release, reclaim, fee, terms: hex(p.terms_hash, 32, 'terms_hash'), salt: hex(p.salt, 16, 'salt') };
}

/** Canonical Arras JSON: field order, decimal-string timestamps, lowercase hex, no spaces. */
export function buildEscrowMsg(p: EscrowMsgParams): string {
  const v = msgValues(p);
  return JSON.stringify({ v: 1, action: 'authorize', operator_id: p.operator_id, receiver: p.receiver,
    release_deadline: v.release.toString(), reclaim_after: v.reclaim.toString(), fee_bps_max: Number(v.fee),
    terms_hash: p.terms_hash, salt: p.salt });
}
/** Exact Rust Borsh preimage, exposed for cross-language conformance. */
export function paymentIdPreimage(p: PaymentIdParams): Uint8Array {
  const v = msgValues(p);
  account(p.token, 'token'); account(p.payer, 'payer');
  return concat(Uint8Array.of(1), str(p.operator_id), str(p.token), str(p.payer), str(p.receiver),
    le(uint(p.amount, 128, 'amount'), 16), le(v.release, 8), le(v.reclaim, 8), le(v.fee, 2), v.terms, v.salt);
}
export function computePaymentId(p: PaymentIdParams): string {
  return encodeBase58(sha256(paymentIdPreimage(p)));
}

/** A 32-byte Ed25519 seed, or a NEAR ed25519: base58 secret (seed + public key, 64 bytes). */
export function createNearLocalSigner(secret: Uint8Array | string): NearLocalSigner {
  let raw: Uint8Array;
  if (typeof secret === 'string') {
    if (!secret.startsWith('ed25519:')) throw new Error('Expected ed25519: secret key');
    raw = unbase58(secret.slice(8));
    if (raw.length !== 64) throw new Error('NEAR secret key must contain 64 bytes');
  } else if (secret instanceof Uint8Array && secret.length === 32) {
    raw = new Uint8Array(secret);
  } else throw new Error('Expected a 32-byte seed or NEAR secret key');
  const seed = raw.slice(0, 32);
  const publicKey = ed25519.getPublicKey(seed);
  if (raw.length === 64 && !raw.slice(32).every((b, i) => b === publicKey[i])) {
    throw new Error('NEAR secret key public half does not match seed');
  }
  return { get publicKey() { return publicKey.slice(); }, sign: (digest) => ed25519.sign(digest, seed) };
}

function delegateOptions(o: NearEscrowDelegateOptions): void {
  if (o.network !== 'near:mainnet' && o.network !== 'near:testnet') throw new Error('Unsupported NEAR network');
  account(o.senderId, 'senderId'); account(o.escrowContract, 'escrowContract');
  if (!NEAR_ESCROW_CONTRACTS[o.network].includes(o.escrowContract)) {
    throw new Error(`escrowContract: not a registered Arras escrow for ${o.network}`);
  }
  delegateNonce(o);
}
function delegateNonce(o: Pick<NearEscrowDelegateOptions, 'nonce' | 'maxBlockHeight'>): void {
  const nonce = uint(o.nonce, 64, 'nonce');
  if (nonce === 0n) throw new Error('nonce must be positive');
  const height = uint(o.maxBlockHeight, 64, 'maxBlockHeight');
  if (height === 0n) throw new Error('maxBlockHeight must be positive');
  // Execution never passes maxBlockHeight, so NEAR would always answer DelegateActionNonceTooLarge.
  if (nonce >= height * NONCE_RANGE_MULTIPLIER) throw new Error('nonce must be below maxBlockHeight * 10^6');
}

/** Build the one allowed FT action. The contract must be in NEAR_ESCROW_CONTRACTS; the operator comes from trusted /supported configuration. */
export function buildEscrowAuthorizationDelegate(o: EscrowAuthorizationOptions): NearEscrowDelegate {
  delegateOptions(o);
  if (o.token !== NEAR_ESCROW_TOKENS[o.network]) throw new Error('token does not match network USDC');
  if (o.msg.receiver === o.senderId || o.msg.receiver === o.escrowContract) throw new Error('receiver equals payer or escrow');
  const amount = uint(o.amount, 128, 'amount');
  if (amount === 0n) throw new Error('amount must be positive');
  return { senderId: o.senderId, receiverId: o.token, nonce: o.nonce, maxBlockHeight: o.maxBlockHeight,
    actions: [{ methodName: 'ft_transfer_call', args: JSON.stringify({ receiver_id: o.escrowContract,
      amount: amount.toString(), msg: buildEscrowMsg(o.msg) }), gas: o.gas ?? NEAR_ESCROW_MAX_GAS, deposit: 1n }] };
}
/** Validate before signing, including strict byte binding to the expected canonical FT arguments. */
export function validateEscrowAuthorizationDelegate(d: NearEscrowDelegate, o: EscrowAuthorizationOptions): void {
  const expected = buildEscrowAuthorizationDelegate(o);
  if (d.senderId !== expected.senderId || d.receiverId !== expected.receiverId ||
      uint(d.nonce, 64, 'nonce') !== uint(expected.nonce, 64, 'nonce') ||
      uint(d.maxBlockHeight, 64, 'maxBlockHeight') !== uint(expected.maxBlockHeight, 64, 'maxBlockHeight')) {
    throw new Error('Delegate does not match authorization');
  }
  if (d.actions.length !== 1) throw new Error('Expected exactly one action');
  const a = d.actions[0];
  if (a.methodName !== 'ft_transfer_call' || a.args !== expected.actions[0].args) throw new Error('FT method or arguments mismatch');
  if (uint(a.deposit, 128, 'deposit') !== 1n) throw new Error('FT deposit must be 1 yocto');
  const gas = uint(a.gas, 64, 'gas');
  if (gas < NEAR_ESCROW_MIN_GAS || gas > NEAR_ESCROW_MAX_GAS) throw new Error('FT gas outside 38..100 TGas');
}
type SigningContext = Pick<NearEscrowDelegateOptions, 'network' | 'signer'>;
async function signDelegate(o: SigningContext, d: NearEscrowDelegate, scheme: 'exact'): Promise<NearExactPayment>;
async function signDelegate(o: SigningContext, d: NearEscrowDelegate, scheme?: 'escrow'): Promise<NearEscrowPayment>;
async function signDelegate(o: SigningContext, d: NearEscrowDelegate, scheme: 'escrow' | 'exact' = 'escrow'): Promise<NearEscrowPayment | NearExactPayment> {
  const network = o.network;
  const pk = new Uint8Array(o.signer.publicKey);
  if (pk.length !== 32) throw new Error('Expected 32-byte Ed25519 public key');
  const a = d.actions[0];
  const bytes = concat(str(d.senderId), str(d.receiverId), le(1n, 4), Uint8Array.of(2), str(a.methodName), str(a.args),
    le(uint(a.gas, 64, 'gas'), 8), le(uint(a.deposit, 128, 'deposit'), 16),
    le(uint(d.nonce, 64, 'nonce'), 8), le(uint(d.maxBlockHeight, 64, 'maxBlockHeight'), 8), Uint8Array.of(0), pk);
  const digest = sha256(concat(Uint8Array.of(0x6e, 0x01, 0x00, 0x40), bytes));
  const signature = await o.signer.sign(digest.slice());
  if (!(signature instanceof Uint8Array) || signature.length !== 64 || !ed25519.verify(signature, digest, pk)) {
    throw new Error('Invalid Ed25519 delegate signature');
  }
  const signed = concat(bytes, Uint8Array.of(0), signature);
  return { x402Version: 2, scheme, network,
    payload: { signedDelegateAction: btoa(Array.from(signed, (b) => String.fromCharCode(b)).join('')) } };
}
export async function signEscrowAuthorization(options: EscrowAuthorizationOptions): Promise<NearEscrowPayment> {
  const o = { ...options }; // read each field once, so the contract checked is the contract signed
  const d = buildEscrowAuthorizationDelegate(o);
  validateEscrowAuthorizationDelegate(d, o);
  return signDelegate(o, d);
}

export type NearEscrowLifecycleMethod = 'release' | 'refund' | 'reclaim' | 'withdraw' | 'withdraw_for';
const lifecycleGas: Record<NearEscrowLifecycleMethod, bigint> = Object.freeze({
  release: 30_000_000_000_000n, refund: 30_000_000_000_000n, reclaim: 30_000_000_000_000n,
  withdraw: 50_000_000_000_000n, withdraw_for: 50_000_000_000_000n,
});
export async function signEscrowLifecycle(options: NearEscrowDelegateOptions,
  method: NearEscrowLifecycleMethod, args: { payment_id?: string; amount?: NearUnsigned | null; account?: string } = {}
): Promise<NearEscrowPayment> {
  const o = { ...options }; // read each field once, so the contract checked is the contract signed
  delegateOptions(o);
  if (!Object.hasOwn(lifecycleGas, method)) throw new Error('Escrow method not allowed');
  const gas = uint(o.gas ?? lifecycleGas[method], 64, 'gas');
  const minGas = method === 'withdraw' || method === 'withdraw_for' ? 29_000_000_000_000n : 3_000_000_000_000n;
  if (gas < minGas || gas > lifecycleGas[method]) throw new Error('Lifecycle gas outside method limit');
  const allowed = method === 'release' ? ['payment_id', 'amount'] : method === 'withdraw' ? [] :
    method === 'withdraw_for' ? ['account'] : ['payment_id'];
  if (Object.keys(args).some((k) => !allowed.includes(k))) throw new Error('Unexpected lifecycle argument');
  const params: Record<string, string | null> = {};
  if (method === 'withdraw_for') { account(args.account!, 'account'); params.account = args.account!; }
  else if (method !== 'withdraw') {
    if (typeof args.payment_id !== 'string' || args.payment_id.length < 32 || args.payment_id.length > 44 ||
        unbase58(args.payment_id).length !== 32) throw new Error('Invalid payment_id');
    params.payment_id = args.payment_id;
    if (method === 'release') {
      params.amount = args.amount == null ? null : uint(args.amount, 128, 'amount').toString();
      if (params.amount === '0') throw new Error('release amount must be positive');
    }
  }
  return signDelegate(o, { senderId: o.senderId, receiverId: o.escrowContract, nonce: o.nonce,
    maxBlockHeight: o.maxBlockHeight, actions: [{ methodName: method, args: JSON.stringify(params), gas, deposit: 0n }] });
}
export const release = (o: NearEscrowDelegateOptions, paymentId: string, amount?: NearUnsigned | null) =>
  signEscrowLifecycle(o, 'release', { payment_id: paymentId, amount });
export const refund = (o: NearEscrowDelegateOptions, paymentId: string) => signEscrowLifecycle(o, 'refund', { payment_id: paymentId });
export const reclaim = (o: NearEscrowDelegateOptions, paymentId: string) => signEscrowLifecycle(o, 'reclaim', { payment_id: paymentId });
export const withdraw = (o: NearEscrowDelegateOptions) => signEscrowLifecycle(o, 'withdraw');
export const withdrawFor = (o: NearEscrowDelegateOptions, account: string) => signEscrowLifecycle(o, 'withdraw_for', { account });

/** v2 boundary only: no budget wire format or signing is defined until Arras v2 supplies its vectors. */
export interface AuthorizeFromBudget {
  authorizeFromBudget(request: unknown): Promise<NearEscrowPayment>;
}

/** Local-key exact NEP-366 payment; uses the escrow serializer and raw digest signer. */
export interface NearExactDelegateOptions extends Omit<NearEscrowDelegateOptions, 'escrowContract'> {
  token: string;
  payTo: string;
  amount: NearUnsigned;
}
export interface NearExactPayment extends Omit<NearEscrowPayment, 'scheme'> { scheme: 'exact' }
export async function signExactNearDelegate(options: NearExactDelegateOptions): Promise<NearExactPayment> {
  const o = { ...options };
  if (o.network !== 'near:mainnet' && o.network !== 'near:testnet') throw new Error('Unsupported NEAR network');
  account(o.senderId, 'senderId'); account(o.payTo, 'payTo');
  if (o.payTo === 'intents.near') throw new Error('intents.near is not an allowed recipient');
  if (o.token !== NEAR_ESCROW_TOKENS[o.network]) throw new Error('token does not match network USDC');
  delegateNonce(o);
  const amount = uint(o.amount, 128, 'amount');
  if (amount === 0n) throw new Error('amount must be positive');
  const gas = uint(o.gas ?? 30_000_000_000_000n, 64, 'gas');
  if (gas === 0n || gas > 30_000_000_000_000n) throw new Error('Exact gas must be positive and at most 30 TGas');
  return signDelegate(o, { senderId: o.senderId, receiverId: o.token, nonce: o.nonce, maxBlockHeight: o.maxBlockHeight,
    actions: [{ methodName: 'ft_transfer', args: JSON.stringify({ receiver_id: o.payTo, amount: amount.toString() }),
      gas, deposit: 1n }] }, 'exact');
}
