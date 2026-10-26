/**
 * The anchor payment and its proof.
 *
 * `paymentHash` is checked against a second, byte-by-byte derivation of the
 * facilitator's preimage (x402-rs `types.rs::compute_payment_hash`: the
 * addresses enter as their EIP-55 TEXT, as alloy displays them). The payment
 * runs against the chain double: a real signed EIP-1559 transaction, parsed
 * and mined, with the USDC `Transfer` log the proof is read from.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  JsonRpcError,
  ReputationError,
  computePaymentHash,
  jsonRpc,
  payAndProve,
  provePayment,
  signPayment,
  type SignedPayment,
} from './index';
import { FakeChain, USDC, seededAddress, seededSigner } from '../../test/reputation/doubles';

const SIGNER = seededSigner('uvd-x402 reputation payment rater');
const PAYEE = seededAddress('uvd-x402 reputation payment viewer');

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(ReputationError);
    return (error as ReputationError).code;
  }
  throw new Error('expected a ReputationError');
}

/** The preimage written out by hand: tx[32] || u64 BE block || checksum text || checksum text || u256 BE amount. */
function byHand(tx: string, block: bigint, payer: string, payee: string, amount: bigint, text = ethers.getAddress): string {
  const blockBytes = new Uint8Array(8);
  new DataView(blockBytes.buffer).setBigUint64(0, block);
  const amountBytes = ethers.getBytes('0x' + amount.toString(16).padStart(64, '0'));
  const parts = [ethers.getBytes(tx), blockBytes, new TextEncoder().encode(text(payer)), new TextEncoder().encode(text(payee)), amountBytes];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return '0x' + bytesToHex(keccak_256(all));
}

describe('computePaymentHash', () => {
  const tx = '0x' + 'ab'.repeat(32);
  const payer = seededAddress('payer');
  const payee = seededAddress('payee');

  it('is the facilitator\'s preimage, with the addresses as EIP-55 text', () => {
    const expected = byHand(tx, 53_125_001n, payer, payee, 1000n);
    expect(computePaymentHash({ transactionHash: tx, blockNumber: 53_125_001, payer, payee, amount: '1000' })).toBe(expected);
    // Whatever case the caller writes, the preimage carries the checksum.
    expect(
      computePaymentHash({ transactionHash: tx.toUpperCase().replace('0X', '0x'), blockNumber: 53_125_001n, payer: payer.toLowerCase(), payee: payee.toLowerCase(), amount: 1000n })
    ).toBe(expected);
    // And the checksum is load-bearing: the lowercase text is another hash.
    expect(byHand(tx, 53_125_001n, payer, payee, 1000n, (a) => a.toLowerCase())).not.toBe(expected);
  });

  it('commits to the block, both addresses and the amount', () => {
    const base = computePaymentHash({ transactionHash: tx, blockNumber: 1, payer, payee, amount: 1 });
    expect(computePaymentHash({ transactionHash: tx, blockNumber: 2, payer, payee, amount: 1 })).not.toBe(base);
    expect(computePaymentHash({ transactionHash: tx, blockNumber: 1, payer: payee, payee: payer, amount: 1 })).not.toBe(base);
    expect(computePaymentHash({ transactionHash: tx, blockNumber: 1, payer, payee, amount: 2 })).not.toBe(base);
  });

  it('refuses what the facilitator could not parse', () => {
    expect(() => computePaymentHash({ transactionHash: '0x12', blockNumber: 1, payer, payee, amount: 1 })).toThrow(ReputationError);
    expect(() => computePaymentHash({ transactionHash: tx, blockNumber: 2n ** 64n, payer, payee, amount: 1 })).toThrow(ReputationError);
    expect(() => computePaymentHash({ transactionHash: tx, blockNumber: 1, payer: 'x', payee, amount: 1 })).toThrow(ReputationError);
    expect(() => computePaymentHash({ transactionHash: tx, blockNumber: 1, payer, payee, amount: -1 })).toThrow(ReputationError);
  });
});

