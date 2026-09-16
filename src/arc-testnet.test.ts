import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';

import { EVMProvider } from './providers/evm';
import {
  SUPPORTED_CHAINS,
  getChainByName,
  getChainById,
  getEnabledChains,
  getEVMChainIds,
  getTokenConfig,
  getTokenByAddress,
  isChainSupported,
} from './chains';
import { CAIP2_IDENTIFIERS, CAIP2_TO_CHAIN } from './types';
import { chainToCAIP2, caip2ToChain, generatePaymentOptions } from './utils/x402';
import { buildTokenMetadata } from './utils';
import { buildPaymentRequirements } from './backend';
import { getFacilitatorAddress, FACILITATOR_ADDRESSES } from './facilitator';
import type { ChainConfig } from './types';

/**
 * Arc testnet (Circle), `eip155:5042002`.
 *
 * THE TRAP THIS FILE EXISTS FOR
 *
 * On Arc the stablecoin IS the chain's native asset, so ONE balance is readable
 * at TWO precisions:
 *   - natively, for gas and EIP-1559 fees (`eth_getBalance`): 18 decimals;
 *   - through the ERC-20 interface (`balanceOf`, `transferWithAuthorization`):
 *     6 decimals, the view being `floor(native / 10^12)`.
 *
 * An x402 payment is an EIP-3009 authorization signed against the ERC-20
 * interface, so its `value` is ALWAYS in 6. Registering Arc's payment token with
 * the native 18 -- the number every Arc gas document leads with -- does not
 * fail loudly anywhere: it signs a perfectly valid authorization for 10^12 times
 * the price. `$0.01` leaves as `10000000000000000` base units, which is ten
 * billion USDC. `withDecimalsTrap` below mounts exactly that state and shows the
 * gap, so the assertion on the registry is not a number somebody can "tidy up".
 *
 * `nativeCurrency.decimals: 18` in the registry is correct and load-bearing --
 * it is what `wallet_addEthereumChain` needs -- which is precisely why the two
 * numbers sit next to each other and why this file pins both.
 *
 * Everything asserted here is testnet. Circle's contract list still marks these
 * addresses testnet and publishes no mainnet deployment, so there is no
 * `arc`/`arc-mainnet` entry to add until it does.
 */

const ARC = 'arc-testnet';
const ARC_CHAIN_ID = 5042002;
const ARC_CAIP2 = 'eip155:5042002';
const ARC_USDC = '0x3600000000000000000000000000000000000000';

/** A key per run, in memory: nothing here depends on a particular address. */
const PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
const PAY_TO = '0x000000000000000000000000000000000000dEaD';

/**
 * `EVMProvider` connects through `window.ethereum`, which no test has. What it
 * would end up holding is an `ethers.Signer` plus its address, and signing typed
 * data needs neither a browser nor a network.
 */
function providerWithWallet(): EVMProvider {
  const provider = new EVMProvider();
  const wallet = new ethers.Wallet(PRIVATE_KEY);
  Object.assign(provider, { signer: wallet, address: wallet.address });
  return provider;
}

/** The `value` an EIP-3009 authorization for `amount` carries on `chain`. */
async function signedValue(chain: ChainConfig, amount: string): Promise<string> {
  const payload = await providerWithWallet().signPayment(
    { recipient: PAY_TO, amount },
    chain
  );
  return (JSON.parse(payload) as { value: string }).value;
}

/**
 * Runs `body` with Arc's payment token carrying the NATIVE gas precision: the
 * bad state, mounted where it would really live.
 *
 * It patches the registry rather than handing `signPayment` a doctored
 * `ChainConfig`, because `signPayment` resolves the token through
 * `getTokenConfig(chainConfig.name, ...)` -- the global table -- and ignores the
 * `tokens` of the config it was passed. A trap built out of a local clone would
 * quietly measure nothing.
 */
async function withDecimalsTrap<T>(body: () => Promise<T>): Promise<T> {
  const chain = SUPPORTED_CHAINS[ARC];
  const usdc = chain.usdc;
  const tokens = chain.tokens;
  SUPPORTED_CHAINS[ARC] = {
    ...chain,
    usdc: { ...usdc, decimals: 18 },
    tokens: { ...tokens, usdc: { ...usdc, decimals: 18 } },
  };
  try {
    return await body();
  } finally {
    SUPPORTED_CHAINS[ARC] = { ...chain, usdc, tokens };
  }
}

