/**
 * uvd-x402-sdk - Integers that crossed JSON
 *
 * An EIP-712 uint written as a JSON NUMBER hashes the same where it was
 * written and is destroyed where it is read: `JSON.parse` turns every integer
 * above `Number.MAX_SAFE_INTEGER` (2**53 - 1) into the nearest double. A
 * 32-byte `salt` such as `0xab…ab` comes out as 7.76e+76, `BigInt()` of that
 * is a different integer, and the struct signed from it is not the one that
 * was sent: the facilitator answers `bad_signature` and neither end can say
 * why. The pinned lifecycle vector's salt (12345) fits in a double and shows
 * nothing; `release/real-salt` in `scripts/xlang/cross-language-conformance.mjs`
 * is the case that does.
 *
 * The rounding cannot be undone, but it can be seen: an integer above
 * 2**53 - 1 is still above it after rounding. So every integer this SDK reads
 * for a signature or a hash goes through here, and a number that is not a safe
 * integer is refused with an error that names the field. Strings (decimal or
 * 0x-hex) and bigints carry any width exactly and are accepted.
 */

import { ethers } from 'ethers';

import { X402Error, type X402ErrorCode } from '../types';

/** Decimal digits, or 0x-hex. No sign, no spaces, no exponent, never empty. */
const UINT_STRING = /^(?:[0-9]+|0[xX][0-9a-fA-F]+)$/;

/** An EIP-712 integer type: `uint256`, `int128`, `uint` ... */
const INTEGER_TYPE = /^u?int\d*$/;

function shown(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The refusal for an integer JSON could not have carried exactly. */
export function inexactNumberMessage(field: string, value: number): string {
  return (
    `${field} is the JSON number ${String(value)}, larger in magnitude than ` +
    'Number.MAX_SAFE_INTEGER (2**53 - 1): JSON.parse has already rounded it, and signing it ' +
    'would sign a different integer than the one that was written. Send uints as decimal or ' +
    '0x-hex strings (or a bigint)'
  );
}

/** A number found where an integer is read: rounded on its way in, or not an integer at all. */
function numberRefusal(path: string, value: number, code: X402ErrorCode): X402Error {
  return new X402Error(
    Number.isInteger(value)
      ? inexactNumberMessage(path, value)
      : `${path} must be an integer, got the JSON number ${String(value)}`,
    code
  );
}

/**
 * An unsigned integer read for a signature or a hash, exactly.
 *
 * Accepts a bigint `>= 0`, a number that is a safe integer `>= 0`, and a
 * string of decimal digits or 0x-hex. Refuses, with `code`, a number above
 * 2**53 - 1 (it was rounded on its way in), a negative, a fraction, and any
 * other string: empty, signed, with spaces or an exponent. `BigInt('')` is
 * `0n`: an empty lifecycle `amount` used to be signed as zero.
 *
 * @param field - Named in the error, e.g. `'paymentInfo.maxAmount'`.
 */
export function toUint(
  value: unknown,
  field: string,
  code: X402ErrorCode = 'INVALID_CONFIG'
): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new X402Error(`${field} must be a non-negative integer, got ${shown(value)}`, code);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (Number.isInteger(value) && value > 0) {
      throw new X402Error(inexactNumberMessage(field, value), code);
    }
    throw new X402Error(`${field} must be a non-negative integer, got ${shown(value)}`, code);
  }
  if (typeof value === 'string' && UINT_STRING.test(value)) return BigInt(value);
  throw new X402Error(
    `${field} must be a non-negative integer (decimal or 0x-hex string, bigint, or a number ` +
      `up to 2**53 - 1), got ${shown(value)}`,
    code
  );
}

/**
 * The first number under `value` that is not a safe integer, with its path.
 * Depth first, arrays and plain objects only; `null` when there is none.
 */
export function findInexactNumber(
  value: unknown,
  path: string,
  seen: Set<object> = new Set()
): { path: string; value: number } | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? null : { path, value };
  }
  // Untyped, an object holds the same numbers wherever it is reached, so once
  // is enough, and an object that contains itself (built in code, never
  // parsed) does not recurse for ever.
  if (typeof value !== 'object' || value === null || seen.has(value)) return null;
  seen.add(value);
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((item, i): [string, unknown] => [`${path}[${i}]`, item])
    : Object.entries(value).map(([key, item]): [string, unknown] => [`${path}.${key}`, item]);
  for (const [itemPath, item] of entries) {
    const hit = findInexactNumber(item, itemPath, seen);
    if (hit) return hit;
  }
  return null;
}

