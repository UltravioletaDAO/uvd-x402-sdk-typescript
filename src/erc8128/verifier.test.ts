import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';

import { X402Error } from '../types';
import {
  buildSignatureBase,
  buildSignatureParams,
  canonicalParams,
  computeContentDigest,
  splitRequestTarget,
} from './core';
import type { ObservedProfile, SigParam } from './core';
import type { Erc8128Code } from './errors';
import { ERC8128_ERROR_RETRYABLE, ERC8128_ERROR_STATUS } from './errors';
import type { NonceContext, NonceOutcome, NonceStore } from './nonce';
import { policyFromPreset } from './presets';
import type { PolicyPresetName } from './presets';
import { verifiableRequestFromVector } from './conformance';
import { signRequest } from './signer';
import { policyAuthority, verifyRequest } from './verifier';
import type { VerifiableRequest, VerifyPolicy } from './verifier';
import { CONFORMANCE_VECTORS_F3_1, CONFORMANCE_VECTORS_F3_3 } from './vectors';

const F1 = CONFORMANCE_VECTORS_F3_1;
const F3 = CONFORMANCE_VECTORS_F3_3;
const FROZEN = F1.frozen;
const TEST_PRIVATE_KEY = `0x${FROZEN.private_key}`;
const AUTHORITY = 'api.execution.market';
const NOW = FROZEN.created;
const KEYID = `erc8128:${FROZEN.chain_id}:${FROZEN.address}`;

/** First-use-wins, like EM's store. Records every call so ordering is testable. */
class FirstUseStore implements NonceStore {
  readonly calls: Array<{ nonce: string; ctx: NonceContext }> = [];
  private readonly seen = new Set<string>();

  consume(nonce: string, ctx: NonceContext): NonceOutcome {
    this.calls.push({ nonce, ctx });
    const key = `${ctx.chainId}:${ctx.wallet}:${nonce}`;
    if (this.seen.has(key)) return 'replayed';
    this.seen.add(key);
    return 'ok';
  }
}

/** Issuer-bound, like MeshRelay's SQLite store: an unissued nonce is unknown. */
class IssuerBoundStore implements NonceStore {
  constructor(private readonly issued: Set<string> = new Set()) {}
  consume(nonce: string): NonceOutcome {
    return this.issued.has(nonce) ? 'ok' : 'unknown';
  }
}

class BrokenStore implements NonceStore {
  consume(): NonceOutcome {
    throw new Error('DynamoDB blip');
  }
}

function policy(name: PolicyPresetName, extra: Partial<VerifyPolicy> = {}): VerifyPolicy {
  return {
    ...policyFromPreset(name, {
      authority: AUTHORITY,
      nonceStore: new FirstUseStore(),
      now: () => NOW,
    }),
    ...extra,
  };
}

function requestFor(vectorId: string): VerifiableRequest {
  const [family, name] = vectorId.split('/');
  const doc = F3.vectors[family]?.[name] ? F3 : F1;
  return verifiableRequestFromVector(doc.vectors[family][name], doc.requests[name]);
}

/**
 * Sign an arbitrary covered list / parameter list, so the adversarial cases
 * exercise real signatures rather than shape assertions.
 */
async function signCustom(input: {
  method: string;
  url: string;
  covered: string[];
  params?: readonly SigParam[] | string;
  body?: string;
  authority?: string;
  label?: string;
  headers?: Record<string, string>;
}): Promise<VerifiableRequest> {
  const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);
  const target = splitRequestTarget(input.url);
  const digest = input.body !== undefined ? computeContentDigest(input.body) : undefined;
  const message = {
    method: input.method,
    authority: input.authority ?? target.authority!,
    path: target.path,
    query: target.query,
    contentDigest: digest,
    covered: input.covered,
    params:
      input.params ??
      canonicalParams({
        created: NOW,
        expires: FROZEN.expires,
        nonce: FROZEN.nonce,
        keyid: KEYID,
      }),
    headers: input.headers,
  };
  const base = buildSignatureBase(message);
  const sigB64 = ethers.encodeBase64(ethers.getBytes(await wallet.signMessage(base)));
  const label = input.label ?? 'eth';

  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    signature: `${label}=:${sigB64}:`,
    'signature-input': `${label}=${buildSignatureParams(message)}`,
  };
  if (digest) headers['content-digest'] = digest;

  let rawBody: Uint8Array | undefined;
  if (input.body !== undefined) {
    rawBody = ethers.toUtf8Bytes(input.body);
    headers['content-length'] = String(rawBody.length);
  }

  return { method: input.method, url: input.url, headers, rawBody };
}