describe('signPayment', () => {
  it('signs a type-2 USDC transfer from the rater, broadcasting nothing', async () => {
    const chain = new FakeChain();
    const p = await signPayment({ signer: SIGNER, rpc: chain, network: 'base', payee: PAYEE, amount: 1000 });
    expect(chain.count('eth_sendRawTransaction')).toBe(0);
    const tx = ethers.Transaction.from(p.rawTransaction);
    expect(tx.type).toBe(2);
    expect(tx.from).toBe(SIGNER.address);
    expect(tx.to).toBe(USDC);
    expect(Number(tx.chainId)).toBe(8453);
    expect(tx.hash?.toLowerCase()).toBe(p.transactionHash);
    const [to, amount] = new ethers.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', tx.data);
    expect([to, amount]).toEqual([PAYEE, 1000n]);
    expect(BigInt(tx.signature!.s) <= ethers.N / 2n).toBe(true);
    // 5 mwei base fee * 2 + 1 mwei tip; 55000 gas estimated * 1.25.
    expect(tx.maxFeePerGas).toBe(11_000_000n);
    expect(tx.gasLimit).toBe(68_750n);
  });

  it('refuses before signing: gas above the ceiling, a gas limit above the ceiling, ETH below the floor, no estimate', async () => {
    const chain = new FakeChain();
    chain.baseFee = 10n ** 9n;
    expect(await code(signPayment({ signer: SIGNER, rpc: chain, network: 'base', payee: PAYEE, amount: 1000 }))).toBe('gas_too_expensive');
    chain.baseFee = 5_000_000n;
    chain.estimate = 200_000n;
    expect(await code(signPayment({ signer: SIGNER, rpc: chain, network: 'base', payee: PAYEE, amount: 1000 }))).toBe('gas_too_expensive');
    chain.estimate = 55_000n;
    chain.balances.set(SIGNER.address.toLowerCase(), 10n);
    expect(await code(signPayment({ signer: SIGNER, rpc: chain, network: 'base', payee: PAYEE, amount: 1000 }))).toBe('balance_low');
    chain.balances.delete(SIGNER.address.toLowerCase());
    expect(
      await code(signPayment({ signer: SIGNER, rpc: chain, network: 'base', payee: PAYEE, amount: 1000, minNativeBalanceWei: 10n ** 19n }))
    ).toBe('balance_low');
    chain.script('eth_estimateGas', { error: new Error('execution reverted: ERC20: transfer amount exceeds balance') });
    expect(await code(signPayment({ signer: SIGNER, rpc: chain, network: 'base', payee: PAYEE, amount: 1000 }))).toBe('payment_estimate_failed');
    chain.usdcBalances.set(SIGNER.address.toLowerCase(), 999n);
    expect(await code(signPayment({ signer: SIGNER, rpc: chain, network: 'base', payee: PAYEE, amount: 1000 }))).toBe('balance_low');
    chain.assertConsumed();
  });

  it('never copies the message of a foreign RPC error, which may carry its URL and key', async () => {
    const leaky = {
      async request() {
        throw new Error('server response 401 (requestUrl="https://base.example/v2/SECRETKEY123")');
      },
    };
    let message = '';
    try {
      await signPayment({ signer: SIGNER, rpc: leaky, network: 'base', payee: PAYEE, amount: 1000 });
    } catch (error) {
      message = (error as Error).message;
      expect((error as ReputationError).code).toBe('rpc_failed');
    }
    expect(message).not.toContain('SECRETKEY123');
  });

  it('refuses a wrong chain, an unknown token, a self-payment, a zero amount and a signer without signHash', async () => {
    expect(await code(signPayment({ signer: SIGNER, rpc: new FakeChain({ chainId: 1 }), network: 'base', payee: PAYEE, amount: 1 }))).toBe('unexpected_chain');
    const chain = new FakeChain();
    expect(await code(signPayment({ signer: SIGNER, rpc: chain, network: 'avalanche', payee: PAYEE, amount: 1 }))).toBe('unsupported_token');
    expect(await code(signPayment({ signer: SIGNER, rpc: chain, network: 'base', payee: SIGNER.address, amount: 1 }))).toBe('invalid_input');
    expect(await code(signPayment({ signer: SIGNER, rpc: chain, network: 'base', payee: PAYEE, amount: 0 }))).toBe('invalid_input');
    expect(await code(signPayment({ signer: { address: SIGNER.address }, rpc: chain, network: 'base', payee: PAYEE, amount: 1 }))).toBe('signer_unavailable');
  });
});

