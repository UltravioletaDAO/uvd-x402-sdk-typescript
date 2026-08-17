/**
 * Emits envelopes sealed by THIS implementation, for x402-rs to open.
 *
 * The point is not the round trip below -- sealing and unsealing in the same
 * module would pass even if the format or the ed25519->X25519 map were wrong,
 * because both halves would share the mistake. The point is the files: they get
 * committed to x402-rs as fixtures for `tests/dx402_cross_seal.rs`, where an
 * independent implementation has to agree.
 */
import { writeFileSync } from 'node:fs';

import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { describe, expect, it } from 'vitest';

import { contentHash, ed25519ToX25519, parseSealed, sealEvidence, unseal } from './dx402';

const PID = '0x' + '11'.repeat(32);
const BODY = new TextEncoder().encode('the paid response that must outlive the session');
const AAD = new TextEncoder().encode(PID);
const toHex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');

const OUT = process.env.DX402_VECTOR_OUT;

describe('seller-side sealing', () => {
  it('seals to a secp256k1 payer', () => {
    const priv = new Uint8Array(32).fill(0x42);
    const blob = sealEvidence(BODY, secp256k1.getPublicKey(priv, true), PID);
    expect(unseal(parseSealed(blob), priv, AAD)).toEqual(BODY);
    if (OUT) writeFileSync(`${OUT}/ts_secp.hex`, toHex(blob));
  });

  it('seals to an ed25519 payer', () => {
    const seed = new Uint8Array(32).fill(0x37);
    const key = ed25519ToX25519(ed25519.getPublicKey(seed));
    const blob = sealEvidence(BODY, key, PID);
    expect(unseal(parseSealed(blob), seed, AAD)).toEqual(BODY);
    if (OUT) writeFileSync(`${OUT}/ts_ed.hex`, toHex(blob));
  });

  it('agrees with the facilitator on contentHash', () => {
    expect(contentHash(BODY)).toBe(
      '0xfe8b2e5d48e880760dfcbfa8f794555810bb82b2e2b29138caab4bb36b58f748',
    );
  });

  it('rejects a wrong-sized payer key', () => {
    for (const n of [0, 16, 31, 64]) {
      expect(() => sealEvidence(BODY, new Uint8Array(n), PID)).toThrow();
    }
  });

  it('produces a different blob every time', () => {
    // Fresh CEK and nonces. Identical blobs would let an observer of the store
    // learn that two buyers received the same answer.
    const priv = new Uint8Array(32).fill(0x42);
    const pub = secp256k1.getPublicKey(priv, true);
    expect(sealEvidence(BODY, pub, PID)).not.toEqual(sealEvidence(BODY, pub, PID));
  });

  it('never leaks the plaintext into the blob', () => {
    const priv = new Uint8Array(32).fill(0x42);
    const marker = new TextEncoder().encode('SENSITIVE-MARKER-STRING');
    const blob = sealEvidence(marker, secp256k1.getPublicKey(priv, true), PID);
    expect(toHex(blob)).not.toContain(toHex(marker));
  });
});