function expectCode(result: { ok: boolean }, code: Erc8128Code) {
  expect(result).toMatchObject({
    ok: false,
    code,
    status: ERC8128_ERROR_STATUS[code],
    retryable: ERC8128_ERROR_RETRYABLE[code],
  });
}

describe('verifyRequest — happy path', () => {
  it('accepts a canonical GET and rebuilds the pinned base byte for byte', async () => {
    const result = await verifyRequest(requestFor('canonical/get_query'), policy('em-lenient'));
    expect(result).toMatchObject({
      ok: true,
      wallet: FROZEN.address,
      chainId: FROZEN.chain_id,
      keyid: KEYID,
      label: 'eth',
      nonce: FROZEN.nonce,
      created: FROZEN.created,
      expires: FROZEN.expires,
      observedProfile: 'canonical',
      via: 'eoa',
    });
    expect(result.ok && result.signatureBase).toBe(
      F1.vectors.canonical.get_query.signature_base
    );
  });

  it('reads headers case-insensitively, including array values', async () => {
    const vector = F1.vectors.canonical.post_body;
    const request = F1.requests.post_body;
    const result = await verifyRequest(
      {
        method: request.method,
        url: request.url,
        headers: {
          Signature: vector.headers.Signature,
          'Signature-Input': [vector.headers['Signature-Input']],
          'Content-Digest': vector.headers['Content-Digest'],
          'Content-Length': String(ethers.toUtf8Bytes(request.body!).length),
        },
        rawBody: ethers.toUtf8Bytes(request.body!),
      },
      policy('meshrelay-strict')
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a bodied POST under both live postures', async () => {
    for (const preset of ['meshrelay-strict', 'em-lenient'] as const) {
      const result = await verifyRequest(requestFor('canonical/post_body'), policy(preset));
      expect(result.ok, preset).toBe(true);
    }
  });
});

describe('verifyRequest — the verbatim parameter substring', () => {
  it('verifies alg-present, alg-absent and checksummed keyids through ONE path', async () => {
    const cases: Array<[string, ObservedProfile]> = [
      ['canonical/get_query', 'canonical'],
      ['legacy_no_alg/get_query', 'legacy_no_alg'],
      ['legacy_alg_checksum_keyid/get_query', 'legacy_alg_checksum_keyid'],
    ];
    for (const [vectorId, profile] of cases) {
      const result = await verifyRequest(requestFor(vectorId), policy('meshrelay-strict'));
      expect(result.ok, vectorId).toBe(true);
      expect(result.ok && result.observedProfile).toBe(profile);
    }
  });

  it('verifies an UNKNOWN future RFC 9421 parameter, in an unusual order', async () => {
    const raw =
      `("@method" "@authority" "@path");alg="eip191";tag="app";` +
      `created=${NOW};expires=${FROZEN.expires};nonce="${FROZEN.nonce}";keyid="${KEYID}"`;
    const req = await signCustom({
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks',
      covered: ['@method', '@authority', '@path'],
      params: raw,
    });
    for (const preset of ['meshrelay-strict', 'em-lenient'] as const) {
      const result = await verifyRequest(req, policy(preset));
      expect(result.ok, preset).toBe(true);
    }
  });
});

describe('verifyRequest — adversarial', () => {
  it('rejects a tampered body (digest header untouched)', async () => {
    const req = requestFor('canonical/post_body');
    req.rawBody = ethers.toUtf8Bytes('{"title":"tampered"}');
    req.headers = { ...req.headers, 'content-length': String(req.rawBody.length) };
    for (const preset of ['meshrelay-strict', 'em-lenient'] as const) {
      expectCode(await verifyRequest(req, policy(preset)), 'content_digest_mismatch');
    }
  });

  it('rejects a tampered digest header before it ever builds a base', async () => {
    const req = requestFor('canonical/post_body');
    req.headers = { ...req.headers, 'content-digest': computeContentDigest('something else') };
    expectCode(await verifyRequest(req, policy('em-lenient')), 'content_digest_mismatch');
  });

  it('rejects a malformed digest and a covered-but-missing digest', async () => {
    const base = requestFor('canonical/post_body');
    expectCode(
      await verifyRequest(
        { ...base, headers: { ...base.headers, 'content-digest': 'sha-512=:AAAA:' } },
        policy('em-lenient')
      ),
      'content_digest_invalid'
    );

    const headers = { ...base.headers };
    delete headers['content-digest'];
    expectCode(await verifyRequest({ ...base, headers }, policy('em-lenient')), 'content_digest_required');
  });

  it('partitions the three digest codes by ABSENT / unparseable / not-matching', async () => {
    // A bodyless request that covered the digest voluntarily — the case where
    // the three outcomes are distinguishable on the same bytes.
    const base = requestFor('canonical/post_emptybody');

    const absent = { ...base.headers };
    delete absent['content-digest'];
    expectCode(
      await verifyRequest({ ...base, headers: absent }, policy('em-lenient')),
      'content_digest_required'
    );

    expectCode(
      await verifyRequest(
        { ...base, headers: { ...base.headers, 'content-digest': 'sha-512=:AAAA:' } },
        policy('em-lenient')
      ),
      'content_digest_invalid'
    );

    expectCode(
      await verifyRequest(
        { ...base, headers: { ...base.headers, 'content-digest': computeContentDigest('other') } },
        policy('em-lenient')
      ),
      'content_digest_mismatch'
    );
  });

  it('rejects a reordered covered list that was not re-signed', async () => {
    const req = requestFor('canonical/get_query');
    req.headers = {
      ...req.headers,
      'signature-input': (req.headers['signature-input'] as string).replace(
        '("@method" "@authority" "@path" "@query")',
        '("@authority" "@method" "@path" "@query")'
      ),
    };
    expectCode(await verifyRequest(req, policy('meshrelay-strict')), 'components_invalid');
    // The lenient posture allows the order, so it fails on the bytes instead:
    // the reordered list is echoed into @signature-params, which the signer
    // never signed.
    expectCode(await verifyRequest(req, policy('em-lenient')), 'wallet_mismatch');
  });

  it('splits the two postures on a legitimately reordered / superset list', async () => {
    const reordered = await signCustom({
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks',
      covered: ['@authority', '@method', '@path'],
    });
    expect((await verifyRequest(reordered, policy('em-lenient'))).ok).toBe(true);
    expectCode(await verifyRequest(reordered, policy('meshrelay-strict')), 'components_invalid');

    const superset = await signCustom({
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks',
      covered: ['@method', '@authority', '@path', 'date'],
      headers: { date: 'Tue, 01 Aug 2025 00:00:00 GMT' },
    });
    expect((await verifyRequest(superset, policy('em-lenient'))).ok).toBe(true);
    expectCode(await verifyRequest(superset, policy('meshrelay-strict')), 'components_invalid');
  });

  it('rejects a signature made for a different authority', async () => {
    const req = requestFor('canonical/get_query');
    expectCode(
      await verifyRequest(req, policy('meshrelay-strict', { authority: 'api.meshrelay.xyz' })),
      'wallet_mismatch'
    );
  });

  /**
   * Every class the configured-authority rule rejects. All of them are the
   * OPERATOR's typo, so all of them are 503 `authority_invalid` — a 401 would
   * blame the caller for a server misconfiguration.
   */
  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['NBSP only', '\u00a0'],
    ['longer than 253 characters', `${'a'.repeat(250)}.market`],
    ['inner space', 'api execution.market'],
    ['inner tab', 'api\texecution.market'],
    ['inner CR', 'api\rexecution.market'],
    ['inner LF', 'api\nexecution.market'],
    ['inner vertical tab', 'api\vexecution.market'],
    ['inner form feed', 'api\fexecution.market'],
    ['inner NBSP', 'api\u00a0execution.market'],
    ['path component', 'api.execution.market/api'],
    ['userinfo prefix', 'user@api.execution.market'],
    ['query component', 'api.execution.market?x=1'],
    ['fragment', 'api.execution.market#frag'],
    ['scheme prefix', 'https://api.execution.market'],
    ['scheme prefix with a path', 'https://api.execution.market/api/v1'],
    ['bare default port', ':443'],
    ['default port :443', 'api.execution.market:443'],
    ['default port :80', 'api.execution.market:80'],
    ['IPv6 with a default port', '[::1]:443'],
  ])('reports a misconfigured authority (%s) as 503, never as a bad signature', async (
    _label,
    authority
  ) => {
    const result = await verifyRequest(
      requestFor('canonical/get_query'),
      policy('em-lenient', { authority })
    );
    expectCode(result, 'authority_invalid');
    expect(result.ok === false && result.status, authority).toBe(503);
    expect(result.ok === false && result.status, authority).not.toBe(401);
  });

  it('gives a default port in the configuration its OWN message', async () => {
    // Silently stripping it is what broke https-on-:80, so the operator is
    // told to write the value the way the signer emits it.
    for (const [authority, expected] of [
      ['api.execution.market:443', 'api.execution.market'],
      ['API.Execution.Market:80', 'api.execution.market'],
      ['[::1]:443', '[::1]'],
    ]) {
      const result = await verifyRequest(
        requestFor('canonical/get_query'),
        policy('meshrelay-strict', { authority })
      );
      expectCode(result, 'authority_invalid');
      const message = result.ok === false ? result.message : '';
      expect(message, authority).toContain('default port omitted');
      expect(message, authority).toContain(`write "${expected}"`);
      expect(message, authority).toContain(`not "${authority.toLowerCase()}"`);
    }
  });

  it('accepts a configured authority written in another case, or padded', async () => {
    // Case and surrounding whitespace are formatting. A port is NOT — the
    // configured value must already be in the form the signer emits.
    for (const authority of ['API.Execution.Market', '  api.execution.market  ']) {
      const result = await verifyRequest(
        requestFor('canonical/get_query'),
        policy('meshrelay-strict', { authority })
      );
      expect(result.ok, authority).toBe(true);
    }
  });

  it('keeps a non-default port, on both sides of the wire', async () => {
    const req = await signCustom({
      method: 'GET',
      url: 'https://api.execution.market:8443/api/v1/tasks',
      covered: ['@method', '@authority', '@path'],
    });
    expect(
      (await verifyRequest(req, policy('meshrelay-strict', { authority: 'api.execution.market:8443' })))
        .ok
    ).toBe(true);
    // Dropping the port would rebuild a base the client never signed.
    expectCode(
      await verifyRequest(req, policy('meshrelay-strict', { authority: 'api.execution.market' })),
      'wallet_mismatch'
    );
  });

  it('rejects an expired window, with each posture keeping its own grace', async () => {
    const req = requestFor('canonical/get_query');
    // MeshRelay: zero grace past expiry.
    expect((await verifyRequest(req, policy('meshrelay-strict', { now: () => FROZEN.expires - 1 }))).ok).toBe(true);
    expectCode(
      await verifyRequest(req, policy('meshrelay-strict', { now: () => FROZEN.expires })),
      'signature_stale'
    );
    // EM: 30s of grace, and no more.
    expect((await verifyRequest(req, policy('em-lenient', { now: () => FROZEN.expires + 29 }))).ok).toBe(true);
    expectCode(
      await verifyRequest(req, policy('em-lenient', { now: () => FROZEN.expires + 30 })),
      'signature_stale'
    );
  });

  it('rejects a validity window wider than the policy allows', async () => {
    const req = await signCustom({
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks',
      covered: ['@method', '@authority', '@path'],
      params: canonicalParams({
        created: NOW,
        expires: NOW + 3600,
        nonce: FROZEN.nonce,
        keyid: KEYID,
      }),
    });
    expectCode(await verifyRequest(req, policy('em-lenient')), 'signature_stale');
  });

  it('rejects a replayed nonce with 409', async () => {
    const store = new FirstUseStore();
    const withStore = () =>
      policy('em-lenient', { nonce: { store, mode: 'required', consume: 'before-verify' } });

    expect((await verifyRequest(requestFor('canonical/get_query'), withStore())).ok).toBe(true);
    const replay = await verifyRequest(requestFor('canonical/get_query'), withStore());
    expectCode(replay, 'nonce_replayed');
    expect(replay.ok === false && replay.status).toBe(409);
  });

  it('rejects a nonce this server never issued (issuer-bound store)', async () => {
    expectCode(
      await verifyRequest(
        requestFor('canonical/get_query'),
        policy('meshrelay-strict', {
          nonce: { store: new IssuerBoundStore(), mode: 'required', consume: 'after-verify' },
        })
      ),
      'nonce_unknown'
    );
  });

  it('answers 503 + retryable when the nonce store is down, not 401', async () => {
    const result = await verifyRequest(
      requestFor('canonical/get_query'),
      policy('em-lenient', {
        nonce: { store: new BrokenStore(), mode: 'required', consume: 'before-verify' },
      })
    );
    expectCode(result, 'nonce_store_unavailable');
    expect(result.ok === false && result.retryable).toBe(true);
  });

  it('rejects a foreign alg BEFORE any signature work', async () => {
    const req = requestFor('canonical/get_query');
    const foreignAlg = (req.headers['signature-input'] as string).replace(
      'alg="eip191"',
      'alg="es256"'
    );
    expectCode(
      await verifyRequest({ ...req, headers: { ...req.headers, 'signature-input': foreignAlg } }, policy('em-lenient')),
      'alg_unsupported'
    );
    // Ordering proof: with a signature that cannot even be decoded, the alg
    // gate is still what answers — accepting a scheme we do not verify with
    // would let a signature declare one algorithm and be checked under
    // another.
    expectCode(
      await verifyRequest(
        { ...req, headers: { ...req.headers, 'signature-input': foreignAlg, signature: 'eth=:YWJj:' } },
        policy('em-lenient')
      ),
      'alg_unsupported'
    );
  });

  it('rejects a signature that is not 65 bytes, or base64url encoded', async () => {
    const req = requestFor('canonical/get_query');
    expectCode(
      await verifyRequest({ ...req, headers: { ...req.headers, signature: 'eth=:YWJj:' } }, policy('em-lenient')),
      'signature_invalid'
    );
    const b64url = (req.headers.signature as string).replace(/\+/g, '-').replace(/\//g, '_');
    expectCode(
      await verifyRequest({ ...req, headers: { ...req.headers, signature: b64url } }, policy('em-lenient')),
      'signature_invalid'
    );
  });

  it('rejects a chain id outside the allowlist, and accepts any when unset', async () => {
    const headers = await signRequest({
      privateKey: TEST_PRIVATE_KEY,
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks',
      nonce: FROZEN.nonce,
      chainId: 137,
      now: () => NOW,
    });
    const req: VerifiableRequest = {
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks',
      headers: {
        signature: headers.Signature,
        'signature-input': headers['Signature-Input'],
      },
    };
    expectCode(await verifyRequest(req, policy('meshrelay-strict')), 'chain_not_allowed');
    expect((await verifyRequest(req, policy('em-lenient'))).ok).toBe(true);
  });

  it('rejects a class-bound signature and an uncovered query string', async () => {
    const classBound = await signCustom({
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks',
      covered: ['@method'],
    });
    expectCode(await verifyRequest(classBound, policy('em-lenient')), 'class_bound_rejected');

    const uncoveredQuery = await signCustom({
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks?status=published',
      covered: ['@method', '@authority', '@path'],
    });
    expectCode(await verifyRequest(uncoveredQuery, policy('em-lenient')), 'class_bound_rejected');
  });

  it('rejects a nonce-less (replayable) signature when the policy requires one', async () => {
    const req = await signCustom({
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks',
      covered: ['@method', '@authority', '@path'],
      params: canonicalParams({ created: NOW, expires: FROZEN.expires, keyid: KEYID }),
    });
    expectCode(await verifyRequest(req, policy('em-lenient')), 'nonce_required');
  });
});

