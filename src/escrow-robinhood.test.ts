import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EnvKeyAdapter } from './adapters/env-key';
import {
  AdvancedEscrowClient,
  ESCROW_OPERATOR_GENERATION,
  ESCROW_UNSUPPORTED_ON_GENERATION,
  OPERATOR_ABI_V3,
  USDC_DOMAIN_NAME,
  USDC_DOMAIN_VERSION,
  getEscrowContractsByChainId,
  getEscrowOperatorGeneration,
  isEscrowSupportedOnChain,
} from './backend';
import type { AdvancedPaymentInfo } from './backend';
import { getChainByName } from './chains';
import {
  ESCROW_CONTRACTS,
  ESCROW_MAX_FEE_BPS,
  ESCROW_OPERATORS,
  robinhoodUsdg,
} from './escrow-contracts';
import {
  buildEscrowPreAuth,
  computeEscrowNonce,
  ESCROW_PAYMENT_INFO_TYPEHASH,
  VERIFIED_USDC_DOMAINS,
} from './escrow-preauth';
import type { EscrowNetworkConfig, EscrowPreAuthParams } from './escrow-preauth';
import { X402Error } from './types';

/**
 * Robinhood Chain (4663) on the x402r canonical escrow, with USDG. Nothing here
 * reaches a network: every expected value is written out below, from the three
 * sources the rows were crossed against, and nothing is read from a chain.
 *
 *   (a) this SDK's Arc row (5042): every address but the token;
 *   (b) execution-market@1517823a, docs/handoffs/robinhood-deployed-evidence/reads.json
 *       (measured 2026-11-05 on chain 4663, block 0x65f0768: the factory's
 *       getOperator with Execution Market's config, the operator's ESCROW() and
 *       PROTOCOL_FEE_CONFIG(), runtime code identical to Arc's) and
 *       mcp_server/integrations/x402/network_registry.py (USDG: address,
 *       Global Dollar / 1, 6 decimals);
 *   (c) x402-rs@bc2fe3e5, src/payment_operator/addresses.rs (canonical_v1,
 *       CANONICAL_V1_NETWORKS, payment_operators) and src/network.rs
 *       (USDG_ROBINHOOD).
 *
 * Robinhood testnet (46630) has no escrow: Execution Market's operator has no
 * code there (reads.json), and x402-rs lists no escrow for it.
 */

const CHAIN_ID = 4663;
const TESTNET_CHAIN_ID = 46630;

const OPERATOR = '0x0258472A1410Ac3Ad720f1BC83f22B3c0af1Fd9D';
const ESCROW = '0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff';
const TOKEN_COLLECTOR = '0x0E3dF9510de65469C4518D7843919c0b8C7A7757';
const PROTOCOL_FEE_CONFIG = '0xBe2d24614F339a1eB103A399F93AA2a39Ca815Bc';
const REFUND_REQUEST = '0xe971C674fD5c3462023f3F891dF6289DFbC9CEFC';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const USDG_TESTNET = '0x7E955252E15c84f5768B83c41a71F9eba181802F';
const USDG_DOMAIN = { name: 'Global Dollar', version: '1' };
const MAX_FEE_BPS = 1800;

const ROW = {
  operator: OPERATOR,
  escrow: ESCROW,
  tokenCollector: TOKEN_COLLECTOR,
  protocolFeeConfig: PROTOCOL_FEE_CONFIG,
  refundRequest: REFUND_REQUEST,
  usdc: USDG,
};

/** The network block a marketplace would serve for Robinhood Chain. */
const CONFIG: EscrowNetworkConfig = {
  chain_id: CHAIN_ID,
  operator: OPERATOR,
  escrow: ESCROW,
  token_collector: TOKEN_COLLECTOR,
  usdc: USDG,
  usdc_domain_name: USDG_DOMAIN.name,
  usdc_domain_version: USDG_DOMAIN.version,
  payment_info_typehash: ESCROW_PAYMENT_INFO_TYPEHASH,
  min_fee_bps: 0,
  max_fee_bps: MAX_FEE_BPS,
};

