/**
 * The wiring, not the crypto: what `releaseViaFacilitator` /
 * `refundViaFacilitator` actually PUT ON THE WIRE.
 *
 * The signature itself is pinned in `src/lifecycle-auth.test.ts`. What is
 * pinned here is the half that a refactor breaks silently:
 *
 *   1. WITHOUT a signer the body is byte-for-byte the one that shipped before
 *      (the compatibility promise — every caller in production today passes
 *      no signer).
 *   2. WITH a signer, the order commits to the SAME paymentInfo, the SAME
 *      payer and the SAME amount that are submitted. Those three drifting
 *      apart is a `bad_signature` whose only symptom is that nothing ever
 *      verifies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { AdvancedEscrowClient, type AdvancedPaymentInfo } from './index';
import {
  LIFECYCLE_ORDER_TYPES,
  buildLifecycleTypedData,
  lifecycleAuthFromSignature,
  type LifecycleSigner,
} from '../lifecycle-auth';

const PAYER_KEY = `0x${'11'.repeat(32)}`;
const payerWallet = new ethers.Wallet(PAYER_KEY);

const PI: AdvancedPaymentInfo = {
  operator: '0x271f9fa7f8907aCf178CCFB470076D9129D8F0Eb',
  receiver: '0x2222222222222222222222222222222222222222',
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  maxAmount: '1000000',
  preApprovalExpiry: 1757003600,
  authorizationExpiry: 1757007200,
  refundExpiry: 1759592000,
  minFeeBps: 0,
  maxFeeBps: 1300,
  feeReceiver: '0xaE07cEB6b395BC685a776a0b4c489E8d9cE9A6ad',
  salt: '0x0000000000000000000000000000000000000000000000000000000000003039',
};

function signerAdapter(): LifecycleSigner {
  return {
    getAddress: () => payerWallet.address,
    async signTypedData(typedData: string) {
      const { domain, types, message } = JSON.parse(typedData) as {
        domain: ethers.TypedDataDomain;
        types: Record<string, Array<{ name: string; type: string }>>;
        message: Record<string, unknown>;
      };
      const clean = { ...types };
      delete clean['EIP712Domain'];
      return { signature: await payerWallet.signTypedData(domain, clean, message) };
    },
  };
}

/** A client whose payer is the test wallet and whose fetch is captured. */
function makeClient() {
  const client = new AdvancedEscrowClient(
    { getAddress: async () => payerWallet.address },
    { chainId: 8453, facilitatorUrl: 'https://facilitator.test' }
  );
  return client;
}

let bodies: Array<Record<string, unknown>>;