/**
 * The four deployment shapes, end to end. `@authority` is derived from the URL
 * WITH its scheme (R1); the configured value is only lowercased and validated,
 * never re-ported (R2). Every earlier attempt normalised both, and every
 * single-rule choice broke two of these rows:
 *
 *   deploy          signed @authority   https-assumed   either-port
 *   https on :443   host                OK              OK
 *   http  on :80    host                BROKEN          OK
 *   https on :80    host:80             OK              BROKEN
 *   http  on :443   host:443            BROKEN          BROKEN
 */
describe('verifyRequest — the four deployment shapes', () => {
  const SHAPES: Array<[string, string, string]> = [
    ['https on :443', 'https://api.execution.market:443/api/v1/tasks', 'api.execution.market'],
    ['http on :80', 'http://api.execution.market:80/api/v1/tasks', 'api.execution.market'],
    ['https on :80', 'https://api.execution.market:80/api/v1/tasks', 'api.execution.market:80'],
    ['http on :443', 'http://api.execution.market:443/api/v1/tasks', 'api.execution.market:443'],
  ];

  it.each(SHAPES)('%s signs the authority its policy must carry', (_name, url, signed) => {
    expect(splitRequestTarget(url).authority).toBe(signed);
  });

  it.each(SHAPES)('%s: the configured value comes back with its port untouched', (
    _name,
    _url,
    signed
  ) => {
    // R2 in isolation: the configured authority is the EXPECTED OUTPUT of R1,
    // so the only legal transform on it is lowercasing.
    if (signed.endsWith(':443') || signed.endsWith(':80')) {
      expect(() => policyAuthority(signed)).toThrow(/default port omitted/);
    } else {
      expect(policyAuthority(signed.toUpperCase())).toBe(signed);
    }
  });

  it.each(SHAPES.slice(0, 2))(
    '%s verifies against the authority it signed',
    async (_name, url, signed) => {
      const req = await signCustom({
        method: 'GET',
        url,
        covered: ['@method', '@authority', '@path'],
      });
      for (const preset of ['meshrelay-strict', 'em-lenient'] as const) {
        const result = await verifyRequest(req, policy(preset, { authority: signed }));
        expect(result.ok, `${preset} ${signed}`).toBe(true);
      }
    }
  );

  /**
   * R3. The bottom two rows sign a port that is the OTHER scheme's default,
   * so the value they sign is not a legal configuration: it answers 503 with
   * the dedicated message instead of silently normalising into a base nobody
   * signed (which is how https-on-:80 used to fail as a 401 — blaming the
   * caller for the operator's port choice).
   */
  it.each(SHAPES.slice(2))(
    '%s signs a default port of the other scheme — a legible 503, never a 401',
    async (_name, url, signed) => {
      const req = await signCustom({
        method: 'GET',
        url,
        covered: ['@method', '@authority', '@path'],
      });
      const result = await verifyRequest(req, policy('meshrelay-strict', { authority: signed }));
      expectCode(result, 'authority_invalid');
      expect(result.ok === false && result.status, signed).toBe(503);
      expect(result.ok === false && result.status, signed).not.toBe(401);
      expect(result.ok === false ? result.message : '', signed).toContain(
        `write "api.execution.market", not "${signed}"`
      );
    }
  );

  it('R3: a non-default port survives on BOTH sides of the wire', async () => {
    // Verbatim, whatever it is — the configured value is never re-ported.
    expect(policyAuthority('API.Execution.Market:8443')).toBe('api.execution.market:8443');

    for (const url of [
      'https://api.execution.market:8443/api/v1/tasks',
      'http://api.execution.market:8080/api/v1/tasks',
    ]) {
      const signed = splitRequestTarget(url).authority!;
      const req = await signCustom({
        method: 'GET',
        url,
        covered: ['@method', '@authority', '@path'],
      });
      expect(
        (await verifyRequest(req, policy('meshrelay-strict', { authority: signed }))).ok,
        url
      ).toBe(true);
      // Stripping it would rebuild a base nobody signed.
      expectCode(
        await verifyRequest(
          req,
          policy('meshrelay-strict', { authority: 'api.execution.market' })
        ),
        'wallet_mismatch'
      );
    }
  });
});

