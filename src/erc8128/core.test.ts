import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';

import {
  buildSignatureBase,
  buildSignatureParams,
  canonicalAuthority,
  canonicalKeyid,
  canonicalParams,
  computeContentDigest,
  eip191ByteLength,
  eip191Message,
  Erc8128ParseError,
  extractKeyidWallet,
  parseSignatureHeader,
  parseSignatureInput,
  selectCovered,
  splitRequestTarget,
} from './core';
import { CONFORMANCE_VECTORS_F3_1, CONFORMANCE_VECTORS_F3_3 } from './vectors';

const FROZEN = CONFORMANCE_VECTORS_F3_1.frozen;
const KEYID = `erc8128:${FROZEN.chain_id}:${FROZEN.address}`;

describe('parseSignatureInput', () => {
  const canonical = CONFORMANCE_VECTORS_F3_1.vectors.canonical.get_query.headers['Signature-Input'];

  it('keeps the parameter substring VERBATIM (this is the whole design)', () => {
    const parsed = parseSignatureInput(canonical);
    expect(parsed.paramsRaw).toBe(canonical.slice('eth='.length));
    // Feeding it back through the builder reproduces the pinned base exactly.
    expect(
      buildSignatureBase({
        method: 'GET',
        authority: 'api.execution.market',
        path: '/api/v1/tasks',
        query: '?status=published&limit=5',
        covered: parsed.covered,
        params: parsed.paramsRaw,
      })
    ).toBe(CONFORMANCE_VECTORS_F3_1.vectors.canonical.get_query.signature_base);
  });

  it('extracts the policy fields without touching the byte path', () => {
    const parsed = parseSignatureInput(canonical);
    expect(parsed.label).toBe('eth');
    expect(parsed.covered).toEqual(['@method', '@authority', '@path', '@query']);
    expect(parsed.created).toBe(FROZEN.created);
    expect(parsed.expires).toBe(FROZEN.expires);
    expect(parsed.nonce).toBe(FROZEN.nonce);
    expect(parsed.keyid).toBe(KEYID);
    expect(parsed.chainId).toBe(FROZEN.chain_id);
    expect(parsed.wallet).toBe(FROZEN.address);
    expect(parsed.alg).toBe('eip191');
    expect(parsed.observedProfile).toBe('canonical');
  });

  it('classifies a missing alg as legacy_no_alg', () => {
    const parsed = parseSignatureInput(
      CONFORMANCE_VECTORS_F3_1.vectors.legacy_no_alg.get_query.headers['Signature-Input']
    );
    expect(parsed.alg).toBeUndefined();
    expect(parsed.observedProfile).toBe('legacy_no_alg');
  });

  it('keeps a checksummed keyid in its ORIGINAL case and lowercases only the wallet', () => {
    const parsed = parseSignatureInput(
      CONFORMANCE_VECTORS_F3_1.vectors.legacy_alg_checksum_keyid.get_query.headers[
        'Signature-Input'
      ]
    );
    expect(parsed.keyid).toContain(FROZEN.address_checksummed);
    expect(parsed.wallet).toBe(FROZEN.address);
    expect(parsed.observedProfile).toBe('legacy_alg_checksum_keyid');
  });

  it('survives an unknown future RFC 9421 parameter and an unusual order', () => {
    const raw =
      `eth=("@method" "@authority" "@path");alg="eip191";keyid="${KEYID}";` +
      `tag="app-specific";created=${FROZEN.created};expires=${FROZEN.expires}`;
    const parsed = parseSignatureInput(raw);
    expect(parsed.paramsRaw).toBe(raw.slice('eth='.length));
    expect(parsed.alg).toBe('eip191');
    expect(parsed.created).toBe(FROZEN.created);
    // Nothing was re-serialised, so the unknown parameter is still there.
    expect(buildSignatureParams({ covered: parsed.covered, params: parsed.paramsRaw })).toContain(
      'tag="app-specific"'
    );
  });

  it('selects a dictionary member by label, and `any` prefers eth', () => {
    const raw =
      `sig1=("@method");created=1;expires=2;keyid="${KEYID}", ` +
      `eth=("@method" "@authority" "@path");created=1;expires=2;keyid="${KEYID}"`;
    expect(parseSignatureInput(raw, 'any').label).toBe('eth');
    expect(parseSignatureInput(raw, 'sig1').covered).toEqual(['@method']);
    expect(() => parseSignatureInput(raw, 'nope')).toThrow(Erc8128ParseError);
  });

  it('rejects malformed input with a code, never a silent pass', () => {
    const cases: Array<[string, string]> = [
      ['', 'signature_input_invalid'],
      ['eth=', 'signature_input_invalid'],
      [`eth=("@method");expires=2;keyid="${KEYID}"`, 'signature_input_invalid'],
      ['eth=("@method");created=1;expires=2;keyid="erc8128:8453:0xnothex"', 'signature_input_invalid'],
      ['eth=("@method" bare);created=1;expires=2;keyid="' + KEYID + '"', 'signature_input_invalid'],
    ];
    for (const [raw, code] of cases) {
      try {
        parseSignatureInput(raw);
        throw new Error(`expected ${raw} to throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(Erc8128ParseError);
        expect((error as Erc8128ParseError).code).toBe(code);
      }
    }
  });
});

describe('parseSignatureHeader', () => {
  const signature = CONFORMANCE_VECTORS_F3_1.vectors.canonical.get_query.headers.Signature;

  it('decodes exactly 65 bytes with v = 27/28', () => {
    const bytes = parseSignatureHeader(signature);
    expect(bytes.length).toBe(65);
    expect([27, 28]).toContain(bytes[64]);
  });

  it('rejects base64url, a wrong label and a wrong length', () => {
    const b64url = signature.replace(/\+/g, '-').replace(/\//g, '_');
    expect(() => parseSignatureHeader(b64url)).toThrow(Erc8128ParseError);
    expect(() => parseSignatureHeader(signature, 'sig1')).toThrow(Erc8128ParseError);
    expect(() => parseSignatureHeader('eth=:YWJj:')).toThrow(/65 bytes/);
  });
});

describe('extractKeyidWallet', () => {
  it('returns the lowercase wallet without doing any crypto', () => {
    expect(
      extractKeyidWallet(
        CONFORMANCE_VECTORS_F3_1.vectors.legacy_alg_checksum_keyid.get_query.headers[
          'Signature-Input'
        ]
      )
    ).toBe(FROZEN.address);
  });

  it('never throws — it runs before auth, on the rate-limit path', () => {
    expect(extractKeyidWallet('garbage')).toBeNull();
    expect(extractKeyidWallet('')).toBeNull();
  });
});

describe('buildSignatureBase', () => {
  it('reproduces every pinned base byte for byte, from a parameter LIST', () => {
    for (const doc of [CONFORMANCE_VECTORS_F3_1, CONFORMANCE_VECTORS_F3_3]) {
      for (const [family, cases] of Object.entries(doc.vectors)) {
        for (const [name, vector] of Object.entries(cases)) {
          const request = doc.requests[name];
          const { authority, path, query } = splitRequestTarget(request.url);
          const covered = ['@method', '@authority', '@path'];
          if (query) covered.push('@query');
          const digest =
            request.body !== null ? computeContentDigest(request.body) : undefined;
          if (digest) covered.push('content-digest');

          const keyid =
            family === 'legacy_alg_checksum_keyid'
              ? `erc8128:${doc.frozen.chain_id}:${doc.frozen.address_checksummed}`
              : `erc8128:${doc.frozen.chain_id}:${doc.frozen.address}`;

          const base = buildSignatureBase({
            method: request.method,
            authority: authority!,
            path,
            query,
            contentDigest: digest,
            covered,
            params: canonicalParams({
              created: doc.frozen.created,
              expires: doc.frozen.expires,
              nonce: doc.frozen.nonce,
              keyid,
              alg: family === 'legacy_no_alg' ? null : undefined,
            }),
          });
          expect(base, `${family}/${name}`).toBe(vector.signature_base);
        }
      }
    }
  });

  it('joins with a single LF and no trailing newline', () => {
    const base = CONFORMANCE_VECTORS_F3_1.vectors.canonical.get_query.signature_base;
    expect(base).not.toContain('\r');
    expect(base.endsWith('\n')).toBe(false);
  });

  it('emits the `?` fallback only when @query is covered without a query string', () => {
    const base = buildSignatureBase({
      method: 'GET',
      authority: 'api.execution.market',
      path: '/x',
      covered: ['@method', '@authority', '@path', '@query'],
      params: [{ name: 'created', value: 1 }],
    });
    expect(base).toContain('"@query": ?');
  });

  it('resolves an unknown covered header component, empty when absent', () => {
    const base = buildSignatureBase({
      method: 'GET',
      authority: 'api.execution.market',
      path: '/x',
      covered: ['@method', 'date', 'x-missing'],
      headers: { date: 'Tue, 01 Aug 2025 00:00:00 GMT' },
      params: [{ name: 'created', value: 1 }],
    });
    expect(base).toContain('"date": Tue, 01 Aug 2025 00:00:00 GMT');
    expect(base).toContain('"x-missing": \n');
  });
});

describe('buildSignatureParams', () => {
  it('puts alg LAST, after keyid', () => {
    const params = buildSignatureParams({
      covered: ['@method'],
      params: canonicalParams({
        created: 1,
        expires: 2,
        nonce: 'n',
        keyid: KEYID,
      }),
    });
    expect(params).toBe(`("@method");created=1;expires=2;nonce="n";keyid="${KEYID}";alg="eip191"`);
  });

  it('omits alg for the legacy generation and nonce when replayable', () => {
    expect(
      buildSignatureParams({
        covered: ['@method'],
        params: canonicalParams({ created: 1, expires: 2, keyid: KEYID, alg: null }),
      })
    ).toBe(`("@method");created=1;expires=2;keyid="${KEYID}"`);
  });

  it('returns a verbatim substring untouched', () => {
    const raw = '("@method");created=1;weird="  spaced  ";keyid="x"';
    expect(buildSignatureParams({ covered: ['@method'], params: raw })).toBe(raw);
  });
});

describe('computeContentDigest', () => {
  it('matches the RFC 9530 example and the empty-body digest', () => {
    expect(computeContentDigest('{"hello": "world"}')).toBe(
      'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:'
    );
    expect(computeContentDigest('')).toBe(
      'sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:'
    );
  });

  it('hashes bytes and their UTF-8 string form identically', () => {
    expect(computeContentDigest(ethers.toUtf8Bytes('ñandú'))).toBe(computeContentDigest('ñandú'));
  });
});

describe('eip191ByteLength', () => {
  it('counts UTF-8 BYTES, not UTF-16 code units', () => {
    // The latent EM bug: `len(str)` gives 6 here, the signed prefix says 8.
    const base = '"@path": /ñandú';
    expect(base.length).toBe(15);
    expect(eip191ByteLength(base)).toBe(17);
  });

  it('builds the prefix ethers itself signs, for a non-ASCII base', () => {
    const base = '"@path": /ñandú';
    const message = eip191Message(base);
    expect(ethers.hexlify(message)).toBe(
      ethers.hexlify(ethers.toUtf8Bytes(`\x19Ethereum Signed Message:\n17${base}`))
    );
    expect(ethers.keccak256(message)).toBe(ethers.hashMessage(base));
  });
});

describe('canonicalKeyid', () => {
  it('always lowercases the address (the v9.x silent-auth incident)', () => {
    expect(canonicalKeyid(8453, FROZEN.address_checksummed)).toBe(KEYID);
  });
});

describe('selectCovered', () => {
  it('adds @query only with a query string and content-digest only with a body', () => {
    expect(selectCovered({ url: 'https://a.b/c', hasBody: false })).toEqual([
      '@method',
      '@authority',
      '@path',
    ]);
    expect(selectCovered({ url: 'https://a.b/c?x=1', hasBody: true })).toEqual([
      '@method',
      '@authority',
      '@path',
      '@query',
      'content-digest',
    ]);
    expect(selectCovered({ url: 'https://a.b/c?', hasBody: false })).toEqual([
      '@method',
      '@authority',
      '@path',
    ]);
  });
});

describe('splitRequestTarget', () => {
  it('does not normalise the path — the signed bytes are the raw ones', () => {
    expect(splitRequestTarget('https://a.b/x/../y%2Fz?q=1&r=%20')).toEqual({
      authority: 'a.b',
      path: '/x/../y%2Fz',
      query: '?q=1&r=%20',
    });
  });

  it('normalises the authority per RFC 9421: lowercase, no default port', () => {
    expect(splitRequestTarget('https://API.Execution.Market/x').authority).toBe(
      'api.execution.market'
    );
    expect(splitRequestTarget('https://api.execution.market:443/x').authority).toBe(
      'api.execution.market'
    );
    expect(splitRequestTarget('http://api.execution.market:80/x').authority).toBe(
      'api.execution.market'
    );
    // A non-default port is part of the authority and stays.
    expect(splitRequestTarget('https://localhost:8443/x').authority).toBe('localhost:8443');
    expect(splitRequestTarget('http://[::1]:8080/x').authority).toBe('[::1]:8080');
    expect(splitRequestTarget('https://[::1]:443/x').authority).toBe('[::1]');
  });

  it('handles origin-relative targets, empty paths and a lone question mark', () => {
    expect(splitRequestTarget('/api/v1/tasks').path).toBe('/api/v1/tasks');
    expect(splitRequestTarget('https://a.b').path).toBe('/');
    expect(splitRequestTarget('/x?').query).toBeUndefined();
    expect(splitRequestTarget('/x#frag').path).toBe('/x');
  });
});

describe('canonicalAuthority', () => {
  it('drops the default port for the scheme and keeps every other one', () => {
    expect(canonicalAuthority('API.Execution.Market:443', 'https')).toBe('api.execution.market');
    expect(canonicalAuthority('api.execution.market:80', 'http')).toBe('api.execution.market');
    expect(canonicalAuthority('api.execution.market:8443', 'https')).toBe(
      'api.execution.market:8443'
    );
    // 80 is NOT the default for https, so it is a real part of the authority.
    expect(canonicalAuthority('api.execution.market:80', 'https')).toBe(
      'api.execution.market:80'
    );
    expect(canonicalAuthority('[::1]:443', 'https')).toBe('[::1]');
    expect(canonicalAuthority('[::1]', 'https')).toBe('[::1]');
  });

  /**
   * The four deployment shapes, on the SIGNING side. Each row is what a signer
   * puts in `@authority`, and therefore the only value a policy may be
   * configured with. Neither "always drop :443" nor "drop either default port"
   * reproduces all four — which is why the port rule needs the scheme, and why
   * the configured value (which has none) never comes through here.
   */
  it('derives every deployment shape the way it is signed', () => {
    // https on :443 → host
    expect(canonicalAuthority('host:443', 'https')).toBe('host');
    // http on :80 → host
    expect(canonicalAuthority('host:80', 'http')).toBe('host');
    // https on :80 → host:80  (80 is not https's default)
    expect(canonicalAuthority('host:80', 'https')).toBe('host:80');
    // http on :443 → host:443 (443 is not http's default)
    expect(canonicalAuthority('host:443', 'http')).toBe('host:443');
  });

  it('keeps the port under a scheme it does not know', () => {
    expect(canonicalAuthority('host:443', 'ftp')).toBe('host:443');
  });

  it('is idempotent — normalising live traffic changes no signature', () => {
    for (const value of ['api.execution.market', 'localhost:8443', '[::1]:8080', '[::1]']) {
      expect(canonicalAuthority(canonicalAuthority(value, 'https'), 'https')).toBe(value);
      expect(canonicalAuthority(canonicalAuthority(value, 'http'), 'http')).toBe(value);
    }
    // Idempotent per scheme, including the shapes that keep a default port of
    // the OTHER scheme.
    expect(canonicalAuthority(canonicalAuthority('host:80', 'https'), 'https')).toBe('host:80');
    expect(canonicalAuthority(canonicalAuthority('host:443', 'http'), 'http')).toBe('host:443');
  });
});
