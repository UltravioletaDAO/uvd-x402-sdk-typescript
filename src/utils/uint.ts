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
 *
 * Where the SDK reads the JSON TEXT itself (a signer handed typed data as a
 * string), a 32-byte salt has nothing to undo: {@link parseJsonExact} reads an
 * integer of 22 to 78 digits as a bigint, digit for digit, as Python's `json`
 * does, and the document is signed with the integer that was written. One a
 * double may have been written as is refused as before: JavaScript writes a
 * rounded number in up to 21 plain digits, and other writers print a rounded
 * double in full, so those digits may not be the ones the producer meant.
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
 * Fewest digits of an integer literal read as a bigint. JavaScript writes a
 * number below 1e21 in plain digits, 21 at most, and from 1e21 up with an
 * exponent, so a literal of 22 digits or more never came out of
 * `JSON.stringify`. One of 21 digits or fewer may be a value a JavaScript hop
 * already rounded and wrote back in digits:
 * `JSON.stringify(JSON.parse('1234567890123456789'))` is `1234567890123456800`.
 * Such a literal stays the number `JSON.parse` reads, and an integer field
 * refuses it, as before.
 */
const MIN_EXACT_DIGITS = 22;

/**
 * The widest EIP-712 integer, 2**256 - 1, has 78 decimal digits. A longer
 * literal cannot be one, and `BigInt()` of a long run of digits costs time
 * that grows faster than its length, while `JSON.parse` reads it at once.
 */
const MAX_EXACT_DIGITS = 78;

/** A double's shortest decimal form has at most 17 significant digits. */
const MAX_DOUBLE_DIGITS = 17;

/**
 * Whether an integer literal may be a double written out in full: the exact
 * value of a double (`BigInt(n).toString()`, Python's `int(f)` and `'%.0f'`,
 * Java's `new BigDecimal(d)`), or at most 17 significant digits followed by
 * zeros (`n.toLocaleString()`, `Intl.NumberFormat`, Java's `toPlainString()`,
 * a 15-digit writer). Such a literal may be a value that was rounded to a
 * double before it was written, so it is not read as more exact than one. A
 * random 32-byte salt is neither, but with odds of about 1 in 10**60.
 */
function doubleShaped(literal: string): boolean {
  const significant = literal.replace(/^-/, '').replace(/0+$/, '');
  return significant.length <= MAX_DOUBLE_DIGITS || BigInt(literal) === BigInt(Number(literal));
}

/** A JSON number (RFC 8259): groups 1 and 2 are the fraction and the exponent. */
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;

/** The four characters JSON allows between tokens. */
const JSON_SPACE = /[ \t\n\r]*/y;

type Frame =
  | { kind: 'array'; items: unknown[] }
  | { kind: 'object'; object: Record<string, unknown>; key: string };

/**
 * A data descriptor with no prototype: `Object.defineProperty` reads `get`
 * and `set` through the prototype chain, and `JSON.parse` reads nothing a
 * polluted `Object.prototype` adds.
 */
function dataDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.writable = true;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  return descriptor;
}

/**
 * `JSON.parse(text)`, except that an integer literal of 22 to 78 digits, with
 * no fraction or exponent, that no double could have been written as comes
 * back as a bigint with the exact value written. Python's `json` reads those
 * digits exactly; `JSON.parse` turns a 32-byte salt (77 digits) into
 * 7.76e+76. 22 is where JavaScript stops writing plain digits
 * ({@link MIN_EXACT_DIGITS}), 78 the width of 2**256 - 1
 * ({@link MAX_EXACT_DIGITS}), and a literal a double may have been written as
 * is left out ({@link doubleShaped}). Any other literal is the number
 * `JSON.parse` reads: one of 21 digits or fewer, longer than 78, shaped like a
 * double, or with a fraction or an exponent (`7.76e+76`).
 *
 * A text with no such literal is returned by `JSON.parse` itself, so for it
 * nothing changes. Otherwise the value is built the way `JSON.parse` builds
 * it: the last of two equal keys wins in the place of the first, `__proto__`
 * is an own key, strings are decoded by `JSON.parse`, and a plain property
 * added to `Object.prototype` is never read into the value (an accessor or a
 * read-only index there makes it throw, never return another value). Anything
 * that is not JSON throws a `SyntaxError`, as `JSON.parse` does, and a value
 * that is not a string is read as `String(value)`, as `JSON.parse` reads it.
 */
