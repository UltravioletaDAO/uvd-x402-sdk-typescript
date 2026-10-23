/**
 * uvd-x402-sdk/batch-settlement - x402 `batch-settlement` on EVM, BUYER side.
 *
 * The scheme (coinbase/x402, `specs/schemes/batch-settlement/scheme_batch_settlement_evm.md`)
 * lets a buyer open a payment channel once and pay each later request with an
 * off-chain voucher. This module is the part a buyer needs, and nothing of the
 * seller or the facilitator:
 *
 * - {@link computeChannelId} - the chain-bound EIP-712 hash of the channel config.
 * - {@link signVoucher} - the cumulative `Voucher` typed data.
 * - {@link buildDepositPayload} - ERC-3009 `ReceiveWithAuthorization` to the
 *   deposit collector + a voucher.
 * - {@link BatchSettlementClient} - decides deposit vs voucher, keeps the channel
 *   state, and updates it from the seller's response the way the spec says (from
 *   its own previous state plus `chargedAmount`, never by copying the seller's
 *   `channelState`).
 *
 * It signs through anything with `signTypedData(typedDataJson)` - the SDK's
 * `SigningWalletAdapter` (`EnvKeyAdapter`, `OWSWalletAdapter`) or a wrapper over
 * a remote wallet - so the key never has to be loaded here.
 *
 * WHAT IS NOT HERE, on purpose: the Permit2 deposit path
 * (`assetTransferMethod: "permit2"` throws {@link BatchSettlementError}, it is
 * never guessed), the cooperative refund, and the corrective-402 resync. USDC
 * settles through ERC-3009, which is the default the spec names.
 *
 * MONEY RULES this module enforces, because a 402 is somebody else's input:
 *
 * - A deposit is capped by `maxDeposit` (default 1 USDC in atomic units of the
 *   asset, i.e. `1_000_000` for a 6-decimals token). A seller whose `minDeposit`
 *   is above the cap is capped, not obeyed; a deposit the next voucher NEEDS above
 *   the cap is refused.
 * - The seller's `extra.minDeposit` is only a target; the amount is never below
 *   what the next voucher needs.
 * - Only `eip155:*` networks and only `scheme === "batch-settlement"` are signed.
 *
 * Port of `uvd_x402_sdk.batch_settlement` (Python). Keep the two in step: the
 * golden vectors of `src/batch-settlement.test.ts` are the Python suite's, and a
 * divergence here is a channel the seller cannot open or a voucher it rejects.
 *
 * @example
 * ```ts
 * import { EnvKeyAdapter } from 'uvd-x402-sdk';
 * import { BatchSettlementClient, FileChannelStorage } from 'uvd-x402-sdk/batch-settlement';
 *
 * const client = new BatchSettlementClient(new EnvKeyAdapter(), {
 *   storage: new FileChannelStorage('./channels.json'),
 * });
 * const prepared = await client.createPayment(accepted, { url });
 * const res = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': prepared.header() } });
 * if (res.ok) await client.confirm(prepared, settleResponse.extra);
 * ```
 */

import { ethers } from 'ethers';
import { encodeBase64Utf8 } from './utils/base64';
import {
  needsAccountWrap,
  replaySafeTypedData,
  resolveDelegation,
  wrapSignature,
  type DelegationResolver,
} from './erc7702.js';

export const SCHEME = 'batch-settlement';

/** Deterministic CREATE2 addresses, the same on every supported EVM chain (spec, "Contract addresses"). */
export const BATCH_SETTLEMENT_ADDRESS = '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003';
export const ERC3009_DEPOSIT_COLLECTOR_ADDRESS = '0x4020806089470a89826cB9fB1f4059150b550004';
export const PERMIT2_DEPOSIT_COLLECTOR_ADDRESS = '0x4020425FAf3B746C082C2f942b4E5159887B0005';

export const BATCH_SETTLEMENT_DOMAIN_NAME = 'x402 Batch Settlement';
export const BATCH_SETTLEMENT_DOMAIN_VERSION = '1';

export const MIN_WITHDRAW_DELAY = 900;
export const MAX_WITHDRAW_DELAY = 2_592_000;

export const ZERO_ADDRESS = '0x' + '0'.repeat(40);
export const ZERO_BYTES32 = '0x' + '0'.repeat(64);

