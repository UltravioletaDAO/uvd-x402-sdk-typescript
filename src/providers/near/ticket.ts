/**
 * Arras v2 operator ticket: the operator's Ed25519 signature that lets a payer use the operator's space. When the
 * operator has a `ticket_pubkey`, every v2 payment (`ft_transfer_call` authorize and `authorize_from_budget`) and every
 * budget deposit in that operator needs one (arras contracts/escrow-v2/src/authorize.rs:263-285).
 *
 * Offline: no RPC, no key storage. The signing key is injected, as a key in memory (`createNearLocalSigner`) or as an
 * external signer; it is never read from a file or the environment.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { encodeBase58 } from 'ethers';
import { account, concat, fullMatch, le, operatorId, str, uint, unbase58 } from './encoding';
import type { NearUnsigned } from './escrow';

/** ticket.rs:25. */
export const OPERATOR_TICKET_DOMAIN = 'arras:v2:operator_ticket';

/**
 * What the ticket authorizes (ticket.rs:28-39), in the shape of arras docs/vectores.json: one payment by its
 * `payment_id`, or budget deposits of the pair `(owner, agent)` in `operator_id` until expiry.
 */
export type OperatorTicketSubject =
  | { payment: { payment_id: string } }
  | { budget: { operator_id: string; owner: string; agent: string } };

/** The `operator_ticket` JSON the contract reads (msg.rs:28-33, lib.rs:304-312): expiry is a U64 decimal string. */
export interface OperatorTicket {
  expiry: string;
  /** Canonical base58 of the 64-byte Ed25519 signature. */
  sig: string;
}

