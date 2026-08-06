import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';

import { runConformance } from './conformance';
import type { NonceStore } from './nonce';
import { POLICY_PRESETS, policyFromPreset, presetAsData, PRESET_NONCE_CONSUME } from './presets';
import type { PolicyPresetName } from './presets';
import {
  CONFORMANCE_SHA256,
  CONFORMANCE_VECTORS_F3_1,
  CONFORMANCE_VECTORS_F3_3,
  F3_1_VECTORS_JSON,
  F3_3_VECTORS_JSON,
} from './vectors';

/**
 * NO SKIPS ANYWHERE IN THIS FILE. The vectors are resolved through module
 * imports, never a path relative to a monorepo, so a missing file is a
 * collection-time error and not a silent green — that is exactly how EM's
 * `test_erc8128_canonical_parity.py` ended up with untested byte-equality
 * assertions outside its monorepo.
 */

describe('shipped vectors', () => {
  it('hashes to the pinned CONFORMANCE_SHA256 (hand-edit tripwire)', () => {
    const sha256 = (text: string) =>
      createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    expect(sha256(F3_1_VECTORS_JSON)).toBe(CONFORMANCE_SHA256['f3-1']);
    expect(sha256(F3_3_VECTORS_JSON)).toBe(CONFORMANCE_SHA256['f3-3']);
  });

  it('keys the hash map by generation id, the way Python does', () => {
    // The spec's cross-language check is `CONFORMANCE_SHA256 == CONFORMANCE_SHA256`.
    // It cannot pass if one side says `f3_1` and the other `f3-1`.
    expect(Object.keys(CONFORMANCE_SHA256)).toEqual(['f3-1', 'f3-3']);
  });

  it('carries the F3-1 pinned wire policy verbatim from the fleet source', () => {
    const pinned = (
      CONFORMANCE_VECTORS_F3_1.policy as {
        pinned_wire_format: {
          alg: string;
          alg_required: boolean;
          keyid_lowercase: boolean;
          label: string;
          signature_params_order: string[];
        };
      }
    ).pinned_wire_format;
    expect(pinned.alg).toBe('eip191');
    expect(pinned.alg_required).toBe(true);
    expect(pinned.keyid_lowercase).toBe(true);
    expect(pinned.label).toBe('eth');
    expect(pinned.signature_params_order).toEqual([
      'created',
      'expires',
      'nonce',
      'keyid',
      'alg',
    ]);
  });

  it('is self-consistent: every pinned signature recovers the frozen address', () => {
    for (const doc of [CONFORMANCE_VECTORS_F3_1, CONFORMANCE_VECTORS_F3_3]) {
      for (const [family, cases] of Object.entries(doc.vectors)) {
        for (const [name, vector] of Object.entries(cases)) {
          const b64 = /^eth=:(.+):$/.exec(vector.headers.Signature)?.[1];
          expect(b64, `${family}/${name}`).toBeTruthy();
          const recovered = ethers.verifyMessage(
            vector.signature_base,
            ethers.hexlify(ethers.decodeBase64(b64!))
          );
          expect(recovered.toLowerCase(), `${family}/${name}`).toBe(doc.frozen.address);
        }
      }
    }
  });

  it("F3-3's Signature-Input is exactly its base's @signature-params line", () => {
    for (const cases of Object.values(CONFORMANCE_VECTORS_F3_3.vectors)) {
      for (const vector of Object.values(cases)) {
        const line = vector.signature_base.split('\n').at(-1)!;
        expect(vector.headers['Signature-Input']).toBe(
          `eth=${line.slice('"@signature-params": '.length)}`
        );
      }
    }
  });
});

/**
 * The four F3-3 signatures the design spec pins independently
 * (docs/plans/UVD_SDK_ERC8128_UNIFICATION_SPEC.md §5.2 — V1, V4, V5, V7).
 * These literals are the EXTERNAL anchor for the derivation script: if
 * `derive-erc8128-f3-3.mjs` ever drifts, it drifts away from a number written
 * down before the code existed.
 */
