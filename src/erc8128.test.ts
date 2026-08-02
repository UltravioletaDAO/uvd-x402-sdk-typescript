import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

import {
  buildSignatureBase,
  createSignedFetch,
  fetchNonce,
  signRequest,
  signRequestWithSigner,
  signRequestWithWallet,
} from './erc8128';
import { EnvKeyAdapter } from './adapters/env-key';
import { X402Error } from './types';
import vectors from './erc8128.vectors.json';

/**
 * Provenance: `src/erc8128.vectors.json` is a byte-identical copy of the
 * F3-1 golden vectors from the Execution Market repo
 * (`shared/test-vectors/erc8128.json`, execution-market@63b284ca). That file
 * is the single source for every conformance suite in the fleet; if the wire
 * format ever changes there, re-copy the file and this suite must keep
 * passing WITHOUT touching the assertions (the format is pinned).
 *
 * Signatures are deterministic (RFC 6979): the same key + signature base
 * produces the same 65 bytes in ethers, so the headers are compared for
 * BYTE equality, not shape.
 *
 * The private key in the fixture is a synthetic test key (0x42 * 32) that
 * never held funds; it is stored WITHOUT the 0x prefix and re-prefixed here.
 */
const FROZEN = vectors.frozen;
const TEST_PRIVATE_KEY = `0x${FROZEN.private_key}`;
const CANONICAL = vectors.vectors.canonical;
const REQUESTS = vectors.requests;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('F3-1 conformance — canonical vectors (byte-pinned)', () => {
  beforeEach(() => {
    // The vectors freeze created/expires; expires - created = 300 = the
    // default validity window, so pinning the clock at `created` reproduces
    // both values without touching the API surface.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN.created * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('signRequest reproduces the get_query vector byte-for-byte', async () => {
    const headers = await signRequest({
      privateKey: TEST_PRIVATE_KEY,
      method: REQUESTS.get_query.method,
      url: REQUESTS.get_query.url,
      nonce: FROZEN.nonce,
      chainId: FROZEN.chain_id,
    });

    expect(headers.Signature).toBe(CANONICAL.get_query.headers.Signature);
    expect(headers['Signature-Input']).toBe(CANONICAL.get_query.headers['Signature-Input']);
    expect(headers['Content-Digest']).toBeUndefined();
  });

  it('signRequest reproduces the post_body vector byte-for-byte', async () => {
    const headers = await signRequest({
      privateKey: TEST_PRIVATE_KEY,
      method: REQUESTS.post_body.method,
      url: REQUESTS.post_body.url,
      body: REQUESTS.post_body.body,
      nonce: FROZEN.nonce,
      chainId: FROZEN.chain_id,
    });

    expect(headers.Signature).toBe(CANONICAL.post_body.headers.Signature);
    expect(headers['Signature-Input']).toBe(CANONICAL.post_body.headers['Signature-Input']);
    expect(headers['Content-Digest']).toBe(CANONICAL.post_body.headers['Content-Digest']);
  });

  it('signRequestWithSigner lowercases a checksummed address and matches the vector', async () => {
    const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);

    const headers = await signRequestWithSigner({
      address: FROZEN.address_checksummed,
      signMessage: (signatureBase) => wallet.signMessage(signatureBase),
      method: REQUESTS.post_body.method,
      url: REQUESTS.post_body.url,
      body: REQUESTS.post_body.body,
      nonce: FROZEN.nonce,
      chainId: FROZEN.chain_id,
    });

    expect(headers.Signature).toBe(CANONICAL.post_body.headers.Signature);
    expect(headers['Signature-Input']).toBe(CANONICAL.post_body.headers['Signature-Input']);
    expect(headers['Content-Digest']).toBe(CANONICAL.post_body.headers['Content-Digest']);
  });

  it('signRequestWithWallet (EnvKeyAdapter) matches the get_query vector', async () => {
    const wallet = new EnvKeyAdapter(TEST_PRIVATE_KEY);

    const headers = await signRequestWithWallet(wallet, {
      method: REQUESTS.get_query.method,
      url: REQUESTS.get_query.url,
      nonce: FROZEN.nonce,
      chainId: FROZEN.chain_id,
    });

    expect(headers.Signature).toBe(CANONICAL.get_query.headers.Signature);
    expect(headers['Signature-Input']).toBe(CANONICAL.get_query.headers['Signature-Input']);
    expect(headers['Content-Digest']).toBeUndefined();
  });

  it('accepts the private key without 0x prefix (as stored in the fixture)', async () => {
    const headers = await signRequest({
      privateKey: FROZEN.private_key,
      method: REQUESTS.get_query.method,
      url: REQUESTS.get_query.url,
      nonce: FROZEN.nonce,
      chainId: FROZEN.chain_id,
    });

    expect(headers.Signature).toBe(CANONICAL.get_query.headers.Signature);
  });
});

