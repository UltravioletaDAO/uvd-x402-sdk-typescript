/**
 * DX402 tests.
 *
 * The decryption vectors in `dx402.vectors.json` were produced by the **Rust**
 * implementation in x402-rs (`tests/dx402_vector_gen.rs`), not by this SDK. That
 * is deliberate: a vector generated and checked by the same code proves only
 * that the code is self-consistent. Three fabricated SHA-256 variants of
 * ERC-8004 SEAL v1 passed CI for months on exactly that mistake.
 *
 * Regenerate with:
 *   cargo test --test dx402_vector_gen -- --nocapture emit_vectors
 */

import { describe, expect, it } from 'vitest';

import vectors from './dx402.vectors.json';
import {
  ContentHashMismatch,
  DX402Error,
  EVIDENCE_HEADER,
  EvidenceSkipped,
  contentHash,
  dereferencePointer,
  evidenceFromHeaders,
  isEndToEnd,
  parseEvidenceHeader,
  parseSealed,
  paymentId,
  recoverEvidence,
  unseal,
  sealedRoles,
  type AnchoredEvidence,
} from './dx402';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const AAD = new TextEncoder().encode(vectors.paymentId);
const BODY = new TextEncoder().encode(vectors.body);

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

describe('cross-implementation vectors (sealed by Rust)', () => {
  it('agrees with Rust on contentHash', () => {
    // If the two sides disagree here, the integrity check is worthless.
    expect(contentHash(BODY)).toBe(vectors.contentHash);
  });

  it('decrypts a secp256k1 envelope sealed by Rust', () => {
    const sealed = parseSealed(hexToBytes(vectors.secp256k1.blob));
    expect(sealed.recipients[0].alg).toBe('secp256k1');
    expect(sealed.recipients[0].ephemeral.length).toBe(33);
    expect(unseal(sealed, hexToBytes(vectors.secp256k1.privateKey), AAD)).toEqual(BODY);
  });

  it('decrypts an X25519 envelope sealed by Rust', () => {
    const sealed = parseSealed(hexToBytes(vectors.ed25519.blob));
    expect(sealed.recipients[0].alg).toBe('x25519');
    expect(sealed.recipients[0].ephemeral.length).toBe(32);
    expect(unseal(sealed, hexToBytes(vectors.ed25519.seed), AAD)).toEqual(BODY);
  });

  it('refuses a ciphertext lifted from a different payment', () => {
    // paymentId is the AEAD associated data. Without this binding an anchor
    // would prove nothing about which transaction it belongs to.
    const sealed = parseSealed(hexToBytes(vectors.secp256k1.blob));
    expect(() =>
      unseal(sealed, hexToBytes(vectors.secp256k1.privateKey), new TextEncoder().encode('0xother')),
    ).toThrow();
  });

  it('refuses the wrong key', () => {
    const sealed = parseSealed(hexToBytes(vectors.secp256k1.blob));
    expect(() => unseal(sealed, new Uint8Array(32).fill(0x11), AAD)).toThrow();
  });
});

describe('sealed-blob parsing', () => {
  it('rejects anything that is not a DX402 blob', () => {
    expect(() => parseSealed(new Uint8Array(0))).toThrow(DX402Error);
    expect(() => parseSealed(new TextEncoder().encode('NOTDX402xxxxxx'))).toThrow(DX402Error);
  });

  it('errors on every truncation rather than reading out of range', () => {
    const blob = hexToBytes(vectors.secp256k1.blob);
    for (let n = 0; n < blob.length; n++) {
      try {
        parseSealed(blob.subarray(0, n));
      } catch (err) {
        expect(err, `truncation at ${n}`).toBeInstanceOf(DX402Error);
      }
    }
  });
});

describe('payment identifier', () => {
  it('is stable and 0x-prefixed', () => {
    const id = paymentId('eip155:8453', '0xabc123');
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(paymentId('eip155:8453', 'abc123')).toBe(id); // 0x prefix is optional
  });

  it('separates networks', () => {
    expect(paymentId('eip155:8453', '0xabc')).not.toBe(paymentId('eip155:84532', '0xabc'));
  });
});

describe('pointer dereferencing', () => {
  it('maps each scheme to something fetchable', () => {
    expect(dereferencePointer('s3+https://e.example/a.dx402')).toBe('https://e.example/a.dx402');
    expect(dereferencePointer('ipfs://bafy1')).toBe('https://ipfs.io/ipfs/bafy1');
    expect(dereferencePointer('ar://tx1')).toBe('https://arweave.net/tx1');
    // Unknown schemes pass through rather than being mangled.
    expect(dereferencePointer('https://x.example/y')).toBe('https://x.example/y');
  });
});

