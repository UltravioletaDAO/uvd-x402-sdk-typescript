import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BazaarClient,
  HEALTH_FILTERS,
  MAX_SEARCH_LEN,
  TIER_FILTERS,
  epochToDate,
  isAlive,
  type DiscoveryResponse,
} from './index';

/**
 * Verbatim (trimmed) page from
 * GET https://facilitator.ultravioletadao.xyz/discovery/resources?limit=2&health=alive
 * captured 2026-07-27. The client is pinned to this shape because the previous
 * BazaarClient invented a different one -- `resources`/`page`/`totalPages`
 * against a host that does not resolve -- and nothing caught it.
 */
const LIVE_PAGE: DiscoveryResponse = {
  x402Version: 2,
  items: [
    {
      url: 'https://tenjin.blog/api/read/onchain-notes/stablecoin-chart',
      type: 'http',
      x402Version: 2,
      description: "DeFiLlama's July 27 chart row slipped to $306.23B.",
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          amount: '100000',
          payTo: '0xf4dDbE500C0caDD3e48f3ee4Bf55836dE3622938',
          maxTimeoutSeconds: 120,
        },
      ],
      lastUpdated: 1785175425,
      source: 'self_registered',
      firstSeen: 1785175425,
      health: {
        status: 'alive',
        lastChecked: 1785175442,
        httpStatus: 402,
        latencyMs: 248,
      },
      curation: { tier: 'vip', label: 'Tenjin' },
    },
  ],
  pagination: { limit: 2, offset: 0, total: 1883 },
};

function mockFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestedUrl(fetchMock: ReturnType<typeof mockFetch>, call = 0): URL {
  return new URL(fetchMock.mock.calls[call][0] as string);
}

