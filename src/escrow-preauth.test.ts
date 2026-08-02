import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildEscrowPreAuth,
  computeEscrowNonce,
  ESCROW_DEPOSIT_LIMIT_USD,
  ESCROW_TIER_WINDOWS,
  OPERATOR_FEE_BPS,
} from './escrow-preauth';
import type {
  EscrowNetworkConfig,
  EscrowPaymentInfo,
  EscrowTierWindows,
} from './escrow-preauth';
import { EnvKeyAdapter } from './adapters/env-key';
import { X402Error } from './types';
import fixtureRaw from './escrow-preauth.vectors.json';

/**
 * Provenance: `src/escrow-preauth.vectors.json` is a byte-identical copy of
 * the F0-1 golden vectors from the Execution Market repo
 * (`shared/test-vectors/escrow-preauth.json`, execution-market@63b284ca).
 * That file is the single source for every mirrored suite (dashboard vitest,
 * em-mobile node --test, em-plugin-sdk pytest); if the wire format ever
 * changes there, re-copy the file and this suite must keep passing WITHOUT
 * touching the assertions (the format is pinned).
 *
 * The nonce MUST match AuthCaptureEscrow.getHash(paymentInfo) or the
 * on-chain authorize reverts. The golden-wrapper test freezes time
 * (vi.setSystemTime) and the salt RNG (crypto.getRandomValues stub) because
 * the builder reads now/salt INTERNALLY, and signs with the fixture's
 * synthetic test key (0x42 * 32, never held funds): the RFC 6979
 * deterministic signature must equal the fixture's expected bytes in
 * ethers, viem and eth_account alike.
 *
 * NOTE: hex values >= 32 bytes are stored in the fixture WITHOUT the 0x
 * prefix (the EM repo's pre-commit secret scanner blocks any literal `0x` +
 * 64 hex chars). `hydrate` re-prefixes them on load.
 */
interface EscrowPreAuthFixture {
  network: string;
  network_config: Omit<EscrowNetworkConfig, 'tiers'>;
  deposit_limit_usd: number;
  escrow_tier_windows: Record<string, EscrowTierWindows>;
  review_window_sec: number;
  refund_window_sec: number;
  payer: string;
  worker: string;
  bounty_usd: string;
  bounty_atomic: string;
  static_vector: { payment_info: EscrowPaymentInfo; expected_nonce: string };
  frozen_build: {
    signer_private_key: string;
    signer_address: string;
    now: number;
    salt: string;
    deadline: number;
    tier: string;
    expected_typed_data: {
      domain: Record<string, unknown>;
      primaryType: string;
      message: Record<string, string>;
    };
    expected_wrapper: Record<string, unknown>;
  };
}

const LONG_HEX = /^[0-9a-f]{64,}$/;

/** Re-prefix long hex values (stored 0x-less to dodge the secret scanner). */
function hydrate(value: unknown): unknown {
  if (typeof value === 'string' && LONG_HEX.test(value)) return '0x' + value;
  if (Array.isArray(value)) return value.map(hydrate);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hydrate(v)]));
  return value;
}

const FX = hydrate(fixtureRaw) as EscrowPreAuthFixture;
const FROZEN = FX.frozen_build;

const EXPECTED_NONCE = FX.static_vector.expected_nonce;
const MOCK_SIGNATURE = '0x' + '11'.repeat(65);

const PAYER = FX.payer;
const WORKER = FX.worker;

// Base mainnet — addresses mirror NETWORK_CONFIG in the EM backend.
const NETWORK_CONFIG: EscrowNetworkConfig = {
  ...FX.network_config,
  tiers: FX.escrow_tier_windows,
};

const FIXTURE_PI: EscrowPaymentInfo = FX.static_vector.payment_info;

