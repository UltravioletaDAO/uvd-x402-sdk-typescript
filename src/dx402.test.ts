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
import { secp256k1 } from '@noble/curves/secp256k1';

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
  anchorDigest,
  ZERO_ADDRESS,
  anchorEvidence,
  availableBackends,
  evidenceHeader,
  sealEvidenceTo,
  sellerDigestFor,
  payerKeyFromSolanaAddress,
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

describe('anchor authorization digest', () => {
  const a = (vectors as unknown as Record<string, Record<string, Record<string, string>>>)
    .anchorDigest;

  it('matches the digest the facilitator computes (EVM)', () => {
    // Pinned against Rust, not recomputed here. A digest built slightly
    // differently throws nothing — it produces a signature that never verifies
    // and the seller's anchor silently stays provisional.
    const d = anchorDigest(
      a.paymentId as unknown as string,
      a.contentHash as unknown as string,
      a.evm.pointer,
      a.evm.payee,
      Number(a.evm.chainId),
    );
    expect('0x' + Array.from(d).map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(
      a.evm.digest,
    );
  });

  it('matches the digest the facilitator computes (ed25519 form)', () => {
    const d = anchorDigest(
      a.paymentId as unknown as string,
      a.contentHash as unknown as string,
      a.ed25519.pointer,
      a.ed25519.payee,
      Number(a.ed25519.chainId),
    );
    expect('0x' + Array.from(d).map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(
      a.ed25519.digest,
    );
  });

  it('rejects malformed inputs rather than hashing garbage', () => {
    expect(() => anchorDigest('0x00', '0x' + '22'.repeat(32), '', ZERO_ADDRESS, 0)).toThrow();
    expect(() => anchorDigest('0x' + '11'.repeat(32), '0x00', '', ZERO_ADDRESS, 0)).toThrow();
    expect(() => anchorDigest('0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '', '0x00', 0)).toThrow();
  });

  it('binds every field', () => {
    const base = anchorDigest('0x' + '11'.repeat(32), '0x' + '22'.repeat(32), 'p', ZERO_ADDRESS, 0);
    const other = anchorDigest('0x' + '11'.repeat(32), '0x' + '22'.repeat(32), 'otro', ZERO_ADDRESS, 0);
    expect(base).not.toEqual(other);
  });
});

describe('the whole seller side in one call', () => {
  it('never throws — an unreachable facilitator costs the receipt, not the sale', async () => {
    const result = await anchorEvidence(new TextEncoder().encode('body'), {
      paymentId: vectors.paymentId,
      network: 'solana',
      txHash: 'abc',
      payer: 'p',
      payee: 'q',
      payerKey: new Uint8Array(32),
      facilitator: 'http://127.0.0.1:1',
    });
    expect(result.skipped).toBe('anchor_failed');
  });

  it('decodes a Solana address into an encryption key', () => {
    const k = payerKeyFromSolanaAddress('3znAGhp6Tk4kmebhXnk9K3jaTMffu82PJfEG91AeRkq2');
    expect(k.length).toBe(32);
    // An empty address used to pad up to 32 bytes and yield a small-order point.
    expect(() => payerKeyFromSolanaAddress('')).toThrow();
    expect(() => payerKeyFromSolanaAddress('1')).toThrow();
  });

  it('seals to both parties and reports the roles', () => {
    const buyer = secp256k1.getPublicKey(new Uint8Array(32).fill(0x42), true);
    const seller = secp256k1.getPublicKey(new Uint8Array(32).fill(0x55), true);
    const blob = sealEvidenceTo(BODY, [
      { role: 'payer', key: buyer },
      { role: 'seller', key: seller },
    ], vectors.paymentId);
    expect(sealedRoles(blob)).toEqual(['payer', 'seller']);
    expect(unseal(parseSealed(blob), new Uint8Array(32).fill(0x55), AAD)).toEqual(BODY);
  });

  it('emits a single-payer envelope as v1', () => {
    const buyer = secp256k1.getPublicKey(new Uint8Array(32).fill(0x42), true);
    const blob = sealEvidenceTo(BODY, [{ role: 'payer', key: buyer }], vectors.paymentId);
    expect(blob[5]).toBe(1);
  });
});

// ---- the digest form the facilitator actually verifies (KK, 2026-08-19) ----

describe('sellerDigestFor', () => {
  const pid = '0x' + '11'.repeat(32);
  const ch = '0x' + '22'.repeat(32);
  const payee = '0x' + '33'.repeat(20);

  it('signs an EVM payee against its REAL address and chain id', () => {
    // The facilitator's gate dispatches on the payee's curve and verifies
    // exactly ONE form. Signing the ed25519 form for an EVM payee throws
    // nothing -- it yields a signature that never verifies and leaves the
    // anchor provisional, the hijack a signed anchor exists to prevent.
    // Reproduced against production: identical payloads, the ed25519 form was
    // refused (409 dx402_already_anchored), the EVM form superseded.
    const got = sellerDigestFor(pid, ch, payee, 'base');
    expect(got).toEqual(anchorDigest(pid, ch, '', payee, 8453));
    expect(got).not.toEqual(anchorDigest(pid, ch, '', ZERO_ADDRESS, 0));
  });

  it('keeps the zero-address form for an ed25519 payee', () => {
    // A Solana address does not fit the EIP-712 `address` field.
    const got = sellerDigestFor(
      pid, ch, '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'solana',
    );
    expect(got).toEqual(anchorDigest(pid, ch, '', ZERO_ADDRESS, 0));
  });

  it('declines to sign an unknown network instead of throwing OR guessing', () => {
    // This used to assert the fallback to the ed25519 form, pinning the 0.53.0
    // bug as intended behaviour: for an EVM payee that form yields a signature
    // that never verifies, silently. Not throwing is the part worth keeping.
    expect(sellerDigestFor(pid, ch, payee, 'not-a-network')).toBeUndefined();
  });
});

describe('anchorEvidence size and error reporting', () => {
  const common = {
    paymentId: '0x' + 'ab'.repeat(32),
    network: 'base',
    txHash: '0x' + 'cd'.repeat(32),
    payer: '0x' + '11'.repeat(20),
    payee: '0x' + '22'.repeat(20),
    payerKey: new Uint8Array(32).fill(7),
  };

  it('skips a body that cannot be anchored, measured on the SEALED request', async () => {
    // Measured against production by KarmaKadabra, 2026-08-19: 47 KB of
    // plaintext fits the facilitator's 64 KiB request limit, 48 KB does not.
    // Measuring the plaintext would let the 48 KB case through and turn a
    // knowable size problem into a generic failure after sealing was done.
    const never = () => {
      throw new Error('a too-large body must not reach the network');
    };

    const big = await anchorEvidence(new Uint8Array(48 * 1024), {
      ...common,
      fetch: never as unknown as typeof fetch,
    });
    expect(big.skipped).toBe('too_large');

    // And it does not over-reject: 47 KB is allowed through to the network,
    // where the stub is what fails it.
    const ok = await anchorEvidence(new Uint8Array(47 * 1024), {
      ...common,
      fetch: never as unknown as typeof fetch,
    });
    expect(ok.skipped).toBe('anchor_failed');
  });

  it('keeps the facilitator diagnosis instead of flattening to anchor_failed', async () => {
    const rejects = async () =>
      new Response(JSON.stringify({ error: 'dx402_signature_not_verified' }), {
        status: 422,
      });

    const out = await anchorEvidence(new Uint8Array([1, 2, 3]), {
      ...common,
      fetch: rejects as unknown as typeof fetch,
    });
    expect(out.skipped).toBe('anchor_failed'); // still never throws
    expect(out.status).toBe(422);
    expect(out.error).toBe('dx402_signature_not_verified');
  });
});

describe('hex decoding is strict', () => {
  it('rejects malformed hex instead of turning it into plausible key bytes', () => {
    // The old parseInt loop stored NaN as 0, so 'zz'.repeat(32) became 32 zero
    // bytes and parseInt('4z', 16) became 4 — malformed input silently became a
    // valid-looking key. Same failure class as the Python base58 rjust(32) bug.
    expect(() => anchorDigest('0x' + 'ab'.repeat(32), '0x' + 'cd'.repeat(32), '', 'zz'.repeat(20), 8453)).toThrow(
      /invalid hex/,
    );
    expect(() => anchorDigest('0x' + 'ab'.repeat(32), '0x' + 'cd'.repeat(32), '', '0x' + '4z'.repeat(20), 8453)).toThrow(
      /invalid hex/,
    );
  });

  it('still decodes well-formed hex byte-identically', () => {
    const a = anchorDigest('0x' + 'ab'.repeat(32), '0x' + 'cd'.repeat(32), '', '0x' + '11'.repeat(20), 8453);
    const b = anchorDigest('0x' + 'ab'.repeat(32), '0x' + 'cd'.repeat(32), '', '0x' + '11'.repeat(20), 8453);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
    expect(a.length).toBe(32);
  });
});

describe('the seller digest form is never guessed', () => {
  const pid = '0x' + 'ab'.repeat(32);
  const ch = '0x' + 'cd'.repeat(32);
  const evm = '0x' + '22'.repeat(20);

  it('declines to sign an EVM payee whose chain id cannot be resolved', () => {
    // Falling through to the ed25519 form is the 0.53.0 bug: it throws nothing
    // and yields a signature that never verifies, leaving the anchor
    // provisional forever with no error anywhere.
    expect(sellerDigestFor(pid, ch, evm, 'totally-unknown-net')).toBeUndefined();
  });

  it('reads the chain id straight out of a CAIP-2 network', () => {
    // The chain table has no EVM testnets, so this is the only path that works
    // for a seller on one.
    expect(sellerDigestFor(pid, ch, evm, 'eip155:84532')).toEqual(
      anchorDigest(pid, ch, '', evm, 84532),
    );
  });

  it('still uses the EVM form on a known mainnet and ed25519 for an ed25519 payee', () => {
    expect(sellerDigestFor(pid, ch, evm, 'base')).toEqual(anchorDigest(pid, ch, '', evm, 8453));
    const sol = 'F742C4VfFLQ9zRQyithoj5229ZgtX2WqKCSFKgH2EThq';
    expect(sellerDigestFor(pid, ch, sol, 'solana')).toEqual(
      anchorDigest(pid, ch, '', ZERO_ADDRESS, 0),
    );
  });

  it('the two forms actually differ, or the tests above prove nothing', () => {
    expect(anchorDigest(pid, ch, '', evm, 8453)).not.toEqual(
      anchorDigest(pid, ch, '', ZERO_ADDRESS, 0),
    );
  });
});

describe('reaching verified, and headers that survive non-ASCII', () => {
  it('forwards proofOfPayment, which is the only route to verified:true', async () => {
    // v1.85.0 made rung 2 require an on-chain proof. Without a way to send one,
    // no SDK user could ever be certified -- the security fix and the SDK would
    // disagree, silently, forever.
    let sent: Record<string, unknown> | undefined;
    const capture = async (_url: string, init?: { body?: string }) => {
      sent = JSON.parse(init!.body!);
      return new Response(JSON.stringify({ v: 1, verified: true }), { status: 201 });
    };

    const proof = { transactionHash: '0x' + 'cd'.repeat(32), blockNumber: 7, network: 'base' };
    await anchorEvidence(new Uint8Array([1, 2, 3]), {
      paymentId: '0x' + 'ab'.repeat(32),
      network: 'base',
      txHash: '0x' + 'cd'.repeat(32),
      payer: '0x' + '11'.repeat(20),
      payee: '0x' + '22'.repeat(20),
      payerKey: new Uint8Array(32).fill(7),
      proofOfPayment: proof,
      fetch: capture as unknown as typeof fetch,
    });
    expect(sent?.proofOfPayment).toEqual(proof);
  });

  it('encodes a header containing non-ASCII instead of throwing', () => {
    // `btoa` takes a BINARY string: a code point above U+00FF throws, and one
    // between U+0080 and U+00FF is emitted as a single latin-1 byte, so the far
    // side decodes mojibake. A pointer or a reason string is enough to hit it.
    const evidence = { v: 1, skipped: 'anchor_failed', error: 'símbolo — ✓' };
    const header = evidenceHeader(evidence);

    const pad = header + '='.repeat((4 - (header.length % 4)) % 4);
    const raw = atob(pad.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(evidence);
  });
});

describe('choosing where evidence is stored', () => {
  it('forwards the storage choice to the facilitator', async () => {
    let sent: Record<string, unknown> | undefined;
    const capture = async (_u: string, init?: { body?: string }) => {
      sent = JSON.parse(init!.body!);
      return new Response(JSON.stringify({ v: 1 }), { status: 201 });
    };
    await anchorEvidence(new Uint8Array([1]), {
      paymentId: '0x' + 'ab'.repeat(32),
      network: 'base',
      txHash: '0x' + 'cd'.repeat(32),
      payer: '0x' + '11'.repeat(20),
      payee: '0x' + '22'.repeat(20),
      payerKey: new Uint8Array(32).fill(7),
      storage: 'ipfs-private',
      fetch: capture as unknown as typeof fetch,
    });
    expect(sent?.storage).toBe('ipfs-private');
  });

  it('discovers backends and surfaces the irrevocable one as such', async () => {
    // `revocable` is the field that decides whether the signed `retentionUntil`
    // is true. A caller that ignores it can promise a deletion that never
    // happens.
    const stats = async () =>
      new Response(
        JSON.stringify({
          anchored: 1,
          backends: [
            { id: 's3', retention: '90d', revocable: true, public: false, enabled: true },
            {
              id: 'ipfs-public',
              retention: 'permanent',
              revocable: false,
              public: true,
              enabled: false,
              disabledReason: 'irreversible; awaiting buyer opt-in',
            },
          ],
        }),
        { status: 200 },
      );

    const backends = await availableBackends('https://f.test', {
      fetch: stats as unknown as typeof fetch,
    });
    expect(backends.map((b) => b.id)).toEqual(['s3', 'ipfs-public']);
    const pub = backends.find((b) => b.id === 'ipfs-public')!;
    expect(pub.revocable).toBe(false);
    expect(pub.enabled).toBe(false);
    expect(pub.disabledReason).toMatch(/irreversible/);
  });

  it('returns an empty list instead of throwing when DX402 is not there', async () => {
    // A facilitator without DX402 404s. Discovery must never be a gate.
    const gone = async () => new Response('nope', { status: 404 });
    await expect(
      availableBackends('https://f.test', { fetch: gone as unknown as typeof fetch }),
    ).resolves.toEqual([]);
  });
});

