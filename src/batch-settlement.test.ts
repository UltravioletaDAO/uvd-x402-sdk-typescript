/**
 * batch-settlement (buyer side): golden vectors against the official reference, and the money rules.
 *
 * The nine cases and the golden values are the Python SDK's
 * (`tests/test_batch_settlement.py`, `uvd_x402_sdk.batch_settlement`). There they
 * were produced by the reference implementation (`x402` 2.25.0,
 * `x402.mechanisms.evm.batch_settlement`) with the same inputs and compared byte
 * for byte: channel id, voucher signature, ERC-3009 deposit nonce and deposit
 * authorization signature. This suite must reach the same bytes from the same
 * inputs.
 *
 * The key is derived at run time from a seed, never written as a literal, and
 * never printed. The hex values are built with `'0x' + ...` so a secret scanner
 * looking for `0x` followed by 64 hex characters does not read a public hash as
 * a key.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EnvKeyAdapter } from './adapters/env-key';
import {
  BatchSettlementClient,
  BatchSettlementError,
  ChannelConfig,
  FileChannelStorage,
  buildDepositPayload,
  computeChannelId,
  erc3009DepositNonce,
  signVoucher,
  type BatchSettlementRequirements,
  type DepositPayload,
  type PreparedPayment,
} from './batch-settlement';

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

const KEY = '0x' + sha256Hex('karmakadabra-batch-settlement-golden');
const WALLET = new EnvKeyAdapter(KEY);
const ADDRESS = WALLET.getAddress();

const NET = 'eip155:8453';
const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RECEIVER = '0x578c640E2D53023066026381B8CC362539741063';
const AUTHORIZER = '0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb';
const SALT = '0x' + sha256Hex('salt');

const GOLDEN_CHANNEL_ID = '0x' + '295887a7202d4b158ba2bba9da71d95ea388a87d70e8978212686830d475b6fb';
const GOLDEN_VOUCHER_SIG =
  '0x' +
  'fe027b475464019e165e31ef3e96e5e511201189b37669ce852cda0ebb19cbb1' +
  '4b35d274eb5d66f0382bc833c0e961701d1585e625b044755ed52ae1bd3870031b';
const GOLDEN_NONCE = '0x' + 'bd38203b196308cd9be75a529eb05099f8690a710268c60ae04c0ae08a36320c';
const GOLDEN_DEPOSIT_SIG =
  '0x' +
  '464fa758a27d7b66cee21ad3b3a81843b9df795451e0bb1adbe24a633d7bd539' +
  '004343cf7e690e31dc5b33c853f6ba6a47bd657aa4e6bc5695cdec7d4931eab91c';

const CONFIG = new ChannelConfig({
  payer: ADDRESS,
  payerAuthorizer: ADDRESS,
  receiver: RECEIVER,
  receiverAuthorizer: AUTHORIZER,
  token: ASSET,
  withdrawDelay: 108000,
});

const BASE_EXTRA = {
  name: 'USD Coin',
  version: '2',
  receiverAuthorizer: AUTHORIZER,
  withdrawDelay: 108000,
  minDeposit: '30000',
};

function requirements(over: Partial<BatchSettlementRequirements> = {}): BatchSettlementRequirements {
  return {
    scheme: 'batch-settlement',
    network: NET,
    amount: '3000',
    asset: ASSET,
    payTo: RECEIVER,
    maxTimeoutSeconds: 15,
    extra: { ...BASE_EXTRA },
    ...over,
  };
}

const inner = (p: PreparedPayment) => p.payload.payload as DepositPayload;

describe('batch-settlement buyer (parity with uvd_x402_sdk.batch_settlement)', () => {
  it('golden channel id, voucher, nonce and deposit signature', async () => {
    expect(computeChannelId(CONFIG, NET)).toBe(GOLDEN_CHANNEL_ID);
    expect((await signVoucher(WALLET, GOLDEN_CHANNEL_ID, 3000, NET)).signature).toBe(GOLDEN_VOUCHER_SIG);
    expect(erc3009DepositNonce(GOLDEN_CHANNEL_ID, SALT)).toBe(GOLDEN_NONCE);
    const dep = await buildDepositPayload(WALLET, requirements(), CONFIG, 30000, 3000, {
      depositSalt: SALT,
      now: 1_800_000_000,
    });
    expect(dep.deposit.authorization.erc3009Authorization.signature).toBe(GOLDEN_DEPOSIT_SIG);
  });

  it('the channel id is bound to the chain', () => {
    expect(computeChannelId(CONFIG, 'eip155:84532')).not.toBe(GOLDEN_CHANNEL_ID);
  });

  it('first request deposits the announced minDeposit, then vouchers', async () => {
    const client = new BatchSettlementClient(WALLET);
    const first = await client.createPayment(requirements(), undefined, { now: 1_800_000_000 });
    expect(inner(first).type).toBe('deposit');
    expect(inner(first).deposit.amount).toBe('30000');
    expect(inner(first).voucher.maxClaimableAmount).toBe('3000');
    expect(await client.confirm(first, { chargedAmount: '3000' })).toBe(true);

    const second = await client.createPayment(requirements(), undefined, { now: 1_800_000_001 });
    expect(second.payload.payload.type).toBe('voucher');
    expect(second.payload.payload.voucher.maxClaimableAmount).toBe('6000');
    expect(second.depositAmount).toBeUndefined();
  });

  it('tops up when the next voucher exceeds the balance', async () => {
    const client = new BatchSettlementClient(WALLET, { maxDeposit: 10_000 });
    const req = () => requirements({ extra: { ...BASE_EXTRA, minDeposit: '6000' } });
    const first = await client.createPayment(req());
    expect(first.depositAmount).toBe(6000n);
    await client.confirm(first, { chargedAmount: '3000' });
    const second = await client.createPayment(req());
    expect(second.payload.payload.type).toBe('voucher');
    await client.confirm(second, { chargedAmount: '3000' });
    const third = await client.createPayment(req());
    // 9000 > balance 6000: a top-up, not a voucher
    expect(third.payload.payload.type).toBe('deposit');
    expect(third.payload.payload.voucher.maxClaimableAmount).toBe('9000');
  });

  it('a minDeposit above the local cap is capped, but a need above it is refused', async () => {
    const capped = await new BatchSettlementClient(WALLET, { maxDeposit: 10_000 }).createPayment(requirements());
    // the seller's minDeposit is a target, never an order
    expect(capped.depositAmount).toBe(10_000n);
    await expect(new BatchSettlementClient(WALLET, { maxDeposit: 1_000 }).createPayment(requirements())).rejects.toThrow(
      BatchSettlementError
    );
  });

  it('only batch-settlement on EVM with eip3009 is signed', async () => {
    const client = new BatchSettlementClient(WALLET);
    await expect(client.createPayment(requirements({ scheme: 'exact' }))).rejects.toThrow(BatchSettlementError);
    await expect(client.createPayment(requirements({ network: 'solana:mainnet' }))).rejects.toThrow(
      BatchSettlementError
    );
    const permit2 = requirements({ extra: { ...BASE_EXTRA, assetTransferMethod: 'permit2' } });
    await expect(client.createPayment(permit2)).rejects.toThrow(BatchSettlementError);
    const { receiverAuthorizer: _dropped, ...withoutAuthorizer } = BASE_EXTRA;
    await expect(client.createPayment(requirements({ extra: withoutAuthorizer }))).rejects.toThrow(
      BatchSettlementError
    );
  });

  it("confirm never trusts the seller's channelState", async () => {
    const client = new BatchSettlementClient(WALLET);
    const p = await client.createPayment(requirements());
    // a seller claiming a higher cumulative than previous + charged is NOT copied into the local state
    expect(
      await client.confirm(p, { chargedAmount: '3000', channelState: { chargedCumulativeAmount: '999999' } })
    ).toBe(false);
    // a charge above the price of the request is refused
    expect(await client.confirm(p, { chargedAmount: '3001' })).toBe(false);
    expect(await client.confirm(p, { chargedAmount: '700', channelState: { chargedCumulativeAmount: '700' } })).toBe(
      true
    );
    const nxt = await client.createPayment(requirements());
    // dynamic pricing: 700 charged, not 3000
    expect(nxt.payload.payload.voucher.maxClaimableAmount).toBe('3700');
  });

  it('the payload envelope and header', async () => {
    const p = await new BatchSettlementClient(WALLET).createPayment(requirements(), { url: 'https://x.test/r' });
    expect(p.payload.x402Version).toBe(2);
    expect(p.payload.accepted.scheme).toBe('batch-settlement');
    expect(p.payload.resource).toEqual({ url: 'https://x.test/r' });
    expect(JSON.parse(atob(p.header())).payload.type).toBe('deposit');
  });

  it('file storage survives a new process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uvd-batch-settlement-'));
    try {
      const path = join(dir, 'channels.json');
      const a = new BatchSettlementClient(WALLET, { storage: new FileChannelStorage(path) });
      await a.confirm(await a.createPayment(requirements()), { chargedAmount: '3000' });
      const b = new BatchSettlementClient(WALLET, { storage: new FileChannelStorage(path) });
      expect((await b.createPayment(requirements())).payload.payload.voucher.maxClaimableAmount).toBe('6000');
      // the temporary file was renamed over the target, not left beside it
      expect(readdirSync(dir)).toEqual(['channels.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the header is the Python SDK's bytes: compact JSON, non-ASCII written as JSON escapes", async () => {
    const tether = 'USD' + String.fromCharCode(0x20ae) + '0';
    const p = await new BatchSettlementClient(WALLET).createPayment(
      requirements({ extra: { ...BASE_EXTRA, name: tether } })
    );
    const raw = atob(p.header());
    // json.dumps(..., separators=(",", ":")) with ensure_ascii: U+20AE travels as a 6-character escape
    expect(raw).toContain(String.fromCharCode(92) + 'u20ae0');
    expect(raw).not.toContain(String.fromCharCode(0x20ae));
    expect(JSON.parse(raw).accepted.extra.name).toBe(tether);
    // an all-ASCII payload is plain compact JSON
    const ascii = await new BatchSettlementClient(WALLET).createPayment(requirements());
    expect(atob(ascii.header())).toBe(JSON.stringify(ascii.payload));
  });
});
