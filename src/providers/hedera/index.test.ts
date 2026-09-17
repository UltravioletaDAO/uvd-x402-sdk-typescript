import { describe, expect, it } from 'vitest';
import { PrivateKey, Transaction, TransferTransaction } from '@hiero-ledger/sdk';
import { HederaProvider, buildHederaRequirements, buildHederaRequest, validateHederaRequirements, type HederaNetwork } from './index';
import { getChainByName, getTokenConfig } from '../../chains';
import { X402Client } from '../../client/X402Client';
import { buildPaymentRequirements, resolveEnvelopeVersion } from '../../backend';

const offer = (network: HederaNetwork = 'hedera:testnet', asset = 'usdc', amountAtomic = '1000') =>
  buildHederaRequirements({ network, payTo: '0.0.222', amountAtomic, asset });
const provider = (network: HederaNetwork = 'hedera:testnet') => {
  const key = PrivateKey.generateED25519();
  return { key, signer: new HederaProvider({ network, accountId: '0.0.111', privateKey: key.toStringDer() }) };
};

describe('native Hedera', () => {
  it.each(['hedera:mainnet', 'hedera:testnet'] as const)('registers native IDs and distinct units on %s', network => {
    expect(getChainByName(network)?.chainId).toBe(0);
    expect(getChainByName(network)?.usdc.address).toBe(network === 'hedera:mainnet' ? '0.0.456858' : '0.0.429274');
    expect(getTokenConfig(network, 'hbar')).toMatchObject({ address: '0.0.0', decimals: 8, usdPegged: false });
  });
  it.each([
    ['hedera:mainnet', 'hbar'], ['hedera:mainnet', 'usdc'],
    ['hedera:testnet', 'hbar'], ['hedera:testnet', 'usdc'],
  ] as const)('signs exact principal and all node variants on %s %s', async (network, asset) => {
    const { key, signer } = provider(network);
    const r = offer(network, asset, '9007199254740993');
    const p = await signer.createPaymentPayload(r);
    const tx = Transaction.fromBytes(Buffer.from(p.payload.transaction, 'base64')) as TransferTransaction;
    expect(tx).toBeInstanceOf(TransferTransaction);
    expect(key.publicKey.verifyTransaction(tx)).toBe(true);
    expect(tx.nodeAccountIds?.map(x => x.toString())).toEqual(['0.0.3', '0.0.4', network === 'hedera:mainnet' ? '0.0.7' : '0.0.5']);
    expect(tx.transactionId?.accountId?.toString()).toBe(r.extra.feePayer);
    expect(tx.maxTransactionFee?.toTinybars().toString()).toBe('100000000');
    if (asset === 'hbar') {
      expect(tx.hbarTransfers.get('0.0.111')?.toTinybars().toString()).toBe('-9007199254740993');
      expect(tx.hbarTransfers.get('0.0.222')?.toTinybars().toString()).toBe('9007199254740993');
    } else {
      expect(tx.tokenTransfers.get(r.asset)?.get('0.0.111')?.toString()).toBe('-9007199254740993');
      expect(tx.tokenTransfers.get(r.asset)?.get('0.0.222')?.toString()).toBe('9007199254740993');
    }
    expect(buildHederaRequest(p, r).paymentRequirements).toEqual(r);
    expect(JSON.stringify(signer)).not.toContain(key.toStringDer());
  });
  it.each([
    ['amount', '0'], ['amount', '-1'], ['amount', '01'], ['amount', '1.1'], ['amount', '9223372036854775808'],
    ['maxTimeoutSeconds', 14], ['maxTimeoutSeconds', 181], ['maxTimeoutSeconds', true],
    ['scheme', 'upto'], ['network', 'eip155:296'], ['asset', '0.0.456858'],
    ['extra', { feePayer: '0.0.10576385', hook: true }], ['payTo', '0.0.0'],
  ])('refuses invalid %s=%j', (field, value) => {
    expect(() => validateHederaRequirements({ ...offer(), [String(field)]: value })).toThrow();
  });
  it('refuses another ledger, sponsor, self-payment and changed merchant price', async () => {
    const { signer } = provider();
    await expect(signer.createPaymentPayload(offer('hedera:mainnet'))).rejects.toThrow('ledger');
    await expect(signer.createPaymentPayload({ ...offer(), extra: { feePayer: '0.0.999' } })).rejects.toThrow('fee payer');
    await expect(signer.createPaymentPayload({ ...offer(), payTo: '0.0.111' })).rejects.toThrow('distinct');
    const p = await signer.createPaymentPayload(offer());
    expect(() => buildHederaRequest(p, { ...offer(), amount: '999' })).toThrow('echo');
  });
  it('requires v2 in merchant USD requirements and includes native sponsor', () => {
    const options = { amount: '0.001', recipient: '0.0.222', resource: 'https://merchant.example', chainName: 'hedera:testnet' };
    expect(() => buildPaymentRequirements(options)).toThrow('v2');
    const r = buildPaymentRequirements({ ...options, x402Version: 2 });
    expect(r.extra).toEqual({ feePayer: '0.0.10576385' });
    expect(r.maxAmountRequired).toBe('1000');
    expect(() => resolveEnvelopeVersion({ x402Version: 2, accepted: offer(), payload: { transaction: '' }, resource: { url: options.resource, description: '', mimeType: 'application/json' } }, r, 1)).toThrow('v2');
  });
  it.each(['hbar', 'usdc'] as const)('pays a 402 through the connected native adapter (%s)', async asset => {
    const { signer } = provider();
    const client = new X402Client();
    await client.connectWithAdapter(signer, 'hedera:testnet');
    const r = offer('hedera:testnet', asset, asset === 'hbar' ? '10000' : '1000');
    let calls = 0;
    const doFetch: typeof fetch = async (_url, init) => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ x402Version: 2, accepts: [r] }), { status: 402 });
      const header = new Headers(init?.headers).get('payment-signature')!;
      const p = JSON.parse(Buffer.from(header, 'base64').toString());
      expect(p.accepted).toEqual(r);
      expect(buildHederaRequest(p, r).x402Version).toBe(2);
      return new Response(JSON.stringify({ paid: true }));
    };
    const response = await client.fetch('https://merchant.example/paid', {
      tokenType: asset, maxAmount: asset === 'hbar' ? '0.0001' : '0.001', fetchImpl: doFetch,
    });
    expect(response.status).toBe(200); expect(calls).toBe(2);
  });
});
