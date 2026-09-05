import { describe, expect, it } from 'vitest';

import { AdvancedEscrowClient } from './index';
import {
  DEFAULT_MAX_FEE_BPS,
  DEFAULT_MIN_FEE_BPS,
  MAX_PROTOCOL_FEE_BPS,
  OPERATOR_FEE_BPS,
} from '../escrow-preauth';

/**
 * The signed `maxFeeBps` is a CEILING the payer commits to, and the operator
 * contract compares the whole fee against it before the escrow ever opens:
 *
 *   PaymentOperator.authorize -> _calculateFees -> if (totalFeeBps > maxFeeBps)
 *                                                  revert FeeBoundsIncompatible
 *
 * [VERIFICADO: x402-rs/contracts/src/operator/payment/PaymentOperator.sol:197-199,
 * and the identical guard on charge() at :246-248]
 *
 * So a `maxFeeBps` below the operator's own fee does not shave the fee — it
 * makes the deposit itself revert, and nobody is paid at all. This SDK states
 * the canonical operator fee as OPERATOR_FEE_BPS and `buildEscrowPreAuth`
 * already refuses to sign a bound that cannot cover it. `AdvancedEscrowClient`
 * signs the same struct for the same contracts, so it must agree.
 */
function client(): any {
  const c = Object.create(AdvancedEscrowClient.prototype) as any;
  c.contracts = { operator: '0x' + '11'.repeat(20), usdc: '0x' + '22'.repeat(20) };
  return c;
}

const RECEIVER = '0x' + '33'.repeat(20);

describe('escrow fee bounds have one source', () => {
  it('AdvancedEscrowClient signs a maxFeeBps that can cover the operator fee', () => {
    const pi = client().buildPaymentInfo(RECEIVER, '20000', 'standard');
    // Below this the on-chain authorize reverts with FeeBoundsIncompatible.
    expect(pi.maxFeeBps).toBeGreaterThanOrEqual(OPERATOR_FEE_BPS);
  });

  it('signs exactly the bound the escrow-preauth path signs', () => {
    const pi = client().buildPaymentInfo(RECEIVER, '20000', 'standard');
    expect(pi.minFeeBps).toBe(DEFAULT_MIN_FEE_BPS);
    expect(pi.maxFeeBps).toBe(DEFAULT_MAX_FEE_BPS);
  });

  it('derives the ceiling instead of re-typing it', () => {
    // The number nobody may write by hand again: the operator's canonical fee
    // plus the protocol's on-chain hard cap, because PaymentOperator compares
    // their SUM against maxFeeBps.
    expect(DEFAULT_MAX_FEE_BPS).toBe(OPERATOR_FEE_BPS + MAX_PROTOCOL_FEE_BPS);
    expect(MAX_PROTOCOL_FEE_BPS).toBe(500);
  });

  it('refuses an override that the operator fee cannot fit under', () => {
    // The old hardcoded value, now rejected where the caller can still react
    // instead of on-chain after the payer signed.
    expect(() => client().buildPaymentInfo(RECEIVER, '20000', 'standard', undefined, { maxFeeBps: 800 }))
      .toThrow(/cannot cover the operator/);
  });

  it('still lets a caller tighten the bound above the operator fee', () => {
    const pi = client().buildPaymentInfo(RECEIVER, '20000', 'standard', undefined, {
      maxFeeBps: OPERATOR_FEE_BPS,
    });
    expect(pi.maxFeeBps).toBe(OPERATOR_FEE_BPS);
  });
});
