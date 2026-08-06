import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

import { EnvKeyAdapter } from '../adapters/env-key';
import { X402Error } from '../types';
import {
  createSignedFetch,
  fetchNonce,
  signRequest,
  signRequestWithSigner,
  signRequestWithWallet,
} from './signer';
import { CONFORMANCE_VECTORS_F3_1, CONFORMANCE_VECTORS_F3_3 } from './vectors';

/**
 * The key is the synthetic public test key published in the F3-1 fixture
 * (stored without the 0x prefix, documented there as a key that never held
 * funds). Re-prefixed at runtime; never inlined.
 */
const FROZEN = CONFORMANCE_VECTORS_F3_1.frozen;
const TEST_PRIVATE_KEY = `0x${FROZEN.private_key}`;
const NOW = () => FROZEN.created;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('signer — byte identity against the shipped vectors', () => {
  for (const [generation, doc] of [
    ['f3-1', CONFORMANCE_VECTORS_F3_1],
    ['f3-3', CONFORMANCE_VECTORS_F3_3],
  ] as const) {
    for (const family of ['canonical', 'legacy_no_alg'] as const) {
      for (const name of Object.keys(doc.vectors[family])) {
        it(`${generation} ${family}/${name} reproduces the pinned headers`, async () => {
          const request = doc.requests[name];
          const headers = await signRequest({
            privateKey: TEST_PRIVATE_KEY,
            method: request.method,
            url: request.url,
            body: request.body,
            nonce: doc.frozen.nonce,
            chainId: doc.frozen.chain_id,
            profile: family === 'legacy_no_alg' ? 'legacy-no-alg' : 'canonical',
            now: () => doc.frozen.created,
          });
          const expected = doc.vectors[family][name].headers;
          expect(headers.Signature).toBe(expected.Signature);
          expect(headers['Signature-Input']).toBe(expected['Signature-Input']);
          expect(headers['Content-Digest']).toBe(expected['Content-Digest']);
        });
      }
    }
  }
});

describe('signer — wire format', () => {
  it('emits alg LAST, immediately after keyid', async () => {
    const headers = await signRequest({
      privateKey: TEST_PRIVATE_KEY,
      method: 'GET',
      url: 'https://api.execution.market/api/v1/health',
      nonce: 'order-check',
      chainId: 137,
      now: NOW,
    });
    expect(headers['Signature-Input']).toMatch(
      /;created=\d+;expires=\d+;nonce="order-check";keyid="erc8128:137:0x[0-9a-f]{40}";alg="eip191"$/
    );
  });

  it('signs the same bytes for an explicit :443 and a mixed-case host', async () => {
    const canonical = CONFORMANCE_VECTORS_F3_1.vectors.canonical.get_query.headers.Signature;
    for (const url of [
      'https://api.execution.market:443/api/v1/tasks?status=published&limit=5',
      'https://API.Execution.Market/api/v1/tasks?status=published&limit=5',
    ]) {
      const headers = await signRequest({
        privateKey: TEST_PRIVATE_KEY,
        method: 'GET',
        url,
        nonce: FROZEN.nonce,
        chainId: FROZEN.chain_id,
        now: NOW,
      });
      expect(headers.Signature, url).toBe(canonical);
    }
  });

  it('lowercases a checksummed address into the keyid', async () => {
    const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);
    const headers = await signRequestWithSigner({
      address: FROZEN.address_checksummed,
      signMessage: (base) => wallet.signMessage(base),
      method: 'GET',
      url: CONFORMANCE_VECTORS_F3_1.requests.get_query.url,
      nonce: FROZEN.nonce,
      chainId: FROZEN.chain_id,
      now: NOW,
    });
    expect(headers['Signature-Input']).toContain(FROZEN.address);
    expect(headers.Signature).toBe(
      CONFORMANCE_VECTORS_F3_1.vectors.canonical.get_query.headers.Signature
    );
  });

  it('signs with a SigningWalletAdapter without ever seeing the key', async () => {
    const headers = await signRequestWithWallet({
      wallet: new EnvKeyAdapter(TEST_PRIVATE_KEY),
      method: 'GET',
      url: CONFORMANCE_VECTORS_F3_1.requests.get_query.url,
      nonce: FROZEN.nonce,
      chainId: FROZEN.chain_id,
      now: NOW,
    });
    expect(headers.Signature).toBe(
      CONFORMANCE_VECTORS_F3_1.vectors.canonical.get_query.headers.Signature
    );
  });

  it('emits lowercase header names on demand (KK merges into a lowercase dict)', async () => {
    const headers = await signRequest({
      privateKey: TEST_PRIVATE_KEY,
      method: 'POST',
      url: CONFORMANCE_VECTORS_F3_1.requests.post_body.url,
      body: CONFORMANCE_VECTORS_F3_1.requests.post_body.body,
      nonce: FROZEN.nonce,
      chainId: FROZEN.chain_id,
      headerCase: 'lower',
      now: NOW,
    });
    const expected = CONFORMANCE_VECTORS_F3_1.vectors.canonical.post_body.headers;
    expect(Object.keys(headers).sort()).toEqual([
      'content-digest',
      'signature',
      'signature-input',
    ]);
    expect(headers.signature).toBe(expected.Signature);
    expect(headers['content-digest']).toBe(expected['Content-Digest']);
  });
});

