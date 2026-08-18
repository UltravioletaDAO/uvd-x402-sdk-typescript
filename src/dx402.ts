/**
 * DX402 `durable-evidence`: recover a paid response after the fact.
 *
 * x402 settles payment on-chain permanently but delivers the purchased resource
 * **exactly once**, in the body of a `200 OK`, and keeps nothing. A buyer who did
 * not capture it at that instant cannot recover it, and neither party can later
 * prove *what* was delivered — only *that* payment happened.
 *
 * DX402 closes that gap. The seller seals a copy of the response to the payer's
 * own public key — recovered from the payment signature itself — and anchors it.
 * The buyer gets an `X-Durable-Evidence` header pointing at it.
 *
 * **Paying is publishing your encryption key.** No registration, no key
 * exchange, no extra round trip.
 *
 * ```ts
 * const evidence = evidenceFromHeaders(response.headers);
 * const body = await recoverEvidence(evidence, myPrivateKey);
 * ```
 *
 * Specification: `docs/plans/dx402/02-SPEC-v0.1.md` in x402-rs.
 */

import { gcm } from '@noble/ciphers/aes';
import { x25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256, sha512 } from '@noble/hashes/sha2';

export const EVIDENCE_HEADER = 'X-Durable-Evidence';

const MAGIC = new Uint8Array([0x44, 0x58, 0x34, 0x30, 0x32]); // "DX402"
/** One recipient (the payer). Still emitted for that case, so deployed readers keep working. */
const FORMAT_V1 = 1;
/** Several recipients. A v2 blob positively signals that somebody besides the payer can open it. */
const FORMAT_V2 = 2;

/** Why a party holds a key to this evidence. */
export type RecipientRole = 'payer' | 'seller' | 'auditor';
const ROLE_NAMES: RecipientRole[] = ['payer', 'seller', 'auditor'];
const NONCE_LEN = 12;
const CEK_LEN = 32;
const HKDF_INFO = new TextEncoder().encode('DX402-v1-wrap');

export class DX402Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DX402Error';
  }
}

/**
 * No evidence was anchored for this payment.
 *
 * A normal outcome, not a fault: the body may have exceeded the seller's size
 * cap, the store may have been unreachable, or the payer may be a
 * smart-contract wallet with no recoverable key.
 */
export class EvidenceSkipped extends DX402Error {
  constructor(public readonly reason: string) {
    super(`no durable evidence was anchored: ${reason}`);
    this.name = 'EvidenceSkipped';
  }
}

/**
 * The anchored bytes are not the bytes that were delivered.
 *
 * This is the interesting failure: the seller anchored something other than
 * what it served, which is precisely the fraud `contentHash` exists to expose.
 * Treat it as evidence of misbehaviour, not a transport glitch.
 */
export class ContentHashMismatch extends DX402Error {
  constructor(
    public readonly anchored: string,
    public readonly actual: string,
  ) {
    super(`content hash mismatch: anchored ${anchored}, decrypted ${actual}`);
    this.name = 'ContentHashMismatch';
  }
}

export type EvidenceMode = 'direct' | 'escrowed';

export interface AnchoredEvidence {
  v: number;
  paymentId: string;
  pointer: string;
  backend: string;
  contentHash: string;
  cipher: string;
  keyAlg: 'ECIES-secp256k1' | 'ECIES-X25519';
  mode: EvidenceMode;
  retention: string;
  receipt?: string;
}

/**
 * Whether the facilitator is cryptographically unable to read this payload.
 *
 * `direct` and `escrowed` make materially different claims about who can open
 * the payload, so a caller that cares about confidentiality must check rather
 * than assume.
 */
export function isEndToEnd(evidence: AnchoredEvidence): boolean {
  return evidence.mode === 'direct';
}

