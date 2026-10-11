import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress, getBytes, id, parseUnits } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildEscrowPreAuth,
  computeEscrowNonce,
  DEFAULT_MAX_FEE_BPS,
  ESCROW_DEPOSIT_LIMIT_USD,
  ESCROW_MAX_AUTHORIZATION_SEC,
  ESCROW_PAYMENT_INFO_TYPEHASH,
  ESCROW_TIER_WINDOW_MAX,
  ESCROW_TIER_WINDOWS,
  OPERATOR_FEE_BPS,
  REFUND_WINDOW_SEC,
  REVIEW_WINDOW_SEC,
  VERIFIED_USDC_DOMAINS,
} from './escrow-preauth';
import type {
  EscrowNetworkConfig,
  EscrowPaymentInfo,
  EscrowPreAuthParams,
  EscrowTierWindows,
} from './escrow-preauth';
import { EnvKeyAdapter } from './adapters/env-key';
import { ESCROW_CONTRACTS, PAYMENT_INFO_TYPEHASH, TIER_TIMINGS } from './backend';
import {
  ESCROW_CONTRACTS as REGISTRY_CONTRACTS,
  ESCROW_MAX_FEE_BPS,
  ESCROW_OPERATORS,
} from './escrow-contracts';
import { SMA_WRAP_TARGETS, type DelegationResolver } from './erc7702';
import { CHAIN_ALIASES, getChainById, getChainByName, isChainSupported, SUPPORTED_CHAINS } from './chains';
import { chainToCAIP2 } from './utils/x402';
import { X402Error } from './types';
import fixtureRaw from './escrow-preauth.vectors.json';
import arcVectorRaw from './escrow-preauth.arc-vector.json';

