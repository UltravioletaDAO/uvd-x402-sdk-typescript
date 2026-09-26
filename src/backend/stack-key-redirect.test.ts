/**
 * Does X-UVD-Stack-Key follow a 30x from a house facilitator to a host the
 * gate rejects?
 *
 * "casa"  = http://127.0.0.1:<p1>, listed in stackKeyHosts (a house facilitator
 *           for the gate), answers every request with a redirect to "ajeno".
 * "ajeno" = http://localhost:<p2>, NOT listed: the gate refuses it as a base URL.
 *
 * Every assertion states the SAFE property. A red here is a leak.
 * The key is synthetic. Nothing leaves the machine.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { BazaarClient, Erc8004Client, FacilitatorClient, AdvancedEscrowClient } from './index';
import type { PaymentRequirements } from './index';
import type { X402Header } from '../types';

const KEY = `uvdsk_${'synthetic-redirect-key_'.repeat(3)}`;
const TX = '0x' + '22'.repeat(32);
const ANSWER = { isValid: true, success: true, transaction: TX, network: 'base', payer: '0x01' };
const HEADER = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: {
    signature: '0xdead',
    authorization: {
      from: '0x0000000000000000000000000000000000000001',
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      value: '1000000',
      validAfter: '0',
      validBefore: '9999999999',
      nonce: '0x' + '11'.repeat(32),
    },
  },
} as unknown as X402Header;
const REQUIREMENTS = {
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '1000000',
  resource: 'https://merchant.example/data',
  description: '',
  mimeType: 'application/json',
  payTo: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  maxTimeoutSeconds: 300,
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
} as PaymentRequirements;

type Seen = { method: string; path: string; keyArrived: boolean; bodyBytes: number };

let casa: http.Server;
let ajeno: http.Server;
let casaUrl = '';
let ajenoUrl = '';
const atAjeno: Seen[] = [];
let status = 307;

beforeAll(async () => {
  ajeno = http.createServer((req, res) => {
    let bytes = 0;
    req.on('data', (c: Buffer) => (bytes += c.length));
    req.on('end', () => {
      // Booleans only: the report never carries the value.
      atAjeno.push({
        method: req.method || '',
        path: req.url || '',
        keyArrived: req.headers['x-uvd-stack-key'] === KEY,
        bodyBytes: bytes,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ANSWER));
    });
  });
  // '::' is dual stack on Windows and Linux: "localhost" resolves either way.
  await new Promise<void>((r) => ajeno.listen(0, '::', r));
  ajenoUrl = `http://localhost:${(ajeno.address() as AddressInfo).port}`;

  casa = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { Location: `${ajenoUrl}${req.url}` });
      res.end();
    });
  });
  await new Promise<void>((r) => casa.listen(0, '127.0.0.1', r));
  casaUrl = `http://127.0.0.1:${(casa.address() as AddressInfo).port}`;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(async () => {
  await new Promise<void>((r) => casa.close(() => r()));
  await new Promise<void>((r) => ajeno.close(() => r()));
});

const house = () => ({ baseUrl: casaUrl, stackKey: KEY, stackKeyHosts: ['127.0.0.1'], retries: 0 });

describe('stack key: redirects', () => {
  it('control: the gate refuses ajeno as a base URL (no key when called directly)', async () => {
    atAjeno.length = 0;
    const direct = new FacilitatorClient({ baseUrl: ajenoUrl, stackKey: KEY, stackKeyHosts: ['127.0.0.1'], retries: 0 });
    await direct.verify(HEADER, REQUIREMENTS);
    expect(atAjeno.map((s) => s.keyArrived)).toEqual([false]);
  });

  for (const code of [301, 302, 303, 307, 308]) {
    it(`FacilitatorClient verify+settle: a ${code} from casa never carries the key to ajeno`, async () => {
      status = code;
      atAjeno.length = 0;
      const client = new FacilitatorClient(house());
      await client.verify(HEADER, REQUIREMENTS);
      await client.settle(HEADER, REQUIREMENTS);
      // Printed so a report can quote what arrived (booleans and sizes only).
      console.log(`[redirect] ${code} FacilitatorClient ->`, JSON.stringify(atAjeno));
      expect(atAjeno.filter((s) => s.keyArrived)).toEqual([]);
    });
  }

  it('FacilitatorClient GET routes (supported, health, version): a 302 never carries the key', async () => {
    status = 302;
    atAjeno.length = 0;
    const client = new FacilitatorClient(house());
    await client.getSupported().catch(() => undefined);
    await client.healthCheck().catch(() => undefined);
    await client.getVersion().catch(() => undefined);
    console.log('[redirect] GET routes ->', JSON.stringify(atAjeno));
    expect(atAjeno.filter((s) => s.keyArrived)).toEqual([]);
  });

  it('Erc8004Client read and BazaarClient list: a 302 never carries the key', async () => {
    status = 302;
    atAjeno.length = 0;
    await new Erc8004Client(house()).getIdentityTotalSupply('base' as never).catch(() => undefined);
    await new BazaarClient(house()).listResources().catch(() => undefined);
    console.log('[redirect] ERC-8004 + Bazaar ->', JSON.stringify(atAjeno));
    expect(atAjeno.filter((s) => s.keyArrived)).toEqual([]);
  });

  it('AdvancedEscrowClient /escrow/state: a 307 never carries the key', async () => {
    status = 307;
    atAjeno.length = 0;
    const signer = {
      provider: null,
      getAddress: async () => '0x1111111111111111111111111111111111111111',
      signTypedData: async () => '0x' + 'ab'.repeat(65),
    };
    const escrow = new AdvancedEscrowClient(signer, {
      chainId: 8453,
      retries: 0,
      facilitatorUrl: casaUrl,
      stackKey: KEY,
      stackKeyHosts: ['127.0.0.1'],
    });
    const pi = {
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
      salt: '0x' + '00'.repeat(30) + '3039',
    };
    await escrow.queryEscrowState(pi as never).catch(() => undefined);
    console.log('[redirect] AdvancedEscrow state ->', JSON.stringify(atAjeno));
    expect(atAjeno.filter((s) => s.keyArrived)).toEqual([]);
  });
});
