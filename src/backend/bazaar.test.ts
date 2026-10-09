import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BazaarClient,
  DEFAULT_MAX_SEARCH_LEN,
  HEALTH_FILTERS,
  KIND_FILTERS,
  MAX_SEARCH_LEN,
  METHOD_FILTERS,
  TIER_FILTERS,
  bazaarExtension,
  epochToDate,
  isAlive,
  type DiscoveryResource,
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

// ---------------------------------------------------------------------------
// What the facilitator does with what this client sends, transcribed from
// x402-rs main @ 6b0fefea (VERSION 2.49.0; facilitator.ultravioletadao.xyz
// /version answered 2.49.0 on 2026-10-09 UTC). Written apart from the
// client's own checks, so a test compares the client against the server and
// not against itself.
// ---------------------------------------------------------------------------

/** discovery_search.rs `parse_max_price_usd`: decimal digits, no sign, no exponent, at most 32 characters. */
function facilitatorTakesPrice(raw: string): boolean {
  const s = raw.trim();
  if (s === '' || Array.from(s).length > 32) return false;
  const dot = s.indexOf('.');
  const [whole, fraction] = dot === -1 ? [s, ''] : [s.slice(0, dot), s.slice(dot + 1)];
  if (whole === '' && fraction === '') return false;
  return /^[0-9]*$/.test(whole) && /^[0-9]*$/.test(fraction);
}

/** json_depth.rs `json_value_depth`: the root is level 0, each child one more. */
function facilitatorDepth(root: unknown): number {
  let max = 0;
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length > 0) {
    const [v, d] = stack.pop()!;
    max = Math.max(max, d);
    if (v !== null && typeof v === 'object') {
      for (const x of Object.values(v)) stack.push([x, d + 1]);
    }
  }
  return max;
}

/**
 * discovery_price.rs `sanitize_extensions`, which `RegisterResourceRequest::into_resource`
 * applies: kept as is, or dropped (no error) above 64 levels or 16 KiB of JSON.
 */
function facilitatorKeptExtensions(ext: unknown): unknown {
  if (ext === undefined || ext === null) return undefined;
  if (facilitatorDepth(ext) > 64) return undefined;
  return Buffer.byteLength(JSON.stringify(ext), 'utf8') <= 16 * 1024 ? ext : undefined;
}

/**
 * types_v2.rs `DiscoveryResource::has_input_schema`: `extensions.bazaar.info.input`,
 * or `extensions.bazaar.schema.properties.input`, is a non-empty object.
 */
function facilitatorHasInputSchema(ext: unknown): boolean {
  const get = (v: unknown, k: string) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)[k]
      : undefined;
  const declared = (v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
  const bazaar = get(ext, 'bazaar');
  return (
    declared(get(get(bazaar, 'info'), 'input')) ||
    declared(get(get(get(bazaar, 'schema'), 'properties'), 'input'))
  );
}

/**
 * discovery_health.rs `declared_request`, first rule: `info.input.method`, case
 * and spaces aside; HEAD and DELETE probe as GET. A listing that declares no
 * method is a GET for the `method` filter.
 */
function facilitatorMethod(ext: unknown): string {
  const input = (ext as { bazaar?: { info?: { input?: { method?: unknown } } } })?.bazaar
    ?.info?.input;
  const m = typeof input?.method === 'string' ? input.method.trim().toUpperCase() : '';
  return ['POST', 'PUT', 'PATCH'].includes(m) ? m : 'GET';
}

/**
 * A facilitator double for `POST /discovery/register` and
 * `GET /discovery/resources`: it reads the register body field by field as
 * `RegisterResourceRequest` (types_v2.rs) declares them, keeps `extensions`
 * through `sanitize_extensions`, and answers `hasInputSchema` and `method`
 * the way the rules above decide them.
 */