function b64urlDecode(value: string): Uint8Array {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new DX402Error('odd-length hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** keccak256 of a body, `0x`-prefixed — matching the facilitator's `contentHash`. */
export function contentHash(body: Uint8Array): string {
  return '0x' + bytesToHex(keccak_256(body));
}

/**
 * Derive the canonical payment identifier: `keccak256(caip2Network || txHash)`.
 *
 * This value is the AEAD associated data binding a ciphertext to its payment.
 * Buyer and seller must derive it identically or decryption fails with no
 * obvious cause, which is why it lives in the SDK rather than in each caller.
 */
export function paymentId(caip2Network: string, txHash: string): string {
  const enc = new TextEncoder();
  const clean = txHash.startsWith('0x') ? txHash.slice(2) : txHash;
  const preimage = new Uint8Array([...enc.encode(caip2Network), ...enc.encode(clean)]);
  return '0x' + bytesToHex(keccak_256(preimage));
}

/** Parse an `X-Durable-Evidence` header value. */
export function parseEvidenceHeader(value: string): AnchoredEvidence {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(value)));
  } catch (err) {
    throw new DX402Error(`malformed ${EVIDENCE_HEADER} header: ${String(err)}`);
  }
  if ('skipped' in payload) {
    throw new EvidenceSkipped(String(payload.skipped));
  }
  if (!payload.paymentId || !payload.pointer || !payload.contentHash) {
    throw new DX402Error(`malformed ${EVIDENCE_HEADER} header: missing required fields`);
  }
  return payload as unknown as AnchoredEvidence;
}

/**
 * Pull the anchored evidence out of a response's headers.
 *
 * Accepts a `Headers` object or a plain record. Lookup is case-insensitive,
 * because HTTP does not care and different clients disagree about casing.
 */
export function evidenceFromHeaders(
  headers: Headers | Record<string, string>,
): AnchoredEvidence {
  let raw: string | null | undefined;
  if (typeof (headers as Headers).get === 'function') {
    raw = (headers as Headers).get(EVIDENCE_HEADER);
  } else {
    const target = EVIDENCE_HEADER.toLowerCase();
    for (const [key, value] of Object.entries(headers as Record<string, string>)) {
      if (key.toLowerCase() === target) {
        raw = value;
        break;
      }
    }
  }
  if (!raw) throw new DX402Error(`no ${EVIDENCE_HEADER} header on this response`);
  return parseEvidenceHeader(raw);
}

/**
 * Turn a DX402 pointer into a fetchable URL.
 *
 * `s3+https://...` is a scheme tag over an ordinary HTTPS URL; `ipfs://` and
 * `ar://` go through public gateways. Anything else passes through untouched, so
 * a caller with their own resolver is not blocked by this function.
 */
