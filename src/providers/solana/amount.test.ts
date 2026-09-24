/**
 * The amount an SVM buyer signs is the price, to the atom.
 *
 * Drives the real `SVMProvider.signPayment` offline -- real `@solana/web3.js` and
 * `@solana/spl-token`, only the RPC calls and Phantom stubbed -- and reads the
 * amount back out of the TransferChecked instruction in the serialized
 * transaction, the bytes the facilitator receives.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { SVMProvider } from './index';
import { getChainByName } from '../../chains';
import type { PaymentInfo } from '../../types';

const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill));
const PAYER = key(1);
const RECIPIENT = key(2);
const FACILITATOR = key(3);
const BLOCKHASH = key(4).toBase58();

/** SPL Token instruction tag for TransferChecked. */
const TRANSFER_CHECKED = 12;

const signTransaction = vi.fn(async <T>(tx: T) => tx);

function cents(c: number): string {
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

let provider: SVMProvider;
const SOLANA = getChainByName('solana')!;

beforeAll(async () => {
  vi.stubGlobal('window', {
    phantom: {
      solana: {
        isPhantom: true,
        isConnected: true,
        publicKey: { toBase58: () => PAYER.toBase58() },
        connect: async () => ({ publicKey: { toBase58: () => PAYER.toBase58() } }),
        disconnect: async () => undefined,
        signTransaction,
      },
    },
  });
  // Recipient ATA exists (no create instruction); a fixed blockhash.
  vi.spyOn(Connection.prototype, 'getAccountInfo').mockResolvedValue({} as never);
  vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 1,
  });

  provider = new SVMProvider();
  await provider.connect();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Sign a payment for `amount` and return [atomic amount, decimals] from its TransferChecked. */
async function signedTransfer(amount: string): Promise<[bigint, number]> {
  const info: PaymentInfo = {
    recipient: RECIPIENT.toBase58(),
    facilitator: FACILITATOR.toBase58(),
    amount,
  };
  const { transaction } = JSON.parse(await provider.signPayment(info, SOLANA));
  const message = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64')).message;
  const transfers = message.compiledInstructions.filter(
    (ix) =>
      message.staticAccountKeys[ix.programIdIndex].equals(TOKEN_PROGRAM_ID) &&
      ix.data[0] === TRANSFER_CHECKED
  );
  expect(transfers).toHaveLength(1);
  const data = Buffer.from(transfers[0].data);
  return [data.readBigUInt64LE(1), data[9]];
}

describe('SVMProvider.signPayment signs the exact atomic amount', () => {
  it('2.01 is 2,010,000 atoms, not 2,009,999', async () => {
    expect(await signedTransfer('2.01')).toEqual([2_010_000n, 6]);
  });

  it('every cent price 0.01..99.99 signs c * 10**4', async () => {
    for (let c = 1; c <= 9_999; c++) {
      const [atomic] = await signedTransfer(cents(c));
      expect(atomic, cents(c)).toBe(BigInt(c) * 10_000n);
    }
  }, 120_000);

  it('an amount with more decimals than USDC has is refused before anything is signed', async () => {
    signTransaction.mockClear();
    await expect(
      provider.signPayment(
        { recipient: RECIPIENT.toBase58(), facilitator: FACILITATOR.toBase58(), amount: '2.0100001' },
        SOLANA
      )
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(signTransaction).not.toHaveBeenCalled();
  });
});
