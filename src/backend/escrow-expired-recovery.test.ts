/**
 * An expired escrow is NOT the payer's problem to solve, and this SDK said it was.
 *
 * Three places in this repo asserted that once `authorizationExpiry` passes,
 * "only the payer's `reclaim()` can move the funds". Read the contract
 * (`AuthCaptureEscrow.sol`, vendored under x402-rs
 * `contracts/lib/commerce-payments/`) and that is false:
 *
 * - `partialVoid` is `onlySender(paymentInfo.operator)` — the operator is the
 *   FACILITATOR — it `_sendTokens(..., paymentInfo.payer, amount)`, and it
 *   contains **no `authorizationExpiry` check at all**.
 * - `reclaim` is `onlySender(paymentInfo.payer)` and gated on expiry. It is a
 *   payer's self-service escape hatch, not the only exit.
 *
 * So a release that reverted with `AfterAuthorizationExpiry` is recoverable
 * through `refundViaFacilitator` — no gas, no payer, expiry irrelevant. The
 * false claim is why stuck escrows were treated as written off.
 *
 * These tests pin the two things code can actually enforce: the request the SDK
 * sends is the operator-only `refundInEscrow` action, and a facilitator that
 * reached no verdict is not reported as a failed refund.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdvancedEscrowClient } from './index';
import type { AdvancedPaymentInfo } from './index';

const PAYER = '0x' + '44'.repeat(20);

function client(): AdvancedEscrowClient {
  const c = new AdvancedEscrowClient({ getAddress: async () => PAYER }, {
    chainId: 8453,
    retries: 0,
  });
  return c;
}

/** An escrow whose release window closed a day ago. */
function expiredPaymentInfo(c: AdvancedEscrowClient): AdvancedPaymentInfo {
  const pi = c.buildPaymentInfo('0x' + '33'.repeat(20), '5000000', 'micro');
  const yesterday = Math.floor(Date.now() / 1000) - 86400;
  return { ...pi, preApprovalExpiry: yesterday, authorizationExpiry: yesterday };
}

function leaseRefusal() {
  const body = JSON.stringify({
    error: 'this instance does not hold the EVM writer lease; retry',
    reason: 'holder_unknown',
  });
  return {
    ok: false,
    status: 503,
    headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? '5' : null) },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refundViaFacilitator on an expired escrow', () => {
  it('asks the OPERATOR to partialVoid, which needs neither the payer nor an unexpired window', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, transaction: '0x' + 'cd'.repeat(32) }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const c = client();
    const pi = expiredPaymentInfo(c);
    const result = await c.refundViaFacilitator(pi, '5000000');

    expect(result.success).toBe(true);

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    // `refundInEscrow` -> PaymentOperator -> escrow.partialVoid, which is
    // onlySender(operator) and never reads authorizationExpiry. `reclaim` is
    // the payer-only path and is deliberately NOT what we send.
    expect(sent.action).toBe('refundInEscrow');
    expect(sent.action).not.toBe('reclaim');
    // The window really is in the past — the point of the test.
    expect(sent.payload.paymentInfo.authorizationExpiry).toBeLessThan(
      Math.floor(Date.now() / 1000),
    );
    expect(sent.payload.amount).toBe('5000000');
  });

  it('does not declare a recoverable escrow lost when the facilitator reached no verdict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(leaseRefusal()));

    const c = client();
    const result = await c.refundViaFacilitator(expiredPaymentInfo(c), '5000000');

    // Before this change the non-2xx branch did not exist: `response.json()`
    // parsed the 503 body, `result.success` came back undefined, and the refund
    // was reported failed. The tokens were never touched.
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.status).toBe(503);
    expect(result.reason).toBe('holder_unknown');
    expect(result.safeToReplay).toBe(true);
  });

  it('names the status when the facilitator refuses with an empty body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
    );

    const c = client();
    const result = await c.refundViaFacilitator(expiredPaymentInfo(c), '5000000');

    expect(result.success).toBe(false);
    // "Refund failed" alone is a dead end; the caller needs a thread to pull.
    expect(result.error).toContain('HTTP 200');
  });
});
