/**
 * A uint written as a JSON NUMBER: refused, never signed rounded.
 *
 * `JSON.parse` turns every integer above 2**53 - 1 into the nearest double. A
 * 32-byte salt hashes the same where it was written as a number (Python's
 * `json` keeps it exact) and comes out of JavaScript's parser as 7.76e+76, a
 * different integer, with no error. The pinned lifecycle vector's salt (12345)
 * fits in a double and could not show it. These tests use a REAL salt, 0xab*32,
 * and walk it through every path of this SDK that reads a uint for a signature
 * or a hash:
 *
 * - as a number past 2**53 - 1 it is refused, with the field named, and the
 *   signer is never called;
 * - as the wire's hex string (or a bigint) it signs the digest the Python SDK
 *   computes for the same order: pinned below, and compared live, process to
 *   process, by `release/real-salt` in `scripts/xlang/cross-language-conformance.mjs`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

import {
  buildLifecycleAuth,
  buildLifecycleTypedData,
  lifecycleAuthFromSignature,
  wagmiLifecycleSigner,
  type LifecyclePaymentInfo,
  type LifecycleSigner,
  type LifecycleTypedData,
} from './lifecycle-auth';
import vectors from './lifecycle-auth.vectors.json';
import { EnvKeyAdapter } from './adapters/env-key';
import {
  buildEscrowPreAuth,
  computeEscrowNonce,
  type EscrowNetworkConfig,
  type EscrowPaymentInfo,
} from './escrow-preauth';
import { Erc8004Client } from './backend/index.js';
import { X402Client } from './client/X402Client';
import { EVMProvider } from './providers/evm';
import { StellarProvider } from './providers/stellar';
import { SuiProvider } from './providers/sui';
import { getChainByName } from './chains';
import { decodeBase64Utf8 } from './utils/base64';
import {
  assertTypedDataIntegersExact,
  findInexactNumber,
  parseTypedDataJson,
  toUint,
} from './utils/uint';
import { X402Error } from './types';

// ============================================================================
// The salt, three ways
// ============================================================================

/** 32 random-looking bytes, the width `buildEscrowPreAuth` mints. */
const REAL_SALT_HEX = `0x${'ab'.repeat(32)}`;
const REAL_SALT = BigInt(REAL_SALT_HEX);
/** The salt as the digits of a JSON number: what Python's `json.dumps(int)` writes. */
const REAL_SALT_DIGITS = REAL_SALT.toString();
/** What JavaScript's `JSON.parse` makes of those digits. */
const REAL_SALT_PARSED = JSON.parse(REAL_SALT_DIGITS) as number;

/**
 * The Python SDK on this order (the lifecycle vector with salt 0xab*32):
 * `uvd_x402_sdk.escrow_signing.build_lifecycle_auth`, uvd-x402-sdk-python
 * 0.95.0 (origin/main be56460), digest by eth-account 0.14.0
 * `encode_typed_data` over the document the SDK handed its wallet. Python
 * gives the same two values for the salt as hex and as an int.
 */
const PY_REAL_SALT_DIGEST = '0x6a02e2629018e31d047184c475981035e40e25aa4359c2f9dfdb421319efe448';
const PY_REAL_SALT_SIGNATURE =
  '0x15a8587e82d062e4e1c97f343d0eea1fa3b84842b3ff0ac21b37718225c4ce9e' +
  '411c54cc4689d758640cf946fcd778cde012c7eec88116d60ec415eb572810a71b';

const PI = vectors.paymentInfo as LifecyclePaymentInfo;
const ORDER = {
  action: 'release' as const,
  payer: vectors.payer,
  amount: vectors.amount,
  chainId: vectors.chainId,
  deadline: vectors.deadline,
  nonce: vectors.nonce,
  now: vectors.deadline - 60,
};

/** The paymentInfo as a server that writes uints as numbers would send it, parsed. */
function paymentInfoFromJson(fields: Record<string, string>): LifecyclePaymentInfo {
  const text = JSON.stringify(PI).replace(/\}$/, '');
  const extra = Object.entries(fields)
    .map(([k, digits]) => `,${JSON.stringify(k)}:${digits}`)
    .join('');
  // Later keys win in JSON.parse, so these replace the vector's values.
  return JSON.parse(`${text}${extra}}`) as LifecyclePaymentInfo;
}

/** A signer that records whether it was ever asked. */
function spySigner(): LifecycleSigner & { calls: string[] } {
  const wallet = new ethers.Wallet(vectors.privateKey);
  const calls: string[] = [];
  return {
    calls,
    getAddress: () => wallet.address,
    async signTypedData(typedData: string) {
      calls.push(typedData);
      const { domain, types, message } = JSON.parse(typedData);
      return { signature: await wallet.signTypedData(domain, types, message) };
    },
  };
}