export interface OperatorTicketSigner {
  /** The 32-byte Ed25519 public key registered as the operator's `ticket_pubkey`. */
  readonly publicKey: Uint8Array;
  /** Ed25519-sign exactly these bytes: the Borsh ticket message, not a digest of it. */
  sign(message: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export interface SignOperatorTicketOptions {
  /** `createNearLocalSigner(seed)` qualifies: it Ed25519-signs the bytes it is given. */
  signer: OperatorTicketSigner;
  /**
   * The v2 escrow account (the contract's `env::current_account_id()`). Take it from the operator's own configuration,
   * never from the request: the account is what keeps a ticket from serving in another contract that trusts the key.
   */
  contract: string;
  subject: OperatorTicketSubject;
  /** Nanoseconds. The contract accepts the ticket while `block_timestamp < expiry` (E54 otherwise). Keep it short. */
  expiry: NearUnsigned;
  /** Nanoseconds; defaults to the wall clock. A ticket already expired at `now` is refused before signing. */
  now?: NearUnsigned;
}

export type OperatorTicketRejection = 'E53_TICKET_INVALIDO' | 'E54_TICKET_VENCIDO';

export interface CheckOperatorTicketOptions {
  /** The operator's `ticket_pubkey` as `get_operator` returns it (`ed25519:<base58>`) or its 32 bytes; null if none. */
  ticketPubkey: string | Uint8Array | null | undefined;
  contract: string;
  subject: OperatorTicketSubject;
  ticket: OperatorTicket | null | undefined;
  /** Nanoseconds (the block timestamp to judge against); defaults to the wall clock. */
  now?: NearUnsigned;
}

export interface VerifyOperatorTicketOptions {
  /** `ed25519:<base58>` or the 32 bytes. */
  publicKey: string | Uint8Array;
  contract: string;
  subject: OperatorTicketSubject;
  ticket: OperatorTicket;
  /** Nanoseconds; defaults to the wall clock. */
  now?: NearUnsigned;
}

const wallClock = (): bigint => BigInt(Date.now()) * 1_000_000n;

function plainObject(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name}: expected an object`);
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((k) => Object.hasOwn(value, k))) {
    throw new Error(`${name}: expected exactly ${keys.join(', ')}`);
  }
  return value as Record<string, unknown>;
}

/** A payment ID as the contract derives it: canonical base58 of 32 bytes. */
function paymentIdValue(value: unknown): string {
  let bytes: Uint8Array | undefined;
  if (typeof value === 'string' && value.length >= 32 && value.length <= 44) {
    try { bytes = unbase58(value); } catch { bytes = undefined; }
  }
  if (bytes?.length !== 32 || encodeBase58(bytes) !== value) throw new Error('payment_id: expected base58 of 32 bytes');
  return value as string;
}

/** Borsh of the `subject` enum (ticket.rs:28-39): tag u8, then its Strings. Each field is read once. */
function subjectBytes(subject: OperatorTicketSubject): Uint8Array {
  if (typeof subject !== 'object' || subject === null || Array.isArray(subject) || Object.keys(subject).length !== 1) {
    throw new Error('subject: expected exactly one of payment or budget');
  }
  if (Object.hasOwn(subject, 'payment')) {
    const p = plainObject((subject as { payment: unknown }).payment, ['payment_id'], 'subject.payment');
    return concat(Uint8Array.of(0), str(paymentIdValue(p.payment_id)));
  }
  if (Object.hasOwn(subject, 'budget')) {
    const b = plainObject((subject as { budget: unknown }).budget, ['operator_id', 'owner', 'agent'], 'subject.budget');
    const [op, owner, agent] = [b.operator_id, b.owner, b.agent] as string[];
    operatorId(op, 'operator_id'); account(owner, 'owner'); account(agent, 'agent');
    return concat(Uint8Array.of(1), str(op), str(owner), str(agent));
  }
  throw new Error('subject: expected exactly one of payment or budget');
}

/**
 * The bytes the operator signs: `borsh(domain String, contract String, subject enum, expiry u64)` (ticket.rs:41-59),
 * the same bytes the views `ticket_message_payment` and `ticket_message_budget` return (views.rs:214-242).
 */
export function operatorTicketMessage(contract: string, subject: OperatorTicketSubject, expiry: NearUnsigned): Uint8Array {
  account(contract, 'contract');
  return ticketBytes(contract, subjectBytes(subject), uint(expiry, 64, 'expiry'));
}
function ticketBytes(contract: string, subject: Uint8Array, expiry: bigint): Uint8Array {
  return concat(str(OPERATOR_TICKET_DOMAIN), str(contract), subject, le(expiry, 8));
}

/** The 64 signature bytes of a canonical base58 `sig`, or null (decode_ticket_sig, ticket.rs:61-73). */
export function decodeOperatorTicketSig(sig: unknown): Uint8Array | null {
  if (typeof sig !== 'string' || sig.length === 0 || sig.length > 88) return null;
  let bytes: Uint8Array;
  try { bytes = unbase58(sig); } catch { return null; }
  return bytes.length === 64 && encodeBase58(bytes) === sig ? bytes : null;
}

/**
 * A ticket in the canonical JSON the msg and `authorize_from_budget` carry: exactly `{ expiry, sig }`, expiry a u64
 * and sig a canonical base58 Ed25519 signature. Throws on anything else; does not check the signature or expiry.
 */
export function canonicalOperatorTicket(ticket: OperatorTicket): OperatorTicket {
  const t = plainObject(ticket, ['expiry', 'sig'], 'operator_ticket');
  const [expiry, sig] = [t.expiry, t.sig];
  if (typeof expiry !== 'string' && typeof expiry !== 'bigint') throw new Error('operator_ticket.expiry: expected a decimal string');
  const value = uint(expiry, 64, 'operator_ticket.expiry');
  if (decodeOperatorTicketSig(sig) === null) {
    throw new Error('operator_ticket.sig: expected canonical base58 of a 64-byte Ed25519 signature');
  }
  return { expiry: value.toString(), sig: sig as string };
}

/** The 32 bytes of an Ed25519 `ticket_pubkey`: `ed25519:<base58>` (as get_operator returns it) or the bytes. */
export function parseTicketPubkey(key: string | Uint8Array): Uint8Array {
  if (key instanceof Uint8Array) {
    if (key.length !== 32) throw new Error('ticket_pubkey: expected 32 Ed25519 bytes');
    return key.slice();
  }
  if (typeof key !== 'string' || !fullMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{1,44}$/, key)) {
    throw new Error('ticket_pubkey: expected ed25519:<base58>');
  }
  const bytes = unbase58(key.slice(8));
  if (bytes.length !== 32 || encodeBase58(bytes) !== key.slice(8)) throw new Error('ticket_pubkey: expected 32 Ed25519 bytes');
  return bytes;
}

/**
 * Sign an operator ticket. Refuses before signing a ticket already expired at `now`, and refuses the result unless it
 * verifies under the signer's public key. Returns the JSON to put in the msg's `operator_ticket`.
 */
export async function signOperatorTicket(options: SignOperatorTicketOptions): Promise<OperatorTicket> {
  const o = { ...options }; // read each option once: the message checked is the message signed
  const signer = o.signer;
  const expiry = uint(o.expiry, 64, 'expiry');
  const now = o.now === undefined ? wallClock() : uint(o.now, 64, 'now');
  const message = operatorTicketMessage(o.contract, o.subject, expiry);
  if (expiry <= now) throw new Error('expiry: the ticket is already expired at now (E54)');
  if (typeof signer !== 'object' || signer === null || typeof signer.sign !== 'function') throw new Error('signer: expected an OperatorTicketSigner');
  const publicKey = signer.publicKey;
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) throw new Error('Expected 32-byte Ed25519 public key');
  const pk = publicKey.slice();
  const signature = await signer.sign(message.slice());
  if (!(signature instanceof Uint8Array) || signature.length !== 64 || !ed25519.verify(signature, message, pk, { zip215: false })) {
    throw new Error('Invalid Ed25519 ticket signature');
  }
  return { expiry: expiry.toString(), sig: encodeBase58(signature) };
}

/**
 * What the contract's `check_ticket` (authorize.rs:263-285) answers, for the ticket of a payment or budget deposit in an
 * operator with `ticketPubkey`: null if it passes. No key and no ticket passes; a key without a ticket, or a ticket
 * without a key, is E53; an expired ticket (`now >= expiry`) is E54, checked before the signature; a signature of
 * anything else (another contract, subject, expiry or key) is E53. Stricter than the chain on form: a ticket that is
 * not exactly `{expiry, sig}` with a canonical decimal expiry is E53 here, while the contract answers E03 for a bad
 * shape (msg.rs:28-33) and parses a non-canonical expiry such as "+1" or "01". Both refuse it.
 */
export function checkOperatorTicket(options: CheckOperatorTicketOptions): OperatorTicketRejection | null {
  const o = { ...options };
  account(o.contract, 'contract');
  const subject = subjectBytes(o.subject); // read once: the subject checked is the subject verified
  const now = o.now === undefined ? wallClock() : uint(o.now, 64, 'now');
  const key = o.ticketPubkey == null ? null : parseTicketPubkey(o.ticketPubkey);
  const raw = o.ticket ?? null;
  if (key === null && raw === null) return null;
  if (key === null || raw === null) return 'E53_TICKET_INVALIDO';
  let ticket: OperatorTicket;
  try { ticket = canonicalOperatorTicket(raw); } catch { return 'E53_TICKET_INVALIDO'; }
  const expiry = BigInt(ticket.expiry);
  if (now >= expiry) return 'E54_TICKET_VENCIDO';
  const sig = decodeOperatorTicketSig(ticket.sig)!;
  return ed25519.verify(sig, ticketBytes(o.contract, subject, expiry), key, { zip215: false }) ? null : 'E53_TICKET_INVALIDO';
}

/** True if the contract would accept `ticket` for `subject` in `contract` with this operator key at `now`. */
export function verifyOperatorTicket(options: VerifyOperatorTicketOptions): boolean {
  const o = { ...options };
  if (o.publicKey == null) throw new Error('publicKey: expected the operator ticket_pubkey');
  return checkOperatorTicket({ ticketPubkey: o.publicKey, contract: o.contract, subject: o.subject, ticket: o.ticket, now: o.now }) === null;
}