/** Default ceiling for ONE deposit, in atomic units. A 402 must not be able to lock unbounded escrow (spec). */
export const DEFAULT_MAX_DEPOSIT = 1_000_000n;
/** Used when the seller announces no `minDeposit`: the deposit target is this many requests. */
export const DEFAULT_DEPOSIT_MULTIPLIER = 5n;

type TypedFields = Record<string, Array<{ name: string; type: string }>>;

export const CHANNEL_CONFIG_TYPES: TypedFields = Object.freeze({
  ChannelConfig: [
    { name: 'payer', type: 'address' },
    { name: 'payerAuthorizer', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'receiverAuthorizer', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'withdrawDelay', type: 'uint40' },
    { name: 'salt', type: 'bytes32' },
  ],
});
export const VOUCHER_TYPES: TypedFields = Object.freeze({
  Voucher: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'maxClaimableAmount', type: 'uint128' },
  ],
});
export const RECEIVE_AUTHORIZATION_TYPES: TypedFields = Object.freeze({
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
});

/** The 402 or the channel state cannot be signed as asked. Never retried blindly. */
export class BatchSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchSettlementError';
  }
}

// ---------------------------------------------------------------------------
// Signer and wire types
// ---------------------------------------------------------------------------

/**
 * What this module signs with: EIP-712 over the full typed-data JSON string
 * (`domain`, `types`, `primaryType`, `message`), the contract of
 * `SigningWalletAdapter.signTypedData`, so `EnvKeyAdapter` and
 * `OWSWalletAdapter` satisfy it structurally. The address comes from
 * `getAddress()` or, failing that, `address`.
 */
export interface BatchSettlementSigner {
  signTypedData(typedData: string): Promise<{ signature: string } | string>;
  getAddress?: () => string;
  address?: string;
}

/** The fields of a `batch-settlement` accept this module reads. Other fields travel untouched in `accepted`. */
export interface BatchSettlementRequirements {
  scheme: string;
  network: string;
  amount: string | number | bigint;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number | string;
  extra?: unknown;
}

export interface ChannelConfigFields {
  payer: string;
  payerAuthorizer: string;
  receiver: string;
  receiverAuthorizer: string;
  token: string;
  withdrawDelay: number;
  salt?: string;
}

/** `channelConfig` as it travels in the payload: checksummed addresses, lowercase salt. */
export interface ChannelConfigJSON {
  payer: string;
  payerAuthorizer: string;
  receiver: string;
  receiverAuthorizer: string;
  token: string;
  withdrawDelay: number;
  salt: string;
}

export interface SignedVoucher {
  channelId: string;
  maxClaimableAmount: string;
  signature: string;
}

export interface DepositPayload {
  type: 'deposit';
  channelConfig: ChannelConfigJSON;
  voucher: SignedVoucher;
  deposit: {
    amount: string;
    authorization: {
      erc3009Authorization: {
        validAfter: string;
        validBefore: string;
        salt: string;
        signature: string;
      };
    };
  };
}

export interface VoucherPayload {
  type: 'voucher';
  channelConfig: ChannelConfigJSON;
  voucher: SignedVoucher;
}

export type BatchSettlementInnerPayload = DepositPayload | VoucherPayload;

/** The x402 v2 `PaymentPayload` envelope. */
export interface BatchSettlementPaymentPayload {
  x402Version: 2;
  resource?: Record<string, unknown>;
  accepted: BatchSettlementRequirements;
  payload: BatchSettlementInnerPayload;
}

// ---------------------------------------------------------------------------
// Plain helpers
// ---------------------------------------------------------------------------

function shown(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function chainIdOf(network: unknown): number {
  if (typeof network !== 'string' || !network.startsWith('eip155:')) {
    throw new BatchSettlementError(`batch-settlement signs only eip155 networks, got ${shown(network)}`);
  }
  const reference = network.slice('eip155:'.length);
  const id = /^[0-9]+$/.test(reference) ? Number(reference) : NaN;
  if (!Number.isSafeInteger(id)) {
    throw new BatchSettlementError(`bad network ${shown(network)}`);
  }
  return id;
}

/**
 * A non-negative integer from a bigint, a safe-integer number, a decimal string
 * or a `0x`-hex string - what the Python SDK's `_int` accepts. A boolean, a
 * fraction or a number above 2**53 - 1 is refused, never rounded.
 */
function toInt(value: unknown, what: string): bigint {
  let n: bigint;
  if (typeof value === 'bigint') {
    n = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    n = BigInt(value);
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
    n = BigInt(value.trim());
  } else if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) {
    n = BigInt('0x' + value.slice(2));
  } else {
    throw new BatchSettlementError(`${what} must be an integer, got ${shown(value)}`);
  }
  if (n < 0n) {
    throw new BatchSettlementError(`${what} must not be negative`);
  }
  return n;
}