describe('header handling', () => {
  const anchored = {
    v: 1,
    paymentId: vectors.paymentId,
    pointer: 's3+https://e.example/a.dx402',
    backend: 's3',
    contentHash: vectors.contentHash,
    cipher: 'AES-256-GCM',
    keyAlg: 'ECIES-secp256k1',
    mode: 'direct',
    retention: '90d',
  };

  it('parses an anchored header', () => {
    const evidence = parseEvidenceHeader(b64url(anchored));
    expect(evidence.paymentId).toBe(vectors.paymentId);
    expect(isEndToEnd(evidence)).toBe(true);
  });

  it('reports a skip notice as a skip, not a failure', () => {
    // "The seller chose not to anchor" and "the evidence is broken" are
    // different situations a buyer has to be able to tell apart.
    expect(() => parseEvidenceHeader(b64url({ v: 1, skipped: 'too_large' }))).toThrow(
      EvidenceSkipped,
    );
    try {
      parseEvidenceHeader(b64url({ v: 1, skipped: 'no_payer_key' }));
    } catch (err) {
      expect((err as EvidenceSkipped).reason).toBe('no_payer_key');
    }
  });

  it('does not report escrowed mode as end-to-end', () => {
    // direct and escrowed make materially different confidentiality claims.
    const evidence = parseEvidenceHeader(b64url({ ...anchored, mode: 'escrowed' }));
    expect(isEndToEnd(evidence)).toBe(false);
  });

  it('finds the header regardless of casing', () => {
    for (const key of [EVIDENCE_HEADER, EVIDENCE_HEADER.toLowerCase(), EVIDENCE_HEADER.toUpperCase()]) {
      expect(evidenceFromHeaders({ [key]: b64url(anchored) }).paymentId).toBe(vectors.paymentId);
    }
  });

  it('works with a Headers object', () => {
    const headers = new Headers();
    headers.set(EVIDENCE_HEADER, b64url(anchored));
    expect(evidenceFromHeaders(headers).paymentId).toBe(vectors.paymentId);
  });

  it('distinguishes a missing header from a malformed one', () => {
    expect(() => evidenceFromHeaders({})).toThrow(DX402Error);
    expect(() => parseEvidenceHeader('!!!not base64!!!')).toThrow(DX402Error);
  });
});

describe('recoverEvidence', () => {
  const evidence: AnchoredEvidence = {
    v: 1,
    paymentId: vectors.paymentId,
    pointer: 'https://e.example/a.dx402',
    backend: 's3',
    contentHash: vectors.contentHash,
    cipher: 'AES-256-GCM',
    keyAlg: 'ECIES-secp256k1',
    mode: 'direct',
    retention: '90d',
  };

  const serve = (blobHex: string) =>
    (async () =>
      new Response(hexToBytes(blobHex), { status: 200 })) as unknown as typeof fetch;

  it('returns the original body end to end', async () => {
    const body = await recoverEvidence(evidence, vectors.secp256k1.privateKey, {
      fetch: serve(vectors.secp256k1.blob),
    });
    expect(new TextDecoder().decode(body)).toBe(vectors.body);
  });

  it('rejects a key of the wrong length before doing any work', async () => {
    await expect(recoverEvidence(evidence, new Uint8Array(16))).rejects.toThrow(DX402Error);
  });

  it('flags a dishonest anchor through the content hash', async () => {
    // The seller anchored real ciphertext but claimed the hash of something
    // else. This is the fraud contentHash exists to expose.
    const lying = { ...evidence, contentHash: '0x' + 'ff'.repeat(32) };
    await expect(
      recoverEvidence(lying, vectors.secp256k1.privateKey, {
        fetch: serve(vectors.secp256k1.blob),
      }),
    ).rejects.toThrow(ContentHashMismatch);
  });
});


describe('multi-recipient envelopes (v2, sealed by Rust)', () => {
  const m = (vectors as unknown as Record<string, Record<string, string>>).multiRecipient;
  const AAD2 = new TextEncoder().encode(vectors.paymentId);

  it('opens as the buyer', () => {
    const sealed = parseSealed(hexToBytes(m.blob));
    expect(sealed.recipients.length).toBe(2);
    expect(unseal(sealed, hexToBytes(m.buyerPrivateKey), AAD2)).toEqual(BODY);
  });

  it('opens as the seller', () => {
    // The property that did not exist before v2: the seller can answer a false
    // "that is not what you sent".
    const sealed = parseSealed(hexToBytes(m.blob));
    expect(unseal(sealed, hexToBytes(m.sellerPrivateKey), AAD2)).toEqual(BODY);
  });

  it('still refuses a stranger', () => {
    const sealed = parseSealed(hexToBytes(m.blob));
    expect(() => unseal(sealed, new Uint8Array(32).fill(0x77), AAD2)).toThrow();
  });

  it('reports who holds a key without decrypting', () => {
    expect(sealedRoles(hexToBytes(m.blob))).toEqual(['payer', 'seller']);
  });

  it('reads a v1 blob as a single payer recipient', () => {
    // Every blob anchored before v2 existed is v1. If this stopped parsing,
    // evidence already in the store would become unreadable.
    expect(sealedRoles(hexToBytes(vectors.secp256k1.blob))).toEqual(['payer']);
  });
});
