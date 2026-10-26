/**
 * The public evidence of a rating: what the `feedbackURI` serves.
 *
 * The registry stores `feedbackHash`; the facilitator fetches `feedbackURI`
 * and checks that keccak of the served bytes is that hash, so the document
 * must be served byte for byte as {@link evidenceDocument} returns it
 * (`body`).
 *
 * WHAT IT NEVER CARRIES: the chat text, the author, the login, the user id.
 * Karma Hello's `evidence.py` publishes the comment and its author on public
 * IPFS; the Twitch Developer Agreement forbids retaining chat to build public
 * databases, and a rating cannot be revoked. So what identifies the person
 * locally enters only as a COMMITMENT: `HMAC-SHA256(salt, label "|" value)`
 * with a salt per viewer, kept locally. Destroying the salt (`!forgetme`)
 * leaves the commitments unlinkable to anyone; what stays public is what the
 * chain already shows (the subject's wallet, the rating, the payment).
 *
 * Two guards make that structural rather than a convention:
 * - no key of the document, at any depth, may name content or a person
 *   ({@link isPrivateKey}: `message`, `author`, `login`, `chatText`,
 *   `author_name`, the Spanish words too), so a caller cannot slip the text in
 *   through `context`;
 * - every private value long enough to be recognisable is searched for in
 *   the caller-written public strings, and its presence anywhere (a tag, the
 *   endpoint, a context value) is a refusal.
 *
 * The same contract, the same refusal codes and the same bytes as the Python
 * SDK's `uvd_x402_sdk.reputation.evidence_document`: the shared vectors
 * (`test/vectors/reputation/evidence-document.json`) pin them. Two checks
 * more here, run after every Python check so that they only refuse what
 * Python accepts: a tag or endpoint that is not a string (`invalid_input`),
 * and a proof whose `paymentHash` does not recompute or that is for another
 * network (`proof`).
 */

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { ethers } from 'ethers';
import type { ProofOfPayment } from '../backend';
import { canonicalJson } from './canonical';
import { reputationChain, type ReputationChain } from './constants';
import { ReputationError, type ReputationErrorCode } from './errors';
import { computePaymentHash } from './payment';
import { LONE_SURROGATE, bytes32Of, isAddress, isRecord, uintOf } from './values';

export const EVIDENCE_SCHEMA = 'uvd.reputation.evidence/v1';
export const COMMITMENT_SCHEME = 'hmac-sha256(salt, label|value); salt per viewer, kept off-chain';

export type WalletBinding = 'self_declared_unverified' | 'eip191_verified';
const WALLET_BINDINGS: ReadonlySet<string> = new Set(['self_declared_unverified', 'eip191_verified']);

/** Keys that never appear in public evidence (compared lowercased, without `_` / `-`). */
export const PRIVATE_KEYS: ReadonlySet<string> = new Set([
  'message',
  'messages',
  'text',
  'body',
  'content',
  'quote',
  'comment',
  'transcript',
  'chat',
  'author',
  'username',
  'login',
  'user',
  'userid',
  'viewerid',
  'viewer',
  'displayname',
  'nick',
  'nickname',
  'email',
]);

/** A key is also private when any of its words is one of these (`chatText`, `author_name`, `viewer-login`). */
export const PRIVATE_TOKENS: ReadonlySet<string> = new Set([
  'message',
  'messages',
  'msg',
  'text',
  'quote',
  'comment',
  'transcript',
  'chat',
  'author',
  'username',
  'login',
  'user',
  'viewer',
  'nick',
  'nickname',
  'email',
  'handle',
  // The same in Spanish: the teams that use this module write in it.
  'mensaje',
  'mensajes',
  'texto',
  'cita',
  'comentario',
  'comentarios',
  'transcripcion',
  'autor',
  'autora',
  'usuario',
  'usuaria',
  'apodo',
  'correo',
]);

/** Private values at least this long are searched for (case-insensitive) in every caller-written public string. */
export const LEAK_CHECK_MIN_LENGTH = 8;
/** Shorter ones, down to this, as whole words in `issuer` and `context`. */
export const LEAK_CHECK_MIN_WORD = 4;
const LABEL = /^[a-z][a-z0-9_]{0,31}$/;
const PROOF_FIELDS = ['transactionHash', 'blockNumber', 'network', 'payer', 'payee', 'amount', 'token', 'timestamp', 'paymentHash'] as const;

function reject(code: ReputationErrorCode, message: string): never {
  throw new ReputationError(code, message);
}

