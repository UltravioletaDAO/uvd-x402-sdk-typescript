import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BazaarClient,
  DEFAULT_MAX_SEARCH_LEN,
  HEALTH_FILTERS,
  KIND_FILTERS,
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
        new BazaarClient().listResources({ q: 'x'.repeat(DEFAULT_MAX_SEARCH_LEN + 1) })
      ).rejects.toThrow(/at most 400 characters/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces a non-2xx as an error', async () => {
      mockFetch({ error: 'nope' }, 429);
      await expect(new BazaarClient().listResources()).rejects.toThrow(
        /Bazaar API error: 429/
      );
    });
  });

  describe('search length', () => {
    // The relevance search takes a request in natural language, which the old
    // client-side cap of 128 cut off.
    const SENTENCE =
      'I need an API that takes a phone number and returns the name of the ' +
      'person or company that owns it, with the carrier and the country, ' +
      'and that I can call with a POST from an agent for less than five cents';

    it('sends a natural-language q longer than the old 128 cap', async () => {
      expect(SENTENCE.length).toBeGreaterThan(MAX_SEARCH_LEN);
      const fetchMock = mockFetch(LIVE_PAGE);
      await new BazaarClient().listResources({ q: SENTENCE });

      expect(requestedUrl(fetchMock).searchParams.get('q')).toBe(SENTENCE);
    });

    it('defaults to 400: exactly 400 goes out, 401 does not', async () => {
      expect(DEFAULT_MAX_SEARCH_LEN).toBe(400);
      const fetchMock = mockFetch(LIVE_PAGE);
      await new BazaarClient().listResources({ q: 'x'.repeat(400) });
      expect(requestedUrl(fetchMock).searchParams.get('q')).toHaveLength(400);

      await expect(
        new BazaarClient().listResources({ q: 'x'.repeat(401) })
      ).rejects.toThrow('q must be at most 400 characters');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('takes the cap from maxSearchLen', async () => {
      const fetchMock = mockFetch(LIVE_PAGE);
      const old = new BazaarClient({ maxSearchLen: MAX_SEARCH_LEN });

      await old.listResources({ q: 'x'.repeat(128) });
      await expect(old.listResources({ q: 'x'.repeat(129) })).rejects.toThrow(
        'q must be at most 128 characters'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const roomy = new BazaarClient({ maxSearchLen: 1000 });
      await roomy.listResources({ q: 'x'.repeat(1000) });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('counts characters as the facilitator does, not UTF-16 units', async () => {
      // The facilitator counts `q.chars()`. Each of these is one character
      // and two UTF-16 units: 300 of them are 600 units and still fit in 400.
      const emoji = '\u{1F50D}'.repeat(300);
      expect(emoji.length).toBe(600);
      const fetchMock = mockFetch(LIVE_PAGE);
      await new BazaarClient().listResources({ q: emoji });
      expect(requestedUrl(fetchMock).searchParams.get('q')).toBe(emoji);

      await expect(
        new BazaarClient().listResources({ q: '\u{1F50D}'.repeat(401) })
      ).rejects.toThrow(/at most 400/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'refuses maxSearchLen %s',
      (maxSearchLen) => {
        expect(() => new BazaarClient({ maxSearchLen })).toThrow(
          /maxSearchLen must be a positive integer/
        );
      }
    );
  });

  describe('routing filters', () => {
    const OLD_KEYS = [
      'limit',
      'offset',
      'category',
      'network',
      'provider',
      'tag',
      'source',
      'sourceFacilitator',
      'health',
      'tier',
      'q',
    ];

    it('are not sent unless passed: a call without them is byte-for-byte the old one', async () => {
      // A facilitator up to 2.46.1 answers any parameter outside OLD_KEYS
      // with a 400, so sending one by default would break every listing.
      const fetchMock = mockFetch(LIVE_PAGE);
      const client = new BazaarClient();
      await client.listResources();
      await client.listResources({
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

      expect(requestedUrl(fetchMock, 0).search).toBe('?limit=10&offset=0');
      expect([...requestedUrl(fetchMock, 1).searchParams.keys()]).toEqual(OLD_KEYS);
    });

    it('sends each one under its wire name when passed', async () => {
      const fetchMock = mockFetch(LIVE_PAGE);
      await new BazaarClient().listResources({
        q: 'phone lookup',
        maxPriceUsd: 0.05,
        method: 'POST',
        hasInputSchema: true,
        kind: 'api',
        excludeHost: 'tenjin.blog',
      });

      const params = requestedUrl(fetchMock).searchParams;
      expect(params.get('maxPriceUsd')).toBe('0.05');
      expect(params.get('method')).toBe('POST');
      expect(params.get('hasInputSchema')).toBe('true');
      expect(params.get('kind')).toBe('api');
      expect(params.get('excludeHost')).toBe('tenjin.blog');
      expect([...params.keys()]).toEqual([
        'limit',
        'offset',
        'q',
        'maxPriceUsd',
        'method',
        'hasInputSchema',
        'kind',
        'excludeHost',
      ]);
    });

    it('sends a falsy value that was passed: price 0 and hasInputSchema false', async () => {
      const fetchMock = mockFetch(LIVE_PAGE);
      await new BazaarClient().listResources({ maxPriceUsd: 0, hasInputSchema: false });

      const params = requestedUrl(fetchMock).searchParams;
      expect(params.get('maxPriceUsd')).toBe('0');
      expect(params.get('hasInputSchema')).toBe('false');
    });

    it('normalizes case and spaces where they carry no meaning', async () => {
      const fetchMock = mockFetch(LIVE_PAGE);
      await new BazaarClient().listResources({
        method: ' post ',
        excludeHost: ' API.Example.COM ',
        kind: ' content ' as 'content',
      });

      const params = requestedUrl(fetchMock).searchParams;
      expect(params.get('method')).toBe('POST');
      expect(params.get('excludeHost')).toBe('api.example.com');
      expect(params.get('kind')).toBe('content');
    });

    it('treats null as not passed', async () => {
      const fetchMock = mockFetch(LIVE_PAGE);
      const nulls = {
        maxPriceUsd: null,
        method: null,
        hasInputSchema: null,
        kind: null,
        excludeHost: null,
      } as unknown as Parameters<BazaarClient['listResources']>[0];
      await new BazaarClient().listResources(nulls);

      expect(requestedUrl(fetchMock).search).toBe('?limit=10&offset=0');
    });

    it.each([
      [{ maxPriceUsd: -0.01 }, /maxPriceUsd must be a finite number >= 0/],
      [{ maxPriceUsd: Number.NaN }, /maxPriceUsd/],
      [{ maxPriceUsd: Number.POSITIVE_INFINITY }, /maxPriceUsd/],
      [{ maxPriceUsd: '0.05' }, /maxPriceUsd/],
      [{ method: '' }, /method must be an HTTP method/],
      [{ method: '   ' }, /method must be an HTTP method/],
      [{ method: 'GET /search' }, /method must be an HTTP method/],
      [{ method: 'P0ST' }, /method must be an HTTP method/],
      [{ hasInputSchema: 'true' }, /hasInputSchema must be true or false/],
      [{ hasInputSchema: 1 }, /hasInputSchema must be true or false/],
      [{ kind: '' }, /kind must be a kind such as api or content/],
      [{ kind: '  ' }, /kind must be a kind/],
      [{ excludeHost: 'https://tenjin.blog' }, /excludeHost must be a host name/],
      [{ excludeHost: 'tenjin.blog/api' }, /excludeHost must be a host name/],
      [{ excludeHost: 'tenjin .blog' }, /excludeHost must be a host name/],
      [{ excludeHost: 'user@tenjin.blog' }, /excludeHost must be a host name/],
      [{ excludeHost: '' }, /excludeHost must be a host name/],
    ])('refuses %o before the request goes out', async (filter, message) => {
      const fetchMock = mockFetch(LIVE_PAGE);
      await expect(
        new BazaarClient().listResources(
          filter as unknown as Parameters<BazaarClient['listResources']>[0]
        )
      ).rejects.toThrow(message);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps a port in excludeHost', async () => {
      const fetchMock = mockFetch(LIVE_PAGE);
      await new BazaarClient().listResources({ excludeHost: 'localhost:8080' });
      expect(requestedUrl(fetchMock).searchParams.get('excludeHost')).toBe(
        'localhost:8080'
      );
    });

    it('surfaces the 400 of a facilitator that does not know them yet', async () => {
      // The body x402-rs 2.46.1 builds for an unknown parameter
      // (unknown_params_response, src/handlers.rs @ ff0c6404).
      mockFetch(
        {
          error: 'unknown query parameter: method',
          supported: OLD_KEYS,
        },
        400
      );
      await expect(
        new BazaarClient().listResources({ method: 'POST' })
      ).rejects.toThrow(/Bazaar API error: 400 - .*method/);
    });
  });

  describe('iterateResources', () => {
    it('forwards the routing filters on every page', async () => {
      const item = LIVE_PAGE.items[0];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            x402Version: 2,
            items: [item],
            pagination: { limit: 1, offset: 0, total: 2 },
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            x402Version: 2,
            items: [item],
            pagination: { limit: 1, offset: 1, total: 2 },
          }),
          text: async () => '',
        });
      vi.stubGlobal('fetch', fetchMock);

      const seen = [];
      for await (const r of new BazaarClient().iterateResources({
        limit: 1,
        method: 'post',
        maxPriceUsd: 0,
      })) {
        seen.push(r);
      }

      expect(seen).toHaveLength(2);
      for (const call of [0, 1]) {
        const params = new URL(fetchMock.mock.calls[call][0]).searchParams;
        expect(params.get('method')).toBe('POST');
        expect(params.get('maxPriceUsd')).toBe('0');
      }
    });

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

    it('searches with at most the first 128 characters, which every facilitator accepts', async () => {
      const longUrl = `https://api.example.com/${'a'.repeat(300)}`;
      const fetchMock = mockFetch({ ...LIVE_PAGE, items: [{ ...LIVE_PAGE.items[0], url: longUrl }] });

      expect((await new BazaarClient().getResourceByUrl(longUrl))?.url).toBe(longUrl);
      expect(requestedUrl(fetchMock).searchParams.get('q')).toBe(longUrl.slice(0, 128));

      await new BazaarClient({ maxSearchLen: 64 }).getResourceByUrl(longUrl);
      expect(requestedUrl(fetchMock, 1).searchParams.get('q')).toBe(longUrl.slice(0, 64));
    });

    it('cuts the needle between characters, never inside one', async () => {
      // 127 ASCII characters then an astral one: a UTF-16 cut at 128 would
      // keep half of it, which URLSearchParams sends as U+FFFD.
      const url = `https://x.example/${'a'.repeat(109)}\u{1F50D}tail`;
      const fetchMock = mockFetch(LIVE_PAGE);
      await new BazaarClient().getResourceByUrl(url);

      const q = requestedUrl(fetchMock).searchParams.get('q');
      expect(q).toBe(`https://x.example/${'a'.repeat(109)}\u{1F50D}`);
      expect(q).not.toContain('\uFFFD');
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
      expect(KIND_FILTERS).toEqual(['api', 'content']);
    });
  });
});