export function dereferencePointer(pointer: string): string {
  if (pointer.startsWith('s3+')) return pointer.slice(3);
  if (pointer.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${pointer.slice(7)}`;
  if (pointer.startsWith('ar://')) return `https://arweave.net/${pointer.slice(5)}`;
  return pointer;
}

interface Recipient {
  role: RecipientRole;
  alg: 'secp256k1' | 'x25519';
  ephemeral: Uint8Array;
  cekNonce: Uint8Array;
  wrappedCek: Uint8Array;
}

interface SealedEnvelope {
  recipients: Recipient[];
  bodyNonce: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Who can open this blob, without decrypting anything.
 *
 * Worth surfacing: a buyer has to be able to see that the seller — or a
 * designated auditor — also holds a key to what they bought. Finding that out
 * afterwards would destroy the privacy property.
 */
export function sealedRoles(raw: Uint8Array): RecipientRole[] {
  return parseSealed(raw).recipients.map((r) => r.role);
}

/**
 * Parse the sealed-blob layout.
 *
 * `MAGIC | version | alg | ephLen | eph | cekNonce | wrappedLen | wrapped |
 *  bodyNonce | ciphertext`
 *
 * Every read is bounds-checked, so a truncated blob is a clear parse failure
 * rather than an out-of-range surprise later.
 */
export function parseSealed(raw: Uint8Array): SealedEnvelope {
  let pos = 0;
  const take = (n: number, what: string): Uint8Array => {
    if (raw.length < pos + n) throw new DX402Error(`truncated DX402 sealed blob at ${what}`);
    const chunk = raw.subarray(pos, pos + n);
    pos += n;
    return chunk;
  };

  const magic = take(MAGIC.length, 'magic');
  for (let i = 0; i < MAGIC.length; i++) {
    if (magic[i] !== MAGIC[i]) throw new DX402Error('not a DX402 sealed blob');
  }

  const version = take(1, 'version')[0];
  let count: number;
  if (version === FORMAT_V1) count = 1;
  else if (version === FORMAT_V2) count = take(1, 'recipient count')[0];
  else throw new DX402Error(`unsupported sealed-blob version ${version}`);

  // An envelope nobody can open is not evidence.
  if (count === 0) throw new DX402Error('DX402 sealed blob has no recipients');

  const recipients: Recipient[] = [];
  for (let i = 0; i < count; i++) {
    let role: RecipientRole = 'payer';
    if (version === FORMAT_V2) {
      const b = take(1, 'role')[0];
      if (b >= ROLE_NAMES.length) throw new DX402Error(`unknown role ${b}`);
      role = ROLE_NAMES[b];
    }

    const algByte = take(1, 'algorithm')[0];
    if (algByte !== 1 && algByte !== 2) {
      throw new DX402Error(`unknown key algorithm ${algByte}`);
    }
    const ephLen = take(1, 'ephemeral key length')[0];
    const ephemeral = take(ephLen, 'ephemeral key');
    const cekNonce = take(NONCE_LEN, 'cek nonce');
    const lenBytes = take(2, 'wrapped key length');
    const wrappedCek = take((lenBytes[0] << 8) | lenBytes[1], 'wrapped cek');

    recipients.push({
      role,
      alg: algByte === 1 ? 'secp256k1' : 'x25519',
      ephemeral,
      cekNonce,
      wrappedCek,
    });
  }

  const bodyNonce = take(NONCE_LEN, 'body nonce');
  return { recipients, bodyNonce, ciphertext: raw.subarray(pos) };
}

function sharedSecret(sealed: Recipient, privateKey: Uint8Array): Uint8Array {
  if (sealed.alg === 'secp256k1') {
    // Compressed output is 33 bytes: a 0x02/0x03 tag plus the x-coordinate.
    // Only the x-coordinate is the ECDH result, matching what the Rust side
    // feeds into HKDF. Including the tag byte would derive a different key and
    // fail with no useful diagnostic.
    const full = secp256k1.getSharedSecret(privateKey, sealed.ephemeral, true);
    return full.subarray(1);
  }

  // ed25519 seed -> X25519 scalar: SHA-512 the seed, take the low half.
  // @noble/curves clamps internally.
  const scalar = sha512(privateKey).subarray(0, 32);
  const shared = x25519.getSharedSecret(scalar, sealed.ephemeral);

  // RFC 7748 section 6.1: an all-zero result means a small-order public key was
  // supplied, which would make the wrapping key reproducible by whoever
  // supplied it.
  if (shared.every((b) => b === 0)) {
    throw new DX402Error('degenerate ECDH result (small-order public key)');
  }
  return shared;
}

/**
 * Decrypt a sealed envelope with whichever recipient slot belongs to `privateKey`.
 *
 * Tries every slot: a holder does not necessarily know which one is theirs, and
 * in a multi-recipient envelope the payer is not always first. A slot that does
 * not open is skipped, not reported — "that one was not for me" is not an error.
 */
export function unseal(
  sealed: SealedEnvelope,
  privateKey: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  for (const recipient of sealed.recipients) {
    let shared: Uint8Array;
    try {
      shared = sharedSecret(recipient, privateKey);
    } catch (err) {
      if (err instanceof DX402Error) throw err;
      continue;
    }

    const wrapKey = hkdf(sha256, shared, aad, HKDF_INFO, 32);
    let cek: Uint8Array;
    try {
      cek = gcm(wrapKey, recipient.cekNonce, aad).decrypt(recipient.wrappedCek);
    } catch {
      continue; // not our slot
    }
    if (cek.length !== CEK_LEN) {
      throw new DX402Error(`unwrapped CEK is ${cek.length} bytes, expected ${CEK_LEN}`);
    }
    return gcm(cek, sealed.bodyNonce, aad).decrypt(sealed.ciphertext);
  }

  throw new DX402Error(
    'no recipient slot opened -- wrong key, or the blob belongs to another payment',
  );
}

/**
 * Fetch, decrypt and verify the body behind `evidence`.
 *
 * `privateKey` is the raw key of the wallet that paid: 32 bytes for both an EVM
 * secp256k1 key and an ed25519 seed. Hex accepted with or without `0x`.
 *
 * In `direct` mode this needs no permission from anyone — the ciphertext was
 * sealed to the public key of the wallet that paid, so retrieval is arithmetic
 * rather than an access-control decision that could be refused or misconfigured.
 *
 * The `contentHash` check is **not optional**: it is what catches a seller that
 * anchored something other than what it served.
 */
export async function recoverEvidence(
  evidence: AnchoredEvidence,
  privateKey: Uint8Array | string,
  options: { fetch?: typeof fetch } = {},
): Promise<Uint8Array> {
  const key = typeof privateKey === 'string' ? hexToBytes(privateKey) : privateKey;
  if (key.length !== 32) {
    throw new DX402Error(`private key must be 32 bytes, got ${key.length}`);
  }

  const doFetch = options.fetch ?? fetch;
  const url = dereferencePointer(evidence.pointer);
  const res = await doFetch(url);
  if (!res.ok) {
    throw new DX402Error(`could not fetch sealed evidence: HTTP ${res.status}`);
  }
  const blob = new Uint8Array(await res.arrayBuffer());

  const sealed = parseSealed(blob);
  const aad = new TextEncoder().encode(evidence.paymentId);

  let plaintext: Uint8Array;
  try {
    plaintext = unseal(sealed, key, aad);
  } catch (err) {
    if (err instanceof DX402Error) throw err;
    throw new DX402Error(
      'decryption failed -- wrong key, or the blob belongs to another payment',
    );
  }

  const actual = contentHash(plaintext);
  if (actual.toLowerCase() !== evidence.contentHash.toLowerCase()) {
    throw new ContentHashMismatch(evidence.contentHash, actual);
  }

  return plaintext;
}

// ============================================================================
// Seller side -- sealing
// ============================================================================
//
// The half above recovers evidence. This half PRODUCES it, and it belongs to
// whoever holds the plaintext: the resource server, right after settlement.
//
// The facilitator is deliberately not involved. It only ever sees /verify and
// /settle, never a response body, so sealing cannot happen there.

import { edwardsToMontgomeryPub } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';

/**
 * Map an ed25519 public key to its X25519 form.
 *
 * On ed25519 chains (Solana, NEAR, Stellar, Algorand) the address **is** the
 * public key, so this is all that stands between an address and an encryption
 * target — no signature, no lookup.
 */
export function ed25519ToX25519(pubkey: Uint8Array): Uint8Array {
  if (pubkey.length !== 32) {
    throw new DX402Error(`ed25519 public key must be 32 bytes, got ${pubkey.length}`);
  }
  return edwardsToMontgomeryPub(pubkey);
}

/**
 * Recover an EVM payer's secp256k1 public key from their payment signature.
 *
 * `digest` is the EIP-712 digest the payer actually signed. Getting it wrong
 * does not throw: it recovers a *different, perfectly valid* key, and the body
 * would be sealed to a stranger while every log line said success. The token's
 * EIP-712 domain name varies per chain and even flips between a chain's mainnet
 * and testnet, so derive it from the same table the facilitator uses.
 *
 * Returns the SEC1-compressed key (33 bytes).
 */
export function payerKeyFromEvmSignature(
  signature: Uint8Array | string,
  digest: Uint8Array,
): Uint8Array {
  const sig = typeof signature === 'string' ? hexToBytes(signature) : signature;
  if (sig.length !== 65) {
    throw new DX402Error(`signature must be 65 bytes, got ${sig.length}`);
  }

  let v = sig[65 - 1];
  if (v === 27 || v === 28) v -= 27;
  else if (v >= 35) v = (v - 35) % 2;
  if (v !== 0 && v !== 1) throw new DX402Error(`invalid recovery id ${sig[64]}`);

  const parsed = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(v);
  return parsed.recoverPublicKey(digest).toRawBytes(true);
}

/**
 * Seal `body` so that only the holder of the payer's private key can read it.
 *
 * `payerKey` is a 33-byte SEC1-compressed secp256k1 key (EVM, XRPL) or a 32-byte
 * X25519 key from {@link ed25519ToX25519}.
 *
 * `paymentIdValue` is bound in as AEAD associated data, which is what stops a
 * ciphertext from being replayed as the evidence for a different payment.
 * Derive it with {@link paymentId} on both sides — deriving it differently makes
 * decryption fail with no obvious cause.
 *
 * Returns the bytes to upload. Nothing here touches the network.
 */
export function sealEvidence(
  body: Uint8Array,
  payerKey: Uint8Array,
  paymentIdValue: string,
): Uint8Array {
  const aad = new TextEncoder().encode(paymentIdValue);
  const cek = randomBytes(32);
  const bodyNonce = randomBytes(NONCE_LEN);
  const cekNonce = randomBytes(NONCE_LEN);

  const ciphertext = gcm(cek, bodyNonce, aad).encrypt(body);

  let algByte: number;
  let ephemeral: Uint8Array;
  let shared: Uint8Array;

  if (payerKey.length === 33) {
    algByte = 1;
    const ephPriv = secp256k1.utils.randomPrivateKey();
    ephemeral = secp256k1.getPublicKey(ephPriv, true);
    // Only the x-coordinate is the ECDH result; the leading tag byte is not
    // part of it. Including it would derive a different key and fail with no
    // useful diagnostic.
    shared = secp256k1.getSharedSecret(ephPriv, payerKey, true).subarray(1);
  } else if (payerKey.length === 32) {
    algByte = 2;
    const ephPriv = randomBytes(32);
    ephemeral = x25519.getPublicKey(ephPriv);
    shared = x25519.getSharedSecret(ephPriv, payerKey);

    // RFC 7748 section 6.1: a small-order payer key would drive the shared
    // secret to a constant that whoever supplied it could reproduce.
    if (shared.every((b) => b === 0)) {
      throw new DX402Error('degenerate ECDH result (small-order public key)');
    }
  } else {
    throw new DX402Error(
      `payer key must be 33 bytes (secp256k1) or 32 (X25519), got ${payerKey.length}`,
    );
  }

  const wrapKey = hkdf(sha256, shared, aad, HKDF_INFO, 32);
  const wrappedCek = gcm(wrapKey, cekNonce, aad).encrypt(cek);

  const out = new Uint8Array(
    MAGIC.length + 3 + ephemeral.length + NONCE_LEN + 2 + wrappedCek.length +
      NONCE_LEN + ciphertext.length,
  );
  let pos = 0;
  out.set(MAGIC, pos); pos += MAGIC.length;
  out[pos++] = FORMAT_V1;
  out[pos++] = algByte;
  out[pos++] = ephemeral.length;
  out.set(ephemeral, pos); pos += ephemeral.length;
  out.set(cekNonce, pos); pos += NONCE_LEN;
  out[pos++] = (wrappedCek.length >> 8) & 0xff;
  out[pos++] = wrappedCek.length & 0xff;
  out.set(wrappedCek, pos); pos += wrappedCek.length;
  out.set(bodyNonce, pos); pos += NONCE_LEN;
  out.set(ciphertext, pos);
  return out;
}