async function paid(chain: FakeChain, amount = 1000): Promise<SignedPayment> {
  const p = await signPayment({ signer: SIGNER, rpc: chain, network: 'base', payee: PAYEE, amount });
  await chain.request({ method: 'eth_sendRawTransaction', params: [p.rawTransaction] });
  return p;
}

describe('provePayment', () => {
  it('reads the proof from the chain: the block\'s timestamp, the recomputed paymentHash', async () => {
    const chain = new FakeChain();
    const p = await paid(chain);
    chain.advance(1);
    const proof = await provePayment({ rpc: chain, payment: p, now: chain.now() });
    expect(proof.blockNumber).toBe(1001);
    expect(proof.timestamp).toBe(chain.header(1001).timestamp);
    expect(proof.network).toBe('base');
    expect(proof.token).toBe(USDC);
    expect(proof.payer).toBe(SIGNER.address);
    expect(proof.payee).toBe(PAYEE);
    expect(proof.amount).toBe('1000');
    expect(proof.paymentHash).toBe(byHand(p.transactionHash, 1001n, SIGNER.address, PAYEE, 1000n));
  });

  it('waits for confirmations, then for the receipt, and tells a consumed nonce apart', async () => {
    const chain = new FakeChain();
    const p = await paid(chain);
    expect(await code(provePayment({ rpc: chain, payment: p, now: chain.now() }))).toBe('payment_awaiting_confirmations');
    chain.autoMine = false;
    const pending = await signPayment({ signer: SIGNER, rpc: chain, network: 'base', payee: PAYEE, amount: 1000 });
    const error = await code(provePayment({ rpc: chain, payment: pending, now: chain.now() }));
    expect(error).toBe('payment_pending');
    chain.consumeNonce(SIGNER.address);
    expect(await code(provePayment({ rpc: chain, payment: pending, now: chain.now() }))).toBe('payment_nonce_consumed');
  });

  it('a node serving the nonce before the receipt (Celo): the payment is pending, not replaced', async () => {
    const chain = new FakeChain();
    const p = await paid(chain);
    chain.advance(2);
    chain.script('eth_getTransactionReceipt', { result: null });
    expect(await code(provePayment({ rpc: chain, payment: p, now: chain.now() }))).toBe('payment_pending');
    expect((await provePayment({ rpc: chain, payment: p, now: chain.now() })).transactionHash).toBe(p.transactionHash);
    chain.assertConsumed();
  });

  it('refuses a reverted payment, a transfer of another amount or to another wallet, a reorged block, an old payment', async () => {
    const chain = new FakeChain();
    chain.revertNextRaw = true;
    const reverted = await paid(chain);
    chain.advance(2);
    expect(await code(provePayment({ rpc: chain, payment: reverted, now: chain.now() }))).toBe('payment_reverted');

    const p = await paid(chain);
    chain.advance(2);
    expect(await code(provePayment({ rpc: chain, payment: { ...p, amount: '1001' }, now: chain.now() }))).toBe('payment_transfer_missing');
    expect(await code(provePayment({ rpc: chain, payment: { ...p, payee: seededAddress('x') }, now: chain.now() }))).toBe('payment_transfer_missing');
    expect(await code(provePayment({ rpc: chain, payment: { ...p, token: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42' }, now: chain.now() }))).toBe('unsupported_token');
    expect(await code(provePayment({ rpc: chain, payment: p, now: chain.now() + 7 * 86400 + 60 }))).toBe('proof_expired');
    chain.reorg();
    expect(await code(provePayment({ rpc: chain, payment: p, now: chain.now() }))).toBe('payment_block_hash_mismatch');
  });
});

describe('payAndProve', () => {
  const opts = (chain: FakeChain, extra: Partial<Parameters<typeof payAndProve>[0]> = {}) => ({
    signer: SIGNER,
    rpc: chain,
    network: 'base',
    payee: PAYEE,
    amount: 1000,
    onSigned: () => undefined,
    pollIntervalMs: 0,
    sleep: async () => chain.advance(1),
    now: () => chain.now(),
    ...extra,
  });

  it('stores the signed transaction before anything is broadcast', async () => {
    const chain = new FakeChain();
    let stored: SignedPayment | null = null;
    const proof = await payAndProve(
      opts(chain, {
        onSigned: (p) => {
          expect(chain.sentRaw).toHaveLength(0);
          stored = p;
        },
      })
    );
    expect(chain.sentRaw).toEqual([stored!.rawTransaction]);
    expect(proof.transactionHash).toBe(stored!.transactionHash);
  });

  it('broadcasts nothing when storing fails', async () => {
    const chain = new FakeChain();
    const boom = new Error('disk full');
    await expect(payAndProve(opts(chain, { onSigned: () => Promise.reject(boom) }))).rejects.toBe(boom);
    expect(chain.count('eth_sendRawTransaction')).toBe(0);
  });

  it('resumes: re-broadcasts the same bytes when the node lost them, tolerates "already known", signs nothing new', async () => {
    const chain = new FakeChain();
    chain.autoMine = false;
    const p = await signPayment({ signer: SIGNER, rpc: chain, network: 'base', payee: PAYEE, amount: 1000 });
    // Never broadcast (a crash right after storing it): resume sends it.
    const proof = await payAndProve(opts(chain, { resume: p, onSigned: () => { throw new Error('must not sign'); } }));
    expect(chain.sentRaw).toEqual([p.rawTransaction]);
    expect(proof.transactionHash).toBe(p.transactionHash);

    // Already in the node's mempool: "already known" is fine.
    const q = await signPayment({ signer: SIGNER, rpc: chain, network: 'base', payee: PAYEE, amount: 1000 });
    await chain.request({ method: 'eth_sendRawTransaction', params: [q.rawTransaction] });
    await payAndProve(opts(chain, { resume: q }));
    expect(chain.sentRaw).toEqual([p.rawTransaction, q.rawTransaction]);
  });

  it('does not re-broadcast a payment that is already mined', async () => {
    const chain = new FakeChain();
    const p = await paid(chain);
    chain.advance(2);
    const sends = chain.count('eth_sendRawTransaction');
    await payAndProve(opts(chain, { resume: p }));
    expect(chain.count('eth_sendRawTransaction')).toBe(sends);
  });

  it('refuses to resume a payment that is not this one', async () => {
    const chain = new FakeChain();
    const p = await signPayment({ signer: SIGNER, rpc: chain, network: 'base', payee: PAYEE, amount: 1000 });
    expect(await code(payAndProve(opts(chain, { resume: p, amount: 2000 })))).toBe('payment_mismatch');
    expect(await code(payAndProve(opts(chain, { resume: p, payee: seededAddress('y') })))).toBe('payment_mismatch');
    expect(await code(payAndProve(opts(chain, { resume: p, signer: seededSigner('another rater') })))).toBe('payment_mismatch');
  });

  it('gives up with a retryable error when the receipt does not come', async () => {
    const chain = new FakeChain();
    chain.autoMine = false;
    let error: unknown;
    try {
      await payAndProve(opts(chain, { maxPolls: 3, sleep: async () => undefined }));
    } catch (e) {
      error = e;
    }
    expect((error as ReputationError).code).toBe('payment_pending');
    expect((error as ReputationError).retryable).toBe(true);
  });
});

describe('jsonRpc', () => {
  const URL = 'https://rpc.example/v3/SECRETKEY123';
  const fake = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('returns the result', async () => {
    const rpc = jsonRpc(URL, { fetch: fake(200, { jsonrpc: '2.0', id: 1, result: '0x2105' }) });
    expect(await rpc.request({ method: 'eth_chainId' })).toBe('0x2105');
  });

  it('never puts the URL, with its key, in an error', async () => {
    for (const f of [
      fake(500, {}),
      fake(200, { error: { code: -32000, message: 'nonce too low' } }),
      (async () => {
        throw new TypeError(`connect ECONNREFUSED ${URL}`);
      }) as unknown as typeof fetch,
    ]) {
      const error = await jsonRpc(URL, { fetch: f }).request({ method: 'eth_chainId' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReputationError);
      expect(String((error as Error).message)).not.toContain('SECRETKEY123');
    }
    const rpcError = await jsonRpc(URL, { fetch: fake(200, { error: { code: -32000, message: 'nonce too low' } }) })
      .request({ method: 'eth_sendRawTransaction' })
      .catch((e: unknown) => e);
    expect(rpcError).toBeInstanceOf(JsonRpcError);
    expect((rpcError as JsonRpcError).rpcCode).toBe(-32000);
    expect((rpcError as JsonRpcError).rpcMessage).toBe('nonce too low');
  });
});