describe('verifyRequest — body injection (the CRY-001 hole, closed)', () => {
  it('rejects a body attached to a bodyless-signed request (content-length form)', async () => {
    const req = requestFor('canonical/post_nobody');
    const injected = '{"bounty_usd":999999}';
    const withBody: VerifiableRequest = {
      ...req,
      rawBody: ethers.toUtf8Bytes(injected),
      headers: {
        ...req.headers,
        'content-length': String(ethers.toUtf8Bytes(injected).length),
      },
    };
    expectCode(await verifyRequest(withBody, policy('em-lenient')), 'content_digest_required');
  });

  it('rejects an injected body even with NO content-length header', async () => {
    // EM's `has_body` is header-derived, which is only sound under HTTP/1.1
    // framing. A shared SDK cannot inherit that unstated precondition, so
    // non-empty body bytes count as a body on their own.
    const req = requestFor('canonical/post_nobody');
    const withBody: VerifiableRequest = {
      ...req,
      rawBody: ethers.toUtf8Bytes('{"bounty_usd":999999}'),
    };
    expectCode(await verifyRequest(withBody, policy('em-lenient')), 'content_digest_required');
  });

  it('rejects an UNSIGNED Content-Digest header that matches the injected body', async () => {
    // The CRY-001 test is on the SIGNED component list, never on header
    // presence — otherwise an attacker would just add a matching header.
    const req = requestFor('canonical/post_nobody');
    const injected = '{"bounty_usd":999999}';
    const withBody: VerifiableRequest = {
      ...req,
      rawBody: ethers.toUtf8Bytes(injected),
      headers: {
        ...req.headers,
        'content-length': String(ethers.toUtf8Bytes(injected).length),
        'content-digest': computeContentDigest(injected),
      },
    };
    expectCode(await verifyRequest(withBody, policy('em-lenient')), 'content_digest_required');
  });

  it('rejects the attacker adding content-digest to the covered list', async () => {
    const req = requestFor('canonical/post_nobody');
    const injected = '{"bounty_usd":999999}';
    const forged: VerifiableRequest = {
      ...req,
      rawBody: ethers.toUtf8Bytes(injected),
      headers: {
        ...req.headers,
        'content-length': String(ethers.toUtf8Bytes(injected).length),
        'content-digest': computeContentDigest(injected),
        'signature-input': (req.headers['signature-input'] as string).replace(
          '("@method" "@authority" "@path")',
          '("@method" "@authority" "@path" "content-digest")'
        ),
      },
    };
    // The covered list is echoed into the signed @signature-params line, so
    // forging it changes the base and breaks recovery.
    expectCode(await verifyRequest(forged, policy('em-lenient')), 'wallet_mismatch');
  });

  it('keeps the bodyless POST/DELETE split between the two postures', async () => {
    for (const vectorId of ['canonical/post_nobody', 'canonical/delete_nobody']) {
      expect((await verifyRequest(requestFor(vectorId), policy('em-lenient'))).ok, vectorId).toBe(
        true
      );
      expectCode(
        await verifyRequest(requestFor(vectorId), policy('meshrelay-strict')),
        'content_digest_required'
      );
    }
  });

  it('verifies a voluntarily covered digest on a zero-byte body', async () => {
    const result = await verifyRequest(requestFor('canonical/post_emptybody'), policy('em-lenient'));
    expect(result.ok).toBe(true);
  });
});