function digestOf(doc: LifecycleTypedData): string {
  return ethers.TypedDataEncoder.hash(doc.domain, doc.types, doc.message);
}

function caught(fn: () => unknown): X402Error {
  try {
    fn();
  } catch (error) {
    return error as X402Error;
  }
  throw new Error('expected a throw');
}

async function rejected(promise: Promise<unknown>): Promise<X402Error> {
  try {
    await promise;
  } catch (error) {
    return error as X402Error;
  }
  throw new Error('expected a rejection');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('the premise: JSON.parse rounds a 32-byte salt, and BigInt keeps the rounding', () => {
  expect(Number.isSafeInteger(REAL_SALT_PARSED)).toBe(false);
  expect(BigInt(REAL_SALT_PARSED)).not.toBe(REAL_SALT);
  // Still past 2**53 - 1 after rounding: that is what makes it detectable.
  expect(Math.abs(REAL_SALT_PARSED)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
});

// ============================================================================
// 1 · toUint and the typed-data walk
// ============================================================================

describe('toUint', () => {
  it.each<[string, unknown, bigint]>([
    ['zero', 0, 0n],
    ['2**53 - 1 as a number', Number.MAX_SAFE_INTEGER, 9007199254740991n],
    ['a bigint of any width', REAL_SALT, REAL_SALT],
    ['decimal digits of any width', REAL_SALT_DIGITS, REAL_SALT],
    ['0x-hex', REAL_SALT_HEX, REAL_SALT],
    ['0X-hex', `0X${'AB'.repeat(32)}`, REAL_SALT],
    ['negative zero', -0, 0n],
  ])('accepts %s', (_label, value, expected) => {
    expect(toUint(value, 'v')).toBe(expected);
  });

  it.each<[string, unknown, RegExp]>([
    ['2**53 as a number', 2 ** 53, /MAX_SAFE_INTEGER/],
    ['the salt after JSON.parse', REAL_SALT_PARSED, /MAX_SAFE_INTEGER/],
    ['1e21', 1e21, /MAX_SAFE_INTEGER/],
    ['a fraction', 1.5, /non-negative integer/],
    ['a negative number', -1, /non-negative integer/],
    ['a negative number past 2**53', -(2 ** 60), /non-negative integer/],
    ['NaN', Number.NaN, /non-negative integer/],
    ['Infinity', Number.POSITIVE_INFINITY, /non-negative integer/],
    ['a negative bigint', -1n, /non-negative integer/],
    ['an empty string (BigInt reads it as 0)', '', /non-negative integer/],
    ['spaces (BigInt trims them)', ' 5', /non-negative integer/],
    ['a sign', '-5', /non-negative integer/],
    ['an exponent', '1e6', /non-negative integer/],
    ['a decimal point', '1.0', /non-negative integer/],
    ['bare 0x', '0x', /non-negative integer/],
    ['octal', '0o7', /non-negative integer/],
    ['binary', '0b1', /non-negative integer/],
    ['a plus sign', '+5', /non-negative integer/],
    ['a digit separator', '1_000', /non-negative integer/],
    ['fullwidth digits', '\uFF11\uFF12', /non-negative integer/],
    ['Arabic-Indic digits', '\u0661\u0662', /non-negative integer/],
    ['null', null, /non-negative integer/],
    ['undefined', undefined, /non-negative integer/],
    ['a boolean', true, /non-negative integer/],
  ])('refuses %s', (_label, value, message) => {
    const error = caught(() => toUint(value, 'the field', 'INVALID_AMOUNT'));
    expect(error).toBeInstanceOf(X402Error);
    expect(error.code).toBe('INVALID_AMOUNT');
    expect(error.message).toMatch(/^the field /);
    expect(error.message).toMatch(message);
  });
});

describe('assertTypedDataIntegersExact', () => {
  const types = {
    Order: [
      { name: 'amount', type: 'uint256' },
      { name: 'delta', type: 'int256' },
      { name: 'items', type: 'Item[]' },
      { name: 'note', type: 'string' },
    ],
    Item: [{ name: 'salt', type: 'uint256' }],
  };
  const base = { amount: '1', delta: '-1', items: [{ salt: '1' }], note: 'x' };
  const doc = (message: Record<string, unknown>, domain: Record<string, unknown> = { chainId: 1 }) => ({
    domain,
    types,
    primaryType: 'Order',
    message,
  });

  it('passes a document whose integers are strings or safe numbers', () => {
    expect(() => assertTypedDataIntegersExact(doc(base))).not.toThrow();
    expect(() => assertTypedDataIntegersExact(doc({ ...base, amount: 2 ** 53 - 1 }))).not.toThrow();
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown> | undefined, string]>([
    ['a uint field', { ...base, amount: REAL_SALT_PARSED }, undefined, 'typed data message.amount'],
    ['an int field, negative', { ...base, delta: -(2 ** 60) }, undefined, 'typed data message.delta'],
    ['a struct inside an array', { ...base, items: [{ salt: '1' }, { salt: REAL_SALT_PARSED }] }, undefined, 'typed data message.items[1].salt'],
    ['a fraction in a uint field', { ...base, amount: 0.5 }, undefined, 'typed data message.amount'],
    ['domain.chainId', base, { chainId: 2 ** 60 }, 'typed data domain.chainId'],
  ])('refuses %s, naming its path', (_label, message, domain, path) => {
    const error = caught(() => assertTypedDataIntegersExact(doc(message, domain)));
    expect(error).toBeInstanceOf(X402Error);
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message.startsWith(path)).toBe(true);
  });

  it('walks the root struct ethers signs, even when primaryType names an inner one', () => {
    const nested = {
      Order: [{ name: 'amount', type: 'uint256' }, { name: 'inner', type: 'Inner' }],
      Inner: [{ name: 'v', type: 'uint256' }],
    };
    const error = caught(() =>
      assertTypedDataIntegersExact({
        domain: {},
        types: nested,
        primaryType: 'Inner',
        message: { amount: 2 ** 60, inner: { v: '1' } },
      })
    );
    expect(error.message.startsWith('typed data message.amount')).toBe(true);
  });

  it('walks primaryType too when it names a struct inside the root (viem and wagmi sign that one)', () => {
    const wrapped = {
      Wrap: [{ name: 'inner', type: 'Inner' }],
      Inner: [{ name: 'v', type: 'uint256' }],
    };
    const error = caught(() =>
      assertTypedDataIntegersExact({
        domain: {},
        types: wrapped,
        primaryType: 'Inner',
        message: { v: REAL_SALT_PARSED },
      })
    );
    expect(error.message.startsWith('typed data message.v is the JSON number')).toBe(true);
  });

  it('leaves alone a number in a field the types do not declare (it is not hashed)', () => {
    expect(() => assertTypedDataIntegersExact(doc({ ...base, extra: REAL_SALT_PARSED }))).not.toThrow();
  });

  it('when the types cannot be read, refuses any inexact number in the message', () => {
    const error = caught(() =>
      assertTypedDataIntegersExact({ domain: {}, types: {}, message: { a: { b: [1, 2 ** 60] } } })
    );
    expect(error.message.startsWith('typed data message.a.b[1]')).toBe(true);
  });

  it('parseTypedDataJson refuses the text a number-writing producer emits', () => {
    const text = JSON.stringify(doc(base)).replace('"amount":"1"', `"amount":${REAL_SALT_DIGITS}`);
    expect(() => parseTypedDataJson(text)).toThrow(/typed data message\.amount .*MAX_SAFE_INTEGER/);
    expect(parseTypedDataJson(JSON.stringify(doc(base)))).toEqual(doc(base));
  });

  it('findInexactNumber walks arrays and objects', () => {
    expect(findInexactNumber({ a: [1, { b: 2 ** 53 }] }, 'x')).toEqual({ path: 'x.a[1].b', value: 2 ** 53 });
    expect(findInexactNumber({ a: [1, { b: '9007199254740993' }] }, 'x')).toBeNull();
  });

  it('an object that contains itself is walked without recursing for ever', () => {
    const loop: Record<string, unknown> = { n: 1 };
    loop.self = loop;
    expect(findInexactNumber(loop, 'x')).toBeNull();
    expect(findInexactNumber({ loop, late: 2 ** 60 }, 'x')).toEqual({ path: 'x.late', value: 2 ** 60 });

    // Types that contain themselves: ethers refuses them, the walk falls back to primaryType.
    const types = { Node: [{ name: 'next', type: 'Node' }, { name: 'v', type: 'uint256' }] };
    const ok: Record<string, unknown> = { v: 1 };
    ok.next = ok;
    expect(() => assertTypedDataIntegersExact({ types, primaryType: 'Node', message: ok })).not.toThrow();
    const bad: Record<string, unknown> = { v: 2 ** 60 };
    bad.next = bad;
    expect(() => assertTypedDataIntegersExact({ types, primaryType: 'Node', message: bad })).toThrow(
      /^typed data message\.v is the JSON number/
    );
  });

  it('a type named like an Object.prototype key is read, never written, and hides nothing', () => {
    const types = {
      Root: [
        { name: 'a', type: '__proto__' },
        { name: 'b', type: 'constructor' },
        { name: 'c', type: 'uint256' },
      ],
    };
    const message = { a: 2 ** 60, b: 2 ** 60, c: 1 };
    expect(() => assertTypedDataIntegersExact({ types, primaryType: 'Root', message })).not.toThrow();
    expect(() =>
      assertTypedDataIntegersExact({ types, primaryType: 'Root', message: { ...message, c: 2 ** 60 } })
    ).toThrow(/^typed data message\.c is the JSON number/);
    expect(Object.prototype).not.toHaveProperty('a');
  });

  it('one object under two fields of different types is checked under each', () => {
    const shared = { n: 2 ** 60 };
    const types = {
      Root: [{ name: 'a', type: 'Label' }, { name: 'b', type: 'Amount' }],
      Label: [{ name: 'n', type: 'string' }],
      Amount: [{ name: 'n', type: 'uint256' }],
    };
    expect(() =>
      assertTypedDataIntegersExact({ types, primaryType: 'Root', message: { a: shared, b: shared } })
    ).toThrow(/^typed data message\.b\.n is the JSON number/);
  });
});

// ============================================================================
// 2 · The lifecycle order (release / refundInEscrow)
// ============================================================================

describe('the lifecycle order with a real 32-byte salt', () => {
  it('as the wire hex string: the digest and the signature the Python SDK computes', async () => {
    const doc = buildLifecycleTypedData({ ...ORDER, paymentInfo: { ...PI, salt: REAL_SALT_HEX } });
    expect(doc.message.paymentInfo).toMatchObject({ salt: REAL_SALT_DIGITS });
    expect(digestOf(doc)).toBe(PY_REAL_SALT_DIGEST);

    const auth = await buildLifecycleAuth({
      ...ORDER,
      paymentInfo: { ...PI, salt: REAL_SALT_HEX },
      wallet: spySigner(),
    });
    expect(auth.signature).toBe(PY_REAL_SALT_SIGNATURE);
  });

  it('as a bigint: the same digest', () => {
    const doc = buildLifecycleTypedData({ ...ORDER, paymentInfo: { ...PI, salt: REAL_SALT } });
    expect(digestOf(doc)).toBe(PY_REAL_SALT_DIGEST);
  });

  it('the document it emits survives JSON: every uint is a string', () => {
    const doc = buildLifecycleTypedData({ ...ORDER, paymentInfo: { ...PI, salt: REAL_SALT_HEX } });
    const shipped = JSON.parse(JSON.stringify(doc)) as LifecycleTypedData;
    expect(digestOf(shipped)).toBe(PY_REAL_SALT_DIGEST);
    expect(findInexactNumber(shipped, 'doc')).toBeNull();
  });

  it('as a JSON number: refused, naming the salt, and the wallet is never asked', async () => {
    const paymentInfo = paymentInfoFromJson({ salt: REAL_SALT_DIGITS });
    expect(paymentInfo.salt).toBe(REAL_SALT_PARSED);

    const wallet = spySigner();
    const error = await rejected(buildLifecycleAuth({ ...ORDER, paymentInfo, wallet }));
    expect(error).toBeInstanceOf(X402Error);
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message).toMatch(/^paymentInfo\.salt is the JSON number 7\.76\d*e\+76/);
    expect(error.message).toContain('Number.MAX_SAFE_INTEGER');
    expect(wallet.calls).toEqual([]);

    expect(() => buildLifecycleTypedData({ ...ORDER, paymentInfo })).toThrow(/paymentInfo\.salt/);
  });

  it('as a DECIMAL string: refused, because a salt string is read as hex (as the wire carries it)', () => {
    const error = caught(() =>
      buildLifecycleTypedData({ ...ORDER, paymentInfo: { ...PI, salt: REAL_SALT_DIGITS } })
    );
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message).toContain(`has ${REAL_SALT_DIGITS.length} hex digits and a bytes32 has 64`);
  });

  it('64 hex digits without 0x is still the bytes32 it always was', () => {
    const doc = buildLifecycleTypedData({ ...ORDER, paymentInfo: { ...PI, salt: 'ab'.repeat(32) } });
    expect(digestOf(doc)).toBe(PY_REAL_SALT_DIGEST);
  });

  it.each<[string, Record<string, string>, string]>([
    ['maxAmount', { maxAmount: '1000000000000000000001' }, 'paymentInfo.maxAmount'],
    ['refundExpiry', { refundExpiry: String(2n ** 60n + 1n) }, 'paymentInfo.refundExpiry'],
  ])('the other uints of paymentInfo: %s as a JSON number past 2**53 - 1', (_label, fields, field) => {
    const error = caught(() =>
      buildLifecycleTypedData({ ...ORDER, paymentInfo: paymentInfoFromJson(fields) })
    );
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message.startsWith(`${field} is the JSON number`)).toBe(true);
  });

  it('amount as a JSON number past 2**53 - 1 is INVALID_AMOUNT', () => {
    const amount = JSON.parse('1000000000000000000001') as number;
    const error = caught(() => buildLifecycleTypedData({ ...ORDER, paymentInfo: PI, amount }));
    expect(error.code).toBe('INVALID_AMOUNT');
    expect(error.message.startsWith('amount is the JSON number 1e+21')).toBe(true);
  });

  it('a deadline past 2**53 - 1 is refused', () => {
    const error = caught(() =>
      buildLifecycleTypedData({ ...ORDER, paymentInfo: PI, deadline: 2 ** 60 })
    );
    expect(error.message.startsWith('deadline is the JSON number')).toBe(true);
  });

  it('a chainId past 2**53 - 1 is refused (the domain is part of the digest)', () => {
    const error = caught(() =>
      buildLifecycleTypedData({ ...ORDER, paymentInfo: PI, chainId: 2 ** 60 })
    );
    expect(error.message.startsWith('lifecycle order domain.chainId is the JSON number')).toBe(true);
  });

  it('a safe number is still accepted where it always was: 2**53 - 1 as maxAmount', () => {
    const doc = buildLifecycleTypedData({
      ...ORDER,
      paymentInfo: { ...PI, maxAmount: Number.MAX_SAFE_INTEGER },
    });
    expect(doc.message.paymentInfo).toMatchObject({ maxAmount: '9007199254740991' });
  });

  it('an empty amount is refused, where BigInt("") used to sign it as 0', () => {
    const error = caught(() => buildLifecycleTypedData({ ...ORDER, paymentInfo: PI, amount: '' }));
    expect(error.code).toBe('INVALID_AMOUNT');
  });
});

