import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getChainById, getChainsByNetworkType, getSupportedTokens } from './chains';

// The README's EVM table is what integrators read to decide where they can
// charge EURC. It said "Arc | 5042 | USDC" for months after 2.94.0 registered
// EURC on both Arc networks, so readers concluded EURC did not work on Arc.
// Pin every token, not just EURC: Ethereum once advertised unsupported USDT,
// while Monad omitted supported USDT. USDC.e is the SKALE display label for usdc.
function readmeEvmRows(): Map<number, Set<string>> {
  const readme = readFileSync(resolve(__dirname, '..', 'README.md'), 'utf8');
  const start = readme.indexOf('| Network | Chain ID | Tokens |');
  expect(start).toBeGreaterThan(-1);
  const rows = new Map<number, Set<string>>();
  for (const line of readme.slice(start).split('\n').slice(2)) {
    if (!line.startsWith('|')) break;
    const [, , chainId, tokens] = line.split('|').map((cell) => cell.trim());
    rows.set(Number(chainId), new Set(tokens.split(',').map((t) => t.trim().toLowerCase())));
  }
  return rows;
}

describe('README EVM table: EURC column matches the registry', () => {
  const rows = readmeEvmRows();

  it('lists EURC on every EVM chain whose registry has it (Arc included)', () => {
    const withEurc = getChainsByNetworkType('evm').filter((c) => getSupportedTokens(c.name).includes('eurc'));
    expect(withEurc.map((c) => c.name)).toEqual(expect.arrayContaining(['arc', 'arc-testnet']));
    for (const chain of withEurc) {
      expect(rows.get(chain.chainId), `${chain.name} (${chain.chainId}) row`).toBeDefined();
      expect(rows.get(chain.chainId)!.has('eurc'), `${chain.name} README row lacks EURC`).toBe(true);
    }
  });

  it('does not list EURC where the registry has none', () => {
    for (const [chainId, tokens] of rows) {
      if (!tokens.has('eurc')) continue;
      const chain = getChainById(chainId);
      expect(chain, `README row ${chainId}`).toBeDefined();
      expect(getSupportedTokens(chain!.name)).toContain('eurc');
    }
  });
});

describe('README EVM table: all tokens match getSupportedTokens()', () => {
  const rows = readmeEvmRows();
  const chains = getChainsByNetworkType('evm');

  it('lists exactly the enabled EVM chain IDs', () => {
    expect([...rows.keys()].sort()).toEqual(chains.map((chain) => chain.chainId).sort());
  });

  it.each(chains)('$name ($chainId) lists every supported token and no others', (chain) => {
    const expected = getSupportedTokens(chain.name).map((token) =>
      token === 'usdc' && chain.usdc.name === 'Bridged USDC (SKALE Bridge)' ? 'usdc.e' : token,
    );
    expect(rows.get(chain.chainId)).toEqual(new Set(expected));
  });
});