describe('signer — the three Content-Digest predicates', () => {
  const request = CONFORMANCE_VECTORS_F3_3.requests.post_emptybody;

  it('body-present gives an empty body its own digest (the canonical rule)', async () => {
    const headers = await signRequest({
      privateKey: TEST_PRIVATE_KEY,
      method: request.method,
      url: request.url,
      body: '',
      nonce: FROZEN.nonce,
      chainId: FROZEN.chain_id,
      now: NOW,
    });
    expect(headers['Content-Digest']).toBe(
      'sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:'
    );
    expect(headers.Signature).toBe(
      CONFORMANCE_VECTORS_F3_3.vectors.canonical.post_emptybody.headers.Signature
    );
  });

  it('body-truthy emits NO digest for the same call — different bytes', async () => {
    const headers = await signRequest({
      privateKey: TEST_PRIVATE_KEY,
      method: request.method,
      url: request.url,
      body: '',
      contentDigest: 'body-truthy',
      nonce: FROZEN.nonce,
      chainId: FROZEN.chain_id,
      now: NOW,
    });
    expect(headers['Content-Digest']).toBeUndefined();
    // …and it collapses onto the bodyless vector, which is exactly the drift
    // the fleet had no vector for.
    expect(headers.Signature).toBe(
      CONFORMANCE_VECTORS_F3_3.vectors.canonical.post_nobody.headers.Signature
    );
  });

  it('a null body never gets a digest under either rule', async () => {
    for (const rule of ['body-present', 'body-truthy'] as const) {
      const headers = await signRequest({
        privateKey: TEST_PRIVATE_KEY,
        method: 'POST',
        url: request.url,
        body: null,
        contentDigest: rule,
        nonce: FROZEN.nonce,
        chainId: FROZEN.chain_id,
        now: NOW,
      });
      expect(headers['Content-Digest']).toBeUndefined();
      expect(headers['Signature-Input']).not.toContain('content-digest');
    }
  });
});

describe('signer — guardrails', () => {
  it('refuses to sign without a server-issued nonce', async () => {
    await expect(
      signRequest({
        privateKey: TEST_PRIVATE_KEY,
        method: 'GET',
        url: 'https://api.execution.market/x',
        nonce: '',
        now: NOW,
      })
    ).rejects.toThrow(X402Error);
  });

  it('refuses a URL with no authority', async () => {
    await expect(
      signRequest({
        privateKey: TEST_PRIVATE_KEY,
        method: 'GET',
        url: '/api/v1/tasks',
        nonce: 'n',
        now: NOW,
      })
    ).rejects.toThrow(/absolute URL/);
  });

  it('clamps the validity window to 300s', async () => {
    const headers = await signRequest({
      privateKey: TEST_PRIVATE_KEY,
      method: 'GET',
      url: 'https://api.execution.market/x',
      nonce: 'n',
      validitySec: 86400,
      now: NOW,
    });
    expect(headers['Signature-Input']).toContain(
      `created=${FROZEN.created};expires=${FROZEN.created + 300}`
    );
  });
});

describe('fetchNonce', () => {
  it('calls /api/v1/auth/erc8128/nonce and returns the nonce', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ nonce: 'fresh' }) }) as unknown as Response
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchNonce('https://api.execution.market/')).toBe('fresh');
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://api.execution.market/api/v1/auth/erc8128/nonce'
    );
  });

  it('throws on a non-OK response and on an empty payload — never mints one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, statusText: 'nope' }) as unknown as Response)
    );
    await expect(fetchNonce('https://api.execution.market')).rejects.toThrow(
      'Failed to fetch nonce: 503'
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response)
    );
    await expect(fetchNonce('https://api.execution.market')).rejects.toThrow('no nonce');
  });
});

describe('createSignedFetch', () => {
  function stubRail(nonceFails = false) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/api/v1/auth/erc8128/nonce')) {
          if (nonceFails) return { ok: false, status: 503, statusText: 'down' } as Response;
          return { ok: true, json: async () => ({ nonce: FROZEN.nonce }) } as unknown as Response;
        }
        return { ok: true, json: async () => ({}) } as unknown as Response;
      })
    );
    return calls;
  }

  it('fetches a nonce and attaches the exact vector headers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN.created * 1000));
    try {
      const calls = stubRail();
      const signedFetch = createSignedFetch({
        privateKey: TEST_PRIVATE_KEY,
        apiBase: 'https://api.execution.market',
        chainId: FROZEN.chain_id,
      });

      await signedFetch('/api/v1/tasks', {
        method: 'POST',
        body: CONFORMANCE_VECTORS_F3_1.requests.post_body.body!,
      });

      const expected = CONFORMANCE_VECTORS_F3_1.vectors.canonical.post_body.headers;
      const sent = new Headers(calls[1].init?.headers);
      expect(calls[1].url).toBe(CONFORMANCE_VECTORS_F3_1.requests.post_body.url);
      expect(sent.get('Signature')).toBe(expected.Signature);
      expect(sent.get('Signature-Input')).toBe(expected['Signature-Input']);
      expect(sent.get('Content-Digest')).toBe(expected['Content-Digest']);
      expect(sent.get('Content-Type')).toBe('application/json');
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a nonce outage unless the caller opted into a fallback', async () => {
    stubRail(true);
    const strict = createSignedFetch({
      privateKey: TEST_PRIVATE_KEY,
      apiBase: 'https://api.execution.market',
    });
    await expect(strict('/api/v1/tasks')).rejects.toThrow('Failed to fetch nonce: 503');

    const calls = stubRail(true);
    const lenient = createSignedFetch({
      privateKey: TEST_PRIVATE_KEY,
      apiBase: 'https://api.execution.market',
      onNonceUnavailable: () => 'locally-minted-nonce',
    });
    await lenient('/api/v1/tasks');
    expect(new Headers(calls[1].init?.headers).get('Signature-Input')).toContain(
      'nonce="locally-minted-nonce"'
    );
  });

  it('rejects a config without a signer', () => {
    expect(() => createSignedFetch({ apiBase: 'https://api.execution.market' })).toThrow(X402Error);
  });
});
