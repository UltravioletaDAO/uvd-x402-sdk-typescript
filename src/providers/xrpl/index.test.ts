import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { XRPLProvider } from './index';
import { getChainByName } from '../../chains';
import type { PaymentInfo } from '../../types';
import { X402Error } from '../../types';

// ---------------------------------------------------------------------------
// Mock the optional `xrpl` package so the provider can build + sign offline.
// ---------------------------------------------------------------------------

const signMock = vi.fn();
const autofillMock = vi.fn();
const connectMock = vi.fn();
const disconnectMock = vi.fn();
const getXrpBalanceMock = vi.fn();

vi.mock('xrpl', () => {
  return {
    Client: class {
      connect = connectMock;
      disconnect = disconnectMock;
      autofill = autofillMock;
      getXrpBalance = getXrpBalanceMock;
    },
    Wallet: {
      fromSeed: (_seed: string) => ({
        classicAddress: 'rPAYERAddrXXXXXXXXXXXXXXXXXXXXXXXX',
        address: 'rPAYERAddrXXXXXXXXXXXXXXXXXXXXXXXX',
        sign: signMock,
      }),
    },
    convertStringToHex: (value: string) =>
      Array.from(value)
        .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase(),
  };
});

const TESTNET_PAYTO = 'rGhTioKAFHe75KgVnQtacRiKFuPv28Wbwk';