describe('verifyRequest — nonce consumption order', () => {
  it('before-verify burns the nonce even when the signature is bad (EM, CRY-012)', async () => {
    const store = new FirstUseStore();
    const req = requestFor('canonical/get_query');
    const tampered: VerifiableRequest = {
      ...req,
      url: 'https://api.execution.market/api/v1/other?status=published&limit=5',
    };
    expectCode(
      await verifyRequest(
        tampered,
        policy('em-lenient', { nonce: { store, mode: 'required', consume: 'before-verify' } })
      ),
      'wallet_mismatch'
    );
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].ctx).toMatchObject({
      wallet: FROZEN.address,
      chainId: FROZEN.chain_id,
      created: FROZEN.created,
      expires: FROZEN.expires,
      ttlSeconds: FROZEN.expires - FROZEN.created + 30,
    });
  });

  it('after-verify leaves the nonce untouched on a bad signature (MeshRelay)', async () => {
    const store = new FirstUseStore();
    const req = requestFor('canonical/get_query');
    expectCode(
      await verifyRequest(
        { ...req, url: 'https://api.execution.market/api/v1/other?status=published&limit=5' },
        policy('meshrelay-strict', {
          nonce: { store, mode: 'required', consume: 'after-verify' },
        })
      ),
      'wallet_mismatch'
    );
    expect(store.calls).toHaveLength(0);
  });

  it('hands the store the raw nonce so it can derive its own key', async () => {
    const store = new FirstUseStore();
    await verifyRequest(
      requestFor('canonical/get_query'),
      policy('em-lenient', { nonce: { store, mode: 'required', consume: 'before-verify' } })
    );
    expect(store.calls[0].nonce).toBe(FROZEN.nonce);
  });
});

