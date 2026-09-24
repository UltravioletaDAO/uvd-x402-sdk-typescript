/**
 * The amount a Stellar buyer signs is the price, to the stroop.
 *
 * Drives the real `StellarProvider.signPayment` offline -- real
 * `@stellar/stellar-sdk`, only the Soroban RPC and Freighter stubbed -- and reads
 * the amount back out of the `transfer(from, to, amount)` invocation inside the
 * signed SorobanAuthorizationEntry, as well as the payload's own `amount` field.
 * Stellar USDC has 7 decimals: the float formula missed 636 of the 9,999 cent
 * prices here, against 151 at 6 decimals.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Keypair, scValToNative, xdr } from '@stellar/stellar-sdk';

import { StellarProvider } from './index';
import { getChainByName } from '../../chains';

const account = (fill: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, fill)).publicKey();
const PAYER = account(1);
const RECIPIENT = account(2);

const signAuthEntry = vi.hoisted(() =>
  vi.fn(async () => ({ signedAuthEntry: Buffer.alloc(64).toString('base64') }))
);

// The provider imports Freighter lazily, at connect(), after PAYER exists.
vi.mock('@stellar/freighter-api', () => ({
  isConnected: async () => ({ isConnected: true }),
  requestAccess: async () => ({}),
  getAddress: async () => ({ address: PAYER }),
  signAuthEntry,
}));

function cents(c: number): string {
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

let provider: StellarProvider;
const STELLAR = getChainByName('stellar')!;

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ json: async () => ({ result: { sequence: 1000 } }) }))
  );
  provider = new StellarProvider();
  await provider.connect();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/** Sign a payment for `amount`; return the signed transfer amount and the payload's. */
async function signedAmounts(amount: string): Promise<[bigint, string]> {
  const payload = JSON.parse(await provider.signPayment({ recipient: RECIPIENT, amount }, STELLAR));
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(payload.authorizationEntryXdr, 'base64');
  const transfer = entry.rootInvocation().function().contractFn();
  expect(transfer.functionName().toString()).toBe('transfer');
  return [scValToNative(transfer.args()[2]) as bigint, payload.amount];
}

describe('StellarProvider.signPayment signs the exact atomic amount', () => {
  it('2.01 is 20,100,000 stroops, not 20,099,999', async () => {
    expect(await signedAmounts('2.01')).toEqual([20_100_000n, '20100000']);
  });

  it('every cent price 0.01..99.99 signs c * 10**5', async () => {
    for (let c = 1; c <= 9_999; c++) {
      const expected = BigInt(c) * 100_000n;
      expect(await signedAmounts(cents(c)), cents(c)).toEqual([expected, expected.toString()]);
    }
  }, 120_000);

  it('an amount with more decimals than Stellar USDC has is refused before anything is signed', async () => {
    signAuthEntry.mockClear();
    await expect(
      provider.signPayment({ recipient: RECIPIENT, amount: '2.01000001' }, STELLAR)
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(signAuthEntry).not.toHaveBeenCalled();
  });
});
