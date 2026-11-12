import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import vectors from './vectors/arras-v1.json';
import {
  buildEscrowMsg, computePaymentId, paymentIdPreimage, createNearLocalSigner, signEscrowAuthorization,
  signEscrowLifecycle, NEAR_ESCROW_TOKENS, type NearEscrowNetwork, type NearEscrowLifecycleMethod,
} from './escrow';
import { buildArrasStorageDeposit } from './storage';

/**
 * Arras v1 regression: everything the SDK produced for v1 before Arras v2 support, byte for byte. Ed25519 is
 * deterministic, so the signed wires are fixed too. The digest was recorded on origin/main (c092a38, 2.114.0)
 * before the v2 change, and the v2 change must not move it.
 */
const V1_BYTES_SHA256 = 'a2f6a818dff14af84be2e1e43828662411217452c2467d060704a1510f4e3a17';

const signer = createNearLocalSigner(Uint8Array.from({ length: 32 }, (_, i) => i));
const v1Contracts: Record<NearEscrowNetwork, string> = {
  'near:testnet': 'arras-v1b-1101.testnet',
  'near:mainnet': 'v1.arras-escrow.near',
};

async function everythingV1(): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const network of ['near:testnet', 'near:mainnet'] as const) {
    const token = NEAR_ESCROW_TOKENS[network];
    const escrowContract = v1Contracts[network];
    for (const v of vectors.payment_id.vectores) {
      const context = { network, signer, senderId: v.payer, escrowContract, nonce: '42', maxBlockHeight: '100000000' };
      out.push(buildEscrowMsg(v), Buffer.from(paymentIdPreimage(v)).toString('hex'), computePaymentId(v),
        computePaymentId({ ...v, token }));
      out.push(await signEscrowAuthorization({ ...context, token, amount: v.amount, msg: v }));
      const calls: [NearEscrowLifecycleMethod, Record<string, string>][] = [
        ['release', { payment_id: v.payment_id }], ['release', { payment_id: v.payment_id, amount: '400000' }],
        ['refund', { payment_id: v.payment_id }], ['reclaim', { payment_id: v.payment_id }],
        ['withdraw', {}], ['withdraw_for', { account: v.receiver }]];
      for (const [method, args] of calls) out.push(await signEscrowLifecycle(context, method, args));
    }
    out.push(buildArrasStorageDeposit({ network, payerId: vectors.payment_id.vectores[0].payer, escrowContract }));
  }
  return out;
}

describe('Arras v1 bytes do not move with v2 support', () => {
  it('msg, preimage, payment ID, authorization, lifecycle and storage for V-1..V-3 on both networks', async () => {
    const all = await everythingV1();
    expect(all).toHaveLength(2 * (3 * 11 + 1));
    expect(createHash('sha256').update(JSON.stringify(all)).digest('hex')).toBe(V1_BYTES_SHA256);
  });
});