function makePaymentInfo(overrides: Partial<PaymentInfo> = {}): PaymentInfo {
  return {
    recipient: TESTNET_PAYTO,
    amount: '1.50',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  connectMock.mockResolvedValue(undefined);
  disconnectMock.mockResolvedValue(undefined);
  getXrpBalanceMock.mockResolvedValue('42.123456');
  // autofill returns the tx with Fee/Sequence/LastLedgerSequence populated.
  autofillMock.mockImplementation(async (tx: Record<string, unknown>) => ({
    ...tx,
    Fee: '12',
    Sequence: 100,
    LastLedgerSequence: 9999,
  }));
  signMock.mockReturnValue({ tx_blob: 'DEADBEEFCAFE', hash: 'HASH123' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('XRPLProvider registration', () => {
  it('reports xrpl networkType and a stable id/name', () => {
    const provider = new XRPLProvider({ seed: 'sEXAMPLESEED' });
    expect(provider.networkType).toBe('xrpl');
    expect(provider.id).toBe('xrpl-seed');
    expect(provider.name).toBe('XRP Ledger');
  });

  it('isAvailable() is true only when a seed is provided', () => {
    expect(new XRPLProvider({ seed: 'sEXAMPLESEED' }).isAvailable()).toBe(true);
    expect(new XRPLProvider().isAvailable()).toBe(false);
  });

  it('connect() derives the classic r-address from the seed', async () => {
    const provider = new XRPLProvider({ seed: 'sEXAMPLESEED' });
    const address = await provider.connect();
    expect(address).toMatch(/^r/);
    expect(provider.getAddress()).toBe(address);
  });

  it('connect() without a seed throws WALLET_NOT_FOUND', async () => {
    const provider = new XRPLProvider();
    await expect(provider.connect()).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });

  it('disconnect() clears the in-memory signer', async () => {
    const provider = new XRPLProvider({ seed: 'sEXAMPLESEED' });
    await provider.connect();
    await provider.disconnect();
    expect(provider.getAddress()).toBeNull();
  });
});

describe('XRPLProvider.signPayment payload shape', () => {
  it('returns a payload whose ONLY field is signedTxBlob (camelCase)', async () => {
    const provider = new XRPLProvider({ seed: 'sEXAMPLESEED', testnet: true });
    await provider.connect();

    const json = await provider.signPayment(makePaymentInfo(), getChainByName('xrpl-testnet')!);
    const payload = JSON.parse(json);

    expect(Object.keys(payload)).toEqual(['signedTxBlob']);
    expect(payload.signedTxBlob).toBe('DEADBEEFCAFE');
    // Legacy shape must be gone.
    expect(payload.txBlob).toBeUndefined();
    expect(payload.from).toBeUndefined();
    expect(payload.to).toBeUndefined();
    expect(payload.amount).toBeUndefined();
  });

  it('builds a native XRP Payment with Destination=payTo, integer drops, and Flags=0', async () => {
    const provider = new XRPLProvider({ seed: 'sEXAMPLESEED', testnet: true });
    await provider.connect();

    await provider.signPayment(makePaymentInfo({ amount: '1.50' }), getChainByName('xrpl-testnet')!);

    // autofill receives the unsigned Payment.
    const built = autofillMock.mock.calls[0][0] as Record<string, unknown>;
    expect(built.TransactionType).toBe('Payment');
    expect(built.Destination).toBe(TESTNET_PAYTO);
    // This pin SURVIVES 2.85.0 unchanged, and that is the point of the fix
    // rather than a gap in it. `PaymentInfo.amount` on XRPL was always read
    // here as whole XRP; what was wrong is that the type documented it as USD,
    // so the merchant side scaled a dollar price into the same field and the
    // two readings met on the wire. The SDK now refuses to build that dollar
    // price at all, which leaves this reading the only one -- so 1.50 XRP ->
    // 1,500,000 drops is now the whole truth instead of half of a contradiction.
    expect(built.Amount).toBe('1500000'); // 1.50 XRP -> integer drops (6 decimals)
    expect(built.Flags).toBe(0); // tfPartialPayment OFF
    expect('SendMax' in built).toBe(false); // never cross-currency

    // The fully-signed prepared tx must carry LastLedgerSequence.
    const prepared = signMock.mock.calls[0][0] as Record<string, unknown>;
    expect(prepared.LastLedgerSequence).toBe(9999);
  });

  it('prefers paymentInfo.recipients.xrpl over the default recipient', async () => {
    const provider = new XRPLProvider({ seed: 'sEXAMPLESEED', testnet: true });
    await provider.connect();

    await provider.signPayment(
      makePaymentInfo({
        recipient: 'rWRONGdefaultXXXXXXXXXXXXXXXXXXXX',
        recipients: { xrpl: TESTNET_PAYTO },
      }),
      getChainByName('xrpl-testnet')!
    );

    const built = autofillMock.mock.calls[0][0] as Record<string, unknown>;
    expect(built.Destination).toBe(TESTNET_PAYTO);
  });

  it('rejects a non-XRPL recipient address', async () => {
    const provider = new XRPLProvider({ seed: 'sEXAMPLESEED', testnet: true });
    await provider.connect();

    await expect(
      provider.signPayment(makePaymentInfo({ recipient: '0xnotxrpl' }), getChainByName('xrpl-testnet')!)
    ).rejects.toBeInstanceOf(X402Error);
  });

  it('fails closed if autofill omits LastLedgerSequence', async () => {
    autofillMock.mockImplementationOnce(async (tx: Record<string, unknown>) => ({
      ...tx,
      Fee: '12',
      Sequence: 100,
      // LastLedgerSequence intentionally missing
    }));
    const provider = new XRPLProvider({ seed: 'sEXAMPLESEED', testnet: true });
    await provider.connect();

    await expect(
      provider.signPayment(makePaymentInfo(), getChainByName('xrpl-testnet')!)
    ).rejects.toMatchObject({ code: 'PAYMENT_FAILED' });
  });

  it('rejects when autofill reintroduces tfPartialPayment', async () => {
    autofillMock.mockImplementationOnce(async (tx: Record<string, unknown>) => ({
      ...tx,
      Fee: '12',
      Sequence: 100,
      LastLedgerSequence: 9999,
      Flags: 0x00020000, // tfPartialPayment
    }));
    const provider = new XRPLProvider({ seed: 'sEXAMPLESEED', testnet: true });
    await provider.connect();

    await expect(
      provider.signPayment(makePaymentInfo(), getChainByName('xrpl-testnet')!)
    ).rejects.toMatchObject({ code: 'PAYMENT_FAILED' });
  });
});

describe('XRPLProvider.signPayment signs the exact amount in drops', () => {
  const cents = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

  it('every cent amount 0.01..99.99 builds a Payment of c * 10**4 drops', async () => {
    const provider = new XRPLProvider({ seed: 'sEXAMPLESEED', testnet: true });
    await provider.connect();
    for (let c = 1; c <= 9_999; c++) {
      autofillMock.mockClear();
      await provider.signPayment(makePaymentInfo({ amount: cents(c) }), getChainByName('xrpl-testnet')!);
      const built = autofillMock.mock.calls[0][0] as Record<string, unknown>;
      expect(built.Amount, cents(c)).toBe(String(c * 10_000));
    }
  }, 120_000);

  // These used to fall through to Math.round(parseFloat(...)) and be signed rounded.
  it.each(['1.0000005', '1e3', '-1', 'abc'])(
    'refuses %j with INVALID_AMOUNT before connecting or signing',
    async (amount) => {
      const provider = new XRPLProvider({ seed: 'sEXAMPLESEED', testnet: true });
      await provider.connect();
      await expect(
        provider.signPayment(makePaymentInfo({ amount }), getChainByName('xrpl-testnet')!)
      ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
      expect(connectMock).not.toHaveBeenCalled();
      expect(signMock).not.toHaveBeenCalled();
    }
  );
});

describe('XRPLProvider.encodePaymentHeader', () => {
  it('encodes a v1 X-PAYMENT header carrying only signedTxBlob', async () => {
    const provider = new XRPLProvider({ seed: 'sEXAMPLESEED' });
    await provider.connect();

    const header = provider.encodePaymentHeader(JSON.stringify({ signedTxBlob: 'ABCD' }), 1);
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));

    expect(decoded.x402Version).toBe(1);
    expect(decoded.scheme).toBe('exact');
    expect(decoded.network).toBe('xrpl');
    expect(decoded.payload).toEqual({ signedTxBlob: 'ABCD' });
  });

  it('uses the same network id for v2 (the registry carries no CAIP-2 id for XRPL)', async () => {
    const provider = new XRPLProvider({ seed: 'sEXAMPLESEED', testnet: true });
    await provider.connect();

    const header = provider.encodePaymentHeader(JSON.stringify({ signedTxBlob: 'ABCD' }), 2);
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));

    expect(decoded.x402Version).toBe(2);
    expect(decoded.network).toBe('xrpl-testnet');
    expect(decoded.payload).toEqual({ signedTxBlob: 'ABCD' });
  });
});

describe('XRPLProvider.getBalance', () => {
  it('returns the native XRP balance formatted to 2 decimals', async () => {
    const provider = new XRPLProvider({ seed: 'sEXAMPLESEED' });
    await provider.connect();
    const balance = await provider.getBalance(getChainByName('xrpl')!);
    expect(balance).toBe('42.12');
  });
});