describe('F3-1 conformance — signature base (byte-pinned)', () => {
  it('buildSignatureBase reproduces the get_query base', () => {
    const base = buildSignatureBase({
      method: 'GET',
      authority: 'api.execution.market',
      path: '/api/v1/tasks',
      query: '?status=published&limit=5',
      covered: ['@method', '@authority', '@path', '@query'],
      created: FROZEN.created,
      expires: FROZEN.expires,
      nonce: FROZEN.nonce,
      keyid: `erc8128:${FROZEN.chain_id}:${FROZEN.address}`,
    });

    expect(base).toBe(CANONICAL.get_query.signature_base);
  });

  it('buildSignatureBase reproduces the post_body base', () => {
    const base = buildSignatureBase({
      method: 'POST',
      authority: 'api.execution.market',
      path: '/api/v1/tasks',
      contentDigest: CANONICAL.post_body.headers['Content-Digest'],
      covered: ['@method', '@authority', '@path', 'content-digest'],
      created: FROZEN.created,
      expires: FROZEN.expires,
      nonce: FROZEN.nonce,
      keyid: `erc8128:${FROZEN.chain_id}:${FROZEN.address}`,
    });

    expect(base).toBe(CANONICAL.post_body.signature_base);
  });

  it('fixture is self-consistent: the vector signature recovers the frozen address', () => {
    for (const vector of [CANONICAL.get_query, CANONICAL.post_body]) {
      const sigMatch = vector.headers.Signature.match(/^eth=:(.+):$/);
      expect(sigMatch).toBeTruthy();
      const sigHex = ethers.hexlify(ethers.decodeBase64(sigMatch![1]));
      const recovered = ethers.verifyMessage(vector.signature_base, sigHex);
      expect(recovered.toLowerCase()).toBe(FROZEN.address);
    }
  });
});

describe('ERC-8128 signer behavior', () => {
  it('omits Content-Digest for bodyless GET requests', async () => {
    const headers = await signRequest({
      privateKey: TEST_PRIVATE_KEY,
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks',
      nonce: 'nonce-456',
    });

    expect(headers.Signature).toMatch(/^eth=:.+:$/);
    expect(headers['Content-Digest']).toBeUndefined();
    expect(headers['Signature-Input']).not.toContain('content-digest');
  });

  it('covers @query only when the URL has a query string', async () => {
    const withQuery = await signRequest({
      privateKey: TEST_PRIVATE_KEY,
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks?status=published',
      nonce: 'nonce-789',
    });
    const withoutQuery = await signRequest({
      privateKey: TEST_PRIVATE_KEY,
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks',
      nonce: 'nonce-789',
    });

    expect(withQuery['Signature-Input']).toContain('"@query"');
    expect(withoutQuery['Signature-Input']).not.toContain('"@query"');
  });

  it('emits the pinned params order created;expires;nonce;keyid;alg', async () => {
    const headers = await signRequest({
      privateKey: TEST_PRIVATE_KEY,
      method: 'GET',
      url: 'https://api.execution.market/api/v1/health',
      nonce: 'order-check',
      chainId: 137,
    });

    expect(headers['Signature-Input']).toMatch(
      /;created=\d+;expires=\d+;nonce="order-check";keyid="erc8128:137:0x[0-9a-f]{40}";alg="eip191"$/
    );
  });
});

describe('fetchNonce', () => {
  it('fetches from /api/v1/auth/erc8128/nonce and returns the nonce', async () => {
    const fetchMock = vi.fn(async () => {
      return { ok: true, json: async () => ({ nonce: 'fresh-nonce' }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const nonce = await fetchNonce('https://api.execution.market/');

    expect(nonce).toBe('fresh-nonce');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://api.execution.market/api/v1/auth/erc8128/nonce'
    );
  });

  it('throws on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return { ok: false, status: 503, statusText: 'Service Unavailable' } as unknown as Response;
      })
    );

    await expect(fetchNonce('https://api.execution.market')).rejects.toThrow(
      'Failed to fetch nonce: 503'
    );
  });
});

describe('createSignedFetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN.created * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function stubFetchRail() {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/v1/auth/erc8128/nonce')) {
        return { ok: true, json: async () => ({ nonce: FROZEN.nonce }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return calls;
  }

  it('fetches a nonce and attaches the exact vector headers (privateKey)', async () => {
    const calls = stubFetchRail();
    const signedFetch = createSignedFetch({
      privateKey: TEST_PRIVATE_KEY,
      apiBase: 'https://api.execution.market',
      chainId: FROZEN.chain_id,
    });

    await signedFetch('/api/v1/tasks', {
      method: 'POST',
      body: REQUESTS.post_body.body,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(REQUESTS.post_body.url);

    const sent = new Headers(calls[1].init?.headers);
    expect(sent.get('Signature')).toBe(CANONICAL.post_body.headers.Signature);
    expect(sent.get('Signature-Input')).toBe(CANONICAL.post_body.headers['Signature-Input']);
    expect(sent.get('Content-Digest')).toBe(CANONICAL.post_body.headers['Content-Digest']);
    expect(sent.get('Content-Type')).toBe('application/json');
  });

  it('signs with a SigningWalletAdapter when wallet is given', async () => {
    const calls = stubFetchRail();
    const signedFetch = createSignedFetch({
      wallet: new EnvKeyAdapter(TEST_PRIVATE_KEY),
      apiBase: 'https://api.execution.market',
      chainId: FROZEN.chain_id,
    });

    await signedFetch('/api/v1/tasks?status=published&limit=5', { method: 'GET' });

    expect(calls).toHaveLength(2);
    const sent = new Headers(calls[1].init?.headers);
    expect(sent.get('Signature')).toBe(CANONICAL.get_query.headers.Signature);
    expect(sent.get('Signature-Input')).toBe(CANONICAL.get_query.headers['Signature-Input']);
    expect(sent.get('Content-Digest')).toBeNull();
  });

  it('rejects a config without a signer', () => {
    expect(() => createSignedFetch({ apiBase: 'https://api.execution.market' })).toThrow(
      X402Error
    );
  });
});