const ALL_FOUR = 'ESCROW_CONTRACTS, ESCROW_OPERATORS, ESCROW_MAX_FEE_BPS, VERIFIED_USDC_DOMAINS';
const noRowsMessage = (chainId: number) =>
  `Chain ${chainId} has no row in this SDK's escrow tables (${ALL_FOUR}) — refusing to sign.`;

const PAYER = '0x2222222222222222222222222222222222222222';
const WORKER = '0x1111111111111111111111111111111111111111';
const MOCK_SIGNATURE = '0x' + '11'.repeat(65);
/** The synthetic test key of the golden vectors (0x42 * 32, never held funds). */
const SYNTHETIC_KEY = '0x' + '42'.repeat(32);

/** The same address with its last hex digit moved by one, checksummed. */
function changed(address: string): string {
  const lower = address.toLowerCase();
  return ethers.getAddress(lower.slice(0, -1) + ((parseInt(lower.slice(-1), 16) + 1) % 16).toString(16));
}

type ExtraParams = Partial<Omit<EscrowPreAuthParams, 'networkConfig'>>;

function attempt(networkConfig: EscrowNetworkConfig, extra: ExtraParams = {}) {
  const signTypedData = vi.fn(async (_typedData: string) => ({ signature: MOCK_SIGNATURE }));
  const result = buildEscrowPreAuth(
    { signTypedData },
    { networkConfig, payerWallet: PAYER, workerWallet: WORKER, bountyAtomic: '250000', ...extra },
  );
  return { result, signTypedData };
}

async function signs(networkConfig: EscrowNetworkConfig, extra: ExtraParams = {}) {
  const { result, signTypedData } = attempt(networkConfig, extra);
  const wrapper = JSON.parse(await result);
  expect(signTypedData).toHaveBeenCalledTimes(1);
  return { wrapper, typedData: JSON.parse(signTypedData.mock.calls[0][0]) };
}

/** The refusal, with nothing signed before it. */
async function refusal(networkConfig: EscrowNetworkConfig, extra: ExtraParams = {}): Promise<X402Error> {
  const { result, signTypedData } = attempt(networkConfig, extra);
  const error = await result.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, 'the config must be refused').toBeInstanceOf(X402Error);
  expect(signTypedData, 'nothing may be signed before the refusal').not.toHaveBeenCalled();
  return error as X402Error;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Robinhood Chain (4663) escrow rows', () => {
  it('ESCROW_CONTRACTS[4663] is the canonical escrow with its operator, and USDG', () => {
    expect(ESCROW_CONTRACTS[CHAIN_ID]).toEqual(ROW);
    expect(getEscrowContractsByChainId(CHAIN_ID)).toBe(ESCROW_CONTRACTS[CHAIN_ID]);
    expect(isEscrowSupportedOnChain(CHAIN_ID)).toBe(true);
    expect(Object.isFrozen(ESCROW_CONTRACTS[CHAIN_ID])).toBe(true);
  });

  it("ESCROW_OPERATORS[4663] is Execution Market's operator, the row's operator column too", () => {
    expect(ESCROW_OPERATORS[CHAIN_ID]).toBe(OPERATOR);
    expect(ESCROW_CONTRACTS[CHAIN_ID].operator).toBe(OPERATOR);
  });

  it('ESCROW_MAX_FEE_BPS[4663] is 1800, the same ceiling as Arc', () => {
    expect(ESCROW_MAX_FEE_BPS[CHAIN_ID]).toBe(MAX_FEE_BPS);
    expect(ESCROW_MAX_FEE_BPS[CHAIN_ID]).toBe(ESCROW_MAX_FEE_BPS[5042]);
  });

  it('VERIFIED_USDC_DOMAINS[4663] is USDG\'s domain, Global Dollar / 1, frozen', () => {
    expect(VERIFIED_USDC_DOMAINS[CHAIN_ID]).toEqual(USDG_DOMAIN);
    expect(Object.isFrozen(VERIFIED_USDC_DOMAINS[CHAIN_ID])).toBe(true);
  });

  it("every address but the token is the Arc row's (source a)", () => {
    const { usdc: arcToken, ...arc } = ESCROW_CONTRACTS[5042];
    const { usdc: token, ...robinhood } = ESCROW_CONTRACTS[CHAIN_ID];
    expect(robinhood).toEqual(arc);
    expect(ESCROW_OPERATORS[CHAIN_ID]).toBe(ESCROW_OPERATORS[5042]);
    expect(token).not.toBe(arcToken);
    expect(VERIFIED_USDC_DOMAINS[CHAIN_ID]).not.toEqual(VERIFIED_USDC_DOMAINS[5042]);
  });

  it("the token is the chain registry's USDG: 6 decimals, Global Dollar / 1", () => {
    const chain = getChainByName('robinhood')!;
    expect(chain.chainId).toBe(CHAIN_ID);
    expect(chain.usdc).toEqual({ address: USDG, decimals: 6, ...USDG_DOMAIN });
    expect(chain.tokens?.usdg).toEqual(chain.usdc);
    expect(robinhoodUsdg()).toBe(chain.usdc);
    expect(ESCROW_CONTRACTS[CHAIN_ID].usdc).toBe(chain.usdc.address);
  });

  it('the backend client signs the same domain: USDC_DOMAIN_NAME and USDC_DOMAIN_VERSION', () => {
    expect(USDC_DOMAIN_NAME[CHAIN_ID]).toBe(USDG_DOMAIN.name);
    expect(USDC_DOMAIN_VERSION[CHAIN_ID]).toBe(USDG_DOMAIN.version);
    // Only Robinhood Chain has a version other than '2': no other chain changes.
    expect(Object.keys(USDC_DOMAIN_VERSION)).toEqual([String(CHAIN_ID)]);
    expect(Object.isFrozen(USDC_DOMAIN_VERSION)).toBe(true);
  });

  it("the operator generation is 'v3', as on Arc", () => {
    expect(ESCROW_OPERATOR_GENERATION[CHAIN_ID]).toBe('v3');
    expect(getEscrowOperatorGeneration(CHAIN_ID)).toBe(getEscrowOperatorGeneration(5042));
  });
});