describe('the lifecycle order in the browser (split flow and wagmi)', () => {
  /** The document as a backend that writes uints as numbers would ship it. */
  function shippedWithNumberSalt(): { text: string; doc: LifecycleTypedData } {
    const doc = buildLifecycleTypedData({ ...ORDER, paymentInfo: { ...PI, salt: REAL_SALT_HEX } });
    const text = JSON.stringify(doc).replace(`"salt":"${REAL_SALT_DIGITS}"`, `"salt":${REAL_SALT_DIGITS}`);
    expect(text).toContain(`"salt":${REAL_SALT_DIGITS}`);
    return { text, doc: JSON.parse(text) as LifecycleTypedData };
  }

  it('wagmiLifecycleSigner refuses the text, and the wallet client is never called', async () => {
    const signTypedData = vi.fn(async () => `0x${'11'.repeat(65)}`);
    const signer = wagmiLifecycleSigner({ account: { address: vectors.payer }, signTypedData });
    const error = await rejected(signer.signTypedData(shippedWithNumberSalt().text));
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message.startsWith('typed data message.paymentInfo.salt is the JSON number')).toBe(true);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('wagmiLifecycleSigner refuses it with primaryType PaymentInfo too, the struct viem would sign', async () => {
    const signTypedData = vi.fn(async () => `0x${'11'.repeat(65)}`);
    const signer = wagmiLifecycleSigner({ account: { address: vectors.payer }, signTypedData });
    const { doc } = shippedWithNumberSalt();
    const text = JSON.stringify({ ...doc, primaryType: 'PaymentInfo', message: { ...PI, salt: 0 } }).replace(
      '"salt":0',
      `"salt":${REAL_SALT_DIGITS}`
    );
    const error = await rejected(signer.signTypedData(text));
    expect(error.message.startsWith('typed data message.salt is the JSON number')).toBe(true);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('wagmiLifecycleSigner hands the wallet client the document with the salt intact', async () => {
    const signTypedData = vi.fn(async () => `0x${'11'.repeat(65)}`);
    const signer = wagmiLifecycleSigner({ account: { address: vectors.payer }, signTypedData });
    const doc = buildLifecycleTypedData({ ...ORDER, paymentInfo: { ...PI, salt: REAL_SALT_HEX } });
    await signer.signTypedData(JSON.stringify(doc));
    expect(signTypedData).toHaveBeenCalledOnce();
    expect(signTypedData.mock.calls[0][0]).toMatchObject({ message: { paymentInfo: { salt: REAL_SALT_DIGITS } } });
  });

  it('lifecycleAuthFromSignature refuses a document whose salt crossed JSON as a number', () => {
    const error = caught(() =>
      lifecycleAuthFromSignature(shippedWithNumberSalt().doc, PY_REAL_SALT_SIGNATURE, vectors.payer)
    );
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message.startsWith('typedData message.paymentInfo.salt is the JSON number')).toBe(true);
  });

  it('lifecycleAuthFromSignature takes the same document with the salt as a string', () => {
    const doc = buildLifecycleTypedData({ ...ORDER, paymentInfo: { ...PI, salt: REAL_SALT_HEX } });
    const auth = lifecycleAuthFromSignature(JSON.parse(JSON.stringify(doc)), PY_REAL_SALT_SIGNATURE, vectors.payer);
    expect(auth.signature).toBe(PY_REAL_SALT_SIGNATURE);
  });
});

// ============================================================================
// 3 · EnvKeyAdapter.signTypedData: the SDK's own JSON boundary
// ============================================================================

describe('EnvKeyAdapter.signTypedData', () => {
  const adapter = new EnvKeyAdapter(vectors.privateKey);

  it('signs the document with the salt as a string: the Python signature', async () => {
    const doc = buildLifecycleTypedData({ ...ORDER, paymentInfo: { ...PI, salt: REAL_SALT_HEX } });
    expect((await adapter.signTypedData(JSON.stringify(doc))).signature).toBe(PY_REAL_SALT_SIGNATURE);
  });

  it('refuses it with the salt as a JSON number, with an error that names the salt', async () => {
    const doc = buildLifecycleTypedData({ ...ORDER, paymentInfo: { ...PI, salt: REAL_SALT_HEX } });
    const text = JSON.stringify(doc).replace(`"salt":"${REAL_SALT_DIGITS}"`, `"salt":${REAL_SALT_DIGITS}`);
    const error = await rejected(adapter.signTypedData(text));
    expect(error).toBeInstanceOf(X402Error);
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message.startsWith('typed data message.paymentInfo.salt is the JSON number')).toBe(true);
  });
});

// ============================================================================
// 4 · Escrow pre-auth (the lock) and its nonce
// ============================================================================

describe('escrow pre-auth', () => {
  const COLLECTOR = '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6';
  const CONFIG: EscrowNetworkConfig = {
    chain_id: 8453,
    operator: vectors.paymentInfo.operator,
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    token_collector: COLLECTOR,
    usdc: vectors.paymentInfo.token,
    usdc_domain_name: 'USD Coin',
    usdc_domain_version: '2',
    payment_info_typehash: `0x${'5a'.repeat(32)}`,
  };
  const PRE_PI: EscrowPaymentInfo = {
    operator: PI.operator,
    receiver: PI.receiver,
    token: PI.token,
    maxAmount: '1000000',
    preApprovalExpiry: 1757003600,
    authorizationExpiry: 1757007200,
    refundExpiry: 1759592000,
    minFeeBps: 0,
    maxFeeBps: 1300,
    feeReceiver: PI.feeReceiver,
    salt: REAL_SALT_HEX,
  };
  const nonceOf = (pi: unknown) =>
    computeEscrowNonce(CONFIG.chain_id, CONFIG.escrow, CONFIG.payment_info_typehash, pi as EscrowPaymentInfo);

  it.each<[string, unknown]>([
    ['a bigint', REAL_SALT],
    ['a safe number', 12345],
  ])('computeEscrowNonce refuses a salt given as %s: the wire carries bytes32 hex', (_label, salt) => {
    // The Python twin reads str(salt) as hex: 12345 would hash as 0x12345 there.
    const error = caught(() => nonceOf({ ...PRE_PI, salt }));
    expect(error).toBeInstanceOf(X402Error);
    expect(error.message.startsWith('paymentInfo.salt must be the bytes32 hex string the escrow wire carries')).toBe(true);
  });

  it('computeEscrowNonce refuses the salt as a JSON number instead of throwing a TypeError', () => {
    const error = caught(() => nonceOf({ ...PRE_PI, salt: REAL_SALT_PARSED }));
    expect(error).toBeInstanceOf(X402Error);
    expect(error.message.startsWith('paymentInfo.salt is the JSON number')).toBe(true);
  });

  it('computeEscrowNonce refuses maxAmount as a JSON number past 2**53 - 1 instead of hashing it rounded', () => {
    const maxAmount = JSON.parse('1000000000000000000001') as number;
    const error = caught(() => nonceOf({ ...PRE_PI, maxAmount }));
    expect(error.message.startsWith('paymentInfo.maxAmount is the JSON number 1e+21')).toBe(true);
  });

  it('buildEscrowPreAuth refuses a bountyAtomic past 2**53 - 1 by name, and signs nothing', async () => {
    const signTypedData = vi.fn(async () => ({ signature: `0x${'11'.repeat(65)}` }));
    const error = await rejected(
      buildEscrowPreAuth(
        { signTypedData },
        {
          networkConfig: CONFIG,
          payerWallet: vectors.payer,
          workerWallet: PI.receiver,
          bountyAtomic: JSON.parse('1000000000000000000001') as number as unknown as string,
          depositLimitUsd: 1e18,
        }
      )
    );
    expect(error.code).toBe('INVALID_AMOUNT');
    expect(error.message.startsWith('bountyAtomic is the JSON number 1e+21')).toBe(true);
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 5 · Typed data the facilitator sends (ERC-8004 relayed feedback, v4)
// ============================================================================

describe('relayed feedback: the v4 typedData from the facilitator', () => {
  function prepareBody(agentId: string): string {
    return (
      '{"success":true,"delegated":true,"chainId":8453,"network":"base","typedData":{' +
      '"primaryType":"RelayedGiveFeedback","domain":{"name":"FeedbackDelegate","version":"1","chainId":8453},' +
      '"types":{"RelayedGiveFeedback":[{"name":"agentId","type":"uint256"},{"name":"deadline","type":"uint256"}]},' +
      `"message":{"agentId":${agentId},"deadline":1757000600}}}`
    );
  }
  function answer(body: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
    );
  }
  const feedback = {
    x402Version: 1 as const,
    network: 'base' as const,
    feedback: { agentId: 1, value: 1, rater: '0x0000000000000000000000000000000000000001' },
  };
  const response = {
    x402Version: 1 as const,
    network: 'base' as const,
    responder: '0x0000000000000000000000000000000000000001',
    agentId: 1,
    clientAddress: '0x0000000000000000000000000000000000000002',
    feedbackIndex: 1,
    responseUri: 'https://example.com/r',
  };

  it.each([
    ['prepareRelayedFeedback', (c: Erc8004Client) => c.prepareRelayedFeedback(feedback)],
    ['prepareRelayedResponse', (c: Erc8004Client) => c.prepareRelayedResponse(response)],
  ] as const)('%s: a uint past 2**53 - 1 comes back as a failure, without the document', async (_name, call) => {
    answer(prepareBody(REAL_SALT_DIGITS));
    const prep = await call(new Erc8004Client());
    expect(prep.success).toBe(false);
    expect(prep.typedData).toBeUndefined();
    expect(prep.error).toMatch(/^typedData message\.agentId is the JSON number .*MAX_SAFE_INTEGER/);
  });

  it.each([
    ['prepareRelayedFeedback', (c: Erc8004Client) => c.prepareRelayedFeedback(feedback)],
    ['prepareRelayedResponse', (c: Erc8004Client) => c.prepareRelayedResponse(response)],
  ] as const)('%s: safe numbers and strings pass through untouched', async (_name, call) => {
    answer(prepareBody('"2106"'));
    const prep = await call(new Erc8004Client());
    expect(prep.success).toBe(true);
    expect(prep.typedData).toEqual(JSON.parse(prepareBody('"2106"')).typedData);
  });
});

// ============================================================================
// 6 · The buyer: a 402 price written as a JSON number
// ============================================================================

describe('X402Client.fetch: a price past 2**53 - 1', () => {
  const PAY_TO = '0x000000000000000000000000000000000000dEaD';
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const offer = (amount: string) =>
    `{"scheme":"exact","network":"eip155:8453","amount":${amount},"payTo":"${PAY_TO}","asset":"${USDC}"}`;
  const challenge = (...offers: string[]) =>
    new Response(`{"x402Version":2,"accepts":[${offers.join(',')}]}`, {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });

  async function run(first: Response) {
    const calls: RequestInit[] = [];
    const responses = [first, new Response('{"ok":true}', { status: 200 })];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return responses.shift()!;
    }) as unknown as typeof globalThis.fetch;
    const client = new X402Client({ defaultChain: 'base' });
    // The pinned vectors' key: public, a fixture on purpose.
    await client.connectWithPrivateKey(vectors.privateKey, 'base');
    return { calls, result: client.fetch('https://api.example.com/data', { fetchImpl }) };
  }

  it('the only offer: refused, saying why, and nothing is signed', async () => {
    const { calls, result } = await run(challenge(offer('1000000000000000000001')));
    const error = await rejected(result);
    expect(error.code).toBe('POLICY_REFUSED');
    expect(error.message).toContain("the exact offer's amount is the JSON number 1e+21");
    expect(error.message).toContain('MAX_SAFE_INTEGER');
    expect(calls).toHaveLength(1);
  });

  it('2**60 + 1, which JSON rounds to an integer with no exponent, is refused the same way', async () => {
    const { calls, result } = await run(challenge(offer('1152921504606846977')));
    const error = await rejected(result);
    expect(error.code).toBe('POLICY_REFUSED');
    expect(error.message).toContain("the exact offer's amount is the JSON number 1152921504606847000");
    expect(calls).toHaveLength(1);
  });

  it('beside a readable offer: that one is paid, at its exact price', async () => {
    const { calls, result } = await run(challenge(offer('1000000000000000000001'), offer('"20000"')));
    await result;
    expect(calls).toHaveLength(2);
    const header = (calls[1].headers as Record<string, string>)['X-PAYMENT'];
    const paid = JSON.parse(decodeBase64Utf8(header));
    expect(paid.payload.authorization.value).toBe('20000');
  });
});

// ============================================================================
// 7 · EVMProvider.encodePaymentHeader: a payload that crossed JSON
// ============================================================================

describe('EVMProvider.encodePaymentHeader', () => {
  const provider = new EVMProvider();
  const chain = getChainByName('base')!;
  const SIGNED = {
    from: '0x7052cA449702e5ffafbE3dc63b74C7b7d8aF402B',
    to: '0xe4dc963c56979E0260fc146b87eE24F18220e545',
    value: '1000000',
    validAfter: 0,
    validBefore: 1799999999,
    nonce: `0x${'ab'.repeat(32)}`,
    v: 27,
    r: `0x${'11'.repeat(32)}`,
    s: `0x${'22'.repeat(32)}`,
  };

  it('refuses a value past 2**53 - 1 written as a JSON number', () => {
    const text = JSON.stringify(SIGNED).replace('"value":"1000000"', '"value":1000000000000000000001');
    const error = caught(() => provider.encodePaymentHeader(text, chain));
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message.startsWith('paymentPayload.value is the JSON number 1e+21')).toBe(true);
  });

  it('refuses 2**60 + 1, which JSON rounds to an integer with no exponent', () => {
    const text = JSON.stringify(SIGNED).replace('"value":"1000000"', '"value":1152921504606846977');
    const error = caught(() => provider.encodePaymentHeader(text, chain));
    expect(error.message.startsWith('paymentPayload.value is the JSON number 1152921504606847000')).toBe(true);
  });

  it('writes a value given as a safe number as a string, the wire type', () => {
    const header = provider.encodePaymentHeader(JSON.stringify({ ...SIGNED, value: 1000000 }), chain);
    expect(JSON.parse(decodeBase64Utf8(header)).payload.authorization.value).toBe('1000000');
  });

  it('leaves a string value as it came, and never writes a missing one as "undefined"', () => {
    const decode = (h: string) => JSON.parse(decodeBase64Utf8(h)).payload.authorization;
    expect(decode(provider.encodePaymentHeader(JSON.stringify(SIGNED), chain)).value).toBe('1000000');
    const { value: _value, ...withoutValue } = SIGNED;
    expect(decode(provider.encodePaymentHeader(JSON.stringify(withoutValue), chain))).not.toHaveProperty('value');
  });
});

// ============================================================================
// 8 · Stellar and Sui encodePaymentHeader: the payload goes out as it came
// ============================================================================

describe('StellarProvider and SuiProvider.encodePaymentHeader', () => {
  const STELLAR = {
    from: `G${'A'.repeat(55)}`,
    to: `G${'B'.repeat(55)}`,
    amount: '1000000',
    tokenContract: `C${'C'.repeat(55)}`,
    authorizationEntryXdr: 'AAAA',
    nonce: 42,
    signatureExpirationLedger: 123456,
  };
  const SUI = {
    transactionBytes: 'AAAA',
    senderSignature: 'AAAA',
    from: `0x${'1'.repeat(64)}`,
    to: `0x${'2'.repeat(64)}`,
    amount: '1000000',
    coinObjectId: `0x${'3'.repeat(64)}`,
  };

  it('Stellar refuses a nonce past 2**53 - 1 (an i64 written as a JSON number)', () => {
    const text = JSON.stringify(STELLAR).replace('"nonce":42', '"nonce":9223372036854775807');
    const error = caught(() => new StellarProvider().encodePaymentHeader(text));
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message.startsWith('paymentPayload.nonce is the JSON number 9223372036854776000')).toBe(true);
  });

  it('Stellar passes the safe integers through as they came', () => {
    const header = new StellarProvider().encodePaymentHeader(JSON.stringify(STELLAR));
    expect(JSON.parse(decodeBase64Utf8(header)).payload).toMatchObject({
      amount: '1000000',
      nonce: 42,
      signatureExpirationLedger: 123456,
    });
  });

  it('Sui refuses an amount past 2**53 - 1 written as a JSON number', () => {
    const text = JSON.stringify(SUI).replace('"amount":"1000000"', '"amount":1152921504606846977');
    const error = caught(() => new SuiProvider().encodePaymentHeader(text));
    expect(error.message.startsWith('paymentPayload.amount is the JSON number 1152921504606847000')).toBe(true);
  });

  it('Sui passes the payload through as it came', () => {
    const header = new SuiProvider().encodePaymentHeader(JSON.stringify(SUI));
    expect(JSON.parse(decodeBase64Utf8(header)).payload).toEqual(SUI);
  });
});
