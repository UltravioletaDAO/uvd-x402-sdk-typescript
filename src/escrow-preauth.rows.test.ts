import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildEscrowPreAuth, type EscrowNetworkConfig } from './escrow-preauth';
import fixture from './escrow-preauth.vectors.json';
import { X402Error } from './types';

/**
 * A chain is signed only with a row in each of the three escrow tables. The
 * shipped tables never have a chain in one or two of them (a test in
 * `src/escrow-preauth.test.ts` pins that every operator row has a contract row
 * and a fee ceiling), so here the tables are replaced by ones that do:
 *   8453  contracts + operator, no fee ceiling
 *   1     contracts + fee ceiling, no operator
 *   10    operator + fee ceiling, no contracts
 *   42161 all three (the control)
 */
vi.mock('./escrow-contracts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./escrow-contracts')>();
  const pick = <T>(table: Readonly<Record<number, T>>, chains: number[]) =>
    Object.fromEntries(chains.map((chain) => [chain, table[chain]]));
  return {
    ...real,
    ESCROW_CONTRACTS: pick(real.ESCROW_CONTRACTS, [8453, 1, 42161]),
    ESCROW_OPERATORS: pick(real.ESCROW_OPERATORS, [8453, 10, 42161]),
    ESCROW_MAX_FEE_BPS: pick(real.ESCROW_MAX_FEE_BPS, [1, 10, 42161]),
  };
});

const { ESCROW_CONTRACTS, ESCROW_OPERATORS } = await vi.importActual<typeof import('./escrow-contracts')>(
  './escrow-contracts'
);

const PAYER = '0x' + '22'.repeat(20);
const WORKER = '0x' + '11'.repeat(20);
/** Stored without its 0x in the fixture (secret scanners block 0x + 64 hex). */
const TYPEHASH = '0x' + fixture.network_config.payment_info_typehash;

/** The real rows of a chain, as a network config. */
function config(chainId: number): EscrowNetworkConfig {
  const c = ESCROW_CONTRACTS[chainId];
  return {
    chain_id: chainId,
    operator: ESCROW_OPERATORS[chainId],
    escrow: c.escrow,
    token_collector: c.tokenCollector,
    usdc: c.usdc,
    usdc_domain_name: 'USD Coin',
    usdc_domain_version: '2',
    payment_info_typehash: TYPEHASH,
  };
}

async function attempt(chainId: number) {
  const signTypedData = vi.fn(async () => ({ signature: '0x' + '11'.repeat(65) }));
  const result = await buildEscrowPreAuth(
    { signTypedData },
    { networkConfig: config(chainId), payerWallet: PAYER, workerWallet: WORKER, bountyAtomic: '250000' }
  ).then(
    (header) => ({ header, error: null }),
    (error: unknown) => ({ header: null, error })
  );
  return { ...result, signTypedData };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a chain is signed only with a row in each of the three escrow tables', () => {
  it.each<[number, string]>([
    [8453, 'ESCROW_MAX_FEE_BPS'],
    [1, 'ESCROW_OPERATORS'],
    [10, 'ESCROW_CONTRACTS'],
  ])('chain %i, missing only %s, is refused before anything is signed', async (chainId, missing) => {
    const { error, signTypedData } = await attempt(chainId);
    expect(error).toBeInstanceOf(X402Error);
    expect((error as X402Error).code).toBe('INVALID_CONFIG');
    expect((error as X402Error).message).toBe(
      `Chain ${chainId} has no row in this SDK's escrow tables (${missing}) — refusing to sign.`
    );
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('chain 42161, with all three, signs', async () => {
    const { header, error, signTypedData } = await attempt(42161);
    expect(error).toBeNull();
    expect(JSON.parse(header as string).paymentRequirements.network).toBe('eip155:42161');
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });
});
