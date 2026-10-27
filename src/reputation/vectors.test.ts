/**
 * The shared reputation vectors (test/vectors/reputation/*.json), checked
 * against this module.
 *
 * The files are the Python SDK's (uvd-x402-sdk-python
 * tests/vectors/reputation/, recorded by its scripts/reputation_vectors.py,
 * which cross-checks every value against an implementation that is not the
 * module's: eth-account for digests, signatures and the EIP-7702
 * authorization, the facilitator's own captured paymentHash, the digest read
 * from the delegate deployed on Base). They are copied here byte for byte:
 * VECTOR_SHA256 is the same table the Python suite pins, so a file edited on
 * one side, or a CRLF checkout, is red before any value is compared.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import { FakeChain, USDC } from '../../test/reputation/doubles';
import {
  ReputationError,
  authorizationDigest,
  buildRelayAuthorization,
  computePaymentHash,
  evidenceDocument,
  messageRef,
  relayedFeedbackDigest,
  signPayment,
  signRelayedFeedback,
  signerFromEthers,
  validatePreparation,
  type RelayedFeedbackParams,
} from './index';

const DIR = resolve(__dirname, '..', '..', 'test', 'vectors', 'reputation');

const VECTOR_SHA256: Record<string, string> = {
  'evidence-document.json': 'aa2fa7fd2ac40e1eace9d71bb71f4092c051be7edc8e4b930286bff7f0dd2abb',
  'message-ref.json': 'eeff15b79d887149bf995f4e157134c4513267387f18c7f2f942900c69b1dac3',
  'payment-proof.json': '5844804ffc4798a4760fa578098a70a759a9203b9fbe64098a44acdc55a7d71e',
  'prepare-rejections.json': 'e957162d1a5b03e420ce04b45527d0afd3954b8c72c8a7876fc78c5ab21d26f0',
  'relayed-feedback.json': '68480ed21a2e340a76b55aaedc9fcf8b9acea11fc483e8c43ea55e98e4fd14ae',
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

/** `set` / `delete` at a JSON path, on a copy (the Python suite's `_apply`). */
function applyOps(target: unknown, ops: Array<{ op: 'set' | 'delete'; path: Array<string | number>; value?: unknown }>) {
  const copy = JSON.parse(JSON.stringify(target));
  for (const op of ops) {
    let at = copy;
    for (const key of op.path.slice(0, -1)) at = at[key];
    const last = op.path[op.path.length - 1];
    if (op.op === 'set') at[last] = JSON.parse(JSON.stringify(op.value));
    else delete at[last];
  }
  return copy;
}

/** A case's `params` (the Python `RatingParams` fields) as this module takes them. */
function params(network: string, p: any): RelayedFeedbackParams {
  return {
    network,
    agentId: p.agentId,
    value: p.value,
    tag1: p.tag1,
    tag2: p.tag2,
    endpoint: p.endpoint,
    feedbackUri: p.feedbackURI,
    feedbackHash: p.feedbackHash,
  };
}

function signerFor(seedByte: string) {
  return signerFromEthers(new ethers.SigningKey('0x' + seedByte.repeat(32)));
}

describe('the vector files', () => {
  it('are exactly the five the Python SDK records, with its sha256, LF only', () => {
    expect(readdirSync(DIR).sort()).toEqual(Object.keys(VECTOR_SHA256).sort());
    for (const [name, sha] of Object.entries(VECTOR_SHA256)) {
      const bytes = readFileSync(join(DIR, name));
      expect(bytes.includes(0x0d)).toBe(false);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha);
    }
  });
});

describe('message-ref.json', () => {
  const v = load('message-ref.json');
  it.each(v.cases.map((c: any) => [c.note, c]))('%s', (_note, c: any) => {
    expect(messageRef(c.namespace, ...c.parts)).toBe(c.ref);
  });
  it.each(v.rejected.map((c: any) => [c.reason, JSON.stringify([c.namespace, c.parts]), c]))('refuses (%s) %s', (_reason, _json, c: any) => {
    expect(codeOf(() => messageRef(c.namespace, ...c.parts))).toBe('invalid_input');
  });
});