beforeEach(() => {
  bodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ success: true, transaction: '0xabc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Recover the signer straight from the body that was sent. */
function recoverFromBody(body: Record<string, unknown>, action: string): string {
  const payload = body.payload as Record<string, unknown>;
  const auth = payload.lifecycleAuth as {
    signer: string;
    deadline: number;
    nonce: string;
    signature: string;
  };
  const pi = payload.paymentInfo as Record<string, string | number>;
  const types = { ...LIFECYCLE_ORDER_TYPES };
  delete types['EIP712Domain'];
  return ethers.verifyTypedData(
    { name: 'x402 escrow lifecycle', version: '1', chainId: 8453 },
    types,
    {
      action,
      amount: String(payload.amount),
      deadline: String(auth.deadline),
      nonce: auth.nonce,
      paymentInfo: {
        operator: ethers.getAddress(String(pi.operator)),
        payer: ethers.getAddress(String(payload.payer)),
        receiver: ethers.getAddress(String(pi.receiver)),
        token: ethers.getAddress(String(pi.token)),
        maxAmount: String(pi.maxAmount),
        preApprovalExpiry: String(pi.preApprovalExpiry),
        authorizationExpiry: String(pi.authorizationExpiry),
        refundExpiry: String(pi.refundExpiry),
        minFeeBps: String(pi.minFeeBps),
        maxFeeBps: String(pi.maxFeeBps),
        feeReceiver: ethers.getAddress(String(pi.feeReceiver)),
        salt: BigInt(String(pi.salt)).toString(),
      },
    },
    auth.signature
  );
}

describe('release/refund without a lifecycle signer', () => {
  it('release sends the exact body it sent before lifecycle orders existed', async () => {
    const result = await makeClient().releaseViaFacilitator(PI);
    expect(result.success).toBe(true);
    // Pinned whole, not key-by-key: this is the promise to every caller in
    // production today, all of which pass no signer.
    expect(bodies[0]).toEqual({
      x402Version: 2,
      scheme: 'escrow',
      action: 'release',
      payload: {
        paymentInfo: { ...PI },
        payer: payerWallet.address,
        amount: '1000000',
      },
      paymentRequirements: {
        scheme: 'escrow',
        network: 'eip155:8453',
        extra: {
          escrowAddress: expect.any(String),
          operatorAddress: expect.any(String),
          tokenCollector: expect.any(String),
        },
      },
    });
  });

  it('refund sends no lifecycleAuth at all', async () => {
    const result = await makeClient().refundViaFacilitator(PI, '250000');
    expect(result.success).toBe(true);
    const payload = bodies[0].payload as Record<string, unknown>;
    expect('lifecycleAuth' in payload).toBe(false);
    expect(payload.amount).toBe('250000');
  });

  it('the unsigned body is identical with and without an empty options object', async () => {
    await makeClient().releaseViaFacilitator(PI);
    await makeClient().releaseViaFacilitator(PI, undefined, {});
    expect(JSON.stringify(bodies[0])).toBe(JSON.stringify(bodies[1]));
  });
});

describe('release/refund with a lifecycle signer', () => {
  it('release: the order recovers to the signer, over the submitted body', async () => {
    const result = await makeClient().releaseViaFacilitator(PI, undefined, {
      lifecycleSigner: signerAdapter(),
    });
    expect(result.success).toBe(true);

    const payload = bodies[0].payload as Record<string, unknown>;
    const auth = payload.lifecycleAuth as { signer: string; nonce: string; deadline: number };
    expect(auth.signer).toBe(payerWallet.address);
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(recoverFromBody(bodies[0], 'release')).toBe(payerWallet.address);
  });

  it('release: a partial amount is the amount that got signed', async () => {
    await makeClient().releaseViaFacilitator(PI, '250000', {
      lifecycleSigner: signerAdapter(),
    });
    const payload = bodies[0].payload as Record<string, unknown>;
    expect(payload.amount).toBe('250000');
    // Recovery uses payload.amount; if the signature had committed to
    // maxAmount this would recover to a different address.
    expect(recoverFromBody(bodies[0], 'release')).toBe(payerWallet.address);
  });

  it('refundInEscrow: signs its own action, not release', async () => {
    await makeClient().refundViaFacilitator(PI, undefined, {
      lifecycleSigner: signerAdapter(),
    });
    expect(recoverFromBody(bodies[0], 'refundInEscrow')).toBe(payerWallet.address);
    expect(recoverFromBody(bodies[0], 'release')).not.toBe(payerWallet.address);
  });

  it('each call carries a fresh nonce', async () => {
    const client = makeClient();
    await client.releaseViaFacilitator(PI, undefined, { lifecycleSigner: signerAdapter() });
    await client.releaseViaFacilitator(PI, undefined, { lifecycleSigner: signerAdapter() });
    const a = (bodies[0].payload as Record<string, { nonce: string }>).lifecycleAuth.nonce;
    const b = (bodies[1].payload as Record<string, { nonce: string }>).lifecycleAuth.nonce;
    expect(a).not.toBe(b);
  });

  it('a deadline past the ceiling fails before the request is sent', async () => {
    const result = await makeClient().releaseViaFacilitator(PI, undefined, {
      lifecycleSigner: signerAdapter(),
      lifecycleDeadline: Math.floor(Date.now() / 1000) + 4000,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/deadline_too_far/);
    expect(bodies).toHaveLength(0);
  });
});

describe('release/refund transporting an order signed elsewhere', () => {
  /**
   * What the publisher's browser produced: a document this backend built, a
   * signature from the wallet, reassembled into the wire block. The backend
   * never sees a key.
   */
  async function orderFromBrowser(
    action: 'release' | 'refundInEscrow',
    amount: string
  ): Promise<ReturnType<typeof lifecycleAuthFromSignature>> {
    const typedData = buildLifecycleTypedData({
      action,
      paymentInfo: PI,
      payer: payerWallet.address,
      amount,
      chainId: 8453,
    });
    const types = { ...typedData.types };
    delete types['EIP712Domain'];
    const signature = await payerWallet.signTypedData(
      typedData.domain as ethers.TypedDataDomain,
      types,
      typedData.message
    );
    return lifecycleAuthFromSignature(typedData, signature, payerWallet.address);
  }

  it('release: the block travels byte for byte, nothing re-derived', async () => {
    const auth = await orderFromBrowser('release', '1000000');
    const result = await makeClient().releaseViaFacilitator(PI, undefined, {
      lifecycleAuth: auth,
    });
    expect(result.success).toBe(true);

    const payload = bodies[0].payload as Record<string, unknown>;
    // Deep-equal, not field by field: re-signing or "normalizing" any part of
    // it changes bytes the browser committed to and nobody would notice until
    // the facilitator answered `bad_signature`.
    expect(payload.lifecycleAuth).toEqual(auth);
    // And it is still the order the SDK would have signed itself.
    expect(recoverFromBody(bodies[0], 'release')).toBe(payerWallet.address);
  });

  it('refundInEscrow: the same, with its own action', async () => {
    const auth = await orderFromBrowser('refundInEscrow', '250000');
    const result = await makeClient().refundViaFacilitator(PI, '250000', {
      lifecycleAuth: auth,
    });
    expect(result.success).toBe(true);
    expect((bodies[0].payload as Record<string, unknown>).lifecycleAuth).toEqual(auth);
    expect(recoverFromBody(bodies[0], 'refundInEscrow')).toBe(payerWallet.address);
  });

  it('an order signed for a DIFFERENT amount than the one sent does not recover', async () => {
    // The trap the split flow makes reachable: the browser signs the bounty,
    // the backend sends a partial. Both halves look right on their own.
    const auth = await orderFromBrowser('release', '1000000');
    await makeClient().releaseViaFacilitator(PI, '250000', { lifecycleAuth: auth });
    expect((bodies[0].payload as Record<string, unknown>).amount).toBe('250000');
    expect(recoverFromBody(bodies[0], 'release')).not.toBe(payerWallet.address);
  });

  it('a signer and a pre-signed order together is an error, and nothing is sent', async () => {
    const auth = await orderFromBrowser('release', '1000000');
    const result = await makeClient().releaseViaFacilitator(PI, undefined, {
      lifecycleSigner: signerAdapter(),
      lifecycleAuth: auth,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mutually exclusive/);
    expect(bodies).toHaveLength(0);
  });

  it('the same refusal on the refund path', async () => {
    const auth = await orderFromBrowser('refundInEscrow', '1000000');
    const result = await makeClient().refundViaFacilitator(PI, undefined, {
      lifecycleSigner: signerAdapter(),
      lifecycleAuth: auth,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mutually exclusive/);
    expect(bodies).toHaveLength(0);
  });

  it('lifecycleDeadline is ignored next to a pre-signed order', async () => {
    // The order already carries the deadline it was signed with. A ceiling
    // check here would be checking a clock that is not the one that signed.
    const auth = await orderFromBrowser('release', '1000000');
    const result = await makeClient().releaseViaFacilitator(PI, undefined, {
      lifecycleAuth: auth,
      lifecycleDeadline: Math.floor(Date.now() / 1000) + 4000,
    });
    expect(result.success).toBe(true);
    const sent = (bodies[0].payload as Record<string, { deadline: number }>).lifecycleAuth;
    expect(sent.deadline).toBe(auth.deadline);
  });
});