describe('buildEscrowPreAuth on Robinhood Chain (4663): USDG on the canonical escrow', () => {
  it.each(['robinhood', 'ROBINHOOD', ' Robinhood ', 'eip155:4663', 'EIP155:4663', ' eip155:4663 ', 'eip155:04663', undefined])(
    'network %j: signs the pre-auth with USDG, the canonical escrow and its operator',
    async (network) => {
      const { wrapper, typedData } = await signs(CONFIG, { network });
      const { authorization, paymentInfo, signature } = wrapper.payload;
      expect(typedData.primaryType).toBe('ReceiveWithAuthorization');
      expect(typedData.domain).toEqual({ ...USDG_DOMAIN, chainId: CHAIN_ID, verifyingContract: USDG });
      expect(paymentInfo.token).toBe(USDG);
      expect(paymentInfo.operator).toBe(OPERATOR);
      expect(paymentInfo.feeReceiver).toBe(OPERATOR);
      expect(paymentInfo.receiver).toBe(WORKER);
      expect(paymentInfo.maxAmount).toBe('250000');
      expect(paymentInfo.minFeeBps).toBe(0);
      expect(paymentInfo.maxFeeBps).toBe(MAX_FEE_BPS);
      expect(typedData.message.to).toBe(TOKEN_COLLECTOR);
      expect(authorization.to).toBe(TOKEN_COLLECTOR);
      expect(authorization.from).toBe(PAYER);
      expect(authorization.value).toBe('250000');
      expect(typedData.message.value).toBe('250000');
      expect(authorization.nonce).toBe(computeEscrowNonce(CHAIN_ID, ESCROW, ESCROW_PAYMENT_INFO_TYPEHASH, paymentInfo));
      expect(typedData.message.nonce).toBe(authorization.nonce);
      expect(signature).toBe(MOCK_SIGNATURE);
      expect(wrapper.paymentRequirements).toEqual({ scheme: 'escrow', network: 'eip155:4663' });
    },
  );

  it("verifyingContract is the row's token, by the same pattern as Arc's row", async () => {
    // Measured in the code: on Arc the domain's verifyingContract is ESCROW_CONTRACTS[5042].usdc.
    const arc = ESCROW_CONTRACTS[5042];
    const arcConfig: EscrowNetworkConfig = {
      ...CONFIG,
      chain_id: 5042,
      operator: ESCROW_OPERATORS[5042],
      escrow: arc.escrow,
      token_collector: arc.tokenCollector,
      usdc: arc.usdc,
      usdc_domain_name: VERIFIED_USDC_DOMAINS[5042].name,
      usdc_domain_version: VERIFIED_USDC_DOMAINS[5042].version,
    };
    const onArc = await signs(arcConfig, { network: 'arc' });
    expect(onArc.typedData.domain.verifyingContract).toBe(arc.usdc);
    expect(onArc.wrapper.payload.paymentInfo.token).toBe(arc.usdc);

    const onRobinhood = await signs(CONFIG, { network: 'robinhood' });
    expect(onRobinhood.typedData.domain.verifyingContract).toBe(ESCROW_CONTRACTS[CHAIN_ID].usdc);
    expect(onRobinhood.wrapper.payload.paymentInfo.token).toBe(ESCROW_CONTRACTS[CHAIN_ID].usdc);
  });

  it('the nonce commits to chain 4663: the same paymentInfo hashes differently on Arc', async () => {
    const { wrapper } = await signs(CONFIG, { network: 'robinhood' });
    const { paymentInfo, authorization } = wrapper.payload;
    expect(authorization.nonce).not.toBe(computeEscrowNonce(5042, ESCROW, ESCROW_PAYMENT_INFO_TYPEHASH, paymentInfo));
  });

  it('a real key signs it, and the signature recovers to the payer under Global Dollar / 1 / 4663 / USDG only', async () => {
    const adapter = new EnvKeyAdapter(SYNTHETIC_KEY);
    const payer = adapter.getAddress();
    const calls: string[] = [];
    const wallet = {
      signTypedData: (typedData: string) => {
        calls.push(typedData);
        return adapter.signTypedData(typedData);
      },
    };
    const header = await buildEscrowPreAuth(wallet, {
      networkConfig: CONFIG,
      network: 'robinhood',
      payerWallet: payer,
      workerWallet: WORKER,
      bountyAtomic: '250000',
    });
    expect(calls).toHaveLength(1);
    const { authorization, signature } = JSON.parse(header).payload;
    const { types } = JSON.parse(calls[0]);
    const domain = { ...USDG_DOMAIN, chainId: CHAIN_ID, verifyingContract: USDG };
    expect(ethers.verifyTypedData(domain, types, authorization, signature)).toBe(payer);
    // Under any other domain the same signature names someone else.
    for (const other of [
      { ...domain, version: '2' },
      { ...domain, name: 'USD Coin' },
      { ...domain, chainId: 46630 },
      { ...domain, verifyingContract: USDG_TESTNET },
    ]) {
      expect(ethers.verifyTypedData(other, types, authorization, signature)).not.toBe(payer);
    }
  });

  it('USDG has 6 decimals: the $100 deposit limit is 100000000 atomic units, one more is refused', async () => {
    const { wrapper } = await signs(CONFIG, { network: 'robinhood', bountyAtomic: '100000000' });
    expect(wrapper.payload.paymentInfo.maxAmount).toBe('100000000');
    const error = await refusal(CONFIG, { network: 'robinhood', bountyAtomic: '100000001' });
    expect(error.code).toBe('INVALID_AMOUNT');
    expect(error.message).toContain('exceeds the on-chain escrow deposit limit ($100)');
  });
});