/** `0x` + 64 lowercase hex, from a hex string (with or without `0x`) or 32 bytes. */
function toBytes32(value: unknown, what: string): string {
  let hex: string;
  if (value instanceof Uint8Array) {
    hex = ethers.hexlify(value).slice(2);
  } else {
    const text = String(value);
    hex = /^0x/i.test(text) ? text.slice(2) : text;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new BatchSettlementError(`${what} must be 32 bytes`);
  }
  return '0x' + hex.toLowerCase();
}

/**
 * The EIP-55 spelling of a 20-byte address. Like the Python SDK's
 * `to_checksum_address`, any case is read (a mixed-case spelling is not
 * required to carry a valid checksum); anything that is not 20 bytes of hex is
 * refused.
 */
function checksum(value: unknown, what: string): string {
  const text = typeof value === 'string' ? value : '';
  const hex = /^0x/i.test(text) ? text.slice(2) : text;
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new BatchSettlementError(`${what} is not an address: ${shown(value)}`);
  }
  return ethers.getAddress('0x' + hex.toLowerCase());
}

/**
 * The immutable channel identity. `channelId = EIP712Hash(ChannelConfig)`.
 *
 * Addresses are kept as given and checksummed when the config is hashed or
 * serialized, as the Python SDK's frozen dataclass does.
 */
export class ChannelConfig {
  readonly payer: string;
  readonly payerAuthorizer: string;
  readonly receiver: string;
  readonly receiverAuthorizer: string;
  readonly token: string;
  readonly withdrawDelay: number;
  readonly salt: string;

  constructor(fields: ChannelConfigFields) {
    this.payer = fields.payer;
    this.payerAuthorizer = fields.payerAuthorizer;
    this.receiver = fields.receiver;
    this.receiverAuthorizer = fields.receiverAuthorizer;
    this.token = fields.token;
    this.withdrawDelay = fields.withdrawDelay;
    this.salt = fields.salt ?? ZERO_BYTES32;
    Object.freeze(this);
  }

  /** The EIP-712 message and the payload's `channelConfig`: one shape for both. */
  toDict(): ChannelConfigJSON {
    return {
      payer: checksum(this.payer, 'payer'),
      payerAuthorizer: checksum(this.payerAuthorizer, 'payerAuthorizer'),
      receiver: checksum(this.receiver, 'receiver'),
      receiverAuthorizer: checksum(this.receiverAuthorizer, 'receiverAuthorizer'),
      token: checksum(this.token, 'token'),
      withdrawDelay: Number(toInt(this.withdrawDelay, 'withdrawDelay')),
      salt: toBytes32(this.salt, 'salt'),
    };
  }

  toJSON(): ChannelConfigJSON {
    return this.toDict();
  }
}

function asChannelConfig(config: ChannelConfig | ChannelConfigFields): ChannelConfig {
  return config instanceof ChannelConfig ? config : new ChannelConfig(config);
}

export function batchSettlementDomain(chainId: number): {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
} {
  return {
    name: BATCH_SETTLEMENT_DOMAIN_NAME,
    version: BATCH_SETTLEMENT_DOMAIN_VERSION,
    chainId,
    verifyingContract: ethers.getAddress(BATCH_SETTLEMENT_ADDRESS),
  };
}

/** The chain-bound channel id (`0x` + 32 bytes, lowercase): keccak(0x1901 || domainSeparator || structHash). */
export function computeChannelId(config: ChannelConfig | ChannelConfigFields, network: string): string {
  const domain = batchSettlementDomain(chainIdOf(network));
  return ethers.TypedDataEncoder.hash(domain, CHANNEL_CONFIG_TYPES, asChannelConfig(config).toDict()).toLowerCase();
}