describe('verifyRequest — accept profiles (the S3 ladder)', () => {
  it('canonical-strict rejects both legacy generations by name', async () => {
    expectCode(
      await verifyRequest(requestFor('legacy_no_alg/get_query'), policy('canonical-strict')),
      'alg_missing'
    );
    expectCode(
      await verifyRequest(
        requestFor('legacy_alg_checksum_keyid/get_query'),
        policy('canonical-strict')
      ),
      'keyid_not_lowercase'
    );
    expect((await verifyRequest(requestFor('canonical/get_query'), policy('canonical-strict'))).ok).toBe(
      true
    );
  });

  it('canonical-strict pins the chain to 8453 — a "strict" preset that takes any chain is not strict', async () => {
    const url = 'https://api.execution.market/api/v1/tasks';
    const headers = await signRequest({
      privateKey: TEST_PRIVATE_KEY,
      method: 'GET',
      url,
      nonce: FROZEN.nonce,
      chainId: 1, // mainnet, not the production auth chain
      now: () => NOW,
    });
    const req: VerifiableRequest = {
      method: 'GET',
      url,
      headers: { signature: headers.Signature, 'signature-input': headers['Signature-Input'] },
    };

    expectCode(await verifyRequest(req, policy('canonical-strict')), 'chain_not_allowed');
    expectCode(await verifyRequest(req, policy('meshrelay-strict')), 'chain_not_allowed');
    // The pin belongs to the PRESET, not to the pipeline: EM's posture still
    // takes any chain id.
    expect((await verifyRequest(req, policy('em-lenient'))).ok).toBe(true);
  });
});

