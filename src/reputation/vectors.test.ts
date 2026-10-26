/**
 * The shared reputation vectors (test/vectors/reputation/*.json), checked
 * against this module.
 *
 * The files are derived by an emitter that does not import the module
 * (scripts/derive-reputation-vectors.mjs), checked in Python with
 * eth_account / hashlib / json by scripts/xlang/reputation-vectors-check.py,
 * and are meant to sit byte for byte in uvd-x402-sdk-python
 * tests/vectors/reputation/. VECTOR_SHA256 pins the bytes: editing a file
 * without re-deriving it, or a CRLF checkout, is red here before any value is
 * compared.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  ReputationError,
  authorizationDigest,
  buildRelayAuthorization,
  canonicalJson,
  commitment,
  computePaymentHash,
  evidenceDocument,
  messageRef,
  relayedFeedbackDigest,
  signRelayedFeedback,
  signerFromEthers,
  validatePreparation,
} from './index';

const DIR = resolve(__dirname, '..', '..', 'test', 'vectors', 'reputation');

const VECTOR_SHA256: Record<string, string> = {
  'message-ref.json': 'f76b8820253dc3a472738e21a7bbebf3c392ee23db6a7725a0da2e0398474305',
  'relayed-feedback.json': '78c598b39fa48033ac8b0dcd071b3c73f09da3afd4f47688237f47d9ad439d13',
  'payment-hash.json': 'd4f4d0f980aad0d60172a0f4352c01f77b4b3079394e71c70a0b19db1e5176d7',
  'evidence.json': '51dc5a6c102f767819de7eb46acb7dfcb5c35f87ba86a7ea33a5cfe1ad51fab2',
};

function load(name: string): any {
  return JSON.parse(readFileSync(join(DIR, name), 'utf8'));
}

function codeOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(ReputationError);
    return (error as ReputationError).code;
  }
  return 'no error';
}

function applyPatch(target: any, patch: Array<{ op: 'set' | 'delete'; path: Array<string | number>; value?: unknown }>) {
  const copy = JSON.parse(JSON.stringify(target));
  for (const p of patch) {
    let at = copy;
    for (const key of p.path.slice(0, -1)) at = at[key];
    const last = p.path[p.path.length - 1];
    if (p.op === 'delete') delete at[last];
    else at[last] = JSON.parse(JSON.stringify(p.value));
  }
  return copy;
}

describe('the vector files', () => {
  it.each(Object.entries(VECTOR_SHA256))('%s: the pinned bytes, LF only', (name, sha) => {
    const bytes = readFileSync(join(DIR, name));
    expect(bytes.includes(0x0d)).toBe(false);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha);
  });

  it('are exactly what the independent emitter derives', () => {
    const script = resolve(__dirname, '..', '..', 'scripts', 'derive-reputation-vectors.mjs');
    const run = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8', timeout: 60_000 });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});

describe('message-ref.json', () => {
  const v = load('message-ref.json');
  it.each(v.cases.map((c: any) => [c.namespace, c.parts, c.ref]))('%s %j', (namespace, parts, ref) => {
    expect(messageRef(namespace as string, ...(parts as Array<string | number>))).toBe(ref);
  });
  it.each(v.invalid.map((c: any) => [c.name, c.namespace, c.parts]))('refuses %s', (_name, namespace, parts) => {
    expect(codeOf(() => messageRef(namespace as string, ...(parts as Array<string | number>)))).toBe('invalid_input');
  });
});

describe('relayed-feedback.json', () => {
  const v = load('relayed-feedback.json');
  const key = new ethers.SigningKey('0x' + createHash('sha256').update(v.signer.seed, 'utf8').digest('hex'));
  const signer = signerFromEthers(key);

  it('the signer is the one the file names', () => {
    expect(signer.address).toBe(v.signer.address);
  });

  it('the digest of the contract deployed on Base', () => {
    const d = v.deployedContract;
    expect(relayedFeedbackDigest(d.chainId, d.verifyingContract, d.message)).toBe(d.digest);
  });

  it.each(v.cases.map((c: any) => [c.name, c]))('%s', async (_name, c: any) => {
    const validated = validatePreparation(c.prepare, c.params, v.signer.address, { now: c.now });
    expect(validated.digest).toBe(c.expected.digest);
    expect(await signRelayedFeedback(validated, signer)).toBe(c.expected.signature);
    if (c.expected.authorization === null) {
      expect(validated.delegated).toBe(true);
    } else {
      const a = c.expected.authorization;
      expect(authorizationDigest(a.chainId, a.address, a.nonce)).toBe(c.expected.authorizationDigest);
      expect(await buildRelayAuthorization(validated, signer)).toEqual(a);
    }
  });

  it.each(v.rejections.map((r: any) => [r.name, r]))('refuses %s', (_name, r: any) => {
    const c = v.cases[r.case];
    expect(codeOf(() => validatePreparation(applyPatch(c.prepare, r.patch), c.params, v.signer.address, { now: c.now }))).toBe(r.error);
  });
});

describe('payment-hash.json', () => {
  const v = load('payment-hash.json');
  it.each(v.cases.map((c: any) => [c.blockNumber, c]))('block %s', (_block, c: any) => {
    expect(computePaymentHash(c)).toBe(c.paymentHash);
  });
});

describe('evidence.json', () => {
  const v = load('evidence.json');
  const salt = '0x' + createHash('sha256').update(v.salt.seed, 'utf8').digest('hex');
  const withSalt = (input: any) => (input.commitments ? { ...input, salt } : input);
  it.each(v.canonical.map((c: any) => [c.json, c.value]))('canonical %s', (json, value) => {
    expect(canonicalJson(value)).toBe(json);
  });
  it.each(v.commitments.map((c: any) => [c.name, c]))('commitment %s', (_name, c: any) => {
    expect(commitment(salt, c.name, c.value)).toBe(c.commitment);
  });
  it.each(v.documents.map((d: any) => [d.name, d]))('%s', (_name, d: any) => {
    const doc = evidenceDocument(withSalt(d.input));
    expect(doc.json).toBe(d.json);
    expect(doc.contentHash).toBe(d.contentHash);
  });
  it.each(v.forbidden.map((f: any) => [f.name, f]))('refuses %s', (_name, f: any) => {
    expect(codeOf(() => evidenceDocument({ ...withSalt(v.documents[0].input), ...f.patch }))).toBe(f.error);
  });
});
