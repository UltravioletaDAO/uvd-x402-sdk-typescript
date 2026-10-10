/**
 * uvd-x402-sdk - OWSWalletAdapter
 *
 * SigningWalletAdapter over an Open Wallet Standard (OWS) vault. OWS keeps the
 * keys encrypted in a local vault and signs inside it; the key never reaches
 * this process.
 *
 * Written against `@open-wallet-standard/core` 1.4.2 (an optional peer
 * dependency: a native Node module, prebuilt for Linux glibc and macOS on x64
 * and arm64). Measured on 1.4.2, not taken from its docs:
 *
 * - Its functions take the wallet by name or id, the chain as CAIP-2
 *   (`eip155:8453`), then the passphrase and the vault path, all positional.
 *   They return `{ signature, recoveryId }`, the signature as hex without
 *   `0x`: `r || s || v`, with v = 27/28 for messages and typed data and 0/1
 *   for transactions.
 * - `signTypedData` takes the EIP-712 document as a JSON string and refuses
 *   one without `EIP712Domain` in `types` or without `primaryType`. It hashes
 *   `EIP712Domain` in the order it is given.
 * - Integers: a decimal string above 2**128 - 1 is refused ("use hex
 *   encoding"), so is odd-length hex, and a JSON number above 2**64. Out of
 *   range it signs ANOTHER value without a word: `2**256` as a uint256 is
 *   signed as 0, `256` as a uint8 as 0, `-129` as an int8. It also accepts
 *   an address with a bad checksum and bytes without `0x`, where ethers
 *   refuses both.
 * - `signTransaction` signs keccak256 of whatever bytes it is given and
 *   returns only the signature: the signed transaction is assembled here.
 * - A wrong passphrase is `decryption failed: aead::Error`; no error seen
 *   carries the passphrase.
 *
 * So this adapter normalises typed data by the DECLARED EIP-712 type and
 * refuses what ethers refuses before anything is signed, and after signing it
 * recovers every signature with ethers over the digest `EnvKeyAdapter` signs:
 * a signature that does not recover to `getAddress()` is not returned.
 *
 * @example
 * ```ts
 * import * as ows from '@open-wallet-standard/core';
 * import { OWSWalletAdapter } from 'uvd-x402-sdk';
 *
 * const wallet = new OWSWalletAdapter(ows, {
 *   wallet: 'agent-treasury', // name or id in the vault
 *   passphrase: process.env.OWS_PASSPHRASE,
 *   network: 'base',
 * });
 * const auth = await wallet.signEIP3009({
 *   to: '0xRecipient',
 *   amountUsdc: 0.50,
 *   network: 'base',
 * });
 * ```
 */

import { ethers } from 'ethers';
import { getChainByName } from '../chains';
import { X402Error } from '../types';
import { inexactNumberMessage } from '../utils/uint';
import type {
  SigningWalletAdapter,
  EIP3009Params,
  EIP3009Authorization,
} from '../wallet';

// ============================================================================
// THE LIBRARY, AS 1.4.2 DECLARES IT
// ============================================================================

/** What a signing call of `@open-wallet-standard/core` returns. */
export interface OWSSignResult {
  /** Hex WITHOUT `0x`. On EVM, 65 bytes: `r || s || v`. */
  signature: string;
  /** The recovery byte again: 27/28 for messages and typed data, 0/1 for transactions. */
  recoveryId?: number;
}

/** One account of an OWS wallet (one per chain family). */
export interface OWSAccountInfo {
  /** CAIP-2 chain id; the EVM account is `eip155:1`. */
  chainId: string;
  address: string;
  derivationPath: string;
}

/**
 * The functions of `@open-wallet-standard/core` this adapter calls, with the
 * parameters its 1.4.2 `index.d.ts` declares (the same since 1.0.0). Pass the
 * module itself: `import * as ows from '@open-wallet-standard/core'`.
 *
 * Written by hand so that the SDK's types do not need the package installed;
 * `src/adapters/ows.test.ts` compares it with the installed declarations.
 */