/** The ERC-3009 nonce the deposit collector expects: `keccak256(abi.encode(bytes32 channelId, uint256 salt))`. */
export function erc3009DepositNonce(channelId: string, salt: string | bigint): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256'],
    [toBytes32(channelId, 'channelId'), toInt(salt, 'salt')]
  );
  return ethers.keccak256(encoded).toLowerCase();
}

function addressOf(wallet: BatchSettlementSigner): string {
  if (typeof wallet.getAddress === 'function') return wallet.getAddress();
  if (typeof wallet.address === 'string') return wallet.address;
  throw new BatchSettlementError('the wallet has neither getAddress() nor address');
}

async function sign(
  wallet: BatchSettlementSigner,
  domain: Record<string, unknown>,
  types: TypedFields,
  primaryType: string,
  message: Record<string, unknown>
): Promise<string> {
  const signed = await wallet.signTypedData(JSON.stringify({ domain, types, primaryType, message }));
  const sig = typeof signed === 'string' ? signed : signed?.signature;
  if (typeof sig !== 'string' || sig === '') {
    throw new BatchSettlementError(`the wallet returned no signature for ${primaryType}`);
  }
  return sig.startsWith('0x') ? sig : '0x' + sig;
}

/** Sign a cumulative `Voucher`: the seller may claim up to `maxClaimableAmount` from the channel. */
export async function signVoucher(
  wallet: BatchSettlementSigner,
  channelId: string,
  maxClaimableAmount: bigint | number | string,
  network: string
): Promise<SignedVoucher> {
  const message = {
    channelId: toBytes32(channelId, 'channelId'),
    maxClaimableAmount: toInt(maxClaimableAmount, 'maxClaimableAmount').toString(),
  };
  const signature = await sign(wallet, batchSettlementDomain(chainIdOf(network)), VOUCHER_TYPES, 'Voucher', message);
  return {
    channelId: message.channelId,
    maxClaimableAmount: message.maxClaimableAmount,
    signature,
  };
}

export interface BuildDepositOptions {
  /** Signs the voucher instead of `wallet`; its address must be the config's `payerAuthorizer`. */
  voucherWallet?: BatchSettlementSigner;
  /** The deposit's ERC-3009 salt (32-byte hex). Random when omitted. */
  depositSalt?: string;
  /** Unix seconds; `validBefore = now + maxTimeoutSeconds`. The clock when omitted. */
  now?: number;
  /**
   * `(address, network) -> target | true | false | null`: pass it when the payer
   * may be an EIP-7702 delegated account (a Paybox wallet), so the deposit
   * authorization is wrapped for ERC-1271 when needed. See
   * {@link signDepositAuthorization}.
   */
  delegationResolver?: DelegationResolver;
}

/**
 * Sign the ERC-3009 `ReceiveWithAuthorization`, wrapping it for a delegated (EIP-7702) payer.
 *
 * The token contract verifies this signature against the PAYER. A payer whose
 * EOA carries EIP-7702 code (every Paybox wallet after its first money
 * operation) is checked through ERC-1271, so a raw ECDSA signature from it is
 * unsettleable. With a `delegationResolver` the signature goes through the same
 * wrap the SDK already uses for the escrow authorization ({@link replaySafeTypedData}
 * + {@link wrapSignature}, `src/erc7702.ts`), and only for the delegate targets
 * that need it: `true` with an unknown target, or a target in `SMA_WRAP_TARGETS`.
 * `false` or any other target signs plain. `null` or a throwing resolver (the
 * chain could not be read) is NOT "plain": it throws. Without a resolver the
 * payer is taken as a plain EOA; a caller whose wallet may be delegated must
 * pass one. Vouchers never need the wrap (the channel's `payerAuthorizer` is
 * verified by ECDSA).
 */