function mockWallet() {
  const signTypedData = vi.fn(async (_typedData: string) => ({ signature: MOCK_SIGNATURE }));
  return { wallet: { signTypedData }, signTypedData };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('computeEscrowNonce', () => {
  it('matches the fixture nonce (AuthCaptureEscrow.getHash mirror)', () => {
    const nonce = computeEscrowNonce(
      NETWORK_CONFIG.chain_id,
      NETWORK_CONFIG.escrow,
      NETWORK_CONFIG.payment_info_typehash,
      FIXTURE_PI
    );
    expect(nonce).toBe(EXPECTED_NONCE);
  });

  it('changes when the receiver changes (nonce commits to the worker)', () => {
    const other = computeEscrowNonce(
      NETWORK_CONFIG.chain_id,
      NETWORK_CONFIG.escrow,
      NETWORK_CONFIG.payment_info_typehash,
      { ...FIXTURE_PI, receiver: PAYER }
    );
    expect(other).not.toBe(EXPECTED_NONCE);
  });

  it('accepts lowercase addresses (checksums internally like the SDK)', () => {
    const nonce = computeEscrowNonce(
      NETWORK_CONFIG.chain_id,
      NETWORK_CONFIG.escrow.toLowerCase(),
      NETWORK_CONFIG.payment_info_typehash,
      {
        ...FIXTURE_PI,
        operator: FIXTURE_PI.operator.toLowerCase(),
        token: FIXTURE_PI.token.toLowerCase(),
        feeReceiver: FIXTURE_PI.feeReceiver.toLowerCase(),
      }
    );
    expect(nonce).toBe(EXPECTED_NONCE);
  });

  it('accepts the typehash and salt without 0x prefix (as stored in the fixture)', () => {
    const nonce = computeEscrowNonce(
      NETWORK_CONFIG.chain_id,
      NETWORK_CONFIG.escrow,
      NETWORK_CONFIG.payment_info_typehash.replace(/^0x/, ''),
      { ...FIXTURE_PI, salt: FIXTURE_PI.salt.replace(/^0x/, '') }
    );
    expect(nonce).toBe(EXPECTED_NONCE);
  });
});

describe('golden vectors (escrow-preauth.vectors.json, byte-pinned)', () => {
  it('keeps the local constants in sync with the fixture', () => {
    expect(ESCROW_TIER_WINDOWS).toEqual(FX.escrow_tier_windows);
    expect(ESCROW_DEPOSIT_LIMIT_USD).toBe(FX.deposit_limit_usd);
  });

  it('reproduces the expected wrapper + typed data under frozen time/salt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN.now * 1000));
    // The builder reads the salt from crypto.getRandomValues internally.
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => {
        arr.fill(0xab);
        return arr;
      },
    });

    // Real deterministic signer (RFC 6979) — byte parity with eth_account
    // and viem. The signer's address differs from the payer on purpose:
    // payer binding is enforced on-chain and by the backend, not here.
    const adapter = new EnvKeyAdapter(FROZEN.signer_private_key);
    const calls: Array<Record<string, unknown>> = [];
    const wallet = {
      signTypedData: (typedData: string) => {
        calls.push(JSON.parse(typedData) as Record<string, unknown>);
        return adapter.signTypedData(typedData);
      },
    };

    const header = await buildEscrowPreAuth(wallet, {
      networkConfig: NETWORK_CONFIG,
      payerWallet: PAYER,
      workerWallet: WORKER,
      bountyAtomic: FX.bounty_atomic,
      tier: FROZEN.tier,
      reviewDeadlineSec: FROZEN.deadline,
    });
    expect(JSON.parse(header)).toEqual(FROZEN.expected_wrapper);

    const etd = FROZEN.expected_typed_data;
    expect(calls).toHaveLength(1);
    const typedData = calls[0];
    expect(typedData.primaryType).toBe(etd.primaryType);
    expect(typedData.domain).toEqual(etd.domain);
    expect(typedData.message).toEqual(etd.message);
    expect(typedData.types).toHaveProperty('ReceiveWithAuthorization');
  });
});

