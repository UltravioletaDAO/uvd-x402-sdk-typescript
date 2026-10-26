/**
 * The public evidence document a rating's `feedbackURI` points to, and its
 * `feedbackHash`.
 *
 * Karma Hello's `evidence_document` (`services/reputation/live.py`) publishes
 * the chat message and its author. This one never does, and cannot be made
 * to: a rating is irrevocable, and the Twitch Developer Agreement forbids
 * building public databases out of chat. What it carries instead:
 *
 * - public facts: the subject's wallet and agentId, the rater, the value and
 *   tags, the stream's endpoint, and the anchor payment (its transaction hash
 *   under `proofOfPayment.transactionHash`, which is where the facilitator
 *   looks for it: x402-rs `proof.rs::document_mentions_payment`);
 * - COMMITMENTS for anything that identifies a person or a moment locally
 *   (a moment ref, a user id, a login): `HMAC-SHA256(salt, name "|" value)`
 *   with a per-viewer salt that never leaves the program. Destroying the salt
 *   (`!forgetme`) makes every commitment unlinkable for good.
 *
 * `context` and `issuer` take short flat values, and a key that names chat
 * content or a person (`message`, `text`, `author`, `login`, `username`,
 * `userId`, ...) is refused, nested or not.
 *
 * `contentHash` is `keccak256` of the canonical bytes (`canonical.ts`), the
 * value the facilitator compares the fetched document against, and the same
 * as this SDK's `dx402.contentHash` of those bytes.
 */

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ethers } from 'ethers';
import type { ProofOfPayment } from '../backend';
import { canonicalBytes, canonicalJson } from './canonical';
import { reputationChain } from './constants';
import { ReputationError } from './errors';
import { computePaymentHash } from './payment';
import { CONTROL, bytes32Of, int128Of, isAddress, isRecord, uintOf } from './values';

export const EVIDENCE_SCHEMA = 'uvd-x402.reputation.evidence/v1';
export const COMMITMENT_SCHEME = 'hmac-sha256(salt, name "|" value)/v1';

export type WalletBinding = 'self_declared_unverified' | 'eip191_verified';

export interface EvidenceInput {
  /** Facilitator network name of the rating. */
  network: string;
  agentId: string | number | bigint;
  /** The rater (the `clientAddress` the registry records). */
  rater: string;
  subject: {
    wallet: string;
    /** How the program tied the wallet to the person. */
    walletBinding: WalletBinding;
    /** e.g. `chat_participant`. Default `participant`. */
    type?: string;
  };
  value: number | string | bigint;
  valueDecimals?: number;
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  /** ISO 8601 UTC (`2026-10-26T18:00:00Z`), supplied by the caller so the document is deterministic. */
  createdAt: string;
  /** Who issued the rating: product, organisation, ... Short strings. */
  issuer?: Record<string, string>;
  /** What was rated, as short flat values: `{ kind: 'idea' }`. */
  context?: Record<string, string | number | boolean>;
  /** Values to publish only as commitments: `{ momentRef, viewerId, login }`. */
  commitments?: Record<string, string>;
  /** The viewer's salt, 32 bytes hex. Required when there are commitments. */
  salt?: string;
  /** The anchor payment. */
  proof?: ProofOfPayment | null;
}

export interface EvidenceDocument {
  document: Record<string, unknown>;
  /** The canonical JSON text. */
  json: string;
  /** Its UTF-8 bytes: what to publish at the `feedbackURI`. */
  bytes: Uint8Array;
  /** `keccak256(bytes)`: the rating's `feedbackHash`. */
  contentHash: string;
}

const FORBIDDEN = new Set([
  'message',
  'messages',
  'text',
  'quote',
  'author',
  'username',
  'login',
  'displayname',
  'transcript',
  'chat',
  'comment',
  'content',
  'body',
  'email',
  'ip',
  'user',
  'userid',
  'viewer',
  'viewerid',
  'name',
]);
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_VALUE_CHARS = 200;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function forbidden(key: string): boolean {
  return FORBIDDEN.has(key.toLowerCase().replace(/[_-]/g, ''));
}

function shortText(value: unknown, path: string): string {
  if (typeof value !== 'string' || CONTROL.test(value) || Array.from(value).length > MAX_VALUE_CHARS) {
    throw new ReputationError('invalid_input', `${path} must be a string of at most ${MAX_VALUE_CHARS} characters, no control characters`);
  }
  return value;
}

function flat(
  value: unknown,
  path: string,
  allow: (v: unknown) => boolean,
  options: { allowName?: boolean } = {}
): Record<string, string | number | boolean> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ReputationError('invalid_input', `${path} must be a plain object`);
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!KEY.test(key)) throw new ReputationError('invalid_input', `${path} has an invalid key`);
    if (forbidden(key) && !(options.allowName && key.toLowerCase() === 'name')) {
      throw new ReputationError('forbidden_field', `${path}.${key} names chat content or a person; publish it as a commitment or not at all`);
    }
    if (!allow(inner)) throw new ReputationError('invalid_input', `${path}.${key} is not a short flat value`);
    out[key] = typeof inner === 'string' ? shortText(inner, `${path}.${key}`) : (inner as number | boolean);
  }
  return out;
}