const SPEC_PINNED: Record<string, string> = {
  get_noquery:
    'eth=:1GRZMnGfUfo23Y9qNIYdsqQz2Q9Mvp3hvIgj+1AapXhKrnYi9zNG9Ilks2n9/rtzTiozLSB4yQs+vrx6TWmOyhw=:',
  post_nobody:
    'eth=:VueO6hM652wp8ZRtTyI49lrnQtDtqsCJ3qbMdGRIXdwuiCnBl/T7oHefcmvcP88MpXi3s+Lj723PNMzED9uJXhw=:',
  delete_nobody:
    'eth=:SlH4Ev68FarWf/JZ282/jF5LhE72AQKmrc+WTOph5UtoNqMx/D0AQxzYWks3jhURBZt3rjSHhL9x3r7k+HhP7Rs=:',
  post_emptybody:
    'eth=:2ODpBTt4ci8Tg03GPmLSLxf4nK3Htt0GfXs2hgVN/elABjQAYbFQR9WqVuGJ+BNDQEPUTHgIWiIj6PGfRSe4nRs=:',
};

describe('F3-3 additive vectors', () => {
  it('matches the four signatures pinned in the design spec', () => {
    for (const [name, signature] of Object.entries(SPEC_PINNED)) {
      expect(CONFORMANCE_VECTORS_F3_3.vectors.canonical[name].headers.Signature, name).toBe(
        signature
      );
    }
  });

  it('pins the bodyless-POST base the spec spells out line by line', () => {
    expect(CONFORMANCE_VECTORS_F3_3.vectors.canonical.post_nobody.signature_base).toBe(
      [
        '"@method": POST',
        '"@authority": api.execution.market',
        '"@path": /api/v1/tasks/abc/cancel',
        '"@signature-params": ("@method" "@authority" "@path");created=1754006400;expires=1754006700;nonce="f3-1-conformance-nonce-0001";keyid="erc8128:8453:0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025";alg="eip191"',
      ].join('\n')
    );
  });

  it('gives the empty-body POST a digest of the empty string', () => {
    expect(CONFORMANCE_VECTORS_F3_3.vectors.canonical.post_emptybody.headers['Content-Digest']).toBe(
      'sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:'
    );
    expect(
      CONFORMANCE_VECTORS_F3_3.vectors.canonical.post_nobody.headers['Content-Digest']
    ).toBeUndefined();
  });

  it('does NOT duplicate the private key out of F3-1', () => {
    expect(CONFORMANCE_VECTORS_F3_3.frozen.private_key).toBeUndefined();
  });

  it('signs a non-ASCII path RAW, not percent-encoded', () => {
    // `new URL('…/tareas/ñandú').pathname` is `/api/v1/tareas/%C3%B1and%C3%BA`.
    // Python's `urlsplit()` keeps the raw characters. If the signer reached for
    // `new URL()` the two languages would sign different bases for the same
    // request — a 401 that reproduces only on non-ASCII traffic.
    const base = CONFORMANCE_VECTORS_F3_3.vectors.canonical.utf8_path.signature_base;
    expect(base).toContain('"@path": /api/v1/tareas/ñandú');
    expect(base).toContain('"@query": ?buscar=café');
    expect(base).not.toContain('%C3%B1');
    // And the EIP-191 prefix counts BYTES: the base is longer in bytes than in
    // UTF-16 code units, which is the only way this vector can catch that.
    expect(Buffer.byteLength(base, 'utf8')).toBeGreaterThan(base.length);
  });

  it('declares the generation it extends', () => {
    expect(CONFORMANCE_VECTORS_F3_3.generation).toBe('F3-3');
    expect(CONFORMANCE_VECTORS_F3_3.extends).toBe('F3-1');
  });

  /**
   * The reason these vectors exist. Before them every pinned URL was lowercase
   * with no explicit port, so the per-scheme authority rule and the
   * scheme-blind one produced identical bytes for all fourteen — reverting
   * either SDK to the scheme-blind rule left the whole cross-language run
   * green. These six are the same call written six ways, and the last two
   * separate the rules on their own.
   */
  it('pins an @authority that a scheme-blind rule gets WRONG', () => {
    const authorityOf = (name: string) =>
      CONFORMANCE_VECTORS_F3_3.vectors.canonical[name].signature_base.split('\n')[1];

    // Formatting only: these three collapse onto the bare host.
    expect(authorityOf('authority_uppercase_host')).toBe('"@authority": api.execution.market');
    expect(authorityOf('authority_https_on_443')).toBe('"@authority": api.execution.market');
    expect(authorityOf('authority_http_on_80')).toBe('"@authority": api.execution.market');

    // A non-default port is part of the authority.
    expect(authorityOf('authority_https_on_8443')).toBe('"@authority": api.execution.market:8443');

    // THE TWO THAT BITE: 443 is ordinary under http and 80 is ordinary under
    // https. Drop them and these two collapse onto the bare host, which is
    // exactly what "drop :443 and :80 always" does.
    expect(authorityOf('authority_http_on_443')).toBe('"@authority": api.execution.market:443');
    expect(authorityOf('authority_https_on_80')).toBe('"@authority": api.execution.market:80');
    expect(authorityOf('authority_http_on_443')).not.toBe(authorityOf('authority_https_on_443'));
    expect(authorityOf('authority_https_on_80')).not.toBe(authorityOf('authority_http_on_80'));
  });

  it('pins the CONFIGURED-authority behaviour as data, 503 and never 401', () => {
    const cases = CONFORMANCE_VECTORS_F3_3.verify_cases!;
    const configured = cases.filter((c) => c.authority !== undefined);
    expect(configured.length).toBeGreaterThan(0);

    const invalid = configured.filter((c) => c.code === 'authority_invalid');
    // Two default-port configs plus the five whitespace classes.
    expect(invalid.length).toBe(7);
    for (const c of invalid) {
      expect(c.status, JSON.stringify(c)).toBe(503);
      expect(c.status, JSON.stringify(c)).not.toBe(401);
      // Refused before Signature-Input is ever parsed.
      expect(c.observed_profile, JSON.stringify(c)).toBeNull();
    }

    // Every named whitespace character is covered, NBSP included: JS `\s` and
    // Python `\s` disagree about NBSP, so a rule written `\s` on both sides
    // rejects two different input sets.
    const values = invalid.map((c) => c.authority!);
    for (const ch of ['\n', '\r', '\v', '\f', ' ']) {
      expect(values.some((v) => v.includes(ch)), JSON.stringify(ch)).toBe(true);
    }
    expect(values).toContain('api.execution.market:443');
    expect(values).toContain('api.execution.market:80');

    // …and a non-default port is ACCEPTED against a matching signature.
    const accepted = configured.filter(
      (c) => c.expect === 'accept' && c.authority === 'api.execution.market:8443'
    );
    expect(accepted.length).toBe(3);
    expect(accepted.map((c) => c.vector_id)).toEqual([
      'canonical/authority_https_on_8443',
      'canonical/authority_https_on_8443',
      'canonical/authority_https_on_8443',
    ]);
  });

  it('pins a 401/503 status on every reject row', () => {
    for (const c of CONFORMANCE_VECTORS_F3_3.verify_cases!) {
      if (c.expect !== 'reject') continue;
      expect([401, 409, 429, 503], JSON.stringify(c)).toContain(c.status);
    }
  });
});