describe('buildEscrowPreAuth on Robinhood Chain (4663): one contradiction per row, refused before signing', () => {
  it.each(['escrow', 'token_collector', 'usdc'] as const)('a config whose %s differs by one byte is refused', async (key) => {
    for (const network of ['robinhood', undefined]) {
      const error = await refusal({ ...CONFIG, [key]: changed(CONFIG[key]) }, { network });
      expect(error.code).toBe('INVALID_CONFIG');
      expect(error.message).toContain(`Escrow address mismatch for chain 4663: the escrow config asserts ${key} `);
    }
  });

  it('a config whose operator differs by one byte is refused', async () => {
    const error = await refusal({ ...CONFIG, operator: changed(OPERATOR) }, { network: 'robinhood' });
    expect(error.message).toContain("Escrow operator mismatch for chain 4663: the escrow config asserts operator ");
    expect(error.message).toContain(`this SDK's ESCROW_OPERATORS has ${OPERATOR}`);
  });

  it('the fee ceiling: 1800 bps signs, 1801 is refused', async () => {
    const { wrapper } = await signs({ ...CONFIG, max_fee_bps: 1800 }, { network: 'robinhood' });
    expect(wrapper.payload.paymentInfo.maxFeeBps).toBe(1800);
    const error = await refusal({ ...CONFIG, max_fee_bps: 1801 }, { network: 'robinhood' });
    expect(error.message).toContain("maxFeeBps=1801 for chain 4663 is above this SDK's ceiling for that chain (1800 bps");
  });

  it.each([
    ['USD Coin', '2'],
    ['USDC', '2'],
    ['Global Dollar', '2'],
    ['Global Dollar', ' 1'],
    ['global dollar', '1'],
    ['Global Dollar ', '1'],
    ['USDG', '1'],
  ])('the domain %j / %j is refused', async (name, version) => {
    const error = await refusal({ ...CONFIG, usdc_domain_name: name, usdc_domain_version: version }, { network: 'robinhood' });
    expect(error.message).toContain(`but the token's on-chain domain is "Global Dollar" / "1"`);
  });

  it("Arc's USDC, or the testnet's USDG, is not the token on chain 4663", async () => {
    for (const usdc of [ESCROW_CONTRACTS[5042].usdc, USDG_TESTNET]) {
      const error = await refusal({ ...CONFIG, usdc }, { network: 'robinhood' });
      expect(error.message).toContain('Escrow address mismatch for chain 4663: the escrow config asserts usdc ');
    }
  });

  it("Robinhood's config under Arc's name, or Arc's chain under Robinhood's name, is refused", async () => {
    const underArc = await refusal(CONFIG, { network: 'arc' });
    expect(underArc.message).toContain("Chain id mismatch for 'arc'");
    const arcChain = await refusal({ ...CONFIG, chain_id: 5042 }, { network: 'robinhood' });
    expect(arcChain.message).toContain("Chain id mismatch for 'robinhood': the escrow config asserts chain 5042");
  });
});

