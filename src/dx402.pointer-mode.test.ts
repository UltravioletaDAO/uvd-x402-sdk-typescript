/**
 * Bring-your-own-storage for DX402 anchors.
 *
 * The facilitator has accepted two anchor shapes since v0.1 (x402-rs
 * `src/dx402/types.rs` `AnchorRequest`, dispatched in `service.rs`):
 *
 * - `sealed` — the ciphertext rides in the request and the facilitator hosts it
 *   and derives the pointer;
 * - `pointer` — the seller already wrote the blob somewhere durable and sends
 *   only the locator.
 *
 * Both SDKs implemented only `sealed`, so an integrator could not use their own
 * storage at all, and their body had to fit inside an anchor request. `upload`
 * closes that: it is a **callable**, like `sign`, because the SDK must seal
 * first — the buyer has to be able to decrypt — and only then is there anything
 * to upload. A pointer computed in advance would address bytes that do not yet
 * exist.
 *
 * The load-bearing subtlety is the signature. The facilitator verifies the
 * seller signature against `req.pointer` when one is present and against `""`
 * when it is absent (`service.rs`, `signed_pointer`). Signing the empty string
 * next to a real pointer throws nothing — it yields a signature that never
 * verifies and an anchor that stays **provisional**, which is the state anyone
 * can supersede.
 */

import { describe, expect, it } from 'vitest';

import {
  ANCHOR_MAX_REQUEST_BYTES,
  anchorDigest,
  anchorEvidence,
  contentHash,
  parseSealed,
  sellerDigestFor,
} from './dx402';

const COMMON = {
  paymentId: '0x' + 'ab'.repeat(32),
  network: 'base',
  txHash: '0x' + 'cd'.repeat(32),
  payer: '0x' + '11'.repeat(20),
  payee: '0x' + '22'.repeat(20),
  payerKey: new Uint8Array(32).fill(7),
};

