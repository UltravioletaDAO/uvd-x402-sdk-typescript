import { describe, expect, it } from 'vitest';
import vectors from './fixtures/facilitator-receipts-v1.json';
import { createPurchaseContext, fetchWithReceipt, parseFacilitatorReceipt, paymentResponseHeaders,
  receiptCommitment, receiptFromResponse, validatePurchaseContext, verifyFacilitatorReceipt } from './receipts';
import type { X402FetchOptions } from './types';

describe('portable facilitator receipts', () => {
  for (const example of vectors.cases) {
    it(`shares the signed ${example.network} ${example.symbol} vector with Rust and Python`, () => {
      const receipt = parseFacilitatorReceipt(example.receipt)!;
      expect(verifyFacilitatorReceipt(receipt, vectors.jwks)).toBe(true);
      expect(verifyFacilitatorReceipt(receipt, vectors.jwks, 'https://impostor.example')).toBe(false);
      const forged = structuredClone(receipt);
      forged.amount = '2000'; forged.request.amount = '2000';
      forged.requestHash = receiptCommitment(forged.requestHashVersion, forged.request);
      expect(verifyFacilitatorReceipt(forged, vectors.jwks)).toBe(false);
    });
  }

  it('resumes after a lost response without signing again and retains a receipt beside HTTP 500', async () => {
    let signatures = 0;
    const sent: string[] = [];
    const snapshots: string[] = [];
    const buyer = async (url: string, options: X402FetchOptions) => {
      const probe = await options.fetchImpl!(url, options.init);
      if (probe.status !== 402) return probe;
      signatures++;
      const headers = new Headers(options.init?.headers); headers.set('X-PAYMENT', 'one-authorization');
      return options.fetchImpl!(url, { ...options.init, headers });
    };
    const merchant: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (!headers.get('X-PAYMENT')) return new Response('{}', { status: 402 });
      sent.push(headers.get('X-PAYMENT')!);
      if (sent.length === 1) throw new TypeError('connection lost after settlement');
      const header = headers.get('X-UVD-Purchase')!;
      const context = JSON.parse(Buffer.from(header, 'base64').toString());
      validatePurchaseContext(header, init?.method || 'GET', String(input), new Uint8Array());
      const receipt = structuredClone(vectors.cases[5].receipt) as Record<string, unknown>;
      const request = { ...vectors.cases[5].receipt.request, purchaseId: context.purchaseId, method: context.method, url: context.url, bodySha256: context.bodySha256 };
      Object.assign(receipt, { request, requestHash: receiptCommitment('uvd-x402-request-v1', request), purchaseId: context.purchaseId,
        operation: 'settle', status: 'confirmed', proof: null, settlement: { id: '0.0.3003@1700000000.000000001', idType: 'hedera-transaction-id' } });
      return new Response('merchant failed after payment', { status: 500, headers: paymentResponseHeaders({ success: true, receipt }) });
    };
    const persist = (context: unknown) => { snapshots.push(JSON.stringify(context)); };
    const first = await fetchWithReceipt(buyer, 'https://merchant.example/data', { context: createPurchaseContext(), persist, fetchImpl: merchant });
    expect(first.paymentState).toBe('unknown'); expect(first.response).toBeNull();
    const context = JSON.parse(snapshots.at(-1)!);
    const second = await fetchWithReceipt(buyer, 'https://merchant.example/data', { context, persist, fetchImpl: merchant });
    expect(signatures).toBe(1); expect(sent).toEqual(['one-authorization', 'one-authorization']);
    expect(second.paymentState).toBe('confirmed'); expect(second.response?.status).toBe(500);
    expect(second.response?.bodyUsed).toBe(false);
    expect(await second.response?.text()).toBe('merchant failed after payment');
    await expect(fetchWithReceipt(buyer, 'https://merchant.example/other', { context, persist, fetchImpl: merchant })).rejects.toThrow('another HTTP request');
    expect(signatures).toBe(1);
  });

  it('does not send a signed request when persistence fails', async () => {
    let sent = 0;
    const merchant: typeof fetch = async () => { sent++; return new Response('{}'); };
    const buyer = async (url: string, options: X402FetchOptions) => options.fetchImpl!(url, { headers: { 'X-PAYMENT': 'one-authorization' } });
    await expect(fetchWithReceipt(buyer, 'https://merchant.example/data', {
      context: createPurchaseContext(), fetchImpl: merchant, persist: () => { throw new Error('storage failed'); },
    })).rejects.toThrow('storage failed');
    expect(sent).toBe(0);
  });

  it('rejects ambiguous, truncated and future receipts without consuming the response', () => {
    expect(receiptFromResponse(new Response('untouched'))).toBeNull();
    const headers = new Headers(paymentResponseHeaders({ receipt: vectors.cases[0].receipt }));
    headers.append('PAYMENT-RESPONSE', headers.get('PAYMENT-RESPONSE')!);
    expect(() => receiptFromResponse(new Response('untouched', { headers }))).toThrow('ambiguous');
    expect(() => parseFacilitatorReceipt({ ...vectors.cases[0].receipt, schemaVersion: 2 })).toThrow('unsupported');
  });
});
