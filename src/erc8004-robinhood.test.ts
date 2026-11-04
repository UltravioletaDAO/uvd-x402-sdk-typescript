/** Robinhood singleton registries measured by c0der on 2026-11-04; no RPCs. */
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ERC8004_CONTRACTS,
  Erc8004Client,
  type Erc8004Network,
  supportsRelayedFeedback,
  supportsSolanaFeedback,
  wireNetwork,
} from './backend';
import { ESCROW_CONTRACTS } from './escrow-contracts';
import { chainToCAIP2, parseNetworkIdentifier } from './utils';

const MAINNET = {
  identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  validationRegistry: '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58',
};
const TESTNET = {
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
};
const NETWORKS = [
  ['robinhood', 'robinhood', MAINNET],
  ['eip155:4663', 'robinhood', MAINNET],
  ['robinhood-testnet', 'robinhood-testnet', TESTNET],
  ['eip155:46630', 'robinhood-testnet', TESTNET],
] as const satisfies ReadonlyArray<readonly [Erc8004Network, Erc8004Network, object]>;
const client = new Erc8004Client({ baseUrl: 'https://facilitator.example', retries: 0 });

afterEach(() => vi.unstubAllGlobals());

describe('Robinhood in ERC-8004', () => {
  it.each(NETWORKS)('%s resolves to the measured registries', (network, canonical, contracts) => {
    const fetch = vi.fn(() => { throw new Error('local lookup must not fetch'); });
    vi.stubGlobal('fetch', fetch);
    expect(client.isAvailable(network)).toBe(true);
    expect(client.getContracts(network)).toStrictEqual(contracts);
    expect(client.getContracts(network)).toBe(ERC8004_CONTRACTS[canonical]);
    expect(wireNetwork(network)).toBe(canonical);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('agrees with the existing payment network identifiers', () => {
    expect(chainToCAIP2('robinhood')).toBe('eip155:4663');
    expect(chainToCAIP2('robinhood-testnet')).toBe('eip155:46630');
    expect(parseNetworkIdentifier('eip155:4663')).toBe('robinhood');
    expect(parseNetworkIdentifier('eip155:46630')).toBe('robinhood-testnet');
  });

  it('does not advertise an unconfirmed testnet validation registry', () => {
    expect(client.getContracts('robinhood-testnet')).not.toHaveProperty('validationRegistry');
  });

  it.each(NETWORKS)('%s uses the canonical name on identity and reputation reads', async (network, canonical) => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ network: canonical }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(client.getIdentity(network, 42)).resolves.toEqual({ network: canonical });
    await expect(client.getReputation(network, 42)).resolves.toEqual({ network: canonical });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `https://facilitator.example/identity/${canonical}/42`,
      `https://facilitator.example/reputation/${canonical}/42`,
    ]);
  });

  it.each(NETWORKS)('%s uses the canonical name in feedback request bodies', async (network, canonical) => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true, network: canonical }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const request = { x402Version: 1 as const, network, feedback: { agentId: 42, value: 95 } };
    await expect(client.submitFeedback(request)).resolves.toEqual({ success: true, network: canonical });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://facilitator.example/feedback');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ ...request, network: canonical });
    expect(request.network).toBe(network);
  });

  it.each(NETWORKS)('%s does not advertise a relayed or Solana feedback rail', (network) => {
    expect(supportsRelayedFeedback(network)).toBe(false);
    expect(supportsSolanaFeedback(network)).toBe(false);
  });

  it('adds no Robinhood escrow deployment', () => {
    expect(ESCROW_CONTRACTS[4663]).toBeUndefined();
    expect(ESCROW_CONTRACTS[46630]).toBeUndefined();
  });

  it.each([
    '', 'Robinhood', 'ROBINHOOD', ' robinhood', 'robinhood ', 'robinhood-testnet ',
    'EIP155:4663', 'eip155:04663', 'eip155:4663 ', ' eip155:46630',
    'eip155:0x1237', 'eip155:0X1237', 'eip155:4663.0', 'eip155:466300',
    'robinh\u043eod', 'robinhood\u200b', 'robinhood/mainnet', 'robinhood\\mainnet',
    'unknown', 'constructor', 'toString', '__proto__',
  ])('does not invent a registry for %j', (network) => {
    expect(wireNetwork(network)).toBe(network);
    expect(client.isAvailable(network)).toBe(false);
    expect(client.getContracts(network as Erc8004Network)).toBeUndefined();
  });

  it('does not mistake nullish input from JavaScript for a registered network', () => {
    for (const network of [null, undefined]) {
      expect(client.isAvailable(network as unknown as string)).toBe(false);
      expect(client.getContracts(network as unknown as Erc8004Network)).toBeUndefined();
    }
  });

  it('keeps the deprecated Base alias working', () => {
    expect(wireNetwork('base-mainnet')).toBe('base');
    expect(client.isAvailable('base-mainnet')).toBe(true);
    expect(client.getContracts('base-mainnet')).toStrictEqual(ERC8004_CONTRACTS.base);
  });

  // The normal tsconfig excludes tests. Compile this file explicitly so removing
  // a public network from Erc8004Network cannot leave the runtime tests green.
  it('typechecks the four spellings against the public client API', () => {
    const config = ts.readConfigFile(fileURLToPath(new URL('../tsconfig.json', import.meta.url)), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const root = fileURLToPath(new URL('..', import.meta.url));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const program = ts.createProgram([fileURLToPath(import.meta.url)], { ...parsed.options, noEmit: true });
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  }, 30_000);
});
