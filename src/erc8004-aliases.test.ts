/** Offline transport contract: aliases never reach a facilitator URL or body. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ERC8004_CONTRACTS,
  Erc8004Client,
  type Erc8004Network,
  supportsRelayedFeedback,
  supportsSolanaFeedback,
  wireNetwork,
} from './backend';
import { caip2ToChain, chainToCAIP2 } from './utils';

const client = new Erc8004Client({ baseUrl: 'https://facilitator.example', retries: 0 });
const evmNetworks = Object.keys(ERC8004_CONTRACTS).filter(
  (network) => network !== 'base-mainnet' && ERC8004_CONTRACTS[network].identityRegistry,
);
const aliases = evmNetworks.map((canonical) => ({
  canonical,
  network: chainToCAIP2(canonical) as Erc8004Network,
}));

// Compiled with the Robinhood test, so the public type cannot silently narrow
// back to Robinhood-only or widen to arbitrary strings.
const publicAliases = [
  'eip155:1', 'eip155:8453', 'eip155:5042', 'eip155:4663', 'eip155:46630',
] as const satisfies readonly Erc8004Network[];
// @ts-expect-error Arbitrary strings are not public network spellings.
const invalidName: Erc8004Network = 'not-a-network';
// @ts-expect-error A CAIP-2 EVM reference must be numeric.
const invalidReference: Erc8004Network = 'eip155:base';

const address = '0x1111111111111111111111111111111111111111';
const feedback = { agentId: 42, value: 95, rater: address };
const response = {
  responder: address, agentId: 42, clientAddress: address,
  feedbackIndex: 1, responseUri: 'ipfs://response',
};
const signature = { deadline: 2_000_000_000, nonce: '1', signature: '0x1234' };
const request = (network: Erc8004Network) => ({ x402Version: 1 as const, network });

const reads = [
  { name: 'getIdentity', path: '/identity/NETWORK/42', call: (n: Erc8004Network) => client.getIdentity(n, 42) },
  { name: 'getIdentityByOwner', path: `/identity/NETWORK/owner/${address}`, call: (n: Erc8004Network) => client.getIdentityByOwner(n, address) },
  { name: 'getReputation', path: '/reputation/NETWORK/42', call: (n: Erc8004Network) => client.getReputation(n, 42) },
  { name: 'getIdentityMetadata', path: '/identity/NETWORK/42/metadata/a%2Fb', call: (n: Erc8004Network) => client.getIdentityMetadata(n, 42, 'a/b') },
  { name: 'getIdentityTotalSupply', path: '/identity/NETWORK/total-supply', call: (n: Erc8004Network) => client.getIdentityTotalSupply(n) },
];
const writes = [
  { name: 'submitFeedback', path: '/feedback', payload: { feedback }, call: (n: Erc8004Network) => client.submitFeedback({ ...request(n), feedback }) },
  { name: 'revokeFeedback', path: '/feedback/revoke', payload: { agentId: 42, feedbackIndex: 1 }, call: (n: Erc8004Network) => client.revokeFeedback(n, 42, 1) },
  { name: 'appendResponse', path: '/feedback/response', payload: { agentId: 42, feedbackIndex: 1, response: 'Thanks' }, call: (n: Erc8004Network) => client.appendResponse(n, 42, 1, 'Thanks') },
  { name: 'prepareRelayedFeedback', path: '/feedback/evm/prepare', payload: { feedback }, call: (n: Erc8004Network) => client.prepareRelayedFeedback({ ...request(n), feedback }) },
  { name: 'submitRelayedFeedback', path: '/feedback/evm/submit', payload: { feedback, ...signature }, call: (n: Erc8004Network) => client.submitRelayedFeedback({ ...request(n), feedback, ...signature }) },
  { name: 'prepareRelayedResponse', path: '/feedback/response/evm/prepare', payload: response, call: (n: Erc8004Network) => client.prepareRelayedResponse({ ...request(n), ...response }) },
  { name: 'submitRelayedResponse', path: '/feedback/response/evm/submit', payload: { ...response, ...signature }, call: (n: Erc8004Network) => client.submitRelayedResponse({ ...request(n), ...response, ...signature }) },
  // These assertions cover serialization even on an unsupported rail. They do
  // not advertise Solana/delegate deployments on an EVM network.
  { name: 'prepareSolanaFeedback', path: '/feedback/solana/prepare', payload: { feedback }, call: (n: Erc8004Network) => client.prepareSolanaFeedback({ ...request(n), feedback }) },
  { name: 'submitSolanaFeedback', path: '/feedback/solana/submit', payload: { feedback, transaction: 'AA==' }, call: (n: Erc8004Network) => client.submitSolanaFeedback({ ...request(n), feedback, transaction: 'AA==' }) },
  { name: 'registerAgent', path: '/register', payload: { agentUri: 'ipfs://agent' }, call: (n: Erc8004Network) => client.registerAgent({ ...request(n), agentUri: 'ipfs://agent' }) },
  { name: 'registerAgentAsync', path: '/register', payload: { agentUri: 'ipfs://agent' }, call: (n: Erc8004Network) => client.registerAgentAsync({ ...request(n), agentUri: 'ipfs://agent' }) },
];

afterEach(() => vi.unstubAllGlobals());

describe('ERC-8004 EVM aliases', () => {
  it('keeps Base canonical if the payment helper also recognizes base-mainnet', async () => {
    // ERC-8004 must preserve its wire spelling even if the shared payment
    // helper gains the deprecated alias. Otherwise the later table entry wins.
    vi.resetModules();
    const utils = await import('./utils');
    const original = utils.chainToCAIP2;
    const helper = vi.spyOn(utils, 'chainToCAIP2').mockImplementation(
      (network) => original(network === 'base-mainnet' ? 'base' : network),
    );
    try {
      const backend = await import('./backend');
      expect(backend.wireNetwork('eip155:8453')).toBe('base');
      expect(backend.wireNetwork('base-mainnet')).toBe('base');
    } finally {
      helper.mockRestore();
      vi.resetModules();
    }
  });

  // Chain IDs cross-checked against viem's src/chains/definitions on 2026-11-04.
  it.each([
    ['ethereum-sepolia', 'eip155:11155111'],
    ['base-sepolia', 'eip155:84532'],
    ['polygon-amoy', 'eip155:80002'],
    ['arbitrum-sepolia', 'eip155:421614'],
    ['optimism-sepolia', 'eip155:11155420'],
    ['celo-sepolia', 'eip155:11142220'],
    ['avalanche-fuji', 'eip155:43113'],
  ] as const satisfies ReadonlyArray<readonly [Erc8004Network, Erc8004Network]>)('%s has the canonical testnet chain ID %s', (network, caip2) => {
    expect(chainToCAIP2(network)).toBe(caip2);
    expect(caip2ToChain(caip2)).toBe(network);
    expect(client.getContracts(caip2)).toBe(ERC8004_CONTRACTS[network]);
  });

  it('covers every EVM registry with a distinct numeric CAIP-2 identifier', () => {
    expect(evmNetworks).toHaveLength(23);
    expect(new Set(aliases.map(({ network }) => network)).size).toBe(evmNetworks.length);
    for (const { network } of aliases) expect(network).toMatch(/^eip155:[1-9][0-9]*$/);
    for (const network of publicAliases) expect(client.isAvailable(network)).toBe(true);
    expect(client.isAvailable(invalidName)).toBe(false);
    expect(client.isAvailable(invalidReference)).toBe(false);
  });

  it.each(aliases)('$network resolves only to $canonical and preserves rail availability', ({ network, canonical }) => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('local lookups must not fetch'); }));
    expect(wireNetwork(network)).toBe(canonical);
    expect(client.getContracts(network)).toBe(ERC8004_CONTRACTS[canonical]);
    expect(client.isAvailable(network)).toBe(true);
    expect(supportsRelayedFeedback(network)).toBe(supportsRelayedFeedback(canonical));
    expect(supportsSolanaFeedback(network)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'eip155:177', 'eip155:133', 'eip155:999', 'eip155:130', 'eip155:999999999',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    'EIP155:8453', ' eip155:8453', 'eip155:8453 ', 'eip155:08453',
    'eip155:0x2105', 'eip155:0X2105', 'eip155:8453.0', 'eip155:+8453',
    'eip155:8.453e3', 'eip155:８４５３', 'eip155:8453\u200b',
    'eip155:8453/mainnet', 'eip155:8453\\mainnet',
  ])('does not invent an ERC-8004 alias for %j', (network) => {
    expect(wireNetwork(network)).toBe(network);
    expect(client.isAvailable(network)).toBe(false);
    expect(client.getContracts(network as Erc8004Network)).toBeUndefined();
  });
});

describe.each([...aliases, { network: 'base-mainnet' as const, canonical: 'base' }])(
  '$network facilitator transport', ({ network, canonical }) => {
    it.each(reads)('$name sends the canonical URL', async ({ path, call }) => {
      const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ network: canonical }), { status: 200 }));
      vi.stubGlobal('fetch', fetch);
      await call(network);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0];
      expect(url).toBe(`https://facilitator.example${path.replace('NETWORK', canonical)}`);
      expect(init?.method).toBe('GET');
    });

    it.each(writes)('$name sends the canonical request body', async ({ path, payload, call, name }) => {
      const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ success: true, network: canonical }), { status: 200 }));
      vi.stubGlobal('fetch', fetch);
      await call(network);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0];
      expect(url).toBe(`https://facilitator.example${path}`);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({ x402Version: 1, network: canonical, ...payload });
      if (name === 'registerAgentAsync') expect(new Headers(init?.headers).get('Prefer')).toBe('respond-async');
    });
  },
);