/** `0x` + HMAC-SHA256(salt, utf8(name + "|" + value)). */
export function commitment(salt: string, name: string, value: string): string {
  const key = bytes32Of(salt);
  if (key === null) throw new ReputationError('invalid_input', 'the salt must be 32 bytes of hex');
  if (!KEY.test(name)) throw new ReputationError('invalid_input', 'a commitment name must be a short identifier');
  if (typeof value !== 'string' || value === '') {
    throw new ReputationError('invalid_input', `commitment ${name} needs a non-empty string value`);
  }
  const mac = hmac(sha256, ethers.getBytes(key), new TextEncoder().encode(`${name}|${value}`));
  return '0x' + bytesToHex(mac);
}

/** Build the evidence document, its canonical bytes and its hash. */
export function evidenceDocument(input: EvidenceInput): EvidenceDocument {
  if (!isRecord(input)) throw new ReputationError('invalid_input', 'evidenceDocument needs an object');
  const chain = reputationChain(String(input.network));
  if (!chain) throw new ReputationError('unknown_chain', `no ERC-8004 registry is known for ${String(input.network)}`);
  const agentId = uintOf(input.agentId);
  const value = int128Of(input.value);
  const valueDecimals = input.valueDecimals ?? 0;
  if (
    agentId === null ||
    value === null ||
    !Number.isSafeInteger(Number(value)) ||
    !Number.isSafeInteger(valueDecimals) ||
    valueDecimals < 0 ||
    valueDecimals > 18
  ) {
    throw new ReputationError('invalid_input', 'agentId, value or valueDecimals is out of range');
  }
  if (!isAddress(input.rater) || !isRecord(input.subject) || !isAddress(input.subject.wallet)) {
    throw new ReputationError('invalid_input', 'the rater and the subject wallet must be addresses');
  }
  const binding = input.subject.walletBinding;
  if (binding !== 'self_declared_unverified' && binding !== 'eip191_verified') {
    throw new ReputationError('invalid_input', 'subject.walletBinding must say how the wallet was tied to the person');
  }
  if (typeof input.createdAt !== 'string' || !ISO_UTC.test(input.createdAt)) {
    throw new ReputationError('invalid_input', 'createdAt must be ISO 8601 UTC, e.g. 2026-10-26T18:00:00Z');
  }
  const text = (v: unknown, name: string) => (v === undefined ? '' : shortText(v, name));

  const document: Record<string, unknown> = {
    schema: EVIDENCE_SCHEMA,
    agentRegistry: `eip155:${chain.chainId}:${ethers.getAddress(chain.identityRegistry)}`,
    agentId: agentId.toString(),
    clientAddress: ethers.getAddress(input.rater.toLowerCase()),
    subject: {
      type: input.subject.type === undefined ? 'participant' : shortText(input.subject.type, 'subject.type'),
      wallet: ethers.getAddress(input.subject.wallet.toLowerCase()),
      walletBinding: binding,
    },
    createdAt: input.createdAt,
    value: Number(value),
    valueDecimals,
    tag1: text(input.tag1, 'tag1'),
    tag2: text(input.tag2, 'tag2'),
    endpoint: text(input.endpoint, 'endpoint'),
    issuer: flat(input.issuer, 'issuer', (v) => typeof v === 'string', { allowName: true }),
    context: flat(
      input.context,
      'context',
      (v) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isSafeInteger(v))
    ),
  };

  const names = input.commitments === undefined ? [] : Object.keys(input.commitments);
  if (input.commitments !== undefined && !isRecord(input.commitments)) {
    throw new ReputationError('invalid_input', 'commitments must be an object');
  }
  if (names.length > 0) {
    if (input.salt === undefined) throw new ReputationError('invalid_input', 'commitments need the viewer\'s salt');
    const values: Record<string, string> = {};
    for (const name of names) {
      values[name] = commitment(input.salt, name, (input.commitments as Record<string, string>)[name]);
    }
    document.commitments = { scheme: COMMITMENT_SCHEME, values };
  }

  if (input.proof) {
    const p = input.proof;
    if (computePaymentHash(p) !== bytes32Of(p.paymentHash)) {
      throw new ReputationError('invalid_input', 'the proof does not hash to its paymentHash');
    }
    if (p.network !== chain.network) throw new ReputationError('invalid_input', 'the proof is for another network');
    document.proofOfPayment = {
      transactionHash: bytes32Of(p.transactionHash),
      blockNumber: p.blockNumber,
      network: p.network,
      payer: ethers.getAddress(p.payer.toLowerCase()),
      payee: ethers.getAddress(p.payee.toLowerCase()),
      amount: String(uintOf(p.amount)),
      token: ethers.getAddress(String(p.token).toLowerCase()),
      timestamp: p.timestamp,
      paymentHash: bytes32Of(p.paymentHash),
    };
  }

  const json = canonicalJson(document);
  const bytes = canonicalBytes(document);
  return { document, json, bytes, contentHash: ethers.keccak256(bytes).toLowerCase() };
}