export function parseJsonExact(input: string): unknown {
  const text = String(input);
  let pos = 0;
  let wide = false;

  const fail = (what: string): never => {
    throw new SyntaxError(`${what} in JSON at position ${pos}`);
  };
  const space = (): void => {
    JSON_SPACE.lastIndex = pos;
    // A failed sticky match resets lastIndex to 0: never read it then, or a
    // position past the end would send the parse back to the start.
    if (JSON_SPACE.exec(text)) pos = JSON_SPACE.lastIndex;
  };
  const string = (): string => {
    if (text[pos] !== '"') fail('Expected a string');
    let end = pos + 1;
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
    if (end >= text.length) fail('Unterminated string');
    const value = JSON.parse(text.slice(pos, end + 1)) as string;
    pos = end + 1;
    return value;
  };
  const key = (): string => {
    const name = string();
    space();
    if (text[pos] !== ':') fail("Expected ':'");
    pos += 1;
    space();
    return name;
  };
  const scalar = (): unknown => {
    if (text[pos] === '"') return string();
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, pos)) {
        pos += word.length;
        return value;
      }
    }
    JSON_NUMBER.lastIndex = pos;
    const match = JSON_NUMBER.exec(text);
    if (!match) return fail('Unexpected token');
    pos = JSON_NUMBER.lastIndex;
    const literal = match[0];
    const digits = literal.length - (literal.startsWith('-') ? 1 : 0);
    if (
      match[1] === undefined &&
      match[2] === undefined &&
      digits >= MIN_EXACT_DIGITS &&
      digits <= MAX_EXACT_DIGITS &&
      !doubleShaped(literal)
    ) {
      wide = true;
      return BigInt(literal);
    }
    return Number(literal);
  };

  // A loop with its own stack, not recursion: JSON.parse reads nesting as
  // deep as the text has, and so does this.
  const stack: Frame[] = [];
  space();
  for (;;) {
    let value: unknown;
    if (text[pos] === '[') {
      pos += 1;
      space();
      if (text[pos] !== ']') {
        stack.push({ kind: 'array', items: [] });
        continue;
      }
      pos += 1;
      value = [];
    } else if (text[pos] === '{') {
      pos += 1;
      space();
      if (text[pos] !== '}') {
        stack.push({ kind: 'object', object: {}, key: key() });
        continue;
      }
      pos += 1;
      value = {};
    } else {
      value = scalar();
    }

    // The value is complete: hand it to its container, and close every
    // container that ends right after it.
    for (;;) {
      space();
      const top = stack[stack.length - 1];
      if (top === undefined) {
        if (pos !== text.length) fail('Unexpected non-whitespace character after JSON');
        return wide ? value : JSON.parse(text);
      }
      const close = top.kind === 'array' ? ']' : '}';
      if (top.kind === 'array') {
        top.items.push(value);
      } else {
        Object.defineProperty(top.object, top.key, dataDescriptor(value));
      }
      if (text[pos] === ',') {
        pos += 1;
        space();
        if (top.kind === 'object') top.key = key();
        break;
      }
      if (text[pos] !== close) fail(`Expected ',' or '${close}'`);
      pos += 1;
      stack.pop();
      value = top.kind === 'array' ? top.items : top.object;
    }
  }
}

/**
 * An EIP-712 document read from JSON text with {@link parseJsonExact}, so an
 * integer of 22 to 78 digits written as a number keeps every digit; then
 * refused if an integer field still holds a number that is not a safe
 * integer: one of up to 21 digits (a JavaScript hop may have rounded it), one
 * a double may have been written as, or one written with an exponent or a
 * fraction ({@link assertTypedDataIntegersExact}).
 */
export function parseTypedDataJson(
  text: string,
  where = 'typed data',
  code: X402ErrorCode = 'INVALID_CONFIG'
): unknown {
  const doc: unknown = parseJsonExact(text);
  assertTypedDataIntegersExact(doc, where, code);
  return doc;
}
