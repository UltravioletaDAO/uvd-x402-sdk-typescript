import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ESCROW_CONTRACTS,
  ESCROW_OPERATOR_GENERATION,
  getEscrowOperatorGeneration,
} from './index';

// The registry as 2.98.0 shipped it, recorded once in the no-regression snapshot.
const SNAPSHOT_REGISTRY: Record<string, unknown> = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'fixtures', 'escrow-operator-snapshot.json'), 'utf8'),
).registry;

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

  it('keeps every chain 2.98.0 shipped on the ABI it had: v2 for SKALE Base, v1 for the rest', () => {
    const chainIds = Object.keys(SNAPSHOT_REGISTRY).map(Number);
    expect(chainIds).toHaveLength(11);
    for (const chainId of chainIds) {
      expect(getEscrowOperatorGeneration(chainId), `chain ${chainId}`).toBe(chainId === 1187947933 ? 'v2' : 'v1');
    }
  });

  it('has v3 on Arc and Arc Testnet only', () => {
    const v3 = Object.entries(ESCROW_OPERATOR_GENERATION)
      .filter(([, generation]) => generation === 'v3')
      .map(([chainId]) => Number(chainId))
      .sort((a, b) => a - b);
    expect(v3).toEqual([5042, 5042002]);
  });

  it('reads an unlisted chain as v1, the ABI a custom options.contracts has always used', () => {
    expect(getEscrowOperatorGeneration(999999)).toBe('v1');
  });
});