async function signDepositAuthorization(
  wallet: BatchSettlementSigner,
  domain: Record<string, unknown>,
  message: Record<string, unknown>,
  network: string,
  payer: string,
  delegationResolver: DelegationResolver | undefined
): Promise<string> {
  if (!delegationResolver) {
    return sign(wallet, domain, RECEIVE_AUTHORIZATION_TYPES, 'ReceiveWithAuthorization', message);
  }
  const { delegated, target } = await resolveDelegation(payer, network, delegationResolver);
  if (delegated === null) {
    throw new BatchSettlementError(
      'cannot tell whether the payer is EIP-7702 delegated (the chain could not be read): ' +
        'refusing to sign a deposit authorization that may be unsettleable'
    );
  }
  if (delegated && (target === null || needsAccountWrap(target))) {
    const digest = ethers.TypedDataEncoder.hash(domain, RECEIVE_AUTHORIZATION_TYPES, message);
    const replaySafe = replaySafeTypedData(digest, chainIdOf(network), checksum(payer, 'payer'));
    const inner = await sign(
      wallet,
      replaySafe.domain,
      replaySafe.types as TypedFields,
      'ReplaySafeHash',
      replaySafe.message
    );
    return wrapSignature(inner);
  }
  return sign(wallet, domain, RECEIVE_AUTHORIZATION_TYPES, 'ReceiveWithAuthorization', message);
}

/** The inner `payload` of a `deposit`: an ERC-3009 authorization to the collector plus the first voucher. */
export async function buildDepositPayload(
  wallet: BatchSettlementSigner,
  requirements: BatchSettlementRequirements,
  config: ChannelConfig | ChannelConfigFields,
  depositAmount: bigint | number | string,
  maxClaimableAmount: bigint | number | string,
  options: BuildDepositOptions = {}
): Promise<DepositPayload> {
  const channelConfig = asChannelConfig(config);
  const extra = isRecord(requirements.extra) ? requirements.extra : {};
  const { name, version } = extra;
  if (!name || !version) {
    throw new BatchSettlementError("requirements.extra needs the token's EIP-712 name and version");
  }
  const network = String(requirements.network);
  const channelId = computeChannelId(channelConfig, network);
  const salt = options.depositSalt || ethers.hexlify(ethers.randomBytes(32));
  const now = options.now !== undefined ? options.now : Date.now() / 1000;
  const timeout = requirements.maxTimeoutSeconds === undefined ? 3600 : requirements.maxTimeoutSeconds;
  const validBefore = BigInt(Math.trunc(now)) + toInt(timeout, 'maxTimeoutSeconds');
  const domain = {
    name,
    version,
    chainId: chainIdOf(network),
    verifyingContract: checksum(requirements.asset, 'asset'),
  };
  const value = toInt(depositAmount, 'depositAmount');
  const message = {
    from: checksum(channelConfig.payer, 'payer'),
    to: ethers.getAddress(ERC3009_DEPOSIT_COLLECTOR_ADDRESS),
    value: value.toString(),
    validAfter: '0',
    validBefore: validBefore.toString(),
    nonce: toBytes32(erc3009DepositNonce(channelId, salt), 'nonce'),
  };
  const authSignature = await signDepositAuthorization(
    wallet,
    domain,
    message,
    network,
    channelConfig.payer,
    options.delegationResolver
  );
  const voucher = await signVoucher(options.voucherWallet ?? wallet, channelId, maxClaimableAmount, network);
  return {
    type: 'deposit',
    channelConfig: channelConfig.toDict(),
    voucher,
    deposit: {
      amount: value.toString(),
      authorization: {
        erc3009Authorization: {
          validAfter: '0',
          validBefore: validBefore.toString(),
          salt,
          signature: authSignature,
        },
      },
    },
  };
}

/** The inner `payload` of a `voucher`: the next cumulative voucher on an open channel. */
export async function buildVoucherPayload(
  wallet: BatchSettlementSigner,
  config: ChannelConfig | ChannelConfigFields,
  network: string,
  maxClaimableAmount: bigint | number | string
): Promise<VoucherPayload> {
  const channelConfig = asChannelConfig(config);
  const channelId = computeChannelId(channelConfig, network);
  return {
    type: 'voucher',
    channelConfig: channelConfig.toDict(),
    voucher: await signVoucher(wallet, channelId, maxClaimableAmount, network),
  };
}

/** The x402 v2 `PaymentPayload` envelope around an inner deposit/voucher payload. */
export function paymentPayload(
  requirements: BatchSettlementRequirements,
  inner: BatchSettlementInnerPayload,
  resource?: Record<string, unknown>
): BatchSettlementPaymentPayload {
  const out: Partial<BatchSettlementPaymentPayload> = { x402Version: 2 };
  if (resource !== undefined && resource !== null) {
    out.resource = { ...resource };
  }
  out.accepted = { ...requirements };
  out.payload = { ...inner };
  return out as BatchSettlementPaymentPayload;
}

