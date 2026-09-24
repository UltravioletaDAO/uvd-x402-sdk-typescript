/**
 * The amount a NEAR buyer signs is the price, to the atom.
 *
 * Drives the real `NEARProvider.signPayment` offline -- the NEAR RPC and the
 * wallet are stubbed -- and reads the amount back out of the `ft_transfer`
 * arguments inside the borsh-serialized SignedDelegateAction, the bytes the
 * facilitator receives.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { NEARProvider } from './index';
import { getChainByName } from '../../chains';

const ACCOUNT = 'payer.near';
const RECIPIENT = 'merchant.near';
/** Any base58 ed25519 key: the provider only copies its bytes into the action. */
const PUBLIC_KEY = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';

const signMessage = vi.fn(async () => ({ signature: new Uint8Array(64), publicKey: PUBLIC_KEY }));

function cents(c: number): string {
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

/** Answers the three NEAR RPC reads the provider makes. */
async function nearRpc(_url: string, init: { body: string }) {
  const { method, params } = JSON.parse(init.body);
  let result: unknown;
  if (method === 'block') result = { header: { height: 100 } };
  else if (params.request_type === 'view_access_key_list') result = { keys: [{ public_key: PUBLIC_KEY }] };
  else if (params.request_type === 'view_access_key') result = { nonce: 5 };
  else throw new Error(`unexpected NEAR RPC call ${method} ${params.request_type}`);
  return { json: async () => ({ result }) };
}

let provider: NEARProvider;
const NEAR = getChainByName('near')!;

beforeAll(async () => {
  vi.stubGlobal('window', {
    myNearWallet: { signIn: async () => ({ accountId: ACCOUNT }), signMessage },
  });
  vi.stubGlobal('fetch', vi.fn(nearRpc));
  provider = new NEARProvider();
  await provider.connect();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/** Sign a payment for `amount` and return the `amount` argument of its ft_transfer. */
async function signedAmount(amount: string): Promise<string> {
  const { signedDelegateAction } = JSON.parse(
    await provider.signPayment({ recipient: RECIPIENT, amount }, NEAR)
  );
  const bytes = Buffer.from(signedDelegateAction, 'base64').toString('latin1');
  const args = bytes.match(/\{"receiver_id":"[^"]*","amount":"(\d+)"/);
  expect(args, 'ft_transfer args in the signed action').not.toBeNull();
  return args![1];
}

describe('NEARProvider.signPayment signs the exact atomic amount', () => {
  it('2.01 is 2,010,000 atoms, not 2,009,999', async () => {
    expect(await signedAmount('2.01')).toBe('2010000');
  });

  it('every cent price 0.01..99.99 signs c * 10**4', async () => {
    for (let c = 1; c <= 9_999; c++) {
      expect(await signedAmount(cents(c)), cents(c)).toBe(String(c * 10_000));
    }
  }, 120_000);

  it('an amount with more decimals than USDC has is refused before anything is signed', async () => {
    signMessage.mockClear();
    await expect(
      provider.signPayment({ recipient: RECIPIENT, amount: '2.0100001' }, NEAR)
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(signMessage).not.toHaveBeenCalled();
  });
});