describe('Robinhood testnet (46630) has no escrow', () => {
  const TESTNET_CONFIG: EscrowNetworkConfig = { ...CONFIG, chain_id: TESTNET_CHAIN_ID, usdc: USDG_TESTNET };

  it('has no row in any of the four tables, nor an operator generation', () => {
    expect(ESCROW_CONTRACTS[TESTNET_CHAIN_ID]).toBeUndefined();
    expect(ESCROW_OPERATORS[TESTNET_CHAIN_ID]).toBeUndefined();
    expect(ESCROW_MAX_FEE_BPS[TESTNET_CHAIN_ID]).toBeUndefined();
    expect(VERIFIED_USDC_DOMAINS[TESTNET_CHAIN_ID]).toBeUndefined();
    expect(ESCROW_OPERATOR_GENERATION[TESTNET_CHAIN_ID]).toBeUndefined();
    expect(isEscrowSupportedOnChain(TESTNET_CHAIN_ID)).toBe(false);
    expect(getChainByName('robinhood-testnet')!.chainId).toBe(TESTNET_CHAIN_ID);
  });

  it('buildEscrowPreAuth refuses it with the error of any chain without rows, with and without its name', async () => {
    const unknownChain = await refusal({ ...CONFIG, chain_id: 999999 });
    expect(unknownChain.message).toBe(noRowsMessage(999999));
    for (const network of [undefined, 'robinhood-testnet', 'ROBINHOOD-TESTNET', 'eip155:46630']) {
      for (const cfg of [TESTNET_CONFIG, { ...CONFIG, chain_id: TESTNET_CHAIN_ID }]) {
        const error = await refusal(cfg, { network });
        expect(error.code).toBe(unknownChain.code);
        expect(error.message).toBe(noRowsMessage(TESTNET_CHAIN_ID));
        expect(error.message.replace(String(TESTNET_CHAIN_ID), 'N')).toBe(unknownChain.message.replace('999999', 'N'));
      }
    }
  });

  it("is not Robinhood mainnet: the testnet chain under mainnet's name is refused", async () => {
    const error = await refusal(TESTNET_CONFIG, { network: 'robinhood' });
    expect(error.message).toContain("Chain id mismatch for 'robinhood': the escrow config asserts chain 46630");
  });

  it('AdvancedEscrowClient has no contracts for it', () => {
    expect(() => new AdvancedEscrowClient({ getAddress: async () => PAYER }, { chainId: TESTNET_CHAIN_ID })).toThrow(
      'No escrow contracts found for chain ID 46630',
    );
  });
});

