import { describe, expect, it } from 'vitest';

import {
  ESCROW_CONTRACTS,
  ESCROW_OPERATOR_GENERATION,
  getEscrowOperatorGeneration,
} from './index';

describe('ESCROW_OPERATOR_GENERATION', () => {
  it('names a generation for every chain in ESCROW_CONTRACTS (no registered chain falls to the default)', () => {
    for (const chainId of Object.keys(ESCROW_CONTRACTS)) {
      expect(ESCROW_OPERATOR_GENERATION[Number(chainId)], `chain ${chainId}`).toBeDefined();
    }
  });

  it('keeps SKALE Base as the only v2 chain, as the CREATE3 set had it', () => {
    const v2 = Object.entries(ESCROW_OPERATOR_GENERATION)
      .filter(([, generation]) => generation === 'v2')
      .map(([chainId]) => Number(chainId));
    expect(v2).toEqual([1187947933]);
  });

  it('reads an unlisted chain as v1, the ABI a custom options.contracts has always used', () => {
    expect(getEscrowOperatorGeneration(999999)).toBe('v1');
  });
});