describe('relayed-feedback.json', () => {
  const v = load('relayed-feedback.json');

  it.each(v.cases.map((c: any) => [c.name, c]))('%s: digest, typed data, signature and authorization', async (_name, c: any) => {
    const signer = signerFor(c.signerSeedByte);
    expect(signer.address).toBe(c.rater);
    const validated = validatePreparation(c.prepare, params(c.network, c.params), c.rater, { now: c.now });
    const expected = c.expected;
    expect(validated.digest).toBe(expected.digest);
    const { EIP712Domain, ...types } = validated.typedData.types;
    expect(EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ]);
    expect({ ...validated.typedData, types }).toEqual(expected.typedDataToSign);
    expect(await signRelayedFeedback(validated, signer)).toBe(expected.signature);
    if (expected.authorization === null) {
      expect(validated.delegated).toBe(true);
      expect(await codeAsync(buildRelayAuthorization(validated, signer))).toBe('authorization_not_needed');
    } else {
      expect(await buildRelayAuthorization(validated, signer)).toEqual(expected.authorization);
      expect(authorizationDigest(validated.chainId, validated.delegate, validated.accountNonce as number)).toBe(expected.authorizationDigest);
    }
  });

  it('the digest of the delegate deployed on Base', () => {
    const d = v.deployedContract;
    const message = {
      registry: d.registry,
      agentId: String(d.params.agentId),
      value: String(d.params.value),
      valueDecimals: 0,
      tag1: d.params.tag1,
      tag2: d.params.tag2,
      endpoint: d.params.endpoint,
      feedbackURI: d.params.feedbackURI,
      feedbackHash: d.params.feedbackHash,
      deadline: String(d.deadline),
      nonce: d.nonce,
    };
    expect(relayedFeedbackDigest(d.chainId, d.account, message)).toBe(d.digest);
    const domain = { name: 'FeedbackDelegate', version: '1', chainId: d.chainId, verifyingContract: d.account };
    expect(ethers.TypedDataEncoder.hashDomain(domain).toLowerCase()).toBe(d.domainSeparator);
  });
});

async function codeAsync(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(ReputationError);
    return (error as ReputationError).code;
  }
  return 'no error';
}

describe('prepare-rejections.json', () => {
  const v = load('prepare-rejections.json');
  const base = load('relayed-feedback.json').cases.find((c: any) => c.name === v.base);

  it.each(v.rejected.map((c: any) => [c.name, c.code, c]))('%s: %s', (_name, code, c: any) => {
    const prep = applyOps(base.prepare, c.ops);
    const rating = params(c.network ?? base.network, base.params);
    expect(codeOf(() => validatePreparation(prep, rating, c.rater ?? base.rater, { now: v.now }))).toBe(code);
  });

  it.each(v.accepted.map((c: any) => [c.name, c]))('accepts %s', (_name, c: any) => {
    const validated = validatePreparation(applyOps(base.prepare, c.ops), params(base.network, base.params), base.rater, { now: v.now });
    expect(validated.digest).toBe(base.expected.digest);
  });
});

describe('payment-proof.json', () => {
  const v = load('payment-proof.json');

  it.each(v.paymentHash.map((c: any) => [c.name, c]))('paymentHash %s', (_name, c: any) => {
    expect(computePaymentHash(c)).toBe(c.paymentHash);
  });

  it('the proof recomputes', () => {
    expect(computePaymentHash(v.proof)).toBe(v.proof.paymentHash);
  });

  it.each(v.transferCalldata.map((c: any) => [c.amount, c]))('the anchor transfer of %s base units', async (_amount, c: any) => {
    const signed = await signPayment({ signer: signerFor('11'), rpc: new FakeChain(), network: 'base', payee: c.payee, amount: c.amount });
    const tx = ethers.Transaction.from(signed.rawTransaction);
    expect(tx.to).toBe(USDC);
    expect(tx.value).toBe(0n);
    expect(tx.data).toBe(c.data);
  });
});

describe('evidence-document.json', () => {
  const v = load('evidence-document.json');
  const build = (i: any) =>
    evidenceDocument({
      network: i.network,
      agentId: i.agentId,
      rater: i.rater,
      subject: i.subject,
      value: i.value,
      tag1: i.tag1,
      tag2: i.tag2,
      endpoint: i.endpoint,
      createdAt: i.createdAt,
      salt: '0x' + i.saltHex,
      private: i.private,
      walletBinding: i.walletBinding,
      proof: i.proof,
      issuer: i.issuer,
      context: i.context,
    });

  it.each(v.cases.map((c: any) => [c.name, c]))('%s: the bytes and their hash', (_name, c: any) => {
    const built = build(c.inputs);
    expect(new TextDecoder().decode(built.body)).toBe(c.body);
    expect(built.json).toBe(c.body);
    expect(built.contentHash).toBe(c.contentHash);
    for (const value of Object.values(c.inputs.private) as string[]) expect(c.body).not.toContain(value);
  });

  it.each(v.rejected.map((c: any) => [c.name, c.code, c]))('%s: %s', (_name, code, c: any) => {
    expect(codeOf(() => build(c.inputs))).toBe(code);
  });
});
