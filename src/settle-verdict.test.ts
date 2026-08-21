import { describe, it, expect, vi, afterEach } from 'vitest';
import { FacilitatorClient } from './backend/index';
import type { X402Header, PaymentRequirements } from './backend/index';

/**
 * `settle()` must report the facilitator's verdict, not the transport's.
 *
 * The bug these pin: the return object hardcoded `success: true`, so a settle
 * was reported successful whenever the HTTP call was. "The request arrived" is
 * not "the money moved" — and the gap between them is not hypothetical. A
 * transfer that MINES AND THEN REVERTS is answered by x402-rs with HTTP 200 and
 * `success: false` (src/chain/evm.rs:1343, serialised through StatusCode::OK).
 *
 * Every consumer written as `result.success === true` was therefore reading a
 * constant. Downstream, reconciliation paths that exist precisely to flag an
 * unpaid delivery could never fire, and a reverted payment was booked as
 * settled.
 */

const HEADER = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: {
    signature: '0xdead',
    authorization: {
      from: '0x0000000000000000000000000000000000000001',
      to: '0x0000000000000000000000000000000000000002',
      value: '1000000',
      validAfter: '0',
      validBefore: '1800000000',
      nonce: '0x' + '11'.repeat(32),
    },
  },
} as unknown as X402Header;

const REQUIREMENTS = {
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '1000000',
  resource: 'https://example.test/thing',
  payTo: '0x0000000000000000000000000000000000000002',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
} as unknown as PaymentRequirements;

/** A facilitator that answers 200 with `body`. */
function facilitatorReturning(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('settle() reports the facilitator verdict', () => {
  it('a reverted payment (200 + success:false) is NOT reported as success', async () => {
    vi.stubGlobal('fetch', facilitatorReturning({
      success: false,
      errorReason: 'invalid_scheme',
      transaction: '0x' + 'ab'.repeat(32),
      network: 'base',
      payer: '0x0000000000000000000000000000000000000001',
    }));

    const result = await new FacilitatorClient().settle(HEADER, REQUIREMENTS);

    expect(result.success).toBe(false);
    // The reason has to survive, or the caller cannot tell a reverted transfer
    // from a rejected authorization without parsing prose.
    expect(result.errorReason).toBe('invalid_scheme');
    // A revert still produces a transaction — the caller may well need it.
    expect(result.transactionHash).toBe('0x' + 'ab'.repeat(32));
  });

  it('a settled payment is reported as success', async () => {
    vi.stubGlobal('fetch', facilitatorReturning({
      success: true,
      transaction: '0x' + 'cd'.repeat(32),
      network: 'base',
    }));

    const result = await new FacilitatorClient().settle(HEADER, REQUIREMENTS);

    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('0x' + 'cd'.repeat(32));
    expect(result.errorReason).toBeUndefined();
  });

  it('a response with no `success` field is not treated as success', async () => {
    // A facilitator that does not say it worked has not said it worked.
    vi.stubGlobal('fetch', facilitatorReturning({ network: 'base' }));

    expect((await new FacilitatorClient().settle(HEADER, REQUIREMENTS)).success).toBe(false);
  });

  it('proofOfPayment survives, in camelCase and snake_case', async () => {
    // Dropping this made DX402's `verified: true` unreachable through this
    // client: anchorEvidence documents proofOfPayment as the only thing that
    // gets there, and settle() was discarding it.
    const proof = {
      transactionHash: '0x' + 'ef'.repeat(32),
      blockNumber: 12345,
      network: 'base',
      payer: '0x0000000000000000000000000000000000000001',
      payee: '0x0000000000000000000000000000000000000002',
      amount: '1000000',
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      timestamp: 1760000000,
      paymentHash: '0x' + '99'.repeat(32),
    };

    vi.stubGlobal('fetch', facilitatorReturning({
      success: true, transaction: '0x' + 'ef'.repeat(32), network: 'base', proofOfPayment: proof,
    }));
    expect((await new FacilitatorClient().settle(HEADER, REQUIREMENTS)).proofOfPayment).toEqual(proof);

    vi.stubGlobal('fetch', facilitatorReturning({
      success: true, transaction: '0x' + 'ef'.repeat(32), network: 'base', proof_of_payment: proof,
    }));
    expect((await new FacilitatorClient().settle(HEADER, REQUIREMENTS)).proofOfPayment).toEqual(proof);
  });

  it('a non-2xx is still a transport error, distinct from a facilitator verdict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 503, text: async () => 'upstream down',
    }));

    const result = await new FacilitatorClient().settle(HEADER, REQUIREMENTS);

    expect(result.success).toBe(false);
    // `error` is this client failing to ask; `errorReason` is the facilitator
    // answering no. Collapsing them would lose which one happened.
    expect(result.error).toContain('503');
    expect(result.errorReason).toBeUndefined();
  });
});