/** Captures the anchor request body and answers 201. */
function capture() {
  const seen: { body?: any } = {};
  const fetchImpl = async (_url: string, init?: { body?: string }) => {
    seen.body = JSON.parse(init!.body!);
    return new Response(JSON.stringify({ v: 1, pointer: seen.body.pointer }), { status: 201 });
  };
  return { seen, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe('anchorEvidence with a seller-supplied pointer', () => {
  it('sends the pointer instead of the blob, and still seals for the buyer', async () => {
    const { seen, fetchImpl } = capture();
    let uploaded: Uint8Array | undefined;

    const out = await anchorEvidence(new TextEncoder().encode('the paid body'), {
      ...COMMON,
      upload: (sealed) => {
        uploaded = sealed;
        return 's3+https://cdn.example.test/blob-1';
      },
      fetch: fetchImpl,
    });

    expect(out.skipped).toBeUndefined();
    expect(seen.body.pointer).toBe('s3+https://cdn.example.test/blob-1');
    // Exactly one of the two, never both: the facilitator dispatches on presence.
    expect(seen.body.sealed).toBeUndefined();

    // Sealing is NOT optional in this mode. The buyer decrypts with the key
    // they paid with, so what we handed to `upload` must be a real envelope.
    expect(uploaded).toBeInstanceOf(Uint8Array);
    const envelope = parseSealed(uploaded!);
    expect(envelope.recipients.map((r) => r.role)).toContain('payer');

    // And the content hash still covers the PLAINTEXT, which is the only form
    // that proves the anchor decrypts to what was delivered.
    expect(seen.body.contentHash).toBe(contentHash(new TextEncoder().encode('the paid body')));
  });

  it('signs the pointer it actually sent, not the empty string', async () => {
    const { seen, fetchImpl } = capture();
    const pointer = 's3+https://cdn.example.test/blob-2';

    await anchorEvidence(new Uint8Array([1, 2, 3]), {
      ...COMMON,
      upload: () => pointer,
      sign: (digest) => '0x' + Buffer.from(digest).toString('hex'),
      fetch: fetchImpl,
    });

    // The stub signer echoes the digest, so this compares the digest directly.
    const signedDigest = Buffer.from(String(seen.body.sellerSignature).slice(2), 'hex');
    const expected = anchorDigest(
      COMMON.paymentId,
      contentHash(new Uint8Array([1, 2, 3])),
      pointer,
      COMMON.payee,
      8453,
    );
    expect(new Uint8Array(signedDigest)).toEqual(expected);

    // The hosted-mode digest is a DIFFERENT value. Sending it here would leave
    // the anchor provisional with no error anywhere.
    const hostedForm = anchorDigest(
      COMMON.paymentId,
      contentHash(new Uint8Array([1, 2, 3])),
      '',
      COMMON.payee,
      8453,
    );
    expect(new Uint8Array(signedDigest)).not.toEqual(hostedForm);
  });

  it('does not apply the request bound to a body it never puts in the request', async () => {
    const { seen, fetchImpl } = capture();

    // Comfortably past what a `sealed` anchor could carry. In hosted mode this
    // exact body is skipped as `too_large` (pinned in dx402.test.ts).
    const body = new Uint8Array(ANCHOR_MAX_REQUEST_BYTES * 4).fill(3);
    const out = await anchorEvidence(body, {
      ...COMMON,
      upload: () => 's3+https://cdn.example.test/big',
      fetch: fetchImpl,
    });

    expect(out.skipped).toBeUndefined();
    expect(seen.body.pointer).toBe('s3+https://cdn.example.test/big');
    // The request stayed small because the ciphertext went to the seller's sink.
    expect(new TextEncoder().encode(JSON.stringify(seen.body)).length).toBeLessThan(
      ANCHOR_MAX_REQUEST_BYTES,
    );
  });

  it('still skips an oversized body in HOSTED mode — the bound is unchanged', async () => {
    const never = () => {
      throw new Error('a too-large hosted body must not reach the network');
    };
    const out = await anchorEvidence(new Uint8Array(48 * 1024), {
      ...COMMON,
      fetch: never as unknown as typeof fetch,
    });
    expect(out.skipped).toBe('too_large');
    expect(ANCHOR_MAX_REQUEST_BYTES).toBe(64 * 1024);
  });

  it('degrades to a skip when the seller sink fails, and never throws', async () => {
    const never = () => {
      throw new Error('nothing may be anchored when the upload failed');
    };

    const thrown = await anchorEvidence(new Uint8Array([1]), {
      ...COMMON,
      upload: () => {
        throw new Error('bucket is on fire');
      },
      fetch: never as unknown as typeof fetch,
    });
    expect(thrown.skipped).toBe('anchor_failed');
    expect(thrown.stage).toBe('upload');

    const rejected = await anchorEvidence(new Uint8Array([1]), {
      ...COMMON,
      upload: async () => {
        throw new Error('timed out');
      },
      fetch: never as unknown as typeof fetch,
    });
    expect(rejected.skipped).toBe('anchor_failed');
  });

  it('refuses an empty pointer rather than anchoring a locator to nothing', async () => {
    const never = () => {
      throw new Error('an empty pointer must not be anchored');
    };
    for (const bad of ['', '   ', undefined as unknown as string]) {
      const out = await anchorEvidence(new Uint8Array([1]), {
        ...COMMON,
        upload: () => bad,
        fetch: never as unknown as typeof fetch,
      });
      expect(out.skipped, JSON.stringify(bad)).toBe('anchor_failed');
    }
  });

  it('infers the backend family from the pointer scheme, and lets it be overridden', async () => {
    const cases: Array<[string, string]> = [
      ['ipfs://bafyfoo', 'ipfs'],
      ['ar://txid', 'arweave'],
      ['s3+https://cdn.example.test/x', 's3'],
      ['https://cdn.example.test/x', 's3'],
    ];
    for (const [pointer, backend] of cases) {
      const { seen, fetchImpl } = capture();
      await anchorEvidence(new Uint8Array([1]), {
        ...COMMON,
        upload: () => pointer,
        fetch: fetchImpl,
      });
      expect(seen.body.backend, pointer).toBe(backend);
    }

    const { seen, fetchImpl } = capture();
    await anchorEvidence(new Uint8Array([1]), {
      ...COMMON,
      upload: () => 'https://cdn.example.test/x',
      backend: 'arweave',
      fetch: fetchImpl,
    });
    expect(seen.body.backend).toBe('arweave');
  });

  it('leaves hosted mode byte-for-byte as it was', async () => {
    const { seen, fetchImpl } = capture();
    await anchorEvidence(new Uint8Array([1, 2, 3]), { ...COMMON, fetch: fetchImpl });

    expect(typeof seen.body.sealed).toBe('string');
    expect(seen.body.pointer).toBeUndefined();
    expect(seen.body.backend).toBe('s3');
    expect(seen.body.mode).toBe('direct');
  });
});

describe('sellerDigestFor pointer argument', () => {
  it('defaults to the hosted form, so existing callers are unchanged', () => {
    const pid = '0x' + 'ab'.repeat(32);
    const ch = '0x' + 'cd'.repeat(32);
    const payee = '0x' + '22'.repeat(20);

    expect(sellerDigestFor(pid, ch, payee, 'base')).toEqual(
      sellerDigestFor(pid, ch, payee, 'base', ''),
    );
    expect(sellerDigestFor(pid, ch, payee, 'base', 'ipfs://x')).not.toEqual(
      sellerDigestFor(pid, ch, payee, 'base'),
    );
  });

  it('binds the pointer on the ed25519 branch too', () => {
    const pid = '0x' + 'ab'.repeat(32);
    const ch = '0x' + 'cd'.repeat(32);
    const solanaPayee = 'F742C4VfFLQ9zRQyithoj5229ZgtX2WqKCSFKgH2EThq';

    expect(sellerDigestFor(pid, ch, solanaPayee, 'solana', 'ipfs://x')).not.toEqual(
      sellerDigestFor(pid, ch, solanaPayee, 'solana'),
    );
  });
});