describe('POLICY_PRESETS', () => {
  it('is byte-equal to the `policies` block of the shipped vectors', () => {
    for (const name of Object.keys(POLICY_PRESETS) as PolicyPresetName[]) {
      expect(presetAsData(name), name).toEqual(CONFORMANCE_VECTORS_F3_3.policies![name]);
    }
    expect(Object.keys(CONFORMANCE_VECTORS_F3_3.policies!).sort()).toEqual(
      Object.keys(POLICY_PRESETS).sort()
    );
  });

  it('omits the two per-deployment values on purpose', () => {
    for (const preset of Object.values(POLICY_PRESETS)) {
      expect(preset).not.toHaveProperty('authority');
      expect(preset).not.toHaveProperty('nonce');
    }
  });

  it('pins canonical-strict to the production auth chain', () => {
    expect(POLICY_PRESETS['canonical-strict'].allowedChainIds).toEqual([8453]);
  });

  it('carries each posture’s nonce ordering, so adopting a preset cannot flip it', () => {
    expect(PRESET_NONCE_CONSUME).toEqual({
      'meshrelay-strict': 'after-verify',
      'em-lenient': 'before-verify',
      'canonical-strict': 'after-verify',
    });

    const store: NonceStore = { consume: () => 'ok' };
    const em = policyFromPreset('em-lenient', { authority: 'api.execution.market', nonceStore: store });
    expect(em.nonce).toEqual({ store, mode: 'required', consume: 'before-verify' });
    expect(em.authority).toBe('api.execution.market');

    const mesh = policyFromPreset('meshrelay-strict', { authority: 'api.meshrelay.xyz', nonceStore: store });
    expect(mesh.nonce?.consume).toBe('after-verify');

    // No store ⇒ no nonce policy invented for the caller.
    expect(policyFromPreset('em-lenient', { authority: 'api.execution.market' }).nonce).toBeUndefined();
  });
});