describe('buildEscrowPreAuth', () => {
  it('produces the X-Payment-Auth wrapper shape with receiver == worker', async () => {
    const { wallet } = mockWallet();
    const header = await buildEscrowPreAuth(wallet, {
      networkConfig: NETWORK_CONFIG,
      payerWallet: PAYER,
      workerWallet: WORKER,
      bountyAtomic: '100000',
    });

    const wrapper = JSON.parse(header);
    expect(Object.keys(wrapper).sort()).toEqual([
      'payload',
      'paymentRequirements',
      'scheme',
      'x402Version',
    ]);
    expect(wrapper.x402Version).toBe(2);
    expect(wrapper.scheme).toBe('escrow');
    expect(wrapper.paymentRequirements).toEqual({ scheme: 'escrow', network: 'eip155:8453' });

    const { authorization, signature, paymentInfo } = wrapper.payload;
    expect(signature).toBe(MOCK_SIGNATURE);

    // authorization: string-valued, to = token collector, validBefore = preApprovalExpiry
    expect(Object.keys(authorization).sort()).toEqual([
      'from',
      'nonce',
      'to',
      'validAfter',
      'validBefore',
      'value',
    ]);
    expect(authorization.from).toBe(PAYER);
    expect(authorization.to).toBe(NETWORK_CONFIG.token_collector);
    expect(authorization.value).toBe('100000');
    expect(authorization.validAfter).toBe('0');
    expect(authorization.validBefore).toBe(String(paymentInfo.preApprovalExpiry));

    // paymentInfo: maxAmount string, expiries/bps ints, receiver = worker
    expect(Object.keys(paymentInfo).sort()).toEqual([
      'authorizationExpiry',
      'feeReceiver',
      'maxAmount',
      'maxFeeBps',
      'minFeeBps',
      'operator',
      'preApprovalExpiry',
      'receiver',
      'refundExpiry',
      'salt',
      'token',
    ]);
    expect(paymentInfo.receiver).toBe(WORKER);
    expect(paymentInfo.operator).toBe(NETWORK_CONFIG.operator);
    expect(paymentInfo.token).toBe(NETWORK_CONFIG.usdc);
    expect(paymentInfo.maxAmount).toBe('100000');
    expect(typeof paymentInfo.preApprovalExpiry).toBe('number');
    expect(typeof paymentInfo.authorizationExpiry).toBe('number');
    expect(typeof paymentInfo.refundExpiry).toBe('number');
    expect(paymentInfo.minFeeBps).toBe(0);
    expect(paymentInfo.maxFeeBps).toBe(1800);
    expect(paymentInfo.feeReceiver).toBe(NETWORK_CONFIG.operator);
    expect(paymentInfo.salt).toMatch(/^0x[0-9a-f]{64}$/);

    // nonce is reproducible from the serialized paymentInfo (getHash mirror)
    expect(authorization.nonce).toBe(
      computeEscrowNonce(
        NETWORK_CONFIG.chain_id,
        NETWORK_CONFIG.escrow,
        NETWORK_CONFIG.payment_info_typehash,
        paymentInfo
      )
    );
  });

  it('signs ReceiveWithAuthorization with the USDC domain and computed nonce', async () => {
    const { wallet, signTypedData } = mockWallet();
    const header = await buildEscrowPreAuth(wallet, {
      networkConfig: NETWORK_CONFIG,
      payerWallet: PAYER,
      workerWallet: WORKER,
      bountyAtomic: 100000n,
    });
    const wrapper = JSON.parse(header);

    expect(signTypedData).toHaveBeenCalledTimes(1);
    const typedData = JSON.parse(signTypedData.mock.calls[0][0]);
    expect(typedData.primaryType).toBe('ReceiveWithAuthorization');
    expect(typedData.domain).toEqual({
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: NETWORK_CONFIG.usdc,
    });
    expect(typedData.message).toEqual({
      from: PAYER,
      to: NETWORK_CONFIG.token_collector,
      value: '100000',
      validAfter: '0',
      validBefore: String(wrapper.payload.paymentInfo.preApprovalExpiry),
      nonce: wrapper.payload.authorization.nonce,
    });
  });

  it('keeps the release window open past the deadline for human review', async () => {
    vi.useFakeTimers();
    const NOW = FROZEN.now;
    vi.setSystemTime(new Date(NOW * 1000));
    const REVIEW = FX.review_window_sec; // REVIEW_WINDOW_SEC
    const REFUND = FX.refund_window_sec; // REFUND_WINDOW_SEC

    const { wallet } = mockWallet();

    // No deadline: preApproval keeps the short tier window (the lock is
    // immediate), but auth/refund are extended to the review windows — much
    // longer than the 2h micro auth that expired before the human approved.
    const micro = JSON.parse(
      await buildEscrowPreAuth(wallet, {
        networkConfig: NETWORK_CONFIG,
        payerWallet: PAYER,
        workerWallet: WORKER,
        bountyAtomic: '100000',
      })
    ).payload.paymentInfo;
    expect(micro.preApprovalExpiry).toBe(NOW + ESCROW_TIER_WINDOWS.micro.pre);
    expect(micro.authorizationExpiry).toBe(NOW + REVIEW);
    expect(micro.refundExpiry).toBe(NOW + REVIEW + REFUND);

    // With a future deadline, the release window is anchored on the deadline
    // (the worker delivers near it) plus the review buffer.
    const deadline = NOW + 5 * 24 * 3600; // 5 days out
    const withDeadline = JSON.parse(
      await buildEscrowPreAuth(wallet, {
        networkConfig: NETWORK_CONFIG,
        payerWallet: PAYER,
        workerWallet: WORKER,
        bountyAtomic: '100000',
        reviewDeadlineSec: deadline,
      })
    ).payload.paymentInfo;
    expect(withDeadline.preApprovalExpiry).toBe(NOW + ESCROW_TIER_WINDOWS.micro.pre);
    expect(withDeadline.authorizationExpiry).toBe(deadline + REVIEW);
    expect(withDeadline.refundExpiry).toBe(deadline + REFUND + REVIEW);
  });
});