/**
 * Provenance: `src/escrow-preauth.vectors.json` is a byte-identical copy of
 * the F0-1 golden vectors from the Execution Market repo
 * (`shared/test-vectors/escrow-preauth.json`, execution-market@63b284ca).
 * That file is the single source for every mirrored suite (dashboard vitest,
 * em-mobile node --test, em-plugin-sdk pytest); if the wire format ever
 * changes there, re-copy the file and this suite must keep passing WITHOUT
 * touching the assertions (the format is pinned). Its sha256 is pinned below
 * so that no edit here goes unnoticed.
 *
 * Arc (chain 5042) has its own vector, `src/escrow-preauth.arc-vector.json`,
 * derived by `scripts/derive-arc-escrow-preauth-vector.mjs`: the Python SDK's
 * Arc pre-auth case, with the nonce AuthCaptureEscrow.getHash returned on
 * chain 5042 and the token's own name()/version()
 * (`src/fixtures/arc-escrow-d.rpc.json`).
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

interface ArcPreAuthVector {
  pre_auth: {
    network: string;
    now: number;
    salt: string;
    signer: string;
    worker: string;
    bounty_usd: string;
    tier: string;
    payment_info: EscrowPaymentInfo;
  };
  payer: string;
  bounty_atomic: string;
  network_config: Omit<EscrowNetworkConfig, 'tiers'>;
  expected_nonce: string;
  expected_typed_data: EscrowPreAuthFixture['frozen_build']['expected_typed_data'];
  expected_wrapper: Record<string, unknown>;
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
const ARC = hydrate(arcVectorRaw) as ArcPreAuthVector;

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
  it('keeps the file byte-identical to its mirrored copies (sha256 pinned)', () => {
    const bytes = readFileSync(resolve(__dirname, 'escrow-preauth.vectors.json'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '0513fcdfacd934f9658c7f328f23143a82284a5cc8df50304b73688709f6ddf7'
    );
  });

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

describe('Arc vector (escrow-preauth.arc-vector.json: chain 5042, x402r canonical escrow)', () => {
  const ARC_CONFIG: EscrowNetworkConfig = { ...ARC.network_config, tiers: FX.escrow_tier_windows };
  const RPC = JSON.parse(readFileSync(resolve(__dirname, 'fixtures', 'arc-escrow-d.rpc.json'), 'utf8'));
  const recordedGetHash =
    '0x' + RPC.chains['5042'].reads.find((r: { label: string }) => r.label === 'escrow.getHash.preAuth').result;

  it('names the escrow the SDK registry ships for Arc, and the USDC domain of the chain registry', () => {
    const c = ESCROW_CONTRACTS[5042];
    expect(ARC.pre_auth.network).toBe('arc');
    expect(ARC.network_config).toMatchObject({
      chain_id: 5042,
      operator: c.operator,
      escrow: c.escrow,
      token_collector: c.tokenCollector,
      usdc: c.usdc,
      payment_info_typehash: FX.network_config.payment_info_typehash,
    });
    const usdc = getChainByName('arc')!.usdc;
    expect([ARC.network_config.usdc_domain_name, ARC.network_config.usdc_domain_version]).toEqual([
      usdc.name,
      usdc.version,
    ]);
  });

  it('its nonce is the one AuthCaptureEscrow.getHash returned on chain 5042, and computeEscrowNonce agrees', () => {
    expect(ARC.expected_nonce).toBe(recordedGetHash);
    const nonce = computeEscrowNonce(
      ARC_CONFIG.chain_id,
      ARC_CONFIG.escrow,
      ARC_CONFIG.payment_info_typehash,
      ARC.pre_auth.payment_info
    );
    expect(nonce).toBe(ARC.expected_nonce);
    expect(nonce).not.toBe(EXPECTED_NONCE);
  });

  it("signs as the payer (the synthetic key's own address) for the bounty in atomic units", () => {
    expect(ARC.payer).toBe(new EnvKeyAdapter(FROZEN.signer_private_key).getAddress());
    expect(ARC.bounty_atomic).toBe(parseUnits(ARC.pre_auth.bounty_usd, 6).toString());
  });

  it('reproduces the expected Arc wrapper + typed data under frozen time/salt', async () => {
    const salt = getBytes(ARC.pre_auth.salt);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ARC.pre_auth.now * 1000));
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => {
        arr.set(salt);
        return arr;
      },
    });

    const adapter = new EnvKeyAdapter(FROZEN.signer_private_key);
    const calls: Array<Record<string, unknown>> = [];
    const wallet = {
      signTypedData: (typedData: string) => {
        calls.push(JSON.parse(typedData) as Record<string, unknown>);
        return adapter.signTypedData(typedData);
      },
    };

    const header = await buildEscrowPreAuth(wallet, {
      networkConfig: ARC_CONFIG,
      payerWallet: ARC.payer,
      workerWallet: ARC.pre_auth.worker,
      bountyAtomic: ARC.bounty_atomic,
      tier: ARC.pre_auth.tier,
    });
    const wrapper = JSON.parse(header);
    expect(wrapper).toEqual(ARC.expected_wrapper);
    expect(wrapper.payload.paymentInfo).toEqual(ARC.pre_auth.payment_info);

    const etd = ARC.expected_typed_data;
    expect(calls).toHaveLength(1);
    expect(calls[0].primaryType).toBe(etd.primaryType);
    expect(calls[0].domain).toEqual(etd.domain);
    expect(calls[0].domain).toEqual({
      name: 'USDC',
      version: '2',
      chainId: 5042,
      verifyingContract: ESCROW_CONTRACTS[5042].usdc,
    });
    expect(calls[0].message).toEqual(etd.message);
  });
});

describe('VERIFIED_USDC_DOMAINS (domains checked against the token on-chain)', () => {
  const ARC_CONFIG: EscrowNetworkConfig = { ...ARC.network_config, tiers: FX.escrow_tier_windows };
  const params = (networkConfig: EscrowNetworkConfig) => ({
    networkConfig,
    payerWallet: PAYER,
    workerWallet: WORKER,
    bountyAtomic: FX.bounty_atomic,
  });

  /**
   * The Python SDK's `escrow_signing.VERIFIED_USDC_DOMAINS`
   * (uvd-x402-sdk-python@3c81050, 0.97.0), written out here: not read from the
   * table under test, nor from the chain registry.
   */
  const PYTHON_VERIFIED_USDC_DOMAINS: Record<number, [string, string]> = {
    8453: ['USD Coin', '2'],
    1: ['USD Coin', '2'],
    137: ['USD Coin', '2'],
    42161: ['USD Coin', '2'],
    42220: ['USDC', '2'],
    143: ['USDC', '2'],
    43114: ['USD Coin', '2'],
    10: ['USD Coin', '2'],
    1187947933: ['Bridged USDC (SKALE Bridge)', '2'],
    5042: ['USDC', '2'],
    5042002: ['USDC', '2'],
  };
  const DOMAIN_CHAINS = Object.keys(PYTHON_VERIFIED_USDC_DOMAINS)
    .map(Number)
    .map((chainId) => [getChainById(chainId)!.name, chainId] as const);
  /** The other spelling a server could plausibly send. */
  const otherName = (name: string) => (name === 'USD Coin' ? 'USDC' : 'USD Coin');

  it("has the Python SDK's eleven rows, no more", () => {
    expect(VERIFIED_USDC_DOMAINS).toEqual(
      Object.fromEntries(
        Object.entries(PYTHON_VERIFIED_USDC_DOMAINS).map(([chainId, [name, version]]) => [chainId, { name, version }])
      )
    );
  });

  it('has a row for every chain with an escrow operator row, and none without one', () => {
    expect(Object.keys(VERIFIED_USDC_DOMAINS).sort()).toEqual(Object.keys(ESCROW_OPERATORS).sort());
  });

  it.each(DOMAIN_CHAINS)("%s (chain %i): the chain registry's USDC domain is the table's", (network, chainId) => {
    const { name, version } = getChainByName(network)!.usdc;
    expect({ name, version }).toEqual(VERIFIED_USDC_DOMAINS[chainId]);
  });

  it.each(DOMAIN_CHAINS)('%s (chain %i): signs with the table domain, and signs that domain', async (network, chainId) => {
    const [name, version] = PYTHON_VERIFIED_USDC_DOMAINS[chainId];
    for (const extra of [{}, { network }]) {
      const { wallet, signTypedData } = mockWallet();
      await buildEscrowPreAuth(wallet, {
        ...params({ ...tableConfig(chainId), usdc_domain_name: name, usdc_domain_version: version }),
        ...extra,
      });
      expect(signTypedData).toHaveBeenCalledTimes(1);
      const { domain } = JSON.parse(signTypedData.mock.calls[0][0]);
      expect([domain.name, domain.version, Number(domain.chainId)]).toEqual([name, version, chainId]);
    }
  });

  it.each(
    DOMAIN_CHAINS.flatMap(([network, chainId]) => {
      const [name, version] = PYTHON_VERIFIED_USDC_DOMAINS[chainId];
      return [
        [network, chainId, 'another name', otherName(name), version],
        [network, chainId, 'the name in lower case', name.toLowerCase(), version],
        [network, chainId, 'the name with a trailing space', `${name} `, version],
        [network, chainId, 'another version', name, '1'],
        [network, chainId, 'the version with a leading space', name, ` ${version}`],
      ] as const;
    })
  )('%s (chain %i): refuses %s (%j / %j) before anything is signed', async (network, chainId, _what, name, version) => {
    for (const extra of [{}, { network }]) {
      const { wallet, signTypedData } = mockWallet();
      const attempt = buildEscrowPreAuth(wallet, {
        ...params({ ...tableConfig(chainId), usdc_domain_name: name, usdc_domain_version: version }),
        ...extra,
      });
      await expect(attempt).rejects.toBeInstanceOf(X402Error);
      await expect(attempt).rejects.toMatchObject({
        code: 'INVALID_CONFIG',
        message: expect.stringContaining(
          `but the token's on-chain domain is ${JSON.stringify(PYTHON_VERIFIED_USDC_DOMAINS[chainId][0])} / ${JSON.stringify(PYTHON_VERIFIED_USDC_DOMAINS[chainId][1])}`
        ),
      });
      expect(signTypedData).not.toHaveBeenCalled();
    }
  });

  it.each(
    DOMAIN_CHAINS.flatMap(([network, chainId]) => {
      const [name, version] = PYTHON_VERIFIED_USDC_DOMAINS[chainId];
      const boxed = { toString: () => name };
      return [
        [network, chainId, 'the version as a number', name, Number(version), `${JSON.stringify(name)} / ${Number(version)},`],
        [network, chainId, 'the name in an array', [name], version, `[${JSON.stringify(name)}] / ${JSON.stringify(version)},`],
        [network, chainId, 'the name as an object that prints as it', boxed, version, `{} / ${JSON.stringify(version)},`],
      ] as const;
    })
  )(
    '%s (chain %i): refuses %s, which is not the string the token signs, before anything is signed',
    async (network, chainId, _what, name, version, shown) => {
      for (const extra of [{}, { network }]) {
        const { wallet, signTypedData } = mockWallet();
        const attempt = buildEscrowPreAuth(wallet, {
          ...params({
            ...tableConfig(chainId),
            usdc_domain_name: name as unknown as string,
            usdc_domain_version: version as unknown as string,
          }),
          ...extra,
        });
        await expect(attempt).rejects.toBeInstanceOf(X402Error);
        await expect(attempt).rejects.toMatchObject({
          code: 'INVALID_CONFIG',
          message: expect.stringContaining(`the USDC domain ${shown} but the token's on-chain domain`),
        });
        expect(signTypedData).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    ['name', { usdc_domain_name: 'USD Coin' }],
    ['version', { usdc_domain_version: '1' }],
  ])('refuses an Arc config whose USDC domain %s differs, before anything is signed', async (_field, override) => {
    const { wallet, signTypedData } = mockWallet();
    const attempt = buildEscrowPreAuth(wallet, params({ ...ARC_CONFIG, ...override }));
    await expect(attempt).rejects.toBeInstanceOf(X402Error);
    await expect(attempt).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('signs an Arc config with the verified domain', async () => {
    const { wallet, signTypedData } = mockWallet();
    await buildEscrowPreAuth(wallet, params(ARC_CONFIG));
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it('refuses a Base config with a domain other than the token\'s, which it signed until 2.104.1', async () => {
    expect(VERIFIED_USDC_DOMAINS[NETWORK_CONFIG.chain_id]).toEqual({ name: 'USD Coin', version: '2' });
    for (const usdc_domain_name of ['USDC', 'Not The Token Name']) {
      const { wallet, signTypedData } = mockWallet();
      const attempt = buildEscrowPreAuth(wallet, params({ ...NETWORK_CONFIG, usdc_domain_name }));
      await expect(attempt).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      expect(signTypedData).not.toHaveBeenCalled();
    }
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

// ============================================================================
// The SDK tables: chain id, escrow, token collector, USDC, operator, fee ceiling
// ============================================================================
//
// config key        where the signature carries it               checked against
// chain_id          domain.chainId, the nonce, the network       the `network` name
// escrow            the nonce (AuthCaptureEscrow.getHash)        ESCROW_CONTRACTS
// token_collector   message.to / authorization.to                ESCROW_CONTRACTS
// usdc              domain.verifyingContract, paymentInfo.token  ESCROW_CONTRACTS
// operator          paymentInfo.operator / feeReceiver           ESCROW_OPERATORS
// max_fee_bps       paymentInfo.maxFeeBps (ceiling)              ESCROW_MAX_FEE_BPS
//
// Port of the Python SDK's tests/test_escrow_signing_registry.py (0.96.0).

/**
 * Execution Market's config of each escrow network of its registry, with the
 * keys the pre-auth reads: `mcp_server/integrations/x402/network_registry.py`
 * at execution-market@bf1007d8 (each network's `operator`, `escrow`,
 * `x402r_infra.tokenCollector` and `tokens.USDC.address`). The table is the
 * only other copy of these addresses in this repo, so this second one, with
 * its source, is what turns an edited row red. `skale` is retired in
 * Execution Market and its payment config no longer serves it; its registry
 * entry is still the operator of the escrows in flight there.
 */
const EM_NETWORKS: Record<
  string,
  { chainId: number; operator: string; escrow: string; collector: string; usdc: string }
> = {
  base: {
    chainId: 8453,
    operator: '0x271f9fa7f8907aCf178CCFB470076D9129D8F0Eb',
    escrow: '0xb9488351E48b23D798f24e8174514F28B741Eb4f',
    collector: '0x48ADf6E37F9b31dC2AAD0462C5862B5422C736B8',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  ethereum: {
    chainId: 1,
    operator: '0x69B67962ffb7c5C7078ff348a87DF604dfA8001b',
    escrow: '0x9D4146EF898c8E60B3e865AE254ef438E7cEd2A0',
    collector: '0x206D4DbB6E7b876e4B5EFAAD2a04e7d7813FB6ba',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  polygon: {
    chainId: 137,
    operator: '0xB87F1ECC85f074e50df3DD16A1F40e4e1EC4102e',
    escrow: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    collector: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
  arbitrum: {
    chainId: 42161,
    operator: '0xC2377a9Db1de2520BD6b2756eD012f4E82F7938e',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    collector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  celo: {
    chainId: 42220,
    operator: '0xC2377a9Db1de2520BD6b2756eD012f4E82F7938e',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    collector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    usdc: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
  },
  monad: {
    chainId: 143,
    operator: '0x9620Dbe2BB549E1d080Dc8e7982623A9e1Df8cC3',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    collector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    usdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  },
  avalanche: {
    chainId: 43114,
    operator: '0xC2377a9Db1de2520BD6b2756eD012f4E82F7938e',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    collector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  },
  optimism: {
    chainId: 10,
    operator: '0xC2377a9Db1de2520BD6b2756eD012f4E82F7938e',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    collector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  },
  skale: {
    chainId: 1187947933,
    operator: '0x43E46d4587fCCc382285C52012227555ed78D183',
    escrow: '0xBC151792f80C0EB1973d56b0235e6bee2A60e245',
    collector: '0x9A12A116a44636F55c9e135189A1321Abcfe2f30',
    usdc: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
  },
  arc: {
    chainId: 5042,
    operator: '0x0258472A1410Ac3Ad720f1BC83f22B3c0af1Fd9D',
    escrow: '0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff',
    collector: '0x0E3dF9510de65469C4518D7843919c0b8C7A7757',
    usdc: '0x3600000000000000000000000000000000000000',
  },
};
/** The fee bounds Execution Market's payment config serves (`mcp_server/api/h2a.py`). */
const EM_FEES = { min_fee_bps: 0, max_fee_bps: 1800 };
/**
 * The tier windows Execution Market's payment config serves:
 * `_effective_tier_windows` in `mcp_server/api/h2a.py` at bf1007d8, the SDK's
 * micro / standard tiers with `auth` raised to REVIEW_WINDOW_SEC and `refund`
 * to auth + REFUND_WINDOW_SEC.
 */
const EM_TIERS = {
  micro: { pre: 3600, auth: 604800, refund: 1209600 },
  standard: { pre: 7200, auth: 604800, refund: 1209600 },
};

/** The chains with an operator row, and the name this SDK registers for each. */
const TABLE_CHAINS = Object.keys(ESCROW_OPERATORS)
  .map(Number)
  .sort((a, b) => a - b);
const nameOf = (chainId: number): string => getChainById(chainId)!.name;
const TABLE_CASES = TABLE_CHAINS.map((chainId) => [nameOf(chainId), chainId] as const);
/** Rows in ESCROW_CONTRACTS with no operator, no fee ceiling and no name here. */
const TESTNETS = [84532, 11155111];
const ADDRESS_KEYS = [
  ['escrow', 'escrow'],
  ['token_collector', 'tokenCollector'],
  ['usdc', 'usdc'],
] as const;

/** A chain registry address as it is signed (checksummed): `src/chains` writes some lowercase. */
const signed = (address: string): string => getAddress(address.toLowerCase());

/** One network block of the config, from the SDK's own tables only. */
function tableConfig(chainId: number): EscrowNetworkConfig {
  const contracts = REGISTRY_CONTRACTS[chainId];
  const usdc = getChainById(chainId)?.usdc;
  return {
    chain_id: chainId,
    operator: ESCROW_OPERATORS[chainId] ?? getAddress('0x' + chainId.toString(16).padStart(40, '0')),
    escrow: contracts.escrow,
    token_collector: contracts.tokenCollector,
    usdc: contracts.usdc,
    usdc_domain_name: usdc?.name ?? 'USD Coin',
    usdc_domain_version: usdc?.version ?? '2',
    payment_info_typehash: FX.network_config.payment_info_typehash,
  };
}

/** Execution Market's block for one of its networks. */
function emConfig(network: string): EscrowNetworkConfig {
  const em = EM_NETWORKS[network];
  const domain = getChainById(em.chainId)!.usdc;
  return {
    chain_id: em.chainId,
    operator: em.operator,
    escrow: em.escrow,
    token_collector: em.collector,
    usdc: em.usdc,
    usdc_domain_name: domain.name,
    usdc_domain_version: domain.version,
    payment_info_typehash: FX.network_config.payment_info_typehash,
    tiers: EM_TIERS,
    ...EM_FEES,
  };
}

/** The same address with its last hex digit moved by one, checksummed. */
function changed(address: string): string {
  const lower = address.toLowerCase();
  return getAddress(lower.slice(0, -1) + ((parseInt(lower.slice(-1), 16) + 1) % 16).toString(16));
}

type ExtraParams = Partial<Omit<EscrowPreAuthParams, 'networkConfig'>>;

function attempt(networkConfig: EscrowNetworkConfig, extra: ExtraParams = {}) {
  const { wallet, signTypedData } = mockWallet();
  const result = buildEscrowPreAuth(wallet, {
    networkConfig,
    payerWallet: PAYER,
    workerWallet: WORKER,
    bountyAtomic: '250000',
    ...extra,
  });
  return { result, signTypedData };
}

async function signs(networkConfig: EscrowNetworkConfig, extra: ExtraParams = {}) {
  const { result, signTypedData } = attempt(networkConfig, extra);
  const wrapper = JSON.parse(await result);
  expect(signTypedData).toHaveBeenCalledTimes(1);
  return { wrapper, typedData: JSON.parse(signTypedData.mock.calls[0][0]) };
}

async function refused(networkConfig: EscrowNetworkConfig, extra: ExtraParams, match: RegExp) {
  const { result, signTypedData } = attempt(networkConfig, extra);
  const error = await result.then(
    () => null,
    (e: unknown) => e
  );
  expect(error, 'the config must be refused').toBeInstanceOf(X402Error);
  expect((error as X402Error).code).toBe('INVALID_CONFIG');
  expect((error as X402Error).message).toMatch(match);
  expect(signTypedData, 'nothing may be signed before the refusal').not.toHaveBeenCalled();
}

/** A config field set to a value of another type, as a JSON body can carry it. */
const withField = (cfg: EscrowNetworkConfig, key: string, value: unknown): EscrowNetworkConfig =>
  ({ ...cfg, [key]: value }) as unknown as EscrowNetworkConfig;

describe('the escrow tables (src/escrow-contracts.ts)', () => {
  it('backend re-exports the same ESCROW_CONTRACTS object', () => {
    expect(ESCROW_CONTRACTS).toBe(REGISTRY_CONTRACTS);
  });

  it('every operator row is a chain of ESCROW_CONTRACTS, and every one has a fee ceiling', () => {
    for (const chainId of TABLE_CHAINS) expect(REGISTRY_CONTRACTS[chainId], `chain ${chainId}`).toBeDefined();
    expect(Object.keys(ESCROW_MAX_FEE_BPS).sort()).toEqual(Object.keys(ESCROW_OPERATORS).sort());
    for (const chainId of TESTNETS) {
      expect(REGISTRY_CONTRACTS[chainId]).toBeDefined();
      expect(ESCROW_OPERATORS[chainId]).toBeUndefined();
      expect(ESCROW_MAX_FEE_BPS[chainId]).toBeUndefined();
    }
  });

  it("the fee ceiling is Execution Market's 1800 bps on every row, and the default bound is within it", () => {
    expect(new Set(Object.values(ESCROW_MAX_FEE_BPS))).toEqual(new Set([EM_FEES.max_fee_bps]));
    expect(DEFAULT_MAX_FEE_BPS).toBeLessThanOrEqual(Math.min(...Object.values(ESCROW_MAX_FEE_BPS)));
    expect(OPERATOR_FEE_BPS).toBeLessThanOrEqual(Math.min(...Object.values(ESCROW_MAX_FEE_BPS)));
  });

  it("the operator rows are Execution Market's, the Base vector's, and Arc's recorded computeAddress", () => {
    const rpc = JSON.parse(readFileSync(resolve(__dirname, 'fixtures', 'arc-escrow-d.rpc.json'), 'utf8'));
    const computeAddress = (chain: string) =>
      getAddress(
        '0x' +
          String(rpc.chains[chain].reads.find((r: { label: string }) => r.label === 'operatorFactory.computeAddress').result).slice(-40)
      );
    expect(ESCROW_OPERATORS).toEqual({
      ...Object.fromEntries(Object.values(EM_NETWORKS).map((em) => [em.chainId, em.operator])),
      5042002: computeAddress('5042002'),
    });
    expect(ESCROW_OPERATORS[5042]).toBe(computeAddress('5042'));
    expect(ESCROW_OPERATORS[8453]).toBe(FX.network_config.operator);
    for (const address of Object.values(ESCROW_OPERATORS)) expect(getAddress(address)).toBe(address);
  });

  it.each(Object.keys(EM_NETWORKS))("%s: Execution Market's escrow, collector and USDC are the registry row", (network) => {
    const em = EM_NETWORKS[network];
    const contracts = REGISTRY_CONTRACTS[em.chainId];
    expect([contracts.escrow, contracts.tokenCollector, contracts.usdc]).toEqual([em.escrow, em.collector, em.usdc]);
    expect(getChainByName(nameOf(em.chainId))!.chainId).toBe(em.chainId);
  });

  it('every address of every ESCROW_CONTRACTS and ESCROW_OPERATORS row is written in its EIP-55 checksum', () => {
    const spelled: Array<[string, string]> = [
      ...Object.entries(REGISTRY_CONTRACTS).flatMap(([chainId, row]) =>
        Object.entries(row).map(([field, address]): [string, string] => [`ESCROW_CONTRACTS[${chainId}].${field}`, address])
      ),
      ...Object.entries(ESCROW_OPERATORS).map(([chainId, address]): [string, string] => [`ESCROW_OPERATORS[${chainId}]`, address]),
    ];
    expect(spelled.length).toBeGreaterThan(Object.keys(REGISTRY_CONTRACTS).length * 5);
    for (const [where, address] of spelled) {
      let checksummed: string | Error;
      try {
        checksummed = getAddress(address);
      } catch (e) {
        checksummed = e as Error;
      }
      expect(checksummed, where).toBe(address);
    }
  });

  it("the operator row is not the factory that ESCROW_CONTRACTS' operator column holds on Base", () => {
    // 0x3D08…0260 answers ESCROW() and reverts on FEE_CALCULATOR(): a factory.
    expect(REGISTRY_CONTRACTS[8453].operator).toBe('0x3D0837fF8Ea36F417261577b9BA568400A840260');
    expect(ESCROW_OPERATORS[8453]).not.toBe(REGISTRY_CONTRACTS[8453].operator);
  });
});

describe('buildEscrowPreAuth against the SDK tables: valid configs sign as before', () => {
  it.each(Object.keys(EM_NETWORKS))("Execution Market's %s config signs, carrying Execution Market's values", async (network) => {
    // Expected values from EM_NETWORKS (Execution Market's registry), not from the tables under test.
    const em = EM_NETWORKS[network];
    const cfg = emConfig(network);
    for (const extra of [{ network }, {}] as ExtraParams[]) {
      const { wrapper, typedData } = await signs(cfg, extra);
      const { authorization, paymentInfo } = wrapper.payload;
      expect(typedData.domain.chainId).toBe(em.chainId);
      expect(typedData.domain.verifyingContract).toBe(em.usdc);
      expect(wrapper.paymentRequirements.network).toBe(`eip155:${em.chainId}`);
      expect(paymentInfo.token).toBe(em.usdc);
      expect(typedData.message.to).toBe(em.collector);
      expect(authorization.to).toBe(em.collector);
      expect(paymentInfo.operator).toBe(em.operator);
      expect(paymentInfo.feeReceiver).toBe(em.operator);
      expect(paymentInfo.maxFeeBps).toBe(EM_FEES.max_fee_bps);
      expect(paymentInfo.minFeeBps).toBe(EM_FEES.min_fee_bps);
      expect(authorization.nonce).toBe(
        computeEscrowNonce(em.chainId, em.escrow, cfg.payment_info_typehash, paymentInfo)
      );
    }
  });

  it.each(TABLE_CASES)('%s (chain %i): the config built from the tables signs', async (network, chainId) => {
    await signs(tableConfig(chainId), { network });
  });

  it("monad: the USDC row is Execution Market's, spelled as it is signed", async () => {
    // execution-market@43aea599 mcp_server/integrations/x402/network_registry.py, monad USDC.
    const usdc = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
    expect(REGISTRY_CONTRACTS[143].usdc).toBe(usdc);
    const { typedData, wrapper } = await signs(tableConfig(143), { network: 'monad' });
    expect(typedData.domain.verifyingContract).toBe(usdc);
    expect(wrapper.payload.paymentInfo.token).toBe(usdc);
  });

  it.each(['base', 'BASE', ' Base ', 'eip155:8453', 'EIP155:8453', ' eip155:8453 ', 'eip155:08453', undefined])(
    'the Base golden vector is reproduced byte for byte with network %j',
    async (network) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FROZEN.now * 1000));
      vi.stubGlobal('crypto', {
        getRandomValues: (arr: Uint8Array) => {
          arr.fill(0xab);
          return arr;
        },
      });
      const adapter = new EnvKeyAdapter(FROZEN.signer_private_key);
      const header = await buildEscrowPreAuth(adapter, {
        networkConfig: NETWORK_CONFIG,
        network,
        payerWallet: PAYER,
        workerWallet: WORKER,
        bountyAtomic: FX.bounty_atomic,
        tier: FROZEN.tier,
        reviewDeadlineSec: FROZEN.deadline,
      });
      expect(JSON.parse(header)).toEqual(FROZEN.expected_wrapper);
    }
  );

  it('the Arc golden vector is reproduced byte for byte with network arc', async () => {
    const salt = getBytes(ARC.pre_auth.salt);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ARC.pre_auth.now * 1000));
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => {
        arr.set(salt);
        return arr;
      },
    });
    const header = await buildEscrowPreAuth(new EnvKeyAdapter(FROZEN.signer_private_key), {
      networkConfig: { ...ARC.network_config, tiers: FX.escrow_tier_windows },
      network: ARC.pre_auth.network,
      payerWallet: ARC.payer,
      workerWallet: ARC.pre_auth.worker,
      bountyAtomic: ARC.bounty_atomic,
      tier: ARC.pre_auth.tier,
    });
    expect(JSON.parse(header)).toEqual(ARC.expected_wrapper);
  });

  it.each(['lower', 'upper'])('the table addresses written in %s case are the same addresses', async (spelling) => {
    const cfg = tableConfig(8453);
    const respelled = { ...cfg };
    for (const key of ['operator', 'escrow', 'token_collector', 'usdc'] as const) {
      const hex = cfg[key].slice(2);
      respelled[key] = '0x' + (spelling === 'lower' ? hex.toLowerCase() : hex.toUpperCase());
    }
    const { wrapper } = await signs(respelled, { network: 'base' });
    expect(wrapper.payload.authorization.to).toBe(REGISTRY_CONTRACTS[8453].tokenCollector);
    expect(wrapper.payload.paymentInfo.operator).toBe(ESCROW_OPERATORS[8453]);
  });

  it.each(['8453', '08453'])('a chain id written as the digits %j is the same chain, and is signed as the number', async (digits) => {
    const { wrapper, typedData } = await signs(withField(tableConfig(8453), 'chain_id', digits), { network: 'base' });
    expect(typedData.domain.chainId).toBe(8453);
    expect(wrapper.paymentRequirements.network).toBe('eip155:8453');
  });

  it("a chain id written as '05042' is Arc: its verified USDC domain and its rows still apply", async () => {
    const arc = withField(tableConfig(5042), 'chain_id', '05042');
    await signs(arc, { network: 'arc' });
    await refused({ ...arc, usdc_domain_name: 'USD Coin' }, { network: 'arc' }, /on-chain domain is "USDC"/);
    await refused({ ...arc, escrow: changed(arc.escrow) }, {}, /Escrow address mismatch for chain 5042/);
  });

  it.each([null, undefined])('max_fee_bps %s signs the default bound, within the ceiling', async (value) => {
    const { wrapper } = await signs(withField(tableConfig(8453), 'max_fee_bps', value), { network: 'base' });
    expect(wrapper.payload.paymentInfo.maxFeeBps).toBe(DEFAULT_MAX_FEE_BPS);
  });

  it.each([null, undefined])('network %s: no name to check, the tables are still read', async (network) => {
    await signs(tableConfig(8453), { network: network as unknown as string });
    const cfg = { ...tableConfig(8453), token_collector: changed(REGISTRY_CONTRACTS[8453].tokenCollector) };
    await refused(cfg, { network: network as unknown as string }, /Escrow address mismatch .* asserts token_collector /);
  });
});

describe('buildEscrowPreAuth against the SDK tables: one contradiction per field, refused before signing', () => {
  const ADDRESS_CASES = TABLE_CASES.flatMap(([network, chainId]) =>
    ADDRESS_KEYS.map(([key]) => [network, chainId, key] as const)
  );

  it.each(ADDRESS_CASES)('%s (chain %i): a changed %s is refused', async (network, chainId, key) => {
    const cfg = { ...tableConfig(chainId), [key]: changed(tableConfig(chainId)[key]) };
    const match = new RegExp(`Escrow address mismatch for chain ${chainId}: the escrow config asserts ${key} `);
    await refused(cfg, { network }, match);
    await refused(cfg, {}, match);
  });

  it.each(TABLE_CASES)('%s (chain %i): a changed operator is refused', async (network, chainId) => {
    const cfg = { ...tableConfig(chainId), operator: changed(ESCROW_OPERATORS[chainId]) };
    await refused(cfg, { network }, new RegExp(`Escrow operator mismatch for chain ${chainId}`));
    await refused(cfg, {}, /Escrow operator mismatch/);
  });

  // ESCROW_CONTRACTS' operator column: the factory on most chains. On Ethereum,
  // Arc and Arc Testnet it holds the operator itself, so they are not cases.
  const COLUMN_CASES = TABLE_CASES.filter(([, chainId]) => REGISTRY_CONTRACTS[chainId].operator !== ESCROW_OPERATORS[chainId]);

  it('the operator column differs from the operator row on every chain but Ethereum, Arc and Arc Testnet', () => {
    expect(TABLE_CHAINS.filter((c) => !COLUMN_CASES.some(([, chainId]) => chainId === c))).toEqual([1, 5042, 5042002]);
  });

  it.each(COLUMN_CASES)("%s (chain %i): ESCROW_CONTRACTS' operator column is refused as the operator", async (network, chainId) => {
    await refused({ ...tableConfig(chainId), operator: REGISTRY_CONTRACTS[chainId].operator }, { network }, /Escrow operator mismatch/);
  });

  it.each(TABLE_CASES)("%s (chain %i): every other chain's whole config under this name is refused", async (network, chainId) => {
    for (const other of TABLE_CHAINS.filter((c) => c !== chainId)) {
      await refused(tableConfig(other), { network }, new RegExp(`Chain id mismatch for '${network}'`));
    }
  });

  it.each(TABLE_CASES)('%s (chain %i): the fee ceiling is signed and one bps above it is refused', async (network, chainId) => {
    const ceiling = ESCROW_MAX_FEE_BPS[chainId];
    const { wrapper } = await signs({ ...tableConfig(chainId), max_fee_bps: ceiling }, { network });
    expect(wrapper.payload.paymentInfo.maxFeeBps).toBe(ceiling);
    const above = { ...tableConfig(chainId), max_fee_bps: ceiling + 1 };
    const match = new RegExp(`maxFeeBps=${ceiling + 1} for chain ${chainId} is above this SDK's ceiling`);
    await refused(above, { network }, match);
    await refused(above, {}, match);
  });

  it.each(Object.keys(EM_NETWORKS))("Execution Market's %s config with another operator, or 1801 bps, is refused", async (network) => {
    await refused({ ...emConfig(network), operator: changed(EM_NETWORKS[network].operator) }, { network }, /Escrow operator mismatch/);
    await refused({ ...emConfig(network), max_fee_bps: 1801 }, { network }, /above this SDK's ceiling/);
  });
});

describe('buildEscrowPreAuth against the SDK tables: unknown networks, case, nulls and limits', () => {
  /** A config for a chain with no escrow row: its USDC from the chain registry, the rest made up. */
  const rowlessConfig = (chainId: number): EscrowNetworkConfig => {
    const usdc = getChainById(chainId)?.usdc;
    return {
      chain_id: chainId,
      operator: '0x' + '01'.repeat(20),
      escrow: '0x' + '02'.repeat(20),
      token_collector: '0x' + '03'.repeat(20),
      usdc: usdc ? signed(usdc.address) : '0x' + '04'.repeat(20),
      usdc_domain_name: usdc?.name ?? 'USD Coin',
      usdc_domain_version: usdc?.version ?? '2',
      payment_info_typehash: FX.network_config.payment_info_typehash,
      max_fee_bps: 1800,
    };
  };
  /** The refusal of a chain missing rows, naming exactly the tables it lacks. */
  const noRows = (chainId: number, tables: string) =>
    new RegExp(`^Chain ${chainId} has no row in this SDK's escrow tables \\(${tables}\\) — refusing to sign\\.$`);
  const ALL_FOUR = 'ESCROW_CONTRACTS, ESCROW_OPERATORS, ESCROW_MAX_FEE_BPS, VERIFIED_USDC_DOMAINS';
  const UNREGISTERED = /is not a network this SDK registers/;

  it.each<[string, number]>([
    ['base-sepolia', 84532],
    ['ethereum-sepolia', 11155111],
  ])('testnet %s (chain %i): a row in ESCROW_CONTRACTS only, refused with and without network; its name is not registered here', async (name, chainId) => {
    expect(REGISTRY_CONTRACTS[chainId]).toBeDefined();
    expect(ESCROW_OPERATORS[chainId]).toBeUndefined();
    expect(ESCROW_MAX_FEE_BPS[chainId]).toBeUndefined();
    expect(VERIFIED_USDC_DOMAINS[chainId]).toBeUndefined();
    expect(getChainByName(name)).toBeUndefined();
    const missing = noRows(chainId, 'ESCROW_OPERATORS, ESCROW_MAX_FEE_BPS, VERIFIED_USDC_DOMAINS');
    await refused(tableConfig(chainId), {}, missing);
    await refused(tableConfig(chainId), { network: `eip155:${chainId}` }, missing);
    await refused(tableConfig(chainId), { network: name }, UNREGISTERED);
  });

  it.each<[string, number]>([
    ['hyperevm', 999],
    ['unichain', 130],
    ['scroll', 534352],
    ['robinhood', 4663],
  ])('%s (chain %i), with no escrow row: refused with and without network', async (name, chainId) => {
    expect(REGISTRY_CONTRACTS[chainId]).toBeUndefined();
    expect(getChainByName(name)!.chainId).toBe(chainId);
    const cfg = rowlessConfig(chainId);
    for (const network of [undefined, null, name, name.toUpperCase(), `eip155:${chainId}`]) {
      await refused(cfg, { network: network as string | undefined }, noRows(chainId, ALL_FOUR));
    }
    await refused(cfg, { network: 'red-nueva' }, UNREGISTERED);
    await refused(cfg, { network: 'base' }, /Chain id mismatch for 'base'/);
  });

  it('every EVM chain of the chain registry without its escrow rows is refused, with and without its name', async () => {
    const rowless = Object.values(SUPPORTED_CHAINS).filter(
      (chain) => chain.networkType === 'evm' && ESCROW_OPERATORS[chain.chainId] === undefined
    );
    expect(rowless.map((chain) => chain.chainId)).toEqual(expect.arrayContaining([999, 130, 534352, 4663]));
    for (const chain of rowless) {
      await refused(rowlessConfig(chain.chainId), {}, noRows(chain.chainId, ALL_FOUR));
      await refused(rowlessConfig(chain.chainId), { network: chain.name }, noRows(chain.chainId, ALL_FOUR));
    }
  });

  it('a row inherited from Object.prototype is no row', async () => {
    const cfg = rowlessConfig(534352);
    const proto = Object.prototype as Record<string, unknown>;
    proto['534352'] = { escrow: cfg.escrow, tokenCollector: cfg.token_collector, usdc: cfg.usdc };
    try {
      await refused(cfg, {}, noRows(534352, ALL_FOUR));
    } finally {
      delete proto['534352'];
    }
    expect(Object.hasOwn(Object.prototype, '534352')).toBe(false);
  });

  it('a chain no registry knows is refused, also under the eip155 id that names it', async () => {
    const cfg = rowlessConfig(999999);
    await refused(cfg, {}, noRows(999999, ALL_FOUR));
    await refused(cfg, { network: 'eip155:999999' }, noRows(999999, ALL_FOUR));
    await refused(cfg, { network: 'red-nueva' }, UNREGISTERED);
    await refused(cfg, { network: 'eip155:999998' }, /Chain id mismatch/);
  });

  it.each(Object.keys(EM_NETWORKS))("Execution Market's %s config still signs with no network, on both tiers it serves", async (network) => {
    for (const tier of Object.keys(EM_TIERS)) await signs(emConfig(network), { tier });
  });

  it("Execution Market's served windows fit the tier ceilings (its auth floor is the auth ceiling)", () => {
    expect(REVIEW_WINDOW_SEC).toBeLessThanOrEqual(ESCROW_TIER_WINDOW_MAX.auth);
    expect(REVIEW_WINDOW_SEC + REFUND_WINDOW_SEC).toBeLessThanOrEqual(ESCROW_TIER_WINDOW_MAX.refund);
    for (const windows of Object.values(EM_TIERS)) {
      for (const key of ['pre', 'auth', 'refund'] as const) expect(windows[key]).toBeLessThanOrEqual(ESCROW_TIER_WINDOW_MAX[key]);
    }
  });

  it.each(['red-nueva', 'bsae', 'base-sepolia', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'ｂａｓｅ'])(
    'a name this SDK does not register (%j) is refused, also for a chain with rows',
    async (network) => {
      await refused(tableConfig(10), { network }, UNREGISTERED);
    }
  );

  it.each(['skale', 'SKALE', ' Skale '])("%j is the Python registry's alias of skale-base, and is checked", async (network) => {
    const { wrapper } = await signs(tableConfig(1187947933), { network });
    expect(wrapper.paymentRequirements.network).toBe('eip155:1187947933');
    await refused(tableConfig(8453), { network }, /registers '.*' as chain 1187947933/);
  });

  it("'skale-testnet' is the Python registry's alias of skale-base-sepolia", async () => {
    expect(getChainByName('skale-base-sepolia')!.chainId).toBe(324705682);
    await refused(tableConfig(8453), { network: 'skale-testnet' }, /as chain 324705682/);
  });

  it.each(['BASE', ' Base ', 'Base', 'EIP155:10', ' eip155:10 ', 'eip155:010'])(
    'another spelling of a known network (%j) is still checked',
    async (network) => {
      const cfg = network.toLowerCase().includes('eip155') ? tableConfig(8453) : tableConfig(10);
      await refused(cfg, { network }, /Chain id mismatch/);
    }
  );

  it.each(['eip155:', 'eip155:base', 'eip155:0x2105', 'eip155:-8453', 'eip155:+8453', 'eip155:8453.0', 'eip155:8 453', 'eip155:８４５３'])(
    '%j names no EVM chain id and is refused',
    async (network) => {
      await refused(tableConfig(8453), { network }, /names no EVM chain id/);
    }
  );

  it.each(['solana', 'stellar', 'xrpl', 'hedera', 'sui'])('a non-EVM network (%s) is refused', async (network) => {
    await refused(tableConfig(8453), { network }, /Chain id mismatch/);
  });

  it.each<[string, unknown]>([
    ['empty', ''],
    ['blank', '   '],
    ['a number', 8453],
    ['a boolean', true],
    ['an object', { name: 'base' }],
  ])('a network that is %s names no network and is refused', async (_label, network) => {
    await refused(tableConfig(8453), { network: network as string }, /names no network/);
  });

  it.each<[string, unknown]>([
    ['true', true],
    ['a hex string', '0x2105'],
    ['a padded string', ' 8453'],
    ['a signed string', '+8453'],
    ['a decimal string', '8453.0'],
    ['fullwidth digits', '８４５３'],
    ['a fraction', 8453.5],
    ['negative', -8453],
    ['Infinity', Infinity],
    ['past 2**53 - 1', 2 ** 53],
    ['digits past 2**53 - 1', '9007199254740993'],
    ['a bigint', 8453n],
    ['an object', { valueOf: () => 8453 }],
  ])('a chain_id that is %s is refused', async (_label, value) => {
    await refused(withField(tableConfig(8453), 'chain_id', value), {}, /Invalid chain_id/);
  });

  it.each(['chain_id', 'operator', 'escrow', 'token_collector', 'usdc'])('a null %s is a missing key', async (key) => {
    await refused(withField(tableConfig(8453), key, null), { network: 'base' }, new RegExp(`missing ${key}`));
  });

  it.each<[string, string]>([
    ['a 0X prefix', '0X'],
    ['a leading space', ' 0x'],
    ['no hex', '0xzz'],
  ])('a table address with %s is refused as not an address', async (_label, prefix) => {
    for (const key of ['operator', 'escrow', 'token_collector', 'usdc'] as const) {
      const cfg = tableConfig(8453);
      const value = prefix === '0xzz' ? '0x' + 'zz'.repeat(20) : prefix + cfg[key].slice(2);
      await refused({ ...cfg, [key]: value }, { network: 'base' }, new RegExp(`escrow config's ${key} .* is not an address`));
    }
  });

  it('a mixed-case address with a wrong checksum is refused as not an address', async () => {
    const cfg = tableConfig(8453);
    const swapped = cfg.token_collector.slice(0, 4) + cfg.token_collector[4].toLowerCase() + cfg.token_collector.slice(5);
    expect(swapped).not.toBe(cfg.token_collector); // '0x48AD…': the A is the one flipped
    await refused({ ...cfg, token_collector: swapped }, { network: 'base' }, /token_collector .* is not an address/);
  });

  it.each<[string, unknown]>([
    ['100%', 10_000],
    ['uint16 max', 65_535],
    ['a string above', '1801'],
  ])('a fee bound that is %s is refused by the ceiling', async (_label, value) => {
    await refused(withField(tableConfig(8453), 'max_fee_bps', value), { network: 'base' }, /above this SDK's ceiling/);
  });

  it.each(['min_fee_bps', 'max_fee_bps'])('%s that is not an integer from 0 to 65535 is refused', async (key) => {
    for (const value of [65_536, -1, 1800.5, 0.5, Infinity, Number.NaN, 'abc', '', ' 1500', '1500.0', '+1500', '0x5dc', '1e3', true, 1500n, [1500], {}]) {
      await refused(withField(tableConfig(8453), key, value), { network: 'base' }, new RegExp(`Invalid ${key} .*\\(an integer number of bps, 0 to 65535\\)`));
    }
  });

  it('the operator fee floor still applies under the ceiling', async () => {
    const { wrapper } = await signs({ ...tableConfig(8453), max_fee_bps: OPERATOR_FEE_BPS }, { network: 'base' });
    expect(wrapper.payload.paymentInfo.maxFeeBps).toBe(OPERATOR_FEE_BPS);
    await refused({ ...tableConfig(8453), max_fee_bps: OPERATOR_FEE_BPS - 1 }, { network: 'base' }, /cannot cover/);
  });

  it.each<[unknown, number]>([
    [0, 0],
    [OPERATOR_FEE_BPS - 1, 1299],
    [OPERATOR_FEE_BPS, 1300],
    ['1300', 1300],
  ])('min_fee_bps %j, up to the operator fee, is signed as %i', async (min, minBps) => {
    expect(OPERATOR_FEE_BPS).toBe(1300);
    const { wrapper } = await signs(withField(tableConfig(8453), 'min_fee_bps', min), { network: 'base' });
    expect(wrapper.payload.paymentInfo.minFeeBps).toBe(minBps);
  });

  it.each<unknown>([OPERATOR_FEE_BPS + 1, '1301', 1800, 65_535, '65535'])(
    'min_fee_bps %j, above the operator fee, is refused with nothing signed',
    async (min) => {
      await refused(withField(tableConfig(8453), 'min_fee_bps', min), { network: 'base' }, /minFeeBps=\d+ must be between 0 and the operator's 1300 bps static fee/);
    }
  );

  it.each(TABLE_CASES)('%s (chain %i): min_fee_bps 1301 is refused, 1300 signs', async (network, chainId) => {
    await refused(withField(tableConfig(chainId), 'min_fee_bps', 1301), { network }, /minFeeBps=1301 must be between 0 and the operator's/);
    await signs(withField(tableConfig(chainId), 'min_fee_bps', 1300), { network });
  });

  it.each<[unknown, unknown, number, number]>([
    ['1500', '0', 1500, 0],
    ['01800', '100', 1800, 100],
    [1500, 0, 1500, 0],
    [undefined, null, DEFAULT_MAX_FEE_BPS, 0],
  ])('fee bounds max %j / min %j are signed as the integers %i / %i', async (max, min, maxBps, minBps) => {
    const cfg = withField(withField(tableConfig(8453), 'max_fee_bps', max), 'min_fee_bps', min);
    const { wrapper } = await signs(cfg, { network: 'base' });
    expect(wrapper.payload.paymentInfo.maxFeeBps).toBe(maxBps);
    expect(wrapper.payload.paymentInfo.minFeeBps).toBe(minBps);
    expect(wrapper.payload.authorization.nonce).toBe(
      computeEscrowNonce(8453, REGISTRY_CONTRACTS[8453].escrow, FX.network_config.payment_info_typehash, wrapper.payload.paymentInfo)
    );
  });

  it("the tier ceilings are TIER_TIMINGS' enterprise tier, the authorization ceiling EM's 720 h plus the review window", () => {
    expect(ESCROW_TIER_WINDOW_MAX).toEqual(TIER_TIMINGS.enterprise);
    expect(ESCROW_TIER_WINDOW_MAX).toEqual({ pre: 86400, auth: 604800, refund: 2592000 });
    expect(Object.isFrozen(ESCROW_TIER_WINDOW_MAX)).toBe(true);
    expect(ESCROW_MAX_AUTHORIZATION_SEC).toBe(3196800);
    expect(ESCROW_MAX_AUTHORIZATION_SEC).toBe(720 * 3600 + FX.review_window_sec);
    for (const windows of Object.values(ESCROW_TIER_WINDOWS)) {
      for (const key of ['pre', 'auth', 'refund'] as const) expect(windows[key]).toBeLessThanOrEqual(ESCROW_TIER_WINDOW_MAX[key]);
    }
  });

  describe('tier windows and the authorization window (refused past the ceiling, never clamped)', () => {
    const NOW = FROZEN.now;
    const withTier = (windows: unknown): EscrowNetworkConfig =>
      ({ ...tableConfig(8453), tiers: { custom: windows } }) as unknown as EscrowNetworkConfig;
    const signedInfo = async (cfg: EscrowNetworkConfig, extra: ExtraParams = {}) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW * 1000));
      return (await signs(cfg, { network: 'base', tier: 'custom', ...extra })).wrapper.payload.paymentInfo;
    };
    const refusedAt = async (cfg: EscrowNetworkConfig, extra: ExtraParams, match: RegExp) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW * 1000));
      await refused(cfg, { network: 'base', tier: 'custom', ...extra }, match);
    };

    it('a tier at the ceilings signs exactly them', async () => {
      const pi = await signedInfo(withTier({ ...ESCROW_TIER_WINDOW_MAX }));
      expect(pi.preApprovalExpiry).toBe(NOW + 86400);
      expect(pi.authorizationExpiry).toBe(NOW + 604800);
      expect(pi.refundExpiry).toBe(NOW + 2592000);
    });

    it('windows written as decimal digits are signed as the numbers', async () => {
      const pi = await signedInfo(withTier({ pre: '3600', auth: '7200', refund: '86400' }));
      expect(pi.preApprovalExpiry).toBe(NOW + 3600);
      expect(typeof pi.preApprovalExpiry).toBe('number');
      expect(pi.authorizationExpiry).toBe(NOW + FX.review_window_sec);
    });

    it.each(['pre', 'auth', 'refund'] as const)('a %s window one second over its ceiling is refused', async (key) => {
      const windows = { ...ESCROW_TIER_WINDOW_MAX, [key]: ESCROW_TIER_WINDOW_MAX[key] + 1 };
      await refusedAt(withTier(windows), {}, new RegExp(`Invalid ${key} window ${ESCROW_TIER_WINDOW_MAX[key] + 1} \\(number\\) for escrow tier 'custom'`));
    });

    it.each(['pre', 'auth', 'refund'] as const)('a %s window that is not an integer from 0 is refused', async (key) => {
      for (const value of [-1, 1.5, Number.NaN, Infinity, 'abc', ' 3600', '3600.0', '', null, undefined, true, 3600n]) {
        await refusedAt(withTier({ pre: 3600, auth: 7200, refund: 86400, [key]: value }), {}, new RegExp(`Invalid ${key} window .* for escrow tier 'custom'`));
      }
    });

    it('a tier that is not an object of windows is refused', async () => {
      for (const windows of [5, 'micro', []]) await refusedAt(withTier(windows), {}, /Invalid pre window/);
    });

    it('a zero window signs', async () => {
      const pi = await signedInfo(withTier({ pre: 0, auth: 0, refund: 0 }));
      expect(pi.preApprovalExpiry).toBe(NOW);
    });

    it('a review deadline 720 h ahead signs at the authorization ceiling; one second later is refused', async () => {
      const deadline = NOW + 720 * 3600;
      const pi = await signedInfo(tableConfig(8453), { tier: 'micro', reviewDeadlineSec: deadline });
      expect(pi.authorizationExpiry).toBe(NOW + ESCROW_MAX_AUTHORIZATION_SEC);
      await refusedAt(tableConfig(8453), { tier: 'micro', reviewDeadlineSec: deadline + 1 }, /past this SDK's 3196800 s \(ESCROW_MAX_AUTHORIZATION_SEC\)/);
      await refusedAt(tableConfig(8453), { tier: 'micro', reviewDeadlineSec: NOW + 100 * 365 * 24 * 3600 }, /ESCROW_MAX_AUTHORIZATION_SEC/);
    });

    it('a review deadline that is not an integer is refused, not signed', async () => {
      for (const deadline of [Number.NaN, Infinity, NOW + 0.5, '', String(NOW + 3600), ` ${NOW} `, true, BigInt(NOW), [NOW]]) {
        await refusedAt(tableConfig(8453), { tier: 'micro', reviewDeadlineSec: deadline as number }, /Invalid reviewDeadlineSec .*\(epoch seconds, an integer\)/);
      }
    });

    it('a null review deadline is no deadline', async () => {
      const pi = await signedInfo(tableConfig(8453), { tier: 'micro', reviewDeadlineSec: null as unknown as number });
      expect(pi.authorizationExpiry).toBe(NOW + FX.review_window_sec);
    });
  });

  it('the config is read once: a getter that changes its answer signs what was checked', async () => {
    const table = tableConfig(8453);
    const other = getAddress('0x' + 'ee'.repeat(20));
    const reads = { token_collector: 0, operator: 0, usdc: 0, escrow: 0 };
    const cfg = { ...table } as Record<string, unknown>;
    for (const key of Object.keys(reads) as Array<keyof typeof reads>) {
      Object.defineProperty(cfg, key, {
        enumerable: true,
        get: () => (reads[key]++ === 0 ? table[key] : other),
      });
    }
    const { wrapper, typedData } = await signs(cfg as unknown as EscrowNetworkConfig, { network: 'base' });
    expect(reads).toEqual({ token_collector: 1, operator: 1, usdc: 1, escrow: 1 });
    expect(typedData.message.to).toBe(table.token_collector);
    expect(typedData.domain.verifyingContract).toBe(table.usdc);
    expect(wrapper.payload.paymentInfo.operator).toBe(table.operator);
    expect(wrapper.payload.paymentInfo.feeReceiver).toBe(table.operator);
    expect(wrapper.payload.authorization.nonce).toBe(
      computeEscrowNonce(8453, table.escrow, table.payment_info_typehash, wrapper.payload.paymentInfo)
    );
  });

  it('a Proxy config is read once too', async () => {
    const table = tableConfig(8453);
    let reads = 0;
    const proxy = new Proxy(table, {
      get: (target, key) => (key === 'token_collector' && reads++ > 0 ? getAddress('0x' + 'ee'.repeat(20)) : Reflect.get(target, key)),
    });
    const { typedData } = await signs(proxy, { network: 'base' });
    expect(reads).toBe(1);
    expect(typedData.message.to).toBe(table.token_collector);
  });

  it('a config whose keys are inherited (a class instance, Object.create) signs, read once', async () => {
    const table = tableConfig(8453);
    let reads = 0;
    class Config {
      get token_collector() {
        reads++;
        return table.token_collector;
      }
    }
    for (const key of Object.keys(table) as Array<keyof EscrowNetworkConfig>) {
      if (key !== 'token_collector') Object.defineProperty(Config.prototype, key, { get: () => table[key] });
    }
    const { typedData } = await signs(new Config() as unknown as EscrowNetworkConfig, { network: 'base' });
    expect(reads).toBe(1);
    expect(typedData.message.to).toBe(table.token_collector);
    await signs(Object.create(table) as EscrowNetworkConfig, { network: 'base' });
    await refused(
      Object.create({ ...table, operator: changed(table.operator) }) as EscrowNetworkConfig,
      { network: 'base' },
      /Escrow operator mismatch/
    );
  });

  it('the escrow registry, each of its rows, and the operator and fee-ceiling tables are frozen', () => {
    expect(Object.isFrozen(REGISTRY_CONTRACTS)).toBe(true);
    for (const [chainId, row] of Object.entries(REGISTRY_CONTRACTS)) expect(Object.isFrozen(row), `row ${chainId}`).toBe(true);
    expect(Object.isFrozen(ESCROW_OPERATORS)).toBe(true);
    expect(Object.isFrozen(ESCROW_MAX_FEE_BPS)).toBe(true);
    // ESM is strict: a write to a frozen row throws instead of changing what is signed.
    expect(() => {
      (REGISTRY_CONTRACTS[8453] as { escrow: string }).escrow = '0x' + '02'.repeat(20);
    }).toThrow(TypeError);
    expect(REGISTRY_CONTRACTS[8453].escrow).toBe(EM_NETWORKS.base.escrow);
  });
});

describe('buildEscrowPreAuth against the SDK tables: a delegated payer gets the same refusals', () => {
  // The resolver's verdicts: SMA wrap (bool and target), a 1271 delegate that
  // takes the plain signature, and a plain EOA.
  const DELEGATIONS: Record<string, DelegationResolver> = {
    'sma-bool': () => true,
    'sma-target': () => SMA_WRAP_TARGETS[0],
    'plain-1271': () => '0x' + 'd1'.repeat(20),
    'not-delegated': () => false,
  };

  it.each(Object.keys(DELEGATIONS))('%s: the table signs, and a changed collector, operator, chain or fee does not', async (name) => {
    const delegationResolver = DELEGATIONS[name];
    await signs(tableConfig(8453), { network: 'base', delegationResolver });
    const base = tableConfig(8453);
    await refused({ ...base, token_collector: changed(base.token_collector) }, { network: 'base', delegationResolver }, /Escrow address mismatch/);
    await refused({ ...base, operator: changed(base.operator) }, { network: 'base', delegationResolver }, /Escrow operator mismatch/);
    await refused(tableConfig(10), { network: 'base', delegationResolver }, /Chain id mismatch/);
    await refused({ ...base, max_fee_bps: 5000 }, { network: 'base', delegationResolver }, /above this SDK's ceiling/);
  });
});

describe('buildEscrowPreAuth: the payment_info_typehash is AuthCaptureEscrow\'s, checked before signing', () => {
  const PAYMENT_INFO_TYPE =
    'PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,' +
    'uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,' +
    'uint16 maxFeeBps,address feeReceiver,uint256 salt)';
  const DIGITS = ESCROW_PAYMENT_INFO_TYPEHASH.slice(2);

  it("is keccak256 of the PaymentInfo struct, the backend's PAYMENT_INFO_TYPEHASH and the golden vector's", () => {
    expect(ESCROW_PAYMENT_INFO_TYPEHASH).toBe(id(PAYMENT_INFO_TYPE));
    expect(ESCROW_PAYMENT_INFO_TYPEHASH).toBe(PAYMENT_INFO_TYPEHASH);
    expect(FX.network_config.payment_info_typehash).toBe(ESCROW_PAYMENT_INFO_TYPEHASH);
  });

  it('is exported from the package root', async () => {
    expect((await import('./index')).ESCROW_PAYMENT_INFO_TYPEHASH).toBe(ESCROW_PAYMENT_INFO_TYPEHASH);
  });

  it.each<[string, unknown]>([
    ['a filler typehash', '0x' + '5a'.repeat(32)],
    ['one hex digit changed', '0x' + DIGITS.slice(0, -1) + ((parseInt(DIGITS.slice(-1), 16) + 1) % 16).toString(16)],
    ['the typehash of another struct', id('ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)')],
    ['the typehash with a byte appended', ESCROW_PAYMENT_INFO_TYPEHASH + '00'],
    ['the typehash with a byte missing', ESCROW_PAYMENT_INFO_TYPEHASH.slice(0, -2)],
    ['the typehash prefixed twice', '0x' + ESCROW_PAYMENT_INFO_TYPEHASH],
    ['the typehash as a number', Number.parseInt(ESCROW_PAYMENT_INFO_TYPEHASH, 16)],
    ['the typehash in an array', [ESCROW_PAYMENT_INFO_TYPEHASH]],
  ])('%s is refused, with nothing signed and no delegation looked up', async (_label, typehash) => {
    const delegationResolver = vi.fn(() => false);
    await refused(withField(tableConfig(8453), 'payment_info_typehash', typehash), { network: 'base', delegationResolver }, /payment_info_typehash .* not AuthCaptureEscrow's PaymentInfo typehash/);
    expect(delegationResolver).not.toHaveBeenCalled();
  });

  it.each(TABLE_CASES)('%s (chain %i): a filler typehash is refused', async (network, chainId) => {
    await refused(withField(tableConfig(chainId), 'payment_info_typehash', '0x' + '5a'.repeat(32)), { network }, /not AuthCaptureEscrow's PaymentInfo typehash/);
  });

  it.each([
    ['0x-prefixed', ESCROW_PAYMENT_INFO_TYPEHASH],
    ['unprefixed', DIGITS],
    ['upper-case hex', '0x' + DIGITS.toUpperCase()],
    ['an upper-case prefix', '0X' + DIGITS],
    ['surrounding spaces', '  ' + ESCROW_PAYMENT_INFO_TYPEHASH + ' '],
  ])('the typehash %s signs, and the nonce hashes the canonical typehash', async (_label, typehash) => {
    const { wrapper } = await signs({ ...tableConfig(8453), payment_info_typehash: typehash }, { network: 'base' });
    expect(wrapper.payload.authorization.nonce).toBe(
      computeEscrowNonce(8453, REGISTRY_CONTRACTS[8453].escrow, ESCROW_PAYMENT_INFO_TYPEHASH, wrapper.payload.paymentInfo)
    );
  });
});

describe("CHAIN_ALIASES: the Python SDK's _NETWORK_ALIASES", () => {
  it('has exactly the aliases of the Python registry (uvd-x402-sdk-python networks/base.py)', () => {
    expect(CHAIN_ALIASES).toEqual({
      hedera: 'hedera:mainnet',
      'hedera-testnet': 'hedera:testnet',
      skale: 'skale-base',
      'skale-testnet': 'skale-base-sepolia',
      'xrpl-mainnet': 'xrpl',
    });
    for (const [alias, name] of Object.entries(CHAIN_ALIASES)) {
      expect(SUPPORTED_CHAINS[name], `${alias} -> ${name}`).toBeDefined();
      expect(Object.hasOwn(SUPPORTED_CHAINS, alias), `${alias} is no network of its own`).toBe(false);
    }
  });

  it.each([
    ['skale', 'skale-base', 1187947933],
    ['SKALE', 'skale-base', 1187947933],
    ['skale-testnet', 'skale-base-sepolia', 324705682],
    ['Skale-Testnet', 'skale-base-sepolia', 324705682],
  ])('getChainByName(%j) is %s (chain %i)', (alias, name, chainId) => {
    const chain = getChainByName(alias);
    expect(chain).toBe(SUPPORTED_CHAINS[name]);
    expect(chain!.chainId).toBe(chainId);
    expect(isChainSupported(alias)).toBe(true);
    expect(chainToCAIP2(alias)).toBe(`eip155:${chainId}`);
  });
});

describe('VERIFIED_USDC_DOMAINS and ESCROW_TIER_WINDOWS are frozen, rows included', () => {
  it('VERIFIED_USDC_DOMAINS and each of its domains are frozen; a write throws and changes nothing', () => {
    expect(Object.isFrozen(VERIFIED_USDC_DOMAINS)).toBe(true);
    for (const [chainId, domain] of Object.entries(VERIFIED_USDC_DOMAINS)) expect(Object.isFrozen(domain), `chain ${chainId}`).toBe(true);
    expect(() => {
      (VERIFIED_USDC_DOMAINS as Record<number, { name: string; version: string }>)[84532] = { name: 'USDC', version: '2' };
    }).toThrow(TypeError);
    expect(() => {
      (VERIFIED_USDC_DOMAINS[5042] as { name: string }).name = 'USD Coin';
    }).toThrow(TypeError);
    expect(() => {
      (VERIFIED_USDC_DOMAINS[8453] as { version: string }).version = '1';
    }).toThrow(TypeError);
    expect(VERIFIED_USDC_DOMAINS[84532]).toBeUndefined();
    expect(VERIFIED_USDC_DOMAINS[8453]).toEqual({ name: 'USD Coin', version: '2' });
    expect(Object.keys(VERIFIED_USDC_DOMAINS).sort()).toEqual(Object.keys(ESCROW_OPERATORS).sort());
    expect(VERIFIED_USDC_DOMAINS[5042]).toEqual({ name: 'USDC', version: '2' });
  });

  it('ESCROW_TIER_WINDOWS and each of its tiers are frozen; a write throws and changes nothing', () => {
    expect(Object.isFrozen(ESCROW_TIER_WINDOWS)).toBe(true);
    for (const [tier, windows] of Object.entries(ESCROW_TIER_WINDOWS)) expect(Object.isFrozen(windows), `tier ${tier}`).toBe(true);
    expect(() => {
      (ESCROW_TIER_WINDOWS as Record<string, EscrowTierWindows>).forever = { pre: 1, auth: 1, refund: 1 };
    }).toThrow(TypeError);
    expect(() => {
      (ESCROW_TIER_WINDOWS.micro as EscrowTierWindows).auth = 1;
    }).toThrow(TypeError);
    expect(ESCROW_TIER_WINDOWS).toEqual(FX.escrow_tier_windows);
  });
});