/** Whether `key` names something that never goes into public evidence. */
export function isPrivateKey(key: string): boolean {
  if (PRIVATE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))) return true;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some((w) => PRIVATE_TOKENS.has(w));
}

/** 32 random bytes as `0x` hex: one salt per viewer, stored locally, destroyed on forget. */
export function newSalt(): string {
  return '0x' + bytesToHex(randomBytes(32));
}

function saltBytes(salt: unknown): Uint8Array {
  let bytes: Uint8Array | null = null;
  if (salt instanceof Uint8Array) bytes = salt;
  else if (typeof salt === 'string' && /^(0x)?([0-9a-fA-F]{2})+$/.test(salt)) bytes = ethers.getBytes('0x' + salt.replace(/^0x/, ''));
  if (bytes === null || bytes.length < 16) reject('salt', 'the salt must be at least 16 bytes');
  return bytes;
}

/** `0x` + hex of `HMAC-SHA256(salt, label + "|" + value)`. */
export function commitment(salt: Uint8Array | string, label: string, value: string): string {
  const key = saltBytes(salt);
  if (typeof label !== 'string' || !LABEL.test(label)) reject('commitment_label', 'labels are lower_snake_case');
  if (typeof value !== 'string' || LONE_SURROGATE.test(value)) reject('commitment_value', 'committed values are strings');
  return '0x' + bytesToHex(hmac(sha256, key, new TextEncoder().encode(`${label}|${value}`)));
}

function checkPublic(value: unknown, path: string): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'bigint') return;
  if (typeof value === 'number') {
    // Past 2^53, or -0, a JavaScript number is a float to the other SDK.
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) reject('float_in_evidence', `${path} is a float (not canonical)`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkPublic(item, `${path}[${i}]`));
    return;
  }
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      if (isPrivateKey(key)) reject('private_field', `${path}.${key} cannot be public evidence`);
      checkPublic(item, `${path}.${key}`);
    }
    return;
  }
  reject('evidence_type', `${path} is not a JSON value`);
}

/** 9999-12-31T23:59:59Z: past it Python's `datetime` has no year to write. */
const LAST_ISO_SECOND = 253_402_300_799;