export interface OWSCore {
  getWallet(
    nameOrId: string,
    vaultPathOpt?: string | null
  ): { id: string; name: string; accounts: OWSAccountInfo[]; createdAt: string };
  signMessage(
    wallet: string,
    chain: string,
    message: string,
    passphrase?: string | null,
    encoding?: string | null,
    index?: number | null,
    vaultPathOpt?: string | null
  ): OWSSignResult;
  signTypedData(
    wallet: string,
    chain: string,
    typedDataJson: string,
    passphrase?: string | null,
    index?: number | null,
    vaultPathOpt?: string | null
  ): OWSSignResult;
  signTransaction(
    wallet: string,
    chain: string,
    txHex: string,
    passphrase?: string | null,
    index?: number | null,
    vaultPathOpt?: string | null
  ): OWSSignResult;
}

const OWS_FUNCTIONS = ['getWallet', 'signMessage', 'signTypedData', 'signTransaction'] as const;

/**
 * The wallet object the adapter took before it was written against
 * `@open-wallet-standard/core` 1.4.2.
 *
 * @deprecated This shape is not the `@open-wallet-standard/core` API and
 * never worked with OWS 1.x. It is still exported so that code importing it
 * compiles, but `new OWSWalletAdapter(wallet)` with it throws `INVALID_CONFIG`.
 * Migrate to {@link OWSCore}: pass the module and the wallet,
 * `new OWSWalletAdapter(ows, { wallet: '<name or id>', passphrase })` with
 * `import * as ows from '@open-wallet-standard/core'`.
 */
