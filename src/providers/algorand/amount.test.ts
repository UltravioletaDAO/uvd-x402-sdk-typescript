/**
 * The amount an Algorand buyer signs is the price, to the atom.
 *
 * Drives the real `AlgorandProvider.signPayment` offline -- real `algosdk`, only
 * the algod params call and the Lute wallet stubbed -- and decodes the ASA
 * transfer (group index 1) out of the payload the facilitator receives.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import algosdk from 'algosdk';

import { AlgorandProvider } from './index';
import { getChainByName } from '../../chains';

const address = (fill: number) => algosdk.encodeAddress(new Uint8Array(32).fill(fill));
const PAYER = address(1);
const RECIPIENT = address(2);
const FACILITATOR = address(3);

// The "signed" transaction handed back is the unsigned one: its fields are what matter here.
const signTxns = vi.hoisted(() =>
  vi.fn(async (txns: Array<{ txn: string }>) => [null, txns[1].txn])
);

// The provider imports lute-connect lazily, at connect(), after PAYER exists.
vi.mock('lute-connect', () => ({
  default: class {
    connect = async () => [PAYER];
    signTxns = signTxns;
  },
}));

function cents(c: number): string {
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

let provider: AlgorandProvider;
const ALGORAND = getChainByName('algorand')!;

beforeAll(async () => {
  vi.stubGlobal('window', { algorand: {} });
  vi.spyOn(algosdk.Algodv2.prototype, 'getTransactionParams').mockReturnValue({
    do: async () => ({
      fee: 0n,
      minFee: 1000n,
      firstValid: 1000n,
      lastValid: 2000n,
      genesisID: 'mainnet-v1.0',
      genesisHash: new Uint8Array(32).fill(9),
    }),
  } as never);
  provider = new AlgorandProvider();
  await provider.connect();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Sign a payment for `amount` and return the amount of its ASA transfer. */
async function signedAmount(amount: string): Promise<bigint> {
  const { paymentIndex, paymentGroup } = JSON.parse(
    await provider.signPayment({ recipient: RECIPIENT, facilitator: FACILITATOR, amount }, ALGORAND)
  );
  const txn = algosdk.decodeUnsignedTransaction(Buffer.from(paymentGroup[paymentIndex], 'base64'));
  expect(txn.assetTransfer?.assetIndex).toBe(BigInt(ALGORAND.usdc.address));
  return txn.assetTransfer!.amount;
}

describe('AlgorandProvider.signPayment signs the exact atomic amount', () => {
  it('2.01 is 2,010,000 atoms, not 2,009,999', async () => {
    expect(await signedAmount('2.01')).toBe(2_010_000n);
  });

  it('every cent price 0.01..99.99 signs c * 10**4', async () => {
    for (let c = 1; c <= 9_999; c++) {
      expect(await signedAmount(cents(c)), cents(c)).toBe(BigInt(c) * 10_000n);
    }
  }, 120_000);

  it('an amount with more decimals than USDC has is refused before anything is signed', async () => {
    signTxns.mockClear();
    await expect(
      provider.signPayment(
        { recipient: RECIPIENT, facilitator: FACILITATOR, amount: '2.0100001' },
        ALGORAND
      )
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(signTxns).not.toHaveBeenCalled();
  });
});