describe('Arc testnet — registry entry', () => {
  it('is registered under its facilitator name and nothing else', () => {
    expect(SUPPORTED_CHAINS[ARC]).toBeDefined();
    expect(getChainByName(ARC)?.name).toBe(ARC);
    expect(isChainSupported(ARC)).toBe(true);
    // Case-insensitive lookup, like every other chain.
    expect(getChainByName('Arc-Testnet')?.name).toBe(ARC);
    // No mainnet is being claimed: Circle has not published one.
    expect(SUPPORTED_CHAINS.arc).toBeUndefined();
    expect(SUPPORTED_CHAINS['arc-mainnet']).toBeUndefined();
  });

  it('carries the chain id in both decimal and hex, agreeing with each other', () => {
    const chain = getChainByName(ARC)!;

    expect(chain.chainId).toBe(ARC_CHAIN_ID);
    expect(chain.chainIdHex).toBe('0x4cef52');
    expect(parseInt(chain.chainIdHex, 16)).toBe(chain.chainId);
    expect(getChainById(ARC_CHAIN_ID)?.name).toBe(ARC);
  });

  it('is an EVM chain with Arc endpoints', () => {
    const chain = getChainByName(ARC)!;

    expect(chain.networkType).toBe('evm');
    expect(chain.displayName).toBe('Arc Testnet');
    expect(chain.rpcUrl).toBe('https://rpc.testnet.arc.io');
    expect(chain.explorerUrl).toBe('https://testnet.arcscan.app');
  });

  it('registers USDC at the ERC-20 precision with the on-chain EIP-712 domain', () => {
    const chain = getChainByName(ARC)!;

    expect(chain.usdc.address).toBe(ARC_USDC);
    expect(chain.usdc.decimals).toBe(6);
    // `name` is the on-chain name(), which is also the EIP-712 domain name.
    // It is `USDC` here, NOT the `USD Coin` most other deployments use.
    expect(chain.usdc.name).toBe('USDC');
    expect(chain.usdc.version).toBe('2');

    expect(getTokenConfig(ARC, 'usdc')).toEqual(chain.usdc);
    expect(getTokenByAddress(ARC, ARC_USDC)?.tokenType).toBe('usdc');
    // Address matching is case-insensitive on EVM.
    expect(getTokenByAddress(ARC, ARC_USDC.toUpperCase().replace('0X', '0x'))?.tokenType).toBe(
      'usdc'
    );

    expect(buildTokenMetadata(ARC, ARC_USDC)).toEqual({
      address: ARC_USDC,
      symbol: 'USDC',
      decimals: 6,
      eip712: { name: 'USDC', version: '2' },
    });
  });

  it('does not announce EURC, which has no end-to-end proof yet', () => {
    const chain = getChainByName(ARC)!;

    expect(Object.keys(chain.tokens ?? {})).toEqual(['usdc']);
    expect(getTokenConfig(ARC, 'eurc')).toBeUndefined();
  });

  it('keeps the native gas asset at 18 decimals, where 18 is the right answer', () => {
    const chain = getChainByName(ARC)!;

    // This is what wallet_addEthereumChain is handed, and gas on Arc is paid in
    // USDC at 18. Correct here, catastrophic on the payment path -- see below.
    expect(chain.nativeCurrency).toEqual({
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 18,
    });
  });
});

describe('Arc testnet — CAIP-2', () => {
  it('maps the name to eip155:5042002 and back', () => {
    expect(CAIP2_IDENTIFIERS[ARC]).toBe(ARC_CAIP2);
    expect(CAIP2_TO_CHAIN[ARC_CAIP2]).toBe(ARC);
    expect(chainToCAIP2(ARC)).toBe(ARC_CAIP2);
    expect(caip2ToChain(ARC_CAIP2)).toBe(ARC);
  });

  it('agrees with the chain id in the registry', () => {
    expect(CAIP2_IDENTIFIERS[ARC]).toBe(`eip155:${getChainByName(ARC)!.chainId}`);
  });
});