describe('buildEscrowPreAuth — fail-loud validation (never a silent fallback)', () => {
  it('rejects an incomplete network config without signing', async () => {
    const { wallet, signTypedData } = mockWallet();
    const { token_collector: _dropped, ...incomplete } = NETWORK_CONFIG;
    await expect(
      buildEscrowPreAuth(wallet, {
        networkConfig: incomplete as unknown as EscrowNetworkConfig,
        payerWallet: PAYER,
        workerWallet: WORKER,
        bountyAtomic: '100000',
      })
    ).rejects.toThrow(/Incomplete escrow network config \(missing token_collector\)/);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('rejects a zero bounty', async () => {
    const { wallet, signTypedData } = mockWallet();
    await expect(
      buildEscrowPreAuth(wallet, {
        networkConfig: NETWORK_CONFIG,
        payerWallet: PAYER,
        workerWallet: WORKER,
        bountyAtomic: '0',
      })
    ).rejects.toThrow(X402Error);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('rejects a bounty above the on-chain deposit limit ($100)', async () => {
    const { wallet, signTypedData } = mockWallet();
    await expect(
      buildEscrowPreAuth(wallet, {
        networkConfig: NETWORK_CONFIG,
        payerWallet: PAYER,
        workerWallet: WORKER,
        bountyAtomic: BigInt(ESCROW_DEPOSIT_LIMIT_USD) * 10n ** 6n + 1n,
      })
    ).rejects.toThrow(/exceeds the on-chain escrow deposit limit/);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('accepts a raised deposit limit when the server publishes one', async () => {
    const { wallet } = mockWallet();
    const header = await buildEscrowPreAuth(wallet, {
      networkConfig: NETWORK_CONFIG,
      payerWallet: PAYER,
      workerWallet: WORKER,
      bountyAtomic: 250_000_000n, // $250
      depositLimitUsd: 500,
    });
    expect(JSON.parse(header).payload.paymentInfo.maxAmount).toBe('250000000');
  });

  it('rejects a maxFeeBps that cannot cover the operator fee', async () => {
    const { wallet, signTypedData } = mockWallet();
    await expect(
      buildEscrowPreAuth(wallet, {
        networkConfig: { ...NETWORK_CONFIG, max_fee_bps: OPERATOR_FEE_BPS - 1 },
        payerWallet: PAYER,
        workerWallet: WORKER,
        bountyAtomic: '100000',
      })
    ).rejects.toThrow(/cannot cover the operator's 1300 bps static fee/);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('rejects an unknown tier instead of falling back to micro', async () => {
    const { wallet, signTypedData } = mockWallet();
    await expect(
      buildEscrowPreAuth(wallet, {
        networkConfig: NETWORK_CONFIG,
        payerWallet: PAYER,
        workerWallet: WORKER,
        bountyAtomic: '100000',
        tier: 'jumbo',
      })
    ).rejects.toThrow(/Unknown escrow tier 'jumbo'/);
    expect(signTypedData).not.toHaveBeenCalled();
  });
});
