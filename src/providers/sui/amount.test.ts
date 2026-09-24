/**
 * The amount a Sui buyer signs is the price, to the atom.
 *
 * Drives the real `SuiProvider.signPayment` offline -- a real `Transaction` from
 * `@mysten/sui`, with only the coin lookup, the wallet and the final `build()`
 * (which would need a live node for gas) stubbed -- and reads the amount back
 * out of the BCS-encoded u64 the SplitCoins command splits off, as well as the
 * payload's own `amount` field.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

import { SuiProvider } from './index';
import { getChainByName } from '../../chains';

const id = (byte: string) => `0x${byte.repeat(32)}`;
const PAYER = id('11');
const RECIPIENT = id('22');
const FACILITATOR = id('33');
const USDC_COIN = id('44');

const signTransaction = vi.fn(async () => ({ signature: 'c2ln', bytes: 'AA==' }));

function cents(c: number): string {
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

let provider: SuiProvider;
const build = vi.spyOn(Transaction.prototype, 'build');
const SUI = getChainByName('sui')!;

beforeAll(async () => {
  vi.stubGlobal('window', {
    suiWallet: { getAccounts: async () => [PAYER], signTransaction },
  });
  vi.spyOn(SuiClient.prototype, 'getCoins').mockResolvedValue({
    data: [{ coinObjectId: USDC_COIN, balance: '1000000000000' }],
    hasNextPage: false,
    nextCursor: null,
  } as never);
  build.mockResolvedValue(new Uint8Array([0]));
  provider = new SuiProvider();
  await provider.connect();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Sign a payment for `amount`; return the u64 SplitCoins splits off and the payload's amount. */
async function signedAmounts(amount: string): Promise<[bigint, string]> {
  const payload = JSON.parse(
    await provider.signPayment({ recipient: RECIPIENT, facilitator: FACILITATOR, amount }, SUI)
  );
  const data = (build.mock.contexts.at(-1) as Transaction).getData();
  const splits = data.commands.filter((command) => command.SplitCoins);
  expect(splits).toHaveLength(1);
  const [split] = splits[0].SplitCoins!.amounts;
  if (split.$kind !== 'Input') throw new Error('SplitCoins amount is not a transaction input');
  const pure = data.inputs[split.Input].Pure;
  if (!pure) throw new Error('SplitCoins amount is not a pure input');
  return [Buffer.from(pure.bytes, 'base64').readBigUInt64LE(0), payload.amount];
}

describe('SuiProvider.signPayment signs the exact atomic amount', () => {
  it('2.01 is 2,010,000 atoms, not 2,009,999', async () => {
    expect(await signedAmounts('2.01')).toEqual([2_010_000n, '2010000']);
  });

  it('every cent price 0.01..99.99 signs c * 10**4', async () => {
    for (let c = 1; c <= 9_999; c++) {
      const expected = BigInt(c) * 10_000n;
      expect(await signedAmounts(cents(c)), cents(c)).toEqual([expected, expected.toString()]);
    }
  }, 120_000);

  it('an amount with more decimals than USDC has is refused before anything is signed', async () => {
    signTransaction.mockClear();
    await expect(
      provider.signPayment(
        { recipient: RECIPIENT, facilitator: FACILITATOR, amount: '2.0100001' },
        SUI
      )
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(signTransaction).not.toHaveBeenCalled();
  });
});