describe('Arc testnet — the default client list', () => {
  it('is enabled, so a client that lists networks offers it without configuration', () => {
    const chain = getChainByName(ARC)!;

    expect(chain.x402.enabled).toBe(true);
    expect(chain.x402.facilitatorUrl).toBe('https://facilitator.ultravioletadao.xyz');
    expect(getEnabledChains().map((c) => c.name)).toContain(ARC);
    // `NetworkPicker` builds its options from exactly this list.
    expect(getEVMChainIds()).toContain(ARC_CHAIN_ID);
  });

  it('prices a dollar amount into the accepts array at 6 decimals', () => {
    const options = generatePaymentOptions([getChainByName(ARC)!], '0.01');

    expect(options).toEqual([
      {
        network: ARC_CAIP2,
        asset: ARC_USDC,
        amount: '10000',
        facilitator: 'https://facilitator.ultravioletadao.xyz',
      },
    ]);
  });

  it('builds payment requirements at 6 decimals, in v1 and v2 spelling', () => {
    const common = { amount: '0.01', recipient: PAY_TO, resource: 'https://x.test/r', chainName: ARC };

    const v1 = buildPaymentRequirements(common);
    expect(v1.network).toBe(ARC);
    expect(v1.maxAmountRequired).toBe('10000');
    expect(v1.asset).toBe(ARC_USDC);

    expect(buildPaymentRequirements({ ...common, x402Version: 2 }).network).toBe(ARC_CAIP2);
  });
});

describe('Arc testnet — one balance, two precisions', () => {
  it('signs a $0.01 authorization for 10000 units, not 10^16', async () => {
    const chain = getChainByName(ARC)!;

    // RED if `usdc.decimals` is ever "corrected" to the native 18.
    expect(await signedValue(chain, '0.01')).toBe('10000');
    expect(await signedValue(chain, '1.00')).toBe('1000000');
    // One micro-USDC, the smallest unit the ERC-20 view can express.
    expect(await signedValue(chain, '0.000001')).toBe('1');
  });

  it('shows what 18 would actually charge: 10^12 times the price', async () => {
    const right = BigInt(await signedValue(getChainByName(ARC)!, '0.01'));
    const wrong = await withDecimalsTrap(async () =>
      BigInt(await signedValue(getChainByName(ARC)!, '0.01'))
    );

    expect(right).toBe(10_000n);
    expect(wrong).toBe(10_000_000_000_000_000n);
    // A cent signed as ten billion dollars. This is the whole point.
    expect(wrong / right).toBe(1_000_000_000_000n);
    expect(wrong).not.toBe(right);

    // And the registry is back the way it was, so nothing after this leaks.
    expect(getChainByName(ARC)!.usdc.decimals).toBe(6);
  });

  it('never lets the native gas precision reach the payment scale', async () => {
    const chain = getChainByName(ARC)!;

    // The two numbers live side by side in the same config on purpose.
    expect(chain.nativeCurrency.decimals).toBe(18);
    expect(chain.usdc.decimals).toBe(6);
    expect(chain.nativeCurrency.decimals - chain.usdc.decimals).toBe(12);

    // What is signed follows the token, not the native asset.
    expect(await signedValue(chain, '0.01')).toBe(
      ethers.parseUnits('0.01', chain.usdc.decimals).toString()
    );
    expect(await signedValue(chain, '0.01')).not.toBe(
      ethers.parseUnits('0.01', chain.nativeCurrency.decimals).toString()
    );
  });

  it('signs against the Arc chain id and the Arc USDC contract', async () => {
    const chain = getChainByName(ARC)!;

    const payload = JSON.parse(
      await providerWithWallet().signPayment({ recipient: PAY_TO, amount: '0.01' }, chain)
    ) as { chainId: number; token: string };

    expect(payload.chainId).toBe(ARC_CHAIN_ID);
    expect(payload.token).toBe(ARC_USDC);
  });
});

describe('Arc testnet — fee payers', () => {
  it('adds no entry of its own: EVM chains share the EVM signer', () => {
    // EVM networks do not carry a per-chain fee payer, and Arc does not change
    // that. Same fallback the other two EVM testnets already take.
    expect(FACILITATOR_ADDRESSES).not.toHaveProperty(ARC);
    expect(getFacilitatorAddress(ARC, 'evm')).toBe(FACILITATOR_ADDRESSES.evm);
    expect(getFacilitatorAddress(ARC, 'evm')).toBe(
      getFacilitatorAddress('robinhood-testnet', 'evm')
    );
  });
});
