/** Offline agent example. No RPC or transaction submission. Run after npm run build. */
import { createNearLocalSigner, buildEscrowMsg, computePaymentId, signEscrowAuthorization,
  release, refund, withdrawFor, NEAR_ESCROW_TOKENS } from '../dist/providers/near/index.mjs';

// A public deterministic test seed, never an operational wallet.
const signer = createNearLocalSigner(Uint8Array.from({ length: 32 }, (_, i) => i));
const context = { signer, network: 'near:testnet', senderId: 'payer-demo.testnet',
  escrowContract: 'arras-v1b-1101.testnet', nonce: '42', maxBlockHeight: '100000000' };
const msg = { operator_id: 'em', receiver: 'worker-demo.testnet',
  release_deadline: '1793577600000000000', reclaim_after: '1793664000000000000',
  fee_bps_max: 1300, terms_hash: '00'.repeat(32), salt: '00'.repeat(16) };
const token = NEAR_ESCROW_TOKENS[context.network];
const amount = '1000000';
const paymentId = computePaymentId({ ...msg, token, payer: context.senderId, amount });
const paymentPayload = await signEscrowAuthorization({ ...context, token, amount, msg });
const paymentRequirements = { scheme: 'escrow', network: context.network, amount, asset: token,
  payTo: msg.receiver, maxTimeoutSeconds: 60,
  extra: { nearEscrow: { contract: context.escrowContract, operatorId: msg.operator_id, msg: buildEscrowMsg(msg), paymentId } } };
let nonce = BigInt(context.nonce);
const capturer = () => ({ ...context, senderId: 'capturer-demo.testnet', nonce: (++nonce).toString() });
const lifecycle = (action, paymentPayload) => ({ x402Version: 2, paymentPayload,
  paymentRequirements: { scheme: 'escrow', network: context.network, amount: '0',
    extra: { nearEscrow: { contract: context.escrowContract, action } } } });
console.log(JSON.stringify({ offline: true, paymentId,
  authorize: { x402Version: 2, paymentPayload, paymentRequirements },
  release: lifecycle('release', await release(capturer(), paymentId)),
  withdrawWorker: lifecycle('withdraw_for', await withdrawFor(capturer(), msg.receiver)),
  withdrawFee: lifecycle('withdraw_for', await withdrawFor(capturer(), 'fees-demo.testnet')),
  // Alternative path for a second authorization with a fresh salt/payment ID.
  refundAlternative: lifecycle('refund', await refund(capturer(), paymentId)),
}, null, 2));