/**
 * The base64 value for the `PAYMENT-SIGNATURE` request header.
 *
 * Byte for byte the Python SDK's `payment_header`: compact JSON with every
 * character above `~` written as a JSON escape (Python's `json.dumps` with
 * `ensure_ascii`), so a token named `USD₮0` gives the same header in both SDKs.
 * The decoded JSON is the same value either way.
 */
export function paymentHeader(payload: BatchSettlementPaymentPayload): string {
  const json = JSON.stringify(payload);
  let ascii = '';
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    ascii += code > 0x7e ? '\\u' + code.toString(16).padStart(4, '0') : json[i];
  }
  return encodeBase64Utf8(ascii);
}

// ---------------------------------------------------------------------------
// Channel state storage
// ---------------------------------------------------------------------------

/** What the buyer keeps per channel: decimal strings, `balance` and `chargedCumulativeAmount`. */
export type ChannelState = Record<string, string>;

/**
 * Where the buyer keeps its channels. A Fargate task dies between beats: persist
 * somewhere that lives on. Both methods may return a promise (an S3 or database
 * store); the client awaits them.
 */
export interface ChannelStorage {
  get(channelId: string): ChannelState | null | undefined | Promise<ChannelState | null | undefined>;
  set(channelId: string, state: ChannelState): void | Promise<void>;
}

export class MemoryChannelStorage implements ChannelStorage {
  private readonly data = new Map<string, ChannelState>();

  get(channelId: string): ChannelState | undefined {
    const v = this.data.get(channelId.toLowerCase());
    return v && Object.keys(v).length > 0 ? { ...v } : undefined;
  }

  set(channelId: string, state: ChannelState): void {
    this.data.set(channelId.toLowerCase(), { ...state });
  }
}

/**
 * One JSON file for all channels, replaced atomically: written to a temporary
 * file beside it and renamed over it (a half-written file would lose the
 * cumulative). Node only; `node:fs` is loaded on its first use, not when this
 * module is imported, so {@link MemoryChannelStorage} works without it.
 */