describe('runConformance', () => {
  it('passes every integrity, sign and verify case in this build', async () => {
    const report = await runConformance();
    expect(report.failed, JSON.stringify(report.failed, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(report.total);
    expect(report.wireContractVersion).toBe('F3-3');
    expect(report.sha256).toEqual(CONFORMANCE_SHA256);
  });

  it('runs the same three sections Python runs, so the counts can be compared', async () => {
    const report = await runConformance();
    const ids = report.cases.map((c) => c.id);
    expect(ids).toContain('integrity:f3-1');
    expect(ids).toContain('integrity:f3-3');
    expect(ids).toContain('policy:em-lenient');
    expect(ids).toContain('f3-1:sign:canonical/get_query');
    expect(ids).toContain('f3-1:sign:legacy_no_alg/post_body');
    expect(ids).toContain('f3-3:sign:canonical/post_emptybody');
    expect(ids).toContain('f3-3:sign:canonical/authority_http_on_443');
    // 2 shipped vector documents + 3 pinned presets — the section TypeScript
    // used to be missing, and the whole of the 67-vs-62 gap.
    expect(report.cases.filter((c) => c.kind === 'integrity').length).toBe(2);
    expect(report.cases.filter((c) => c.kind === 'policy').length).toBe(3);
    // 2 emittable families × (2 F3-1 requests + 11 F3-3 requests).
    expect(report.cases.filter((c) => c.kind === 'sign').length).toBe(26);
    expect(report.cases.filter((c) => c.kind === 'verify').length).toBe(
      CONFORMANCE_VECTORS_F3_3.verify_cases!.length
    );
  });

  it('can run a single phase, but never skips integrity', async () => {
    const signOnly = await runConformance({ only: 'sign' });
    expect(signOnly.cases.every((c) => c.kind === 'sign' || c.kind === 'integrity' || c.kind === 'policy')).toBe(true);
    expect(signOnly.cases.some((c) => c.kind === 'integrity')).toBe(true);
    expect(signOnly.failed).toEqual([]);

    const verifyOnly = await runConformance({ only: 'verify' });
    expect(verifyOnly.cases.every((c) => c.kind === 'verify' || c.kind === 'integrity' || c.kind === 'policy')).toBe(true);
    expect(verifyOnly.cases.some((c) => c.kind === 'integrity')).toBe(true);
    expect(verifyOnly.failed).toEqual([]);
  });

  it('pins the open contract divergence as DATA, not as prose', () => {
    const cases = CONFORMANCE_VECTORS_F3_3.verify_cases!;
    const strict = cases.find(
      (c) => c.vector_id === 'canonical/post_nobody' && c.policy === 'meshrelay-strict'
    );
    const lenient = cases.find(
      (c) => c.vector_id === 'canonical/post_nobody' && c.policy === 'em-lenient'
    );
    expect(strict).toMatchObject({ expect: 'reject', code: 'content_digest_required' });
    expect(lenient).toMatchObject({ expect: 'accept', observed_profile: 'canonical' });
  });
});
