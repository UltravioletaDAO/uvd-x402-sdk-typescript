import { describe, expect, it } from 'vitest';

import { AdvancedEscrowClient, TIER_TIMINGS } from './index';
import { REVIEW_WINDOW_SEC } from '../escrow-preauth';

/**
 * The release window must outlast the REVIEW, not just the tier.
 *
 * Production incident 2026-08-19: `micro` gives a two-hour `authorizationExpiry`.
 * A release attempted **26.2 hours** later reverted with
 * `AfterAuthorizationExpiry` — the worker went unpaid. 8 escrows stuck on one
 * network in 24h.
 *
 * The original of this comment said the funds could then be moved only by the
 * payer's `reclaim()`. That is false: `partialVoid` is operator-only, ignores
 * `authorizationExpiry`, and refunds the payer, so the facilitator can always
 * unwind a stuck escrow (`refundViaFacilitator`). What a too-short window
 * destroys is the WORKER'S payment, which no refund restores — which is what
 * these tests defend.
 */
function client(): any {
  const c = Object.create(AdvancedEscrowClient.prototype) as any;
  c.contracts = { operator: '0x' + '11'.repeat(20), usdc: '0x' + '22'.repeat(20) };
  return c;
}

describe('buildPaymentInfo release window', () => {
  const now = () => Math.floor(Date.now() / 1000);

  it('survives a real approval loop on the micro tier', () => {
    const t0 = now();
    const pi = client().buildPaymentInfo('0x' + '33'.repeat(20), '20000', 'micro');
    expect(pi.authorizationExpiry - t0).toBeGreaterThanOrEqual(REVIEW_WINDOW_SEC);
    // the exact case that failed in production
    expect(pi.authorizationExpiry).toBeGreaterThan(t0 + 26.2 * 3600);
    // and the raw tier alone would not have
    expect(TIER_TIMINGS.micro.auth).toBeLessThan(26.2 * 3600);
  });

  it('lets a later deadline push the window out, never in', () => {
    const c = client();
    const base = c.buildPaymentInfo('0x' + '33'.repeat(20), '20000', 'micro');
    const later = c.buildPaymentInfo('0x' + '33'.repeat(20), '20000', 'micro', undefined, {
      deadline: now() + 5 * 86400,
    });
    expect(later.authorizationExpiry).toBeGreaterThan(base.authorizationExpiry);
  });

  it('always opens the refund window after the release window closes', () => {
    const c = client();
    for (const tier of ['micro', 'standard', 'premium', 'enterprise'] as const) {
      const pi = c.buildPaymentInfo('0x' + '33'.repeat(20), '20000', tier);
      // refundExpiry <= authorizationExpiry would strand the funds entirely
      expect(pi.refundExpiry).toBeGreaterThan(pi.authorizationExpiry);
      expect(pi.preApprovalExpiry).toBeLessThanOrEqual(pi.authorizationExpiry);
    }
  });
});