export class FileChannelStorage implements ChannelStorage {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private async read(): Promise<Record<string, ChannelState>> {
    const fs = await import('node:fs/promises');
    try {
      return JSON.parse(await fs.readFile(this.path, 'utf8')) as Record<string, ChannelState>;
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'ENOENT') return {};
      throw err;
    }
  }

  async get(channelId: string): Promise<ChannelState | undefined> {
    return (await this.read())[channelId.toLowerCase()] ?? undefined;
  }

  async set(channelId: string, state: ChannelState): Promise<void> {
    const data = await this.read();
    data[channelId.toLowerCase()] = { ...state };
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const dir = nodePath.dirname(this.path);
    await fs.mkdir(dir, { recursive: true });
    const tmp = nodePath.join(dir, `${nodePath.basename(this.path)}.${ethers.hexlify(ethers.randomBytes(8)).slice(2)}`);
    await fs.writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(tmp, this.path);
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** What {@link BatchSettlementClient.createPayment} returns: the payload, and what to confirm afterwards. */
export class PreparedPayment {
  readonly payload: BatchSettlementPaymentPayload;
  readonly channelId: string;
  readonly requestAmount: bigint;
  readonly depositAmount: bigint | undefined;

  constructor(fields: {
    payload: BatchSettlementPaymentPayload;
    channelId: string;
    requestAmount: bigint;
    depositAmount?: bigint;
  }) {
    this.payload = fields.payload;
    this.channelId = fields.channelId;
    this.requestAmount = fields.requestAmount;
    this.depositAmount = fields.depositAmount;
  }

  header(): string {
    return paymentHeader(this.payload);
  }
}

export interface BatchSettlementClientOptions {
  /** Default: a {@link MemoryChannelStorage}, which dies with the process. */
  storage?: ChannelStorage;
  /** The channel config's `salt`. Default {@link ZERO_BYTES32}. */
  salt?: string;
  /** A second key that signs vouchers; its address becomes the channel's `payerAuthorizer`. */
  voucherWallet?: BatchSettlementSigner;
  /** Ceiling for one deposit, in atomic units. Default {@link DEFAULT_MAX_DEPOSIT}. */
  maxDeposit?: bigint | number | string;
  /** Deposit target in requests when the seller announces no `minDeposit`. Default {@link DEFAULT_DEPOSIT_MULTIPLIER}. */
  depositMultiplier?: bigint | number | string;
  /**
   * `(address, network) -> target | true | false | null`: pass it when the payer
   * may be an EIP-7702 delegated account (a Paybox wallet), so the deposit
   * authorization is wrapped for ERC-1271 when needed. Vouchers are never wrapped.
   */
  delegationResolver?: DelegationResolver;
}

/** The response fields {@link BatchSettlementClient.confirm} reads: the settle response's `extra`. */
export interface BatchSettlementResponseExtra {
  chargedAmount?: unknown;
  channelState?: unknown;
  [key: string]: unknown;
}

/**
 * Signs `batch-settlement` payments for one wallet and keeps its channels' state.
 *
 * `wallet` is anything with `getAddress()` (or `address`) and
 * `signTypedData(typedDataJson)`. `voucherWallet` is an optional second key that
 * signs vouchers; its address becomes the channel's `payerAuthorizer` so the
 * seller can verify vouchers without an RPC call.
 */
export class BatchSettlementClient {
  readonly wallet: BatchSettlementSigner;
  readonly storage: ChannelStorage;
  readonly salt: string;
  readonly voucherWallet: BatchSettlementSigner | undefined;
  readonly maxDeposit: bigint;
  readonly depositMultiplier: bigint;
  readonly delegationResolver: DelegationResolver | undefined;

  constructor(wallet: BatchSettlementSigner, options: BatchSettlementClientOptions = {}) {
    this.wallet = wallet;
    this.storage = options.storage ?? new MemoryChannelStorage();
    this.salt = options.salt ?? ZERO_BYTES32;
    this.voucherWallet = options.voucherWallet;
    this.maxDeposit = toInt(options.maxDeposit ?? DEFAULT_MAX_DEPOSIT, 'maxDeposit');
    this.depositMultiplier = toInt(options.depositMultiplier ?? DEFAULT_DEPOSIT_MULTIPLIER, 'depositMultiplier');
    this.delegationResolver = options.delegationResolver;
  }

  channelConfig(requirements: BatchSettlementRequirements): ChannelConfig {
    const extra = isRecord(requirements.extra) ? requirements.extra : {};
    const authorizer = extra.receiverAuthorizer;
    if (!authorizer || checksum(authorizer, 'receiverAuthorizer') === checksum(ZERO_ADDRESS, 'zero')) {
      throw new BatchSettlementError('requirements.extra.receiverAuthorizer must be a non-zero address');
    }
    let delay = extra.withdrawDelay;
    if (typeof delay !== 'number' || !Number.isInteger(delay)) {
      delay = MIN_WITHDRAW_DELAY;
    }
    const withdrawDelay = delay as number;
    if (!(MIN_WITHDRAW_DELAY <= withdrawDelay && withdrawDelay <= MAX_WITHDRAW_DELAY)) {
      throw new BatchSettlementError(
        `withdrawDelay ${withdrawDelay} is outside ${MIN_WITHDRAW_DELAY}..${MAX_WITHDRAW_DELAY}`
      );
    }
    const payer = addressOf(this.wallet);
    const authorizerOfVouchers = this.voucherWallet !== undefined ? addressOf(this.voucherWallet) : payer;
    return new ChannelConfig({
      payer,
      payerAuthorizer: authorizerOfVouchers,
      receiver: requirements.payTo,
      receiverAuthorizer: authorizer as string,
      token: requirements.asset,
      withdrawDelay,
      salt: this.salt,
    });
  }

  private depositAmountFor(requirements: BatchSettlementRequirements, needed: bigint, requestAmount: bigint): bigint {
    const extra = isRecord(requirements.extra) ? requirements.extra : {};
    const announced = extra.minDeposit;
    let target: bigint | undefined;
    if (announced !== undefined && announced !== null) {
      try {
        target = toInt(announced, 'minDeposit');
      } catch (err) {
        if (!(err instanceof BatchSettlementError)) throw err;
        target = undefined;
      }
      if (target !== undefined && target < requestAmount) {
        target = undefined; // the spec: a conforming minDeposit is >= amount; otherwise ignore it
      }
    }
    if (target === undefined) {
      target = this.depositMultiplier * requestAmount;
    }
    let amount = needed > target ? needed : target;
    if (amount > this.maxDeposit) {
      if (needed > this.maxDeposit) {
        throw new BatchSettlementError(
          `the next voucher needs a deposit of ${needed}, above maxDeposit ${this.maxDeposit}`
        );
      }
      amount = this.maxDeposit;
    }
    return amount;
  }

  /** Sign a deposit (first request or top-up) or a voucher for one paid request. */
  async createPayment(
    requirements: BatchSettlementRequirements,
    resource?: Record<string, unknown>,
    options: { now?: number } = {}
  ): Promise<PreparedPayment> {
    if (requirements.scheme !== SCHEME) {
      throw new BatchSettlementError(`not a batch-settlement offer: ${shown(requirements.scheme)}`);
    }
    const network = String(requirements.network);
    chainIdOf(network);
    const extra = isRecord(requirements.extra) ? requirements.extra : {};
    const method = extra.assetTransferMethod || 'eip3009';
    if (method !== 'eip3009') {
      throw new BatchSettlementError(`assetTransferMethod ${shown(method)} is not supported (only eip3009)`);
    }
    const config = this.channelConfig(requirements);
    const channelId = computeChannelId(config, network);
    const state = (await this.storage.get(channelId)) || {};
    const balance = BigInt(state.balance || 0);
    const charged = BigInt(state.chargedCumulativeAmount || 0);
    const requestAmount = toInt(requirements.amount, 'amount');
    const maxClaimable = charged + requestAmount;
    let deposit: bigint | undefined;
    let inner: BatchSettlementInnerPayload;
    if (balance === 0n || maxClaimable > balance) {
      deposit = this.depositAmountFor(requirements, maxClaimable - balance, requestAmount);
      inner = await buildDepositPayload(this.wallet, requirements, config, deposit, maxClaimable, {
        voucherWallet: this.voucherWallet,
        now: options.now,
        delegationResolver: this.delegationResolver,
      });
    } else {
      inner = await buildVoucherPayload(this.voucherWallet ?? this.wallet, config, network, maxClaimable);
    }
    return new PreparedPayment({
      payload: paymentPayload(requirements, inner, resource),
      channelId,
      requestAmount,
      depositAmount: deposit,
    });
  }

  /**
   * Record a SUCCESSFUL paid response. The new cumulative is the previous one plus `chargedAmount`.
   *
   * The seller's `extra.channelState` is untrusted and never copied: it is only
   * compared with the number the buyer computed itself, and a mismatch leaves the
   * local state untouched (the next request would then get a corrective 402).
   * Resolves to whether the state was written.
   */
  async confirm(prepared: PreparedPayment, responseExtra?: BatchSettlementResponseExtra | null): Promise<boolean> {
    const extra: BatchSettlementResponseExtra = responseExtra ?? {};
    const raw = extra.chargedAmount === undefined ? '0' : extra.chargedAmount;
    let charged: bigint;
    try {
      charged = toInt(raw, 'chargedAmount');
    } catch (err) {
      if (err instanceof BatchSettlementError) return false;
      throw err;
    }
    if (charged > prepared.requestAmount) {
      return false;
    }
    const state = (await this.storage.get(prepared.channelId)) || {};
    const previous = BigInt(state.chargedCumulativeAmount || 0);
    const next = previous + charged;
    const channelState = isRecord(extra.channelState) ? extra.channelState : {};
    const seller = channelState.chargedCumulativeAmount;
    if (seller !== undefined && seller !== null) {
      try {
        if (toInt(seller, 'chargedCumulativeAmount') !== next) return false;
      } catch (err) {
        if (err instanceof BatchSettlementError) return false;
        throw err;
      }
    }
    if (previous === 0n && charged === 0n && prepared.depositAmount === undefined) {
      return false;
    }
    const updated: ChannelState = { ...state };
    updated.chargedCumulativeAmount = next.toString();
    if (prepared.depositAmount !== undefined) {
      updated.balance = (BigInt(state.balance || 0) + prepared.depositAmount).toString();
    }
    await this.storage.set(prepared.channelId, updated);
    return true;
  }
}