describe('BazaarClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('endpoint', () => {
    it('targets the facilitator, not a separate bazaar host', async () => {
      const fetchMock = mockFetch(LIVE_PAGE);
      await new BazaarClient().listResources();

      const url = requestedUrl(fetchMock);
      expect(url.origin).toBe('https://facilitator.ultravioletadao.xyz');
      expect(url.pathname).toBe('/discovery/resources');
    });

    it('honours a custom base URL and strips trailing slashes', async () => {
      const fetchMock = mockFetch(LIVE_PAGE);
      await new BazaarClient({ baseUrl: 'http://localhost:8080/' }).listResources();

      expect(requestedUrl(fetchMock).origin).toBe('http://localhost:8080');
    });
  });

  describe('listResources', () => {
    it('parses the live response envelope', async () => {
      mockFetch(LIVE_PAGE);
      const page = await new BazaarClient().listResources({ limit: 2 });

      expect(page.items).toHaveLength(1);
      expect(page.pagination.total).toBe(1883);
      expect(page.pagination.offset).toBe(0);
    });

    it('exposes health and curation', async () => {
      mockFetch(LIVE_PAGE);
      const [item] = (await new BazaarClient().listResources()).items;

      expect(item.health?.status).toBe('alive');
      expect(item.health?.httpStatus).toBe(402);
      expect(item.health?.latencyMs).toBe(248);
      expect(item.curation?.tier).toBe('vip');
      expect(item.curation?.label).toBe('Tenjin');
      expect(isAlive(item)).toBe(true);
    });

    it('keeps timestamps as epoch seconds', async () => {
      mockFetch(LIVE_PAGE);
      const [item] = (await new BazaarClient().listResources()).items;

      expect(item.firstSeen).toBe(1785175425);
      expect(epochToDate(item.firstSeen)?.toISOString()).toBe(
        '2026-07-27T18:03:45.000Z'
      );
      expect(epochToDate(undefined)).toBeUndefined();
    });

    it('sends every filter server-side', async () => {
      const fetchMock = mockFetch(LIVE_PAGE);
      await new BazaarClient().listResources({
        limit: 25,
        offset: 50,
        category: 'finance',
        network: 'eip155:8453',
        provider: 'tenjin',
        tag: 'market-data',
        source: 'self_registered',
        sourceFacilitator: 'ultravioleta',
        health: 'alive',
        tier: 'vip',
        q: 'logs',
      });

      const params = requestedUrl(fetchMock).searchParams;
      expect(params.get('limit')).toBe('25');
      expect(params.get('offset')).toBe('50');
      expect(params.get('category')).toBe('finance');
      expect(params.get('network')).toBe('eip155:8453');
      expect(params.get('provider')).toBe('tenjin');
      expect(params.get('tag')).toBe('market-data');
      expect(params.get('source')).toBe('self_registered');
      expect(params.get('sourceFacilitator')).toBe('ultravioleta');
      expect(params.get('health')).toBe('alive');
      expect(params.get('tier')).toBe('vip');
      expect(params.get('q')).toBe('logs');
    });

    it('uses q, the parameter the server actually reads', async () => {
      const fetchMock = mockFetch(LIVE_PAGE);
      await new BazaarClient().listResources({ q: 'logs' });

      const params = requestedUrl(fetchMock).searchParams;
      expect(params.get('q')).toBe('logs');
      expect(params.has('search')).toBe(false);
      expect(params.has('query')).toBe(false);
    });

    it('rejects an over-long needle before the request goes out', async () => {
      const fetchMock = mockFetch(LIVE_PAGE);
      await expect(
        new BazaarClient().listResources({ q: 'x'.repeat(MAX_SEARCH_LEN + 1) })
      ).rejects.toThrow(/at most/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces a non-2xx as an error', async () => {
      mockFetch({ error: 'nope' }, 429);
      await expect(new BazaarClient().listResources()).rejects.toThrow(
        /Bazaar API error: 429/
      );
    });
  });

  describe('iterateResources', () => {
    it('walks pages in sequence until the total is reached', async () => {
      const item = LIVE_PAGE.items[0];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            x402Version: 2,
            items: [item, item],
            pagination: { limit: 2, offset: 0, total: 3 },
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            x402Version: 2,
            items: [item],
            pagination: { limit: 2, offset: 2, total: 3 },
          }),
          text: async () => '',
        });
      vi.stubGlobal('fetch', fetchMock);

      const seen = [];
      for await (const r of new BazaarClient().iterateResources({ limit: 2 })) {
        seen.push(r);
      }

      expect(seen).toHaveLength(3);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('offset')).toBe(
        '2'
      );
    });

    it('stops on an empty page instead of looping forever', async () => {
      const fetchMock = mockFetch({
        x402Version: 2,
        items: [],
        pagination: { limit: 10, offset: 0, total: 999 },
      });

      const seen = [];
      for await (const r of new BazaarClient().iterateResources()) seen.push(r);

      expect(seen).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getResourceByUrl', () => {
    it('returns the exact match', async () => {
      mockFetch(LIVE_PAGE);
      const found = await new BazaarClient().getResourceByUrl(
        LIVE_PAGE.items[0].url
      );
      expect(found?.url).toBe(LIVE_PAGE.items[0].url);
    });

    it('returns null when the search matches something else', async () => {
      mockFetch(LIVE_PAGE);
      const found = await new BazaarClient().getResourceByUrl(
        'https://tenjin.blog/api/read/something-else'
      );
      expect(found).toBeNull();
    });
  });

  describe('registerResource', () => {
    it('posts to /discovery/register with the registry payload shape', async () => {
      const fetchMock = mockFetch({ success: true });
      await new BazaarClient().registerResource({
        url: 'https://api.example.com/data',
        description: 'Premium data API',
        accepts: [{ scheme: 'exact', network: 'eip155:8453' }],
        metadata: { category: 'finance' },
      });

      expect(requestedUrl(fetchMock).pathname).toBe('/discovery/register');
      const init = fetchMock.mock.calls[0][1];
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.url).toBe('https://api.example.com/data');
      expect(body.type).toBe('http');
      expect(body.accepts).toHaveLength(1);
      expect(body.metadata.category).toBe('finance');
    });
  });

  describe('getStats', () => {
    it('parses the aggregate metrics', async () => {
      mockFetch({
        total: 21259,
        visible: 13590,
        bySource: { aggregated: 21093, self_registered: 166 },
        bySourceFacilitator: { payai: 20495 },
        byNetwork: { 'eip155:8453': 21138 },
        byTier: { vip: 152, listed: 19365 },
        byHealth: { alive: 1883, quarantined: 7669 },
        generatedAt: 1785175442,
      });

      const stats = await new BazaarClient().getStats();
      expect(stats.total).toBe(21259);
      expect(stats.byHealth.alive).toBe(1883);
      expect(stats.byTier.vip).toBe(152);
    });
  });

  describe('filter vocabularies', () => {
    it('match the server', () => {
      expect(HEALTH_FILTERS).toContain('alive');
      expect(HEALTH_FILTERS).toContain('quarantined');
      expect(HEALTH_FILTERS).toContain('any');
      expect(TIER_FILTERS).toEqual(['first_party', 'vip', 'verified', 'listed']);
    });
  });
});