describe('verifyRequest — label handling', () => {
  it("meshrelay-strict pins the label to 'eth'; em-lenient takes any", async () => {
    const headers = await signRequest({
      privateKey: TEST_PRIVATE_KEY,
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks',
      nonce: FROZEN.nonce,
      chainId: FROZEN.chain_id,
      label: 'sig1',
      now: () => NOW,
    });
    const req: VerifiableRequest = {
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks',
      headers: { signature: headers.Signature, 'signature-input': headers['Signature-Input'] },
    };
    expectCode(await verifyRequest(req, policy('meshrelay-strict')), 'signature_input_invalid');
    const lenient = await verifyRequest(req, policy('em-lenient'));
    expect(lenient.ok && lenient.label).toBe('sig1');
  });
});

describe('verifyRequest — ERC-1271 fallback', () => {
  it('accepts a contract wallet and hashes with the UTF-8 BYTE length', async () => {
    const contractWallet = ethers.Wallet.createRandom();
    const other = new ethers.Wallet(TEST_PRIVATE_KEY);
    const keyid = `erc8128:${FROZEN.chain_id}:${contractWallet.address.toLowerCase()}`;
    const message = {
      method: 'GET',
      authority: AUTHORITY,
      path: '/api/v1/tasks/ñandú',
      covered: ['@method', '@authority', '@path'],
      params: canonicalParams({
        created: NOW,
        expires: FROZEN.expires,
        nonce: FROZEN.nonce,
        keyid,
      }),
    };
    const base = buildSignatureBase(message);
    // Signed by a DIFFERENT key: EOA recovery must fail and hand over to the
    // contract verifier.
    const sigB64 = ethers.encodeBase64(ethers.getBytes(await other.signMessage(base)));
    const req: VerifiableRequest = {
      method: 'GET',
      url: 'https://api.execution.market/api/v1/tasks/ñandú',
      headers: {
        signature: `eth=:${sigB64}:`,
        'signature-input': `eth=${buildSignatureParams(message)}`,
      },
    };

    const seen: string[] = [];
    const accepted = await verifyRequest(
      req,
      policy('em-lenient', {
        contractVerifier: async ({ messageHash, address }) => {
          seen.push(ethers.hexlify(messageHash), address);
          return true;
        },
      })
    );
    expect(accepted.ok && accepted.via).toBe('erc1271');
    expect(seen[0]).toBe(ethers.hashMessage(base));
    expect(seen[1]).toBe(contractWallet.address.toLowerCase());

    const refused = await verifyRequest(
      req,
      policy('em-lenient', { contractVerifier: async () => false })
    );
    expectCode(refused, 'wallet_mismatch');
  });

  it('does not let a throwing contract verifier escape as an exception', async () => {
    const req = requestFor('canonical/get_query');
    const forged: VerifiableRequest = {
      ...req,
      url: 'https://api.execution.market/api/v1/other?status=published&limit=5',
    };
    expectCode(
      await verifyRequest(
        forged,
        policy('em-lenient', {
          contractVerifier: async () => {
            throw new Error('RPC down');
          },
        })
      ),
      'wallet_mismatch'
    );
  });
});

describe('verifyRequest — deprecation census', () => {
  it('fires on success AND on failure, tagged with the outcome', async () => {
    const seen: Array<[ObservedProfile, string]> = [];
    const onObservedProfile = (profile: ObservedProfile, ctx: { outcome: 'ok' | Erc8128Code }) =>
      void seen.push([profile, ctx.outcome]);

    await verifyRequest(
      requestFor('legacy_no_alg/get_query'),
      policy('meshrelay-strict', { onObservedProfile })
    );
    await verifyRequest(
      requestFor('legacy_no_alg/get_query'),
      policy('canonical-strict', { onObservedProfile })
    );

    expect(seen).toEqual([
      ['legacy_no_alg', 'ok'],
      ['legacy_no_alg', 'alg_missing'],
    ]);
  });
});

describe('verifyRequest — programmer error', () => {
  it('throws (not returns) when the policy has no authority', async () => {
    await expect(
      verifyRequest(requestFor('canonical/get_query'), {} as unknown as VerifyPolicy)
    ).rejects.toThrow(X402Error);
  });
});