/**
 * Refuse `value` if any number under it is not a safe integer: for JSON whose
 * every number is an integer read for a signature (an ERC-3009 payload).
 */
export function assertNoInexactNumber(
  value: unknown,
  path: string,
  code: X402ErrorCode = 'INVALID_CONFIG'
): void {
  const hit = findInexactNumber(value, path);
  if (hit) throw numberRefusal(hit.path, hit.value, code);
}

/** The root struct ethers signs for `types`, or `primaryType` when ethers cannot say. */
function rootStruct(structs: Record<string, unknown>, primaryType: unknown): string | null {
  try {
    return ethers.TypedDataEncoder.from(
      structs as Record<string, Array<{ name: string; type: string }>>
    ).primaryType;
  } catch {
    return typeof primaryType === 'string' && Array.isArray(structs[primaryType])
      ? primaryType
      : null;
  }
}

function checkTyped(
  type: string,
  value: unknown,
  path: string,
  structs: Record<string, unknown>,
  code: X402ErrorCode,
  ancestors: Set<object> = new Set()
): void {
  // A value that contains itself, under types that do (ethers refuses those,
  // so it falls back to `primaryType`), would recurse for ever.
  if (typeof value === 'object' && value !== null) {
    if (ancestors.has(value)) return;
    ancestors.add(value);
  }
  try {
    const array = /^(.*)\[(\d*)\]$/.exec(type);
    if (array) {
      if (Array.isArray(value)) {
        value.forEach((item, i) =>
          checkTyped(array[1], item, `${path}[${i}]`, structs, code, ancestors)
        );
      }
      return;
    }
    const struct = structs[type];
    if (Array.isArray(struct)) {
      if (!isRecord(value)) return;
      for (const field of struct as Array<{ name?: unknown; type?: unknown }>) {
        if (typeof field?.name === 'string' && typeof field.type === 'string') {
          checkTyped(
            field.type,
            value[field.name],
            `${path}.${field.name}`,
            structs,
            code,
            ancestors
          );
        }
      }
      return;
    }
    if (INTEGER_TYPE.test(type) && typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw numberRefusal(path, value, code);
    }
  } finally {
    if (typeof value === 'object' && value !== null) ancestors.delete(value);
  }
}

/**
 * Refuse an EIP-712 document whose integers JSON could not have carried: every
 * `uintN` / `intN` field of `message` by its declared type (nested structs and
 * arrays included), and `domain.chainId`. `message` is walked as the root
 * struct ethers signs for these `types` and, when it names another struct, as
 * `primaryType` too: viem, wagmi and `eth_signTypedData_v4` sign that one.
 * When the types cannot be read at all, any number in `message` that is not a
 * safe integer is refused.
 *
 * Shape errors (no `types`, a field missing) are left to the signer: this
 * only answers whether an integer was rounded on its way in.
 *
 * @param where - Prefix of the field path in the error, e.g. `'typed data'`.
 */
export function assertTypedDataIntegersExact(
  doc: unknown,
  where = 'typed data',
  code: X402ErrorCode = 'INVALID_CONFIG'
): void {
  if (!isRecord(doc)) return;
  const { domain, types, message, primaryType } = doc;

  if (isRecord(domain) && typeof domain.chainId === 'number' && !Number.isSafeInteger(domain.chainId)) {
    throw numberRefusal(`${where} domain.chainId`, domain.chainId, code);
  }
  if (!isRecord(message)) return;

  const structs = isRecord(types) ? { ...types } : {};
  delete structs['EIP712Domain'];
  const root = rootStruct(structs, primaryType);
  if (root) {
    checkTyped(root, message, `${where} message`, structs, code);
    if (typeof primaryType === 'string' && primaryType !== root && Array.isArray(structs[primaryType])) {
      checkTyped(primaryType, message, `${where} message`, structs, code);
    }
    return;
  }
  assertNoInexactNumber(message, `${where} message`, code);
}

/**
 * `JSON.parse` of an EIP-712 document, refusing one whose integers did not
 * survive the parse ({@link assertTypedDataIntegersExact}).
 */
export function parseTypedDataJson(
  text: string,
  where = 'typed data',
  code: X402ErrorCode = 'INVALID_CONFIG'
): unknown {
  const doc: unknown = JSON.parse(text);
  assertTypedDataIntegersExact(doc, where, code);
  return doc;
}