function iso(timestamp: unknown): string {
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > LAST_ISO_SECOND) {
    reject('created_at', 'createdAt is whole unix seconds');
  }
  return new Date(timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A paymentHash that recomputes, on the rating's network. */
function proofHolds(p: Record<string, unknown>, chain: ReputationChain): boolean {
  try {
    return computePaymentHash(p as unknown as ProofOfPayment) === bytes32Of(p.paymentHash) && reputationChain(String(p.network)) === chain;
  } catch {
    return false;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface EvidenceInput {
  /** Where the rating is written (`base`). */
  network: string;
  /** The subject's ERC-8004 agent id. */
  agentId: number | bigint | string;
  /** The rater's address (the `clientAddress` on-chain). */
  rater: string;
  /** The subject's wallet (owner of `agentId`). */
  subject: string;
  /** Exactly what the rating carries: an integer 0..100. */
  value: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  /** Unix seconds of the rated moment (round it: an exact second can point at a chat line). */
  createdAt: number;
  /** The viewer's salt, at least 16 bytes ({@link newSalt}). */
  salt: Uint8Array | string;
  /**
   * `label -> value` of what identifies the moment and the person locally
   * (`{ moment_ref, user_id, login, message }`). Only their commitments are
   * public, and none of these values may appear anywhere else in the body.
   * At least the moment's reference.
   */
  private: Record<string, string>;
  /** `self_declared_unverified` (a directory entry, the default) or `eip191_verified` (the person signed a claim). */
  walletBinding?: WalletBinding;
  /** The anchor payment's proof, published as is. */
  proof?: ProofOfPayment | null;
  /** Who rates (`{ name, product }`), public strings. */
  issuer?: Record<string, unknown> | null;
  /** Extra PUBLIC fields, checked like the rest. */
  context?: Record<string, unknown> | null;
}

export interface EvidenceDocument {
  document: Record<string, unknown>;
  /** The bytes to serve at the `feedbackURI`. */
  body: Uint8Array;
  /** The same, as text. */
  json: string;
  /** `keccak256(body)`: the rating's `feedbackHash`. */
  contentHash: string;
}

/** Build the public evidence of one rating. Throws {@link ReputationError} with the Python SDK's refusal codes. */
export function evidenceDocument(input: EvidenceInput): EvidenceDocument {
  if (!isRecord(input)) reject('invalid_input', 'evidenceDocument needs an object');
  const chain = reputationChain(String(input.network));
  if (!chain) reject('unknown_network', `no relayed feedback on ${String(input.network)}`);
  const binding = input.walletBinding ?? 'self_declared_unverified';
  if (!WALLET_BINDINGS.has(binding)) reject('wallet_binding', `${String(binding)} is not a binding`);
  const value = input.value;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    reject('value', 'value is an integer within 0..100');
  }
  const agentId = uintOf(input.agentId);
  if (agentId === null) reject('agent_id', 'agentId is a non-negative integer');
  const priv = input.private;
  if (!isRecord(priv) || Object.keys(priv).length === 0) {
    reject('private', 'at least the moment\'s reference is committed');
  }
  const commitments: Record<string, string> = {};
  for (const [label, item] of Object.entries(priv)) commitments[label] = commitment(input.salt, label, item as string);
  if (!isAddress(input.rater) || !isAddress(input.subject)) reject('address', 'rater and subject are addresses');

  const document: Record<string, unknown> = {
    schema: EVIDENCE_SCHEMA,
    network: chain.network,
    chainId: chain.chainId,
    agentRegistry: `eip155:${chain.chainId}:${ethers.getAddress(chain.identityRegistry)}`,
    agentId: agentId.toString(),
    clientAddress: ethers.getAddress(input.rater.toLowerCase()),
    subject: { wallet: ethers.getAddress(input.subject.toLowerCase()), walletBinding: binding },
    value,
    valueDecimals: 0,
    tag1: input.tag1,
    tag2: input.tag2,
    endpoint: input.endpoint,
    createdAt: iso(input.createdAt),
    commitmentScheme: COMMITMENT_SCHEME,
  };
  if (input.proof !== undefined && input.proof !== null) {
    const p = input.proof as unknown as Record<string, unknown>;
    // Python validates a ProofOfPayment before the call: a field missing is refused first.
    if (!isRecord(p) || !PROOF_FIELDS.every((k) => p[k] !== undefined && p[k] !== null)) reject('proof', 'the proof is not a ProofOfPayment');
    // Exactly the ProofOfPayment fields, as Python's model_dump writes them.
    document.proofOfPayment = Object.fromEntries(PROOF_FIELDS.map((k) => [k, p[k]]));
  }
  if (input.issuer !== undefined && input.issuer !== null) document.issuer = { ...input.issuer };
  if (input.context !== undefined && input.context !== null) document.context = { ...input.context };
  // Checked BEFORE the commitments go in: their keys are the private labels
  // ("message", "login"...), and their values are HMACs built right here.
  checkPublic(document, 'evidence');
  // The caller-written strings are where a private value could ride along.
  const freeText = canonicalJson([input.tag1, input.tag2, input.endpoint, input.issuer ?? null, input.context ?? null]).toLowerCase();
  const perRow = canonicalJson([input.issuer ?? null, input.context ?? null]).toLowerCase();
  for (const [label, item] of Object.entries(priv)) {
    const lower = (item as string).toLowerCase();
    const escaped = JSON.stringify(lower).slice(1, -1);
    const chars = Array.from(lower).length;
    if (chars >= LEAK_CHECK_MIN_LENGTH && (freeText.includes(lower) || freeText.includes(escaped))) {
      reject('private_value_leaked', `the ${label} appears in public evidence`);
    }
    if (
      chars >= LEAK_CHECK_MIN_WORD &&
      chars < LEAK_CHECK_MIN_LENGTH &&
      new RegExp(`(?<![0-9a-z])${escapeRegExp(escaped)}(?![0-9a-z])`).test(perRow)
    ) {
      reject('private_value_leaked', `the ${label} appears in public evidence`);
    }
  }
  // This SDK's two checks more, last, so that they only refuse what Python accepts.
  for (const field of ['tag1', 'tag2', 'endpoint'] as const) {
    if (typeof document[field] !== 'string') reject('invalid_input', `${field} must be a string`);
  }
  if (document.proofOfPayment !== undefined && !proofHolds(document.proofOfPayment as Record<string, unknown>, chain)) {
    reject('proof', 'the proof does not hash to its paymentHash, or is for another network');
  }
  document.commitments = commitments;
  const json = canonicalJson(document);
  const body = new TextEncoder().encode(json);
  return { document, body, json, contentHash: ethers.keccak256(body).toLowerCase() };
}