export interface OWSWallet {
  accounts: ReadonlyArray<{
    address: string;
    chains?: ReadonlyArray<string>;
  }>;
  signMessage(params: {
    account: { address: string };
    message: string | Uint8Array;
  }): Promise<{ signature: string }>;
  signTypedData(params: {
    account: { address: string };
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<{ signature: string }>;
  signTransaction(params: {
    account: { address: string };
    transaction: string;
    chainId: string;
  }): Promise<{ signedTransaction: string }>;
}

const MIGRATION =
  "pass the module and the wallet: new OWSWalletAdapter(ows, { wallet: '<name or id>', passphrase }) " +
  "with import * as ows from '@open-wallet-standard/core'";

/** Options of {@link OWSWalletAdapter}. */
export interface OWSWalletAdapterOptions {
  /** Name or id of the wallet in the OWS vault. */
  wallet: string;
  /**
   * Vault passphrase, or an OWS API key. Default: `process.env.OWS_PASSPHRASE`.
   * An explicit value, `''` included, wins over the environment.
   */
  passphrase?: string;
  /**
   * EVM network to sign for when the payload names no chain: an SDK name
   * (`'base'`) or CAIP-2 (`'eip155:8453'`). Default `'base'`. Typed data with
   * a `domain.chainId` and transactions with a `chainId` are signed on their
   * own chain. The chain is what an OWS policy decides on; it does not change
   * the bytes signed.
   */
  network?: string;
  /**
   * Vault directory. Default: the OWS default (`~/.ows`). OWS CREATES a
   * directory that does not exist, so a typo here gives an empty vault and
   * "wallet not found", not a missing-directory error.
   */
  vaultPath?: string;
}

// ============================================================================
// TYPED DATA, AS OWS READS IT
// ============================================================================

type TypedField = { name: string; type: string };
type TypedTypes = Record<string, TypedField[]>;

/**
 * The EIP-712 domain fields in the order ethers derives `EIP712Domain` in.
 * OWS hashes the order it is given, so it gets this one.
 */
const EIP712_DOMAIN_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32'],
];

/** What ethers' `Transaction.from` reads from an object (6.16), `from` and `hash` aside. */
const TRANSACTION_FIELDS = [
  'type',
  'to',
  'nonce',
  'gasLimit',
  'gasPrice',
  'maxPriorityFeePerGas',
  'maxFeePerGas',
  'maxFeePerBlobGas',
  'data',
  'value',
  'chainId',
  'signature',
  'accessList',
  'authorizationList',
  'blobVersionedHashes',
  'kzg',
  'blobWrapperVersion',
  'blobs',
] as const;

/** Keys of other transaction formats, and the ethers name of the same field. */
const ETHERS_NAME_OF: Readonly<Record<string, string>> = { input: 'data', gas: 'gasLimit' };

const TWO_127 = 1n << 127n;
const TWO_128 = 1n << 128n;
const TWO_256 = 1n << 256n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shown(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function refuse(message: string): X402Error {
  return new X402Error(`${message}; nothing was signed`, 'INVALID_CONFIG');
}

/**
 * An integer given as a bigint, a safe-integer number, a decimal string or a
 * 0x-hex string, with an optional leading `-`: what ethers accepts for an
 * EIP-712 integer, minus whitespace and floats.
 */
function toInteger(value: unknown, where: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  // An integer past 2**53 - 1 is a value JSON.parse already rounded.
  if (typeof value === 'number' && Number.isInteger(value)) throw refuse(inexactNumberMessage(where, value));
  if (typeof value === 'string' && /^-?(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(value)) {
    return value.startsWith('-') ? -BigInt(value.slice(1)) : BigInt(value);
  }
  throw refuse(
    `${where}: ${shown(value)} is not an integer (a safe-integer number, a decimal string or 0x-hex)`
  );
}

/**
 * An integer the way OWS 1.4.2 reads it: decimal from -2**127 to 2**128 - 1,
 * even-length hex above, and 256-bit two's complement below (only a type
 * wider than 128 bits gets there).
 */
function integerWire(n: bigint): string {
  if (n >= -TWO_127 && n < TWO_128) return n.toString();
  if (n > 0n) {
    const digits = n.toString(16);
    return `0x${digits.length % 2 ? '0' : ''}${digits}`;
  }
  return `0x${(n + TWO_256).toString(16).padStart(64, '0')}`;
}

/**
 * `value` of the EIP-712 type `kind` in the form OWS reads from JSON.
 *
 * Normalised by the DECLARED type, not by the JavaScript type of the value:
 * a uint256 comes as a number, a decimal string or 0x-hex (the lifecycle
 * order sends its `salt` as a decimal string above 2**128). Every integer is
 * checked against the range of its type here, before anything is signed.
 * Fields not in the type are left out; they are not part of the digest.
 */
function owsValue(kind: string, value: unknown, types: TypedTypes, where: string): unknown {
  const array = /^(.*)\[(\d*)\]$/.exec(kind);
  if (array) {
    const [, inner, size] = array;
    if (!Array.isArray(value)) throw refuse(`${where}: ${kind} needs an array, got ${shown(value)}`);
    if (size !== '' && value.length !== Number(size)) {
      throw refuse(`${where}: ${kind} needs ${size} items, got ${value.length}`);
    }
    return value.map((item, i) => owsValue(inner, item, types, `${where}[${i}]`));
  }

  const struct = types[kind];
  if (struct) {
    if (!isRecord(value)) throw refuse(`${where}: ${kind} needs an object, got ${shown(value)}`);
    const out: Record<string, unknown> = {};
    for (const field of struct) {
      if (value[field.name] === undefined) throw refuse(`${where}: ${kind} lacks ${field.name}`);
      out[field.name] = owsValue(field.type, value[field.name], types, `${where}.${field.name}`);
    }
    return out;
  }

  const integer = /^(u?)int(\d+)$/.exec(kind);
  if (integer) {
    const bits = BigInt(integer[2]);
    const n = toInteger(value, where);
    const [low, high] = integer[1] ? [0n, 1n << bits] : [-(1n << (bits - 1n)), 1n << (bits - 1n)];
    if (n < low || n >= high) {
      throw new X402Error(
        `${where}: ${shown(value)} is out of range for ${kind}; nothing was signed`,
        'INVALID_AMOUNT'
      );
    }
    return integerWire(n);
  }

  if (kind === 'bool') {
    if (typeof value !== 'boolean') throw refuse(`${where}: bool needs true or false, got ${shown(value)}`);
    return value;
  }
  if (kind === 'string') {
    if (typeof value !== 'string') throw refuse(`${where}: string needs a string, got ${shown(value)}`);
    return value;
  }
  if (kind === 'address') {
    try {
      if (typeof value !== 'string') throw new Error();
      return ethers.getAddress(value);
    } catch {
      throw refuse(`${where}: ${shown(value)} is not an address`);
    }
  }

  const bytes = /^bytes(\d*)$/.exec(kind);
  if (bytes) {
    let raw: Uint8Array;
    try {
      if (typeof value !== 'string') throw new Error();
      raw = ethers.getBytes(value);
    } catch {
      throw refuse(`${where}: ${kind} needs 0x-hex, got ${shown(value)}`);
    }
    if (bytes[1] !== '' && raw.length !== Number(bytes[1])) {
      throw refuse(`${where}: ${kind} needs ${bytes[1]} bytes, got ${raw.length}`);
    }
    return ethers.hexlify(raw);
  }

  throw refuse(`${where}: unsupported EIP-712 type ${kind}`);
}

interface PreparedTypedData {
  /** What OWS signs, as JSON. */
  document: string;
  /** The caller's domain, types (without EIP712Domain) and message: what ethers hashes. */
  domain: ethers.TypedDataDomain;
  types: TypedTypes;
  message: Record<string, unknown>;
  /** CAIP-2 chain of `domain.chainId`, if it names one. */
  chain: string | null;
}

/**
 * The typed data as the JSON document `signTypedData` of OWS takes.
 *
 * `EIP712Domain` is always derived from the domain's keys, in ethers' order,
 * and one the caller sent is ignored, as `EnvKeyAdapter` ignores it. The
 * root struct is the one ethers picks; a `primaryType` naming another is
 * refused (ethers would sign the root). Domain and message are normalised by
 * their declared types.
 */
function prepareTypedData(input: unknown): PreparedTypedData {
  if (!isRecord(input)) throw refuse('typed data must be an object with domain, types and message');
  const { domain, types, message, primaryType } = input;
  if (!isRecord(domain)) throw refuse('typed data needs a domain object');
  if (!isRecord(types)) throw refuse('typed data needs a types object');
  if (!isRecord(message)) throw refuse('typed data needs a message object');

  const structs = { ...(types as TypedTypes) };
  delete structs['EIP712Domain'];
  let root: string;
  try {
    root = ethers.TypedDataEncoder.from(structs).primaryType;
  } catch (error) {
    throw refuse(`typed data types are invalid (${error instanceof Error ? error.message : error})`);
  }
  if (primaryType !== undefined && primaryType !== root) {
    throw refuse(
      `primaryType ${shown(primaryType)} is not ${root}, the root struct ethers signs for these types`
    );
  }

  for (const key of Object.keys(domain)) {
    if (!EIP712_DOMAIN_FIELDS.some(([name]) => name === key)) {
      throw refuse(`domain.${key} is not an EIP-712 domain field`);
    }
  }
  // ethers leaves a null domain field out of EIP712Domain; so does this.
  const all: TypedTypes = {
    EIP712Domain: EIP712_DOMAIN_FIELDS.filter(([name]) => domain[name] != null).map(
      ([name, type]) => ({ name, type })
    ),
    ...structs,
  };
  const owsDomain = owsValue('EIP712Domain', domain, all, 'domain') as Record<string, unknown>;
  const owsMessage = owsValue(root, message, all, 'message');

  const chainId = domain['chainId'] != null ? toInteger(domain['chainId'], 'domain.chainId') : 0n;
  return {
    document: JSON.stringify({ types: all, primaryType: root, domain: owsDomain, message: owsMessage }),
    domain: domain as ethers.TypedDataDomain,
    types: structs,
    message,
    chain: chainId > 0n ? `eip155:${chainId}` : null,
  };
}

/** The 65-byte signature of an OWS result, v as 27/28. */
function evmSignature(result: OWSSignResult, what: string): ethers.Signature {
  const hex = String(result?.signature ?? '').replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) {
    throw new X402Error(`OWS ${what} returned a signature that is not 65 bytes of hex`, 'PAYMENT_FAILED');
  }
  const bytes = ethers.getBytes(`0x${hex}`);
  const v = bytes[64] < 27 ? bytes[64] + 27 : bytes[64];
  if (v !== 27 && v !== 28) {
    throw new X402Error(`OWS ${what} returned a recovery byte of ${bytes[64]}`, 'PAYMENT_FAILED');
  }
  return ethers.Signature.from({
    r: ethers.hexlify(bytes.subarray(0, 32)),
    s: ethers.hexlify(bytes.subarray(32, 64)),
    v,
  });
}

/** `eip155:<id>` of an SDK EVM network name or a CAIP-2 `eip155:` id. */
function caip2(network: string): string {
  if (typeof network !== 'string') {
    throw new X402Error(
      `OWSWalletAdapter: options.network must be a string (an SDK network name or eip155:<id>), got ${typeof network}`,
      'INVALID_CONFIG'
    );
  }
  const caip = /^eip155:([1-9][0-9]*)$/.exec(network);
  if (caip) return network;
  const chain = getChainByName(network);
  if (!chain || chain.networkType !== 'evm') {
    throw new X402Error(
      `OWSWalletAdapter signs for an EVM network; got ${shown(network)}`,
      'CHAIN_NOT_SUPPORTED'
    );
  }
  return `eip155:${chain.chainId}`;
}

// ============================================================================
// OWS WALLET ADAPTER
// ============================================================================

/**
 * OWSWalletAdapter -- SigningWalletAdapter over an Open Wallet Standard vault.
 *
 * Every method signs the bytes `EnvKeyAdapter` signs for the same key (the
 * tests import an ephemeral key into a temporary vault and compare), or
 * throws `X402Error` and returns nothing. Refused before signing: an integer
 * out of the range of its EIP-712 type, and whatever ethers refuses to
 * encode. Refused after signing: a signature that does not recover to
 * `getAddress()` with ethers over the digest `EnvKeyAdapter` signs.
 *
 * The passphrase is held in a private field: `JSON.stringify`, `console.log`
 * and `util.inspect` of the adapter do not show it, and error messages are
 * scrubbed of it. Errors do not carry the library's original error object.
 */
export class OWSWalletAdapter implements SigningWalletAdapter {
  readonly #ows: OWSCore;
  readonly #wallet: string;
  readonly #passphrase: string | null;
  readonly #vaultPath: string | null;
  readonly #chain: string;
  readonly #address: string;

  /**
   * Create an OWSWalletAdapter.
   *
   * @param ows - The `@open-wallet-standard/core` module
   *   (`import * as ows from '@open-wallet-standard/core'`), 1.4.2 or later 1.x.
   * @param options - Which wallet, its passphrase, the default network and the vault.
   * @throws {X402Error} `INVALID_CONFIG` if `ows` is not that module or no
   *   wallet is named, `CHAIN_NOT_SUPPORTED` if `network` is not EVM,
   *   `WALLET_NOT_FOUND` if the vault has no such wallet or it has no EVM account.
   */
  constructor(ows: OWSCore, options: OWSWalletAdapterOptions);
  /**
   * @deprecated The old form, a wallet object with `accounts`
   * ({@link OWSWallet}). It still compiles, but it never worked with OWS 1.x
   * and now throws `INVALID_CONFIG` without signing anything. Pass the module
   * and the wallet: `new OWSWalletAdapter(ows, { wallet, passphrase })`.
   */
  constructor(owsWallet: OWSWallet, accountIndex?: number);
  constructor(ows: OWSCore | OWSWallet, options?: OWSWalletAdapterOptions | number) {
    if (isRecord(ows) && 'accounts' in ows && (options === undefined || typeof options === 'number')) {
      throw new X402Error(
        'OWSWalletAdapter no longer takes a wallet object with accounts (the deprecated OWSWallet ' +
          `shape, which never worked with @open-wallet-standard/core 1.x); ${MIGRATION}. Nothing was signed.`,
        'INVALID_CONFIG'
      );
    }
    const missing = OWS_FUNCTIONS.filter(
      (name) => typeof (ows as unknown as Record<string, unknown> | null)?.[name] !== 'function'
    );
    if (missing.length > 0) {
      throw new X402Error(
        `OWSWalletAdapter takes the @open-wallet-standard/core module ` +
          `(import * as ows from '@open-wallet-standard/core'); it lacks ${missing.join(', ')}. ` +
          'Since the OWS rewrite the adapter no longer takes a wallet object with accounts.',
        'INVALID_CONFIG'
      );
    }
    const opts = (isRecord(options) ? options : {}) as Partial<OWSWalletAdapterOptions>;
    if (typeof opts.wallet !== 'string' || opts.wallet === '') {
      throw new X402Error('OWSWalletAdapter needs options.wallet: the name or id of a wallet in the vault', 'INVALID_CONFIG');
    }

    // The native binding echoes a mistyped argument in its error message, so a
    // passphrase that is not a string is refused here, without showing it.
    if (opts.passphrase != null && typeof opts.passphrase !== 'string') {
      throw new X402Error('OWSWalletAdapter: options.passphrase must be a string', 'INVALID_CONFIG');
    }

    this.#ows = ows as OWSCore;
    this.#wallet = opts.wallet;
    this.#passphrase =
      opts.passphrase ??
      (typeof process !== 'undefined' ? process.env?.OWS_PASSPHRASE : undefined) ??
      null;
    this.#vaultPath = opts.vaultPath ?? null;
    this.#chain = caip2(opts.network ?? 'base');

    const info = this.#call('getWallet', () => this.#ows.getWallet(this.#wallet, this.#vaultPath), 'WALLET_NOT_FOUND');
    const account = (info?.accounts ?? []).find((a) => String(a.chainId).startsWith('eip155:'));
    if (!account) {
      throw new X402Error(`OWS wallet ${shown(this.#wallet)} has no EVM account`, 'WALLET_NOT_FOUND');
    }
    this.#address = ethers.getAddress(account.address);
  }

  /**
   * Get the checksummed EVM wallet address (read from the vault once, when
   * the adapter was created; no passphrase needed).
   */
  getAddress(): string {
    return this.#address;
  }

  /**
   * Sign a message using EIP-191 personal_sign (the string as UTF-8, as
   * `EnvKeyAdapter` signs it).
   *
   * @param message - The message string to sign
   * @returns Hex-encoded 65-byte signature, v = 27/28
   */
  async signMessage(message: string): Promise<string> {
    if (typeof message !== 'string') throw refuse(`signMessage takes a string, got ${typeof message}`);
    const result = this.#call('signMessage', () =>
      this.#ows.signMessage(this.#wallet, this.#chain, message, this.#passphrase, 'utf8', null, this.#vaultPath)
    );
    const signature = evmSignature(result, 'signMessage').serialized;
    let signer = '';
    try {
      signer = ethers.verifyMessage(message, signature);
    } catch {
      // not recoverable: refused below
    }
    this.#checkSigner(signer, 'signMessage');
    return signature;
  }

  /**
   * Sign EIP-712 typed structured data.
   *
   * @param typedData - JSON string with `domain`, `types`, `message` and
   *   optionally `primaryType` (it must then be the root struct)
   * @returns Object with signature and v/r/s components
   * @throws {X402Error} `INVALID_AMOUNT` for an integer out of its type's
   *   range and `INVALID_CONFIG` for anything else ethers would not encode,
   *   both before signing; `PAYMENT_FAILED` if OWS fails or signs a digest
   *   other than the one ethers computes (the signature is not returned).
   */
  async signTypedData(typedData: string): Promise<{
    signature: string;
    v: number;
    r: string;
    s: string;
  }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typedData);
    } catch {
      throw refuse('typedData is not a JSON string');
    }
    return this.#signTyped(parsed);
  }

  /**
   * Sign an EVM transaction.
   *
   * OWS signs keccak256 of the bytes it is given and returns only the
   * signature, so the transaction is parsed and serialised with ethers here,
   * the way `EnvKeyAdapter` (ethers.Wallet) does it, EIP-155 `v` included.
   *
   * A sender, given as `from` or implied by an existing signature, must be
   * this wallet: it is taken out, as ethers takes it out; any other sender is
   * refused before signing.
   *
   * @param unsignedTx - Hex-encoded transaction (ethers serialized), an
   *   `ethers.Transaction`, or a transaction object ethers' `Transaction.from`
   *   accepts, plus `from`
   * @returns Hex-encoded signed raw transaction, ready for broadcast
   */
  async signTransaction(unsignedTx: string | ethers.TransactionLike<string>): Promise<string> {
    const tx = this.#unsignedTransaction(unsignedTx);
    const chain = tx.chainId > 0n ? `eip155:${tx.chainId}` : this.#chain;
    const result = this.#call('signTransaction', () =>
      this.#ows.signTransaction(
        this.#wallet,
        chain,
        tx.unsignedSerialized.slice(2),
        this.#passphrase,
        null,
        this.#vaultPath
      )
    );
    tx.signature = evmSignature(result, 'signTransaction');
    const signed = tx.serialized;
    this.#checkSigner(ethers.Transaction.from(signed).from ?? '', 'signTransaction');
    return signed;
  }

  /**
   * Sign an EIP-3009 TransferWithAuthorization for USDC: the typed data
   * `EnvKeyAdapter.signEIP3009` builds, signed through {@link signTypedData}
   * (OWS has no EIP-3009 call of its own).
   *
   * @param params - EIP-3009 parameters
   * @returns Signed authorization ready for facilitator relay
   */
  async signEIP3009(params: EIP3009Params): Promise<EIP3009Authorization> {
    const chain = getChainByName(params.network);
    if (!chain) {
      throw new X402Error(`Unsupported network: ${params.network}`, 'CHAIN_NOT_SUPPORTED');
    }

    if (chain.networkType !== 'evm') {
      throw new X402Error(
        `EIP-3009 is only supported on EVM chains. ${params.network} is ${chain.networkType}.`,
        'CHAIN_NOT_SUPPORTED',
      );
    }

    const chainId = params.chainId ?? chain.chainId;
    const usdcAddress = params.usdcContract ?? chain.usdc.address;
    const from = this.#address;
    const to = ethers.getAddress(params.to);
    const value = ethers.parseUnits(params.amountUsdc.toString(), chain.usdc.decimals);
    const validAfter = params.validAfter ?? 0;
    const validBefore = params.validBefore ?? Math.floor(Date.now() / 1000) + 300;

    // Generate random 32-byte nonce
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    const signed = await this.#signTyped({
      domain: {
        name: chain.usdc.name,
        version: chain.usdc.version,
        chainId,
        verifyingContract: usdcAddress,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: { from, to, value, validAfter, validBefore, nonce },
    });

    return {
      from,
      to,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
      v: signed.v,
      r: signed.r,
      s: signed.s,
      signature: signed.signature,
    };
  }

  // --------------------------------------------------------------------------

  async #signTyped(input: unknown): Promise<{ signature: string; v: number; r: string; s: string }> {
    const typed = prepareTypedData(input);
    const result = this.#call('signTypedData', () =>
      this.#ows.signTypedData(
        this.#wallet,
        typed.chain ?? this.#chain,
        typed.document,
        this.#passphrase,
        null,
        this.#vaultPath
      )
    );
    const sig = evmSignature(result, 'signTypedData');
    let signer: string;
    try {
      signer = ethers.verifyTypedData(typed.domain, typed.types, typed.message, sig);
    } catch (error) {
      throw new X402Error(
        `ethers cannot encode this typed data (${error instanceof Error ? error.message : error}); ` +
          'the OWS signature is not returned',
        'INVALID_CONFIG'
      );
    }
    this.#checkSigner(signer, 'signTypedData');
    return { signature: sig.serialized, v: sig.v, r: sig.r, s: sig.s };
  }

  #unsignedTransaction(input: string | ethers.TransactionLike<string>): ethers.Transaction {
    const senders: unknown[] = [];
    let tx: ethers.Transaction;
    try {
      if (typeof input === 'string') {
        tx = ethers.Transaction.from(input);
      } else if (typeof input === 'object' && input !== null) {
        // Read field by field, not spread: an ethers.Transaction keeps its
        // fields behind getters, and a spread of it is an empty transaction.
        const source = input as Record<string, unknown>;
        // An ethers.Transaction has no own keys; a plain object may only use
        // the keys ethers reads, so that no field is dropped on the way.
        for (const key of Object.keys(source)) {
          if (key === 'from' || key === 'hash' || (TRANSACTION_FIELDS as readonly string[]).includes(key)) continue;
          const ethersName = ETHERS_NAME_OF[key];
          throw refuse(
            `transaction key ${shown(key)} is not one ethers reads` +
              (ethersName ? `; ethers calls it ${ethersName}` : '')
          );
        }
        if (source.from != null) senders.push(source.from);
        const fields: Record<string, unknown> = {};
        for (const key of TRANSACTION_FIELDS) {
          if (source[key] != null) fields[key] = source[key];
        }
        tx = ethers.Transaction.from(fields);
      } else {
        throw new Error(`got ${typeof input}`);
      }
    } catch (error) {
      if (error instanceof X402Error) throw error;
      throw refuse(
        `not a transaction ethers can read (${error instanceof Error ? error.message : error})`
      );
    }
    if (tx.signature) senders.push(tx.from);
    for (const sender of senders) {
      let address = '';
      try {
        address = ethers.getAddress(sender as string);
      } catch {
        // not an address: refused below
      }
      if (address !== this.#address) {
        throw refuse(`transaction from ${shown(sender)} is not this wallet (${this.#address})`);
      }
    }
    tx.signature = null;
    return tx;
  }

  #checkSigner(signer: string, what: string): void {
    if (signer !== this.#address) {
      throw new X402Error(
        `OWS ${what} returned a signature that does not recover to ${this.#address} over the ` +
          'digest ethers computes (the one EnvKeyAdapter signs); it is not returned',
        'PAYMENT_FAILED'
      );
    }
  }

  /** Run one OWS call; its error becomes an X402Error without the passphrase in it. */
  #call<T>(what: string, run: () => T, code: 'PAYMENT_FAILED' | 'WALLET_NOT_FOUND' = 'PAYMENT_FAILED'): T {
    try {
      return run();
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (this.#passphrase) message = message.split(this.#passphrase).join('[redacted]');
      throw new X402Error(`OWS ${what} failed: ${message}`, code);
    }
  }
}
