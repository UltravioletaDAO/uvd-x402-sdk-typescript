import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ethers } from 'ethers';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AdvancedEscrowClient,
  ESCROW_CONTRACTS,
  OPERATOR_ABI,
  OPERATOR_ABI_CREATE3,
  PAYMENT_INFO_TYPEHASH,
  USDC_DOMAIN_NAME,
} from './index';
import type { AdvancedPaymentInfo } from './index';

/**
 * No-regression snapshot of the on-chain escrow calls, recorded ONCE from
 * 2.98.0 (origin/main ef9397e) before any escrow generation work began.
 *
 * The fixture holds, for a fixed PaymentInfo on Base (8453, `OPERATOR_ABI`)
 * and SKALE Base (1187947933, `OPERATOR_ABI_CREATE3`), the exact calldata
 * and destination of `release`, `refundInEscrow`, `charge` and
 * `refundPostEscrow`, in both signer modes, plus the `/settle` body and the
 * typed data of `authorize`. It also holds the registry entries, the two
 * operator ABIs and the USDC domain names as they were then.
 *
 * The fixture is never re-recorded: a difference is a regression on a chain
 * that was already live. `UVD_RECORD_ESCROW_SNAPSHOT=1` only writes a
 * MISSING fixture and refuses to overwrite one.
 *
 * Nothing leaves the process: sends are captured and aborted, `fetch` is
 * stubbed, and the adapter mode's provider reads are stubbed.
 *
 * Hex values of 32 bytes or more are stored WITHOUT the 0x prefix, as in
 * `src/escrow-preauth.vectors.json`; `dehydrate` strips it before comparing.
 */

const FIXTURE = resolve(__dirname, '..', 'fixtures', 'escrow-operator-snapshot.json');
const RECORD = process.env.UVD_RECORD_ESCROW_SNAPSHOT === '1';

const CHAINS = [8453, 1187947933];
const PAYER = '0x2222222222222222222222222222222222222222';
const RECEIVER = '0x1111111111111111111111111111111111111111';
const SIGNATURE = '0x' + '11'.repeat(65);
const PARTIAL = '1250000';
const RPC_URL = 'http://127.0.0.1:9';
const FACILITATOR_URL = 'http://facilitator.invalid';
const NOT_SENT = 'recorded, not sent';

function fixedPaymentInfo(chainId: number): AdvancedPaymentInfo {
  const c = ESCROW_CONTRACTS[chainId];
  return {
    operator: c.operator,
    receiver: RECEIVER,
    token: c.usdc,
    maxAmount: '5000000',
    preApprovalExpiry: 1760003600,
    authorizationExpiry: 1761036800,
    refundExpiry: 1761641600,
    minFeeBps: 0,
    maxFeeBps: 1800,
    feeReceiver: c.operator,
    salt: '0x5eedc0de',
  };
}

const LONG_HEX = /^0x[0-9a-f]{64,}$/;

function dehydrate(value: unknown): unknown {
  if (typeof value === 'string' && LONG_HEX.test(value)) return value.slice(2);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(dehydrate);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, dehydrate(v)]));
  return value;
}

type Call = (client: AdvancedEscrowClient, pi: AdvancedPaymentInfo) => Promise<unknown>;

const CALLS: Array<[string, Call]> = [
  ['authorize', (c, pi) => c.authorize(pi)],
  ['release', (c, pi) => c.release(pi)],
  ['release.partial', (c, pi) => c.release(pi, PARTIAL)],
  ['refundInEscrow', (c, pi) => c.refundInEscrow(pi)],
  ['refundInEscrow.partial', (c, pi) => c.refundInEscrow(pi, PARTIAL)],
  ['charge', (c, pi) => c.charge(pi)],
  ['refundPostEscrow', (c, pi) => c.refundPostEscrow(pi)],
];

async function settle(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    return { resolved: await promise };
  } catch (e: any) {
    return { rejected: e?.message ?? String(e) };
  }
}

function stubFacilitator(bodies: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      bodies.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ success: true, transaction: '0xfeed' }) };
    }),
  );
}

/** ethers.Signer mode: the Contract hands the populated tx to `sendTransaction`. */
async function recordSignerMode(chainId: number, call: Call): Promise<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  const typedData: unknown[] = [];
  const bodies: unknown[] = [];
  const signer = {
    provider: null,
    getAddress: async () => PAYER,
    signTypedData: async (domain: unknown, types: unknown, message: unknown) => {
      typedData.push({ domain, types, message });
      return SIGNATURE;
    },
    sendTransaction: async (tx: Record<string, unknown>) => {
      sent.push({ to: tx.to, data: tx.data, gasLimit: tx.gasLimit });
      throw new Error(NOT_SENT);
    },
  };
  stubFacilitator(bodies);
  try {
    const client = new AdvancedEscrowClient(signer, { chainId, facilitatorUrl: FACILITATOR_URL });
    const outcome = await settle(call(client, fixedPaymentInfo(chainId)));
    return { outcome, sent, typedData, bodies };
  } finally {
    vi.unstubAllGlobals();
  }
}

