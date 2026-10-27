/**
 * The reputation module's chain table and its packaging, tied to the rest of
 * the SDK so the two can never drift apart unnoticed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERC8004_CONTRACTS, RELAYED_FEEDBACK_NETWORKS } from '../backend';
import { getChainByName } from '../chains';
import { REPUTATION_CHAINS, reputationChain, reputationChainById } from './index';

const ROOT = resolve(__dirname, '..', '..');

describe('REPUTATION_CHAINS', () => {
  it('is exactly the networks the backend serves the relayed rail on', () => {
    expect(REPUTATION_CHAINS.map((c) => c.network).sort()).toEqual([...RELAYED_FEEDBACK_NETWORKS].sort());
  });

  it.each(REPUTATION_CHAINS.map((c) => [c.network, c] as const))('%s: the registries and chain id of the rest of the SDK', (network, chain) => {
    const contracts = (ERC8004_CONTRACTS as Record<string, { identityRegistry?: string; reputationRegistry?: string }>)[network];
    expect(chain.reputationRegistry).toBe(contracts.reputationRegistry);
    expect(chain.identityRegistry).toBe(contracts.identityRegistry);
    // The chain registry has no Base Sepolia: an anchor payment there is refused (`unsupported_token`).
    if (network !== 'base-sepolia') expect(getChainByName(network)?.chainId).toBe(chain.chainId);
    else expect(getChainByName(network)).toBeUndefined();
  });

  it('is keyed by chain id: one address is never enough', () => {
    // optimism and monad share a delegate address on two chains; each row stands for its own chain only.
    const shared = REPUTATION_CHAINS.filter((c) => c.delegate === '0x794C907FdfC71BFaF0b86D0e463BBD6E949A31bA');
    expect(shared.map((c) => c.chainId).sort((a, b) => a - b)).toEqual([10, 143]);
    expect(reputationChainById(0)).toBeUndefined();
    expect(reputationChainById(5042002)).toBeUndefined();
    expect(reputationChain('base-mainnet')?.chainId).toBe(8453);
    expect(reputationChain('avalanche')).toBeUndefined();
    expect(Object.isFrozen(REPUTATION_CHAINS) && Object.isFrozen(REPUTATION_CHAINS[0])).toBe(true);
  });
});

describe('the uvd-x402-sdk/reputation subpath', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  it('is exported for ESM, CJS and types, like every other subpath', () => {
    expect(pkg.exports['./reputation']).toEqual({
      types: './dist/reputation/index.d.ts',
      import: './dist/reputation/index.mjs',
      require: './dist/reputation/index.js',
    });
    expect(pkg.typesVersions['*'].reputation).toEqual(['./dist/reputation/index.d.ts']);
    expect(readFileSync(join(ROOT, 'tsup.config.ts'), 'utf8')).toContain("'reputation/index': 'src/reputation/index.ts'");
  });

  it('takes better-sqlite3 as an optional peer, never as a dependency it loads itself', () => {
    expect(pkg.dependencies['better-sqlite3']).toBeUndefined();
    expect(pkg.peerDependenciesMeta['better-sqlite3']).toEqual({ optional: true });
    for (const file of readdirSync(join(ROOT, 'src', 'reputation')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const text = readFileSync(join(ROOT, 'src', 'reputation', file), 'utf8');
      // Only real statements: the adapter's doc comment shows the import a program writes.
      expect(text, file).not.toMatch(/^import[^\n]*['"]better-sqlite3['"]|require\(['"]better-sqlite3/m);
    }
  });

  it('never reads a key from the environment', () => {
    for (const file of readdirSync(join(ROOT, 'src', 'reputation')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      expect(readFileSync(join(ROOT, 'src', 'reputation', file), 'utf8'), file).not.toMatch(/process\.env/);
    }
  });
});