function fakeFacilitator() {
  const listings: DiscoveryResource[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const reply = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (url.pathname === '/discovery/register' && init?.method === 'POST') {
      const req = JSON.parse(String(init.body)) as Record<string, unknown>;
      const extensions = facilitatorKeptExtensions(req.extensions);
      listings.push({
        url: req.url as string,
        type: req.type as string,
        x402Version: 2,
        description: req.description as string,
        accepts: (req.accepts ?? []) as DiscoveryResource['accepts'],
        ...(req.metadata !== undefined ? { metadata: req.metadata as Record<string, unknown> } : {}),
        ...(extensions !== undefined ? { extensions } : {}),
        hasInputSchema: facilitatorHasInputSchema(extensions),
      });
      return reply(201, { success: true, url: req.url });
    }
    if (url.pathname === '/discovery/resources') {
      const p = url.searchParams;
      const items = listings.filter(
        (r) =>
          (!p.has('hasInputSchema') ||
            String(r.hasInputSchema) === p.get('hasInputSchema')) &&
          (!p.has('method') || facilitatorMethod(r.extensions) === p.get('method'))
      );
      return reply(200, {
        x402Version: 2,
        items,
        pagination: { limit: 10, offset: 0, total: items.length },
      });
    }
    return reply(404, { error: 'not found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, listings };
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
        method: ' post ' as 'post',
        excludeHost: ' API.Example.COM ',
        kind: ' Content ' as 'content',
      });

      const params = requestedUrl(fetchMock).searchParams;
      expect(params.get('method')).toBe('POST');
      expect(params.get('excludeHost')).toBe('api.example.com');
      expect(params.get('kind')).toBe('content');
    });

    it.each(
      METHOD_FILTERS.flatMap((m) => [m, m.toLowerCase(), m[0] + m.slice(1).toLowerCase()])
    )('sends method %s as the facilitator names it', async (method) => {
      const fetchMock = mockFetch(LIVE_PAGE);
      await new BazaarClient().listResources({ method: method as 'GET' });
      expect(requestedUrl(fetchMock).searchParams.get('method')).toBe(method.toUpperCase());
    });

    it.each([
      // value, as sent: decimal notation, never an exponent
      [0.05, '0.05'],
      [5, '5'],
      [-0, '0'],
      [0.000001, '0.000001'],
      [1e-7, '0.0000001'],
      [1.5e-7, '0.00000015'],
      [1.2345e-10, '0.00000000012345'],
      [1e-30, `0.${'0'.repeat(29)}1`],
      [1e21, `1${'0'.repeat(21)}`],
      [1.5e21, `15${'0'.repeat(20)}`],
      [1e31, `1${'0'.repeat(31)}`],
    ])('sends maxPriceUsd %s as %s', async (value, sent) => {
      const fetchMock = mockFetch(LIVE_PAGE);
      await new BazaarClient().listResources({ maxPriceUsd: value });
      const price = requestedUrl(fetchMock).searchParams.get('maxPriceUsd');
      expect(price).toBe(sent);
      expect(facilitatorTakesPrice(price!)).toBe(true);
    });

    it('sends every maxPriceUsd the facilitator can read, the same number, and refuses the rest', async () => {
      // String(1e-7) is "1e-7", which parse_max_price_usd answers with a 400.
      expect(facilitatorTakesPrice(String(1e-7))).toBe(false);
      const fetchMock = mockFetch(LIVE_PAGE);
      const client = new BazaarClient();
      let sent = 0;
      let refused = 0;
      for (let exp = -40; exp <= 40; exp++) {
        for (const mantissa of [1, 1.5, 2.25, 9.999999, 123456789]) {
          const value = mantissa * 10 ** exp;
          const before = fetchMock.mock.calls.length;
          try {
            await client.listResources({ maxPriceUsd: value });
          } catch (e) {
            expect(String(e)).toMatch(/maxPriceUsd must fit in 32 characters/);
            expect(fetchMock.mock.calls.length).toBe(before);
            refused++;
            continue;
          }
          const price = requestedUrl(fetchMock, before).searchParams.get('maxPriceUsd')!;
          expect(facilitatorTakesPrice(price), `${value} sent as ${price}`).toBe(true);
          expect(Number(price)).toBe(value);
          sent++;
        }
      }
      expect(sent).toBeGreaterThan(200);
      expect(refused).toBeGreaterThan(50);
    });

    it('sends excludeHost as the facilitator reads it: hosts, comma-separated', async () => {
      const fetchMock = mockFetch(LIVE_PAGE);
      const client = new BazaarClient();
      const sent = async (excludeHost: string) => {
        const before = fetchMock.mock.calls.length;
        await client.listResources({ excludeHost });
        return requestedUrl(fetchMock, before).searchParams.get('excludeHost');
      };

      expect(await sent('tenjin.blog, Api.Example.com ,,tenjin.blog')).toBe(
        'tenjin.blog,api.example.com'
      );
      expect(await sent('tenjin.blog.')).toBe('tenjin.blog');
      expect(await sent('[::1]')).toBe('[::1]');
      expect(await sent('127.0.0.1')).toBe('127.0.0.1');
      expect(await sent('bücher.de')).toBe('xn--bcher-kva.de');

      // parse_exclude_hosts counts before it removes duplicates: 20 hosts go
      // out, and a 21st part is a 400 even when it repeats one of them.
      const twenty = Array.from({ length: 20 }, (_, i) => `h${i}.example`);
      expect(await sent(twenty.join(','))).toBe(twenty.join(','));
      for (const extra of ['h20.example', 'h0.example']) {
        const before = fetchMock.mock.calls.length;
        await expect(
          client.listResources({ excludeHost: [...twenty, extra].join(',') })
        ).rejects.toThrow('excludeHost names at most 20 hosts');
        expect(fetchMock.mock.calls.length).toBe(before);
      }
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
      // 33 characters in decimal: parse_max_price_usd takes at most 32
      [{ maxPriceUsd: 1e-31 }, /maxPriceUsd must fit in 32 characters written in decimal/],
      [{ maxPriceUsd: 1e32 }, /maxPriceUsd must fit in 32 characters/],
      [{ maxPriceUsd: Number.MAX_VALUE }, /maxPriceUsd must fit in 32 characters/],
      [{ maxPriceUsd: Number.MIN_VALUE }, /maxPriceUsd must fit in 32 characters/],
      [{ method: '' }, /method must be one of GET, POST, PUT, PATCH/],
      [{ method: '   ' }, /method must be one of GET, POST, PUT, PATCH/],
      [{ method: 'GET /search' }, /method must be one of/],
      [{ method: 'P0ST' }, /method must be one of/],
      // Methods the facilitator's `method` filter does not take (400)
      [{ method: 'HEAD' }, /method must be one of GET, POST, PUT, PATCH, got "HEAD"/],
      [{ method: 'DELETE' }, /method must be one of/],
      [{ method: 'OPTIONS' }, /method must be one of/],
      [{ method: 'CONNECT' }, /method must be one of/],
      [{ method: 'delete' }, /method must be one of/],
      // toUpperCase() makes 'POST' of the long s; the facilitator does not
      [{ method: 'poſt' }, /method must be one of/],
      [{ method: 1 }, /method must be one of/],
      [{ hasInputSchema: 'true' }, /hasInputSchema must be true or false/],
      [{ hasInputSchema: 1 }, /hasInputSchema must be true or false/],
      [{ kind: '' }, /kind must be one of api, content/],
      [{ kind: '  ' }, /kind must be one of api, content/],
      // Kinds the facilitator's `kind` filter does not take (400)
      [{ kind: 'tool' }, /kind must be one of api, content, got "tool"/],
      [{ kind: 'apis' }, /kind must be one of/],
      [{ kind: 'api,content' }, /kind must be one of/],
      [{ kind: 'аpi' }, /kind must be one of/],
      [{ excludeHost: 'https://tenjin.blog' }, /excludeHost must be host names/],
      [{ excludeHost: 'tenjin.blog/api' }, /excludeHost must be host names/],
      [{ excludeHost: 'tenjin .blog' }, /excludeHost must be host names/],
      // A URL drops a tab or a line break inside the host without a word:
      // 'tenjin\t.blog' would go out as tenjin.blog. Refused, not removed.
      [{ excludeHost: 'tenjin\t.blog' }, /excludeHost must be host names/],
      [{ excludeHost: 'tenjin\n.blog' }, /excludeHost must be host names/],
      [{ excludeHost: 'tenjin.blog,api\r.example.com' }, /excludeHost must be host names/],
      [{ excludeHost: 'user@tenjin.blog' }, /excludeHost must be host names/],
      [{ excludeHost: '' }, /excludeHost must be host names/],
      [{ excludeHost: ' , ,' }, /excludeHost must be host names/],
      [{ excludeHost: '.' }, /excludeHost must be host names/],
      [{ excludeHost: 'tenjin.blog?x' }, /excludeHost must be host names/],
      [{ excludeHost: 'tenjin.blog#x' }, /excludeHost must be host names/],
      [{ excludeHost: 'tenjin\\blog' }, /excludeHost must be host names/],
      [{ excludeHost: 'tenjin.blog,https://other.example' }, /excludeHost must be host names.*other/],
      [{ excludeHost: 'a<b.example' }, /excludeHost must be host names/],
      [{ excludeHost: ['tenjin.blog'] }, /excludeHost must be host names/],
    ])('refuses %o before the request goes out', async (filter, message) => {
      const fetchMock = mockFetch(LIVE_PAGE);
      await expect(
        new BazaarClient().listResources(
          filter as unknown as Parameters<BazaarClient['listResources']>[0]
        )
      ).rejects.toThrow(message);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['localhost:8080', 'tenjin.blog:443', 'tenjin.blog:', '[::1]:8080', 'tenjin.blog,api.example.com:8443'])(
      'refuses a port in excludeHost (%s), which the facilitator answers with a 400',
      async (excludeHost) => {
        // parse_exclude_hosts refuses `:` outside an IPv6 literal and any URL
        // port; this client used to send 'localhost:8080' as it came.
        const fetchMock = mockFetch(LIVE_PAGE);
        await expect(new BazaarClient().listResources({ excludeHost })).rejects.toThrow(
          /excludeHost must be host names .*without a port/
        );
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );

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

    const RESOURCE = {
      url: 'https://api.example.com/phone-lookup',
      description: 'Who owns a phone number',
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          amount: '50000',
          payTo: '0x1234567890123456789012345678901234567890',
          maxTimeoutSeconds: 60,
        },
      ],
      metadata: { category: 'data', tags: ['phone'] },
    };
    const RESOURCE_BODY =
      '{"url":"https://api.example.com/phone-lookup","type":"http","description":"Who owns a phone number",' +
      '"accepts":[{"scheme":"exact","network":"eip155:8453","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",' +
      '"amount":"50000","payTo":"0x1234567890123456789012345678901234567890","maxTimeoutSeconds":60}],' +
      '"metadata":{"category":"data","tags":["phone"]}}';
    const POST_EXTENSION = () =>
      bazaarExtension({
        method: 'POST',
        body: { phone: '+573001234567' },
        bodySchema: {
          type: 'object',
          properties: { phone: { type: 'string' } },
          required: ['phone'],
        },
        output: { example: { owner: 'ACME S.A.S.', carrier: 'Claro' } },
      });
    const sentBody = (fetchMock: { mock: { calls: unknown[][] } }, call = 0) =>
      (fetchMock.mock.calls[call][1] as RequestInit).body as string;

    it('without extensions, sends exactly the body it sent before the option existed', async () => {
      const fetchMock = mockFetch({ success: true });
      const client = new BazaarClient();
      await client.registerResource(RESOURCE);
      await client.registerResource({ ...RESOURCE, extensions: undefined });
      await client.registerResource({
        ...RESOURCE,
        extensions: null as unknown as Record<string, unknown>,
      });

      for (const call of [0, 1, 2]) expect(sentBody(fetchMock, call)).toBe(RESOURCE_BODY);
    });

    it('sends the result of bazaarExtension() as the body\'s extensions, as it came', async () => {
      const fetchMock = mockFetch({ success: true });
      const extensions = POST_EXTENSION();
      await new BazaarClient().registerResource({ ...RESOURCE, extensions });

      const body = JSON.parse(sentBody(fetchMock));
      // Every other byte of the body is what it was; `extensions` goes last.
      expect(sentBody(fetchMock)).toBe(
        `${RESOURCE_BODY.slice(0, -1)},"extensions":${JSON.stringify(extensions)}}`
      );
      expect(Object.keys(body)).toEqual([
        'url',
        'type',
        'description',
        'accepts',
        'metadata',
        'extensions',
      ]);
      expect(body.extensions).toEqual(extensions);
      expect(body.extensions.bazaar.info.input).toEqual({
        type: 'http',
        method: 'POST',
        bodyType: 'json',
        body: { phone: '+573001234567' },
      });
      expect(body.extensions.bazaar.info.output.example).toEqual({
        owner: 'ACME S.A.S.',
        carrier: 'Claro',
      });
      expect(body.extensions.bazaar.schema.properties.input.properties.body.required).toEqual([
        'phone',
      ]);
      // What the facilitator keeps, and what it then says about the listing
      expect(facilitatorKeptExtensions(body.extensions)).toEqual(extensions);
      expect(facilitatorHasInputSchema(body.extensions)).toBe(true);
      expect(facilitatorMethod(body.extensions)).toBe('POST');
    });

    it('keeps other extension keys beside bazaar', async () => {
      const fetchMock = mockFetch({ success: true });
      const extensions = { ...POST_EXTENSION(), 'sign-in-with-x': { chains: ['eip155:8453'] } };
      await new BazaarClient().registerResource({ ...RESOURCE, extensions });

      expect(JSON.parse(sentBody(fetchMock)).extensions).toEqual(extensions);
    });

    it('round trip: registered with bazaarExtension, the listing has an input schema and is found as a POST', async () => {
      const { listings } = fakeFacilitator();
      const client = new BazaarClient();
      await client.registerResource({ ...RESOURCE, extensions: POST_EXTENSION() });
      await client.registerResource({ ...RESOURCE, url: 'https://api.example.com/bare' });

      expect(listings.map((r) => [r.url, r.hasInputSchema])).toEqual([
        ['https://api.example.com/phone-lookup', true],
        ['https://api.example.com/bare', false],
      ]);

      const declared = await client.listResources({ hasInputSchema: true, method: 'POST' });
      expect(declared.items.map((r) => r.url)).toEqual(['https://api.example.com/phone-lookup']);
      const input = (declared.items[0].extensions as ReturnType<typeof bazaarExtension>).bazaar
        .info.input;
      expect(input).toMatchObject({ method: 'POST', body: { phone: '+573001234567' } });

      const bare = await client.listResources({ hasInputSchema: false });
      expect(bare.items.map((r) => r.url)).toEqual(['https://api.example.com/bare']);
    });

    it('round trip with a GET declaration: has an input schema, found as a GET', async () => {
      fakeFacilitator();
      const client = new BazaarClient();
      await client.registerResource({
        ...RESOURCE,
        extensions: bazaarExtension({ method: 'GET', queryParams: { phone: '+573001234567' } }),
      });

      const page = await client.listResources({ hasInputSchema: true, method: 'GET' });
      expect(page.items).toHaveLength(1);
      expect((await client.listResources({ method: 'POST' })).items).toHaveLength(0);
    });

    it.each([
      [[POST_EXTENSION()], /extensions must be an object.*got an array/],
      ['{"bazaar":{}}', /extensions must be an object/],
      [42, /extensions must be an object/],
      [true, /extensions must be an object/],
    ])('refuses extensions %j before the request goes out', async (extensions, message) => {
      const fetchMock = mockFetch({ success: true });
      await expect(
        new BazaarClient().registerResource({
          ...RESOURCE,
          extensions: extensions as unknown as Record<string, unknown>,
        })
      ).rejects.toThrow(message);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends extensions of exactly 16 KiB, counted in UTF-8 bytes, and refuses one byte more', async () => {
      // 'é' is one UTF-16 unit and two bytes: a cap counted in units would let
      // through a blob the facilitator drops.
      const sized = (bytes: number) => {
        const base = { bazaar: POST_EXTENSION().bazaar, pad: '' };
        const room = bytes - Buffer.byteLength(JSON.stringify(base), 'utf8');
        return { ...base, pad: 'é'.repeat(Math.floor(room / 2)) + 'x'.repeat(room % 2) };
      };
      const fits = sized(16 * 1024);
      const over = sized(16 * 1024 + 1);
      expect(Buffer.byteLength(JSON.stringify(fits), 'utf8')).toBe(16384);
      expect(JSON.stringify(fits).length).toBeLessThan(16384);
      expect(facilitatorKeptExtensions(fits)).toBe(fits);
      expect(facilitatorKeptExtensions(over)).toBeUndefined();

      const fetchMock = mockFetch({ success: true });
      await new BazaarClient().registerResource({ ...RESOURCE, extensions: fits });
      expect(JSON.parse(sentBody(fetchMock)).extensions).toEqual(fits);

      await expect(
        new BazaarClient().registerResource({ ...RESOURCE, extensions: over })
      ).rejects.toThrow('extensions must be at most 16384 bytes as JSON, got 16385');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sends extensions 64 levels deep and refuses 65, as the facilitator counts levels', async () => {
      const nested = (levels: number) => {
        let v: unknown = 'leaf';
        for (let i = 0; i < levels; i++) v = i % 2 ? { k: v } : [v];
        return { bazaar: POST_EXTENSION().bazaar, deep: v };
      };
      // `deep` is level 1, so its leaf sits at levels + 1
      const fits = nested(63);
      const over = nested(64);
      expect(facilitatorDepth(fits)).toBe(64);
      expect(facilitatorDepth(over)).toBe(65);
      expect(facilitatorKeptExtensions(fits)).toBe(fits);
      expect(facilitatorKeptExtensions(over)).toBeUndefined();

      const fetchMock = mockFetch({ success: true });
      await new BazaarClient().registerResource({ ...RESOURCE, extensions: fits });
      expect(JSON.parse(sentBody(fetchMock)).extensions).toEqual(fits);

      await expect(
        new BazaarClient().registerResource({ ...RESOURCE, extensions: over })
      ).rejects.toThrow('extensions must be at most 64 levels deep, got 65');
      expect(fetchMock).toHaveBeenCalledTimes(1);
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
      // x402-rs discovery_search.rs `KINDS` and `METHODS`
      expect(KIND_FILTERS).toEqual(['api', 'content']);
      expect(METHOD_FILTERS).toEqual(['GET', 'POST', 'PUT', 'PATCH']);
    });
  });
});