/** SigningWalletAdapter mode: the unsigned tx reaches `signTransaction`. */
async function recordAdapterMode(chainId: number, call: Call): Promise<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  const typedData: unknown[] = [];
  const bodies: unknown[] = [];
  const wallet = {
    getAddress: () => PAYER,
    signTypedData: async (json: string) => {
      typedData.push(JSON.parse(json));
      return { signature: SIGNATURE, v: 27, r: '0x', s: '0x' };
    },
    signTransaction: async (unsignedSerialized: string) => {
      const tx = ethers.Transaction.from(unsignedSerialized);
      sent.push({
        to: tx.to,
        data: tx.data,
        gasLimit: tx.gasLimit,
        chainId: tx.chainId,
        nonce: tx.nonce,
        type: tx.type,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      });
      throw new Error(NOT_SENT);
    },
  };
  const nonceSpy = vi
    .spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionCount')
    .mockResolvedValue(7);
  const feeSpy = vi
    .spyOn(ethers.JsonRpcProvider.prototype, 'getFeeData')
    .mockResolvedValue(new ethers.FeeData(null, 2_000_000_000n, 1_000_000_000n));
  stubFacilitator(bodies);
  try {
    const client = new AdvancedEscrowClient(null, {
      chainId,
      wallet: wallet as any,
      rpcUrl: RPC_URL,
      facilitatorUrl: FACILITATOR_URL,
    });
    const outcome = await settle(call(client, fixedPaymentInfo(chainId)));
    return { outcome, sent, typedData, bodies };
  } finally {
    nonceSpy.mockRestore();
    feeSpy.mockRestore();
    vi.unstubAllGlobals();
  }
}

async function buildSnapshot(): Promise<Record<string, unknown>> {
  const calls: Record<string, unknown> = {};
  for (const chainId of CHAINS) {
    const perChain: Record<string, unknown> = { paymentInfo: fixedPaymentInfo(chainId) };
    for (const [name, call] of CALLS) {
      perChain[name] = {
        signer: await recordSignerMode(chainId, call),
        adapter: await recordAdapterMode(chainId, call),
      };
    }
    calls[String(chainId)] = perChain;
  }
  return {
    _note: [
      'Recorded once from uvd-x402-sdk 2.98.0 (origin/main ef9397e) by',
      'src/backend/escrow-operator-snapshot.test.ts with UVD_RECORD_ESCROW_SNAPSHOT=1.',
      'Never re-recorded: a difference is a regression on a chain that was already live.',
      'Hex values of 32 bytes or more are stored without the 0x prefix.',
    ],
    registry: ESCROW_CONTRACTS,
    operatorAbi: OPERATOR_ABI,
    operatorAbiCreate3: OPERATOR_ABI_CREATE3,
    usdcDomainName: USDC_DOMAIN_NAME,
    paymentInfoTypehash: PAYMENT_INFO_TYPEHASH,
    calls,
  };
}

describe('escrow operator snapshot (recorded at 2.98.0, never re-recorded)', () => {
  let actual: any;
  let expected: any;

  beforeAll(async () => {
    actual = dehydrate(await buildSnapshot());
    if (RECORD) {
      if (existsSync(FIXTURE)) {
        throw new Error(`${FIXTURE} already exists; the snapshot is never re-recorded.`);
      }
      writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + '\n');
    }
    expected = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  });

  it('keeps every recorded registry entry exactly as it was', () => {
    for (const chainId of Object.keys(expected.registry)) {
      expect(actual.registry[chainId], `ESCROW_CONTRACTS[${chainId}]`).toEqual(expected.registry[chainId]);
    }
  });

  it('keeps OPERATOR_ABI and OPERATOR_ABI_CREATE3 byte for byte', () => {
    expect(actual.operatorAbi).toEqual(expected.operatorAbi);
    expect(actual.operatorAbiCreate3).toEqual(expected.operatorAbiCreate3);
    expect(actual.paymentInfoTypehash).toBe(expected.paymentInfoTypehash);
  });

  it('keeps every recorded USDC domain name', () => {
    for (const chainId of Object.keys(expected.usdcDomainName)) {
      expect(actual.usdcDomainName[chainId], `USDC_DOMAIN_NAME[${chainId}]`).toBe(
        expected.usdcDomainName[chainId],
      );
    }
  });

  for (const chainId of CHAINS) {
    for (const [name] of CALLS) {
      it(`${chainId} ${name}: same calldata, destination, signed data and outcome`, () => {
        expect(actual.calls[chainId][name]).toEqual(expected.calls[chainId][name]);
      });
    }
    it(`${chainId}: the fixed PaymentInfo is the recorded one`, () => {
      expect(actual.calls[chainId].paymentInfo).toEqual(expected.calls[chainId].paymentInfo);
    });
  }

  it('records a real transaction for every on-chain call (the capture is not empty)', () => {
    for (const chainId of CHAINS) {
      for (const [name] of CALLS.filter(([n]) => n !== 'authorize')) {
        for (const mode of ['signer', 'adapter']) {
          const sent = expected.calls[chainId][name][mode].sent;
          expect(sent, `${chainId} ${name} ${mode}`).toHaveLength(1);
          expect(sent[0].to).toBe(ESCROW_CONTRACTS[chainId].operator);
        }
      }
    }
  });
});