describe('AdvancedEscrowClient on Robinhood Chain (4663)', () => {
  const FACILITATOR_URL = 'http://facilitator.invalid';
  const OPERATOR_V3 = new ethers.Interface(OPERATOR_ABI_V3);

  function paymentInfo(): AdvancedPaymentInfo {
    return {
      operator: OPERATOR,
      receiver: WORKER,
      token: USDG,
      maxAmount: '5000000',
      preApprovalExpiry: 1760003600,
      authorizationExpiry: 1761036800,
      refundExpiry: 1761641600,
      minFeeBps: 0,
      maxFeeBps: 1800,
      feeReceiver: OPERATOR,
      salt: '0x5eedc0de',
    };
  }

  function stubFacilitator(): Array<{ url: string; body: any }> {
    const bodies: Array<{ url: string; body: any }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        bodies.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => ({ success: true, transaction: '0xfeed' }) };
      }),
    );
    return bodies;
  }

  it('authorize signs ReceiveWithAuthorization under USDG\'s domain (ethers.Signer mode)', async () => {
    const signed: Array<{ domain: any; message: any }> = [];
    const signer = {
      provider: null,
      getAddress: async () => PAYER,
      signTypedData: async (domain: unknown, _types: unknown, message: unknown) => {
        signed.push({ domain, message });
        return MOCK_SIGNATURE;
      },
    };
    const bodies = stubFacilitator();
    const client = new AdvancedEscrowClient(signer, { chainId: CHAIN_ID, facilitatorUrl: FACILITATOR_URL });
    const result = await client.authorize(paymentInfo());
    expect(result.success).toBe(true);
    expect(signed).toHaveLength(1);
    expect(signed[0].domain).toEqual({ ...USDG_DOMAIN, chainId: CHAIN_ID, verifyingContract: USDG });
    expect(signed[0].message.to).toBe(TOKEN_COLLECTOR);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].url).toBe(`${FACILITATOR_URL}/settle`);
    expect(bodies[0].body.paymentRequirements).toMatchObject({
      scheme: 'escrow',
      network: 'eip155:4663',
      asset: USDG,
      extra: { escrowAddress: ESCROW, operatorAddress: OPERATOR, tokenCollector: TOKEN_COLLECTOR },
    });
  });

  it('authorize signs the same domain through a SigningWalletAdapter', async () => {
    const signed: any[] = [];
    const wallet = {
      getAddress: () => PAYER,
      signTypedData: async (json: string) => {
        signed.push(JSON.parse(json));
        return { signature: MOCK_SIGNATURE, v: 27, r: '0x', s: '0x' };
      },
      signTransaction: async () => {
        throw new Error('not expected');
      },
    };
    stubFacilitator();
    const client = new AdvancedEscrowClient(null, {
      chainId: CHAIN_ID,
      wallet: wallet as any,
      rpcUrl: 'http://127.0.0.1:9',
      facilitatorUrl: FACILITATOR_URL,
    });
    expect((await client.authorize(paymentInfo())).success).toBe(true);
    expect(signed).toHaveLength(1);
    expect(signed[0].domain).toEqual({ ...USDG_DOMAIN, chainId: CHAIN_ID, verifyingContract: USDG });
  });

  it("USDC_DOMAIN_VERSION[4663] is the chain registry's version, not a literal, and equals VERIFIED_USDC_DOMAINS'", () => {
    expect(USDC_DOMAIN_VERSION[CHAIN_ID]).toBe(robinhoodUsdg().version);
    expect(USDC_DOMAIN_VERSION[CHAIN_ID]).toBe(VERIFIED_USDC_DOMAINS[CHAIN_ID].version);
    expect(USDC_DOMAIN_NAME[CHAIN_ID]).toBe(VERIFIED_USDC_DOMAINS[CHAIN_ID].name);
    for (const chainId of Object.keys(USDC_DOMAIN_VERSION)) {
      expect(VERIFIED_USDC_DOMAINS[Number(chainId)], `chain ${chainId} has no verified domain`).toBeDefined();
    }
  });

  // The two reads cannot diverge: on every chain with a verified domain, the
  // version authorize actually signs (signErc3009, not a copy of its logic) is
  // the version VERIFIED_USDC_DOMAINS holds -- '1' on 4663, '2' everywhere else.
  it.each(Object.keys(VERIFIED_USDC_DOMAINS).map(Number))(
    'chain %i: authorize signs the domain version VERIFIED_USDC_DOMAINS verified',
    async (chainId) => {
      const signed: any[] = [];
      const signer = {
        provider: null,
        getAddress: async () => PAYER,
        signTypedData: async (domain: unknown) => {
          signed.push(domain);
          return MOCK_SIGNATURE;
        },
      };
      stubFacilitator();
      const client = new AdvancedEscrowClient(signer, { chainId, facilitatorUrl: FACILITATOR_URL });
      await client.authorize({ ...paymentInfo(), token: ESCROW_CONTRACTS[chainId].usdc });
      expect(signed).toHaveLength(1);
      expect(signed[0].chainId).toBe(chainId);
      expect(signed[0].version).toBe(VERIFIED_USDC_DOMAINS[chainId].version);
    },
  );

  it("Arc's authorize still signs version '2': the version table moves Robinhood Chain only", async () => {
    const signed: any[] = [];
    const signer = {
      provider: null,
      getAddress: async () => PAYER,
      signTypedData: async (domain: unknown) => {
        signed.push(domain);
        return MOCK_SIGNATURE;
      },
    };
    stubFacilitator();
    const client = new AdvancedEscrowClient(signer, { chainId: 5042, facilitatorUrl: FACILITATOR_URL });
    await client.authorize({ ...paymentInfo(), token: ESCROW_CONTRACTS[5042].usdc });
    expect(signed[0]).toMatchObject({ name: 'USDC', version: '2', chainId: 5042 });
  });

  it('release sends capture(paymentInfo, maxAmount, 0x) to the operator, and charge sends nothing', async () => {
    const sent: Array<{ to: string; data: string }> = [];
    const txHash = '0x' + 'ab'.repeat(32);
    const signer = {
      provider: {
        getCode: async () => '0x6080604052',
        getTransactionReceipt: async () => ({ status: 1, hash: txHash, logs: [], gasUsed: 21000n, blockNumber: 1 }),
      },
      getAddress: async () => PAYER,
      signTypedData: async () => MOCK_SIGNATURE,
      sendTransaction: async (tx: { to: string; data: string }) => {
        sent.push({ to: tx.to, data: tx.data });
        return { hash: txHash, to: tx.to, data: tx.data };
      },
    };
    const client = new AdvancedEscrowClient(signer, { chainId: CHAIN_ID, facilitatorUrl: FACILITATOR_URL });
    const pi = paymentInfo();
    const tuple = [
      pi.operator, PAYER, pi.receiver, pi.token, pi.maxAmount, pi.preApprovalExpiry,
      pi.authorizationExpiry, pi.refundExpiry, pi.minFeeBps, pi.maxFeeBps, pi.feeReceiver, pi.salt,
    ];
    expect((await client.release(pi)).success).toBe(true);
    expect(sent).toEqual([{ to: OPERATOR, data: OPERATOR_V3.encodeFunctionData('capture', [tuple, '5000000', '0x']) }]);

    const charge = await client.charge(pi);
    expect(charge.success).toBe(false);
    expect(charge.errorCode).toBe(ESCROW_UNSUPPORTED_ON_GENERATION);
    expect(sent).toHaveLength(1);
  });
});
