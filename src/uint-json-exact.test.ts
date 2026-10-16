/**
 * `parseJsonExact`: `JSON.parse`, except that an integer literal of 22 to 78
 * digits comes back as the bigint that was written, unless a double could have
 * been written as it. 22 because JavaScript writes a number it already rounded
 * in up to 21 plain digits; other writers print a rounded double in full
 * (`BigInt(n)`, `toLocaleString`, Python's `int(f)`). Those digits are read as
 * `JSON.parse` reads them, and an integer field refuses them.
 *
 * It is what a signer handed typed data as TEXT reads it with, so for
 * everything but those integers it must build exactly what `JSON.parse` builds:
 * a signer that reads a text one way while its caller read it another signs
 * something the caller never checked. Hence the comparisons with `JSON.parse`
 * itself: fixed cases, every invalid text below, and seeded random documents
 * plus random one-character edits of each.
 */

import { describe, expect, it } from 'vitest';

import { parseJsonExact } from './utils/uint';

/** 32 random-looking bytes, the width of an escrow salt. */
const SALT = BigInt(`0x${'ab'.repeat(32)}`);
const SALT_DIGITS = SALT.toString();
const MAX_UINT256 = 2n ** 256n - 1n;
const MIN_INT256 = -(2n ** 255n);

/** A value spelled out with its key order, own keys, prototype, -0 and bigints visible. */
function canon(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) === Object.prototype ? '' : '<not Object.prototype>';
    const entries = Object.keys(value).map(
      (key) => `${JSON.stringify(key)}:${canon((value as Record<string, unknown>)[key])}`
    );
    return `{${proto}${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Set a key the way JSON.parse does (`__proto__` included). */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** The same value with every bigint as the double JSON.parse makes of its digits. */
function rounded(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(rounded);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) put(out, key, rounded((value as Record<string, unknown>)[key]));
    return out;
  }
  return value;
}

/** A double written out in plain digits: its shortest digits, or `precision` of them, then zeros. */
function writtenOut(n: number, precision?: number): string {
  const [mantissa, exponent] = (precision ? n.toExponential(precision - 1) : n.toExponential()).split('e+');
  const digits = mantissa.replace('.', '');
  return digits + '0'.repeat(Number(exponent) + 1 - digits.length);
}

function attempt(fn: () => unknown): { value?: unknown; error?: unknown } {
  try {
    return { value: fn() };
  } catch (error) {
    return { error };
  }
}

// ============================================================================
// What changes: the integers JSON.parse rounds
// ============================================================================

describe('parseJsonExact keeps every digit of an integer of 22 to 78 digits', () => {
  it('the premise: JSON.parse turns a 32-byte salt into another integer', () => {
    expect(BigInt(JSON.parse(SALT_DIGITS) as number)).not.toBe(SALT);
  });

  it('why 22: JavaScript writes a rounded number in up to 21 plain digits, and from 1e21 up with an exponent', () => {
    // A 19-digit amount through one JavaScript hop: other digits, no exponent.
    const hopped = JSON.stringify(JSON.parse('{"amount":1234567890123456789}'));
    expect(hopped).toBe('{"amount":1234567890123456800}');
    expect(parseJsonExact(hopped)).toEqual({ amount: 1234567890123456800 });
    // The largest double below 1e21 is written in 21 plain digits; 1e21 is not.
    expect(String(1e21 - 2 ** 17)).toMatch(/^[0-9]{21}$/);
    expect(JSON.stringify(1e21)).toBe('1e+21');
  });

  it.each<[string, string, bigint]>([
    ['a 32-byte salt', SALT_DIGITS, SALT],
    ['10**21 + 1, 22 digits', (10n ** 21n + 1n).toString(), 10n ** 21n + 1n],
    ['-(10**21 + 1), 22 digits after the sign', (-(10n ** 21n) - 1n).toString(), -(10n ** 21n) - 1n],
    ['2**256 - 1, 78 digits', MAX_UINT256.toString(), MAX_UINT256],
    ['-(2**256 - 1), 78 digits after the sign', (-MAX_UINT256).toString(), -MAX_UINT256],
    ['-(2**255) + 1', (MIN_INT256 + 1n).toString(), MIN_INT256 + 1n],
    ['18 significant digits and ten zeros', `123456789012345678${'0'.repeat(10)}`, 123456789012345678n * 10n ** 10n],
    ['the salt with its last ten digits zero', `${SALT_DIGITS.slice(0, -10)}${'0'.repeat(10)}`, BigInt(`${SALT_DIGITS.slice(0, -10)}${'0'.repeat(10)}`)],
  ])('%s', (_label, literal, expected) => {
    expect(parseJsonExact(literal)).toBe(expected);
    expect(parseJsonExact(`{"salt":${literal}}`)).toEqual({ salt: expected });
    expect(parseJsonExact(`[ ${literal} , 1 ]`)).toEqual([expected, 1]);
  });

  it('only numbers: the same digits in a string stay a string', () => {
    expect(parseJsonExact(`{"s":"${SALT_DIGITS}","n":${SALT_DIGITS}}`)).toEqual({ s: SALT_DIGITS, n: SALT });
  });
});

// ============================================================================
// What does not: everything else reads as JSON.parse reads it
// ============================================================================

describe('parseJsonExact reads every other number as JSON.parse does', () => {
  it.each<[string, string]>([
    ['2**53 - 1', '9007199254740991'],
    ['-(2**53 - 1)', '-9007199254740991'],
    ['2**53', '9007199254740992'],
    ['2**53 + 1, which JSON.parse reads as 2**53', '9007199254740993'],
    ['a negative past -(2**53 - 1)', '-9007199254740993'],
    ['2**60 + 1 as JSON.stringify writes it', JSON.stringify(2 ** 60 + 1)],
    ['10**18, exact in a double and still up to 21 digits', '1000000000000000000'],
    ['21 nines, the widest JavaScript could have written in digits', '9'.repeat(21)],
    ['21 nines, negative', `-${'9'.repeat(21)}`],
    // A double written out in full, 22 digits or more: it may be a value
    // rounded before it was written, so it is not read as more than that.
    ['10**21, exactly a double', (10n ** 21n).toString()],
    ['5 * 10**21', `5${'0'.repeat(21)}`],
    ['-(2**255), exactly a double', MIN_INT256.toString()],
    ['the rounded salt as BigInt(n).toString(), Python int(f), Java new BigDecimal(d)', BigInt(Number(SALT)).toString()],
    ['the rounded salt as toLocaleString without grouping', Number(SALT).toLocaleString('en-US', { useGrouping: false })],
    ['the rounded salt as Intl.NumberFormat without grouping', new Intl.NumberFormat('en-US', { useGrouping: false }).format(Number(SALT))],
    ['the rounded salt as its shortest digits and zeros (Java toPlainString)', writtenOut(Number(SALT))],
    ['the rounded salt as 15 digits and zeros', writtenOut(Number(SALT), 15)],
    ['a 30-digit double as its 17 shortest digits and zeros', writtenOut(Number('123456789012345678901234567890'))],
    ['zero', '0'],
    ['negative zero', '-0'],
    ['1e21', '1e21'],
    ['1E+21', '1E+21'],
    ['the salt as JSON.stringify writes it once rounded', String(Number(SALT))],
    ['an integer past 2**53 with a fraction', '9007199254740993.0'],
    ['an integer past 2**53 with an exponent of 0', '9007199254740993e0'],
    ['79 digits, wider than any EIP-712 integer', '1'.repeat(79)],
    ['79 digits, negative', `-${'1'.repeat(79)}`],
    ['a fraction', '0.1'],
    ['a small negative with an exponent', '-1.5e-7'],
    ['an overflow to Infinity', '1e400'],
    ['30 digits and a fraction', '123456789012345678901234567890.5'],
  ])('%s', (_label, literal) => {
    expect(canon(parseJsonExact(literal))).toBe(canon(JSON.parse(literal)));
    // And inside a text that does have a wide integer, which this parser builds itself.
    expect(canon(parseJsonExact(`[${SALT_DIGITS},${literal}]`))).toBe(
      canon([SALT, JSON.parse(literal)])
    );
  });

  it('a literal of a million digits is the Infinity JSON.parse reads, never a bigint', () => {
    expect(parseJsonExact(`[${SALT_DIGITS},${'9'.repeat(1_000_000)}]`)).toEqual([
      SALT,
      Number.POSITIVE_INFINITY,
    ]);
  });
});

describe('parseJsonExact builds the value JSON.parse builds', () => {
  it('two equal keys: the last value wins, in the place of the first', () => {
    const text = `{"a":1,"salt":${SALT_DIGITS},"a":2,"2":"two","1":"one"}`;
    const value = parseJsonExact(text) as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['1', '2', 'a', 'salt']);
    expect(value.a).toBe(2);
    expect(value.salt).toBe(SALT);
    expect(canon(rounded(value))).toBe(canon(JSON.parse(text)));
  });

  it('__proto__ is an own key, never the prototype', () => {
    const text = `{"__proto__":{"isAdmin":true,"salt":${SALT_DIGITS}},"inner":{"__proto__":null}}`;
    const value = parseJsonExact(text) as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(['__proto__', 'inner']);
    expect(value.isAdmin).toBeUndefined();
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    expect(Object.getPrototypeOf(value.inner)).toBe(Object.prototype);
    expect(canon(rounded(value))).toBe(canon(JSON.parse(text)));
  });

  it('strings are decoded by JSON.parse: escapes, quotes, surrogates', () => {
    const text =
      `{"s":"\\u00e9\\n\\t\\"\\\\\\/\\b\\f\\r\\ud83d\\ude00\\ud800 [1,{\\"n\\":${SALT_DIGITS}}]",` +
      `"k\\u0041\\"":${SALT_DIGITS},"":"é😀"}`;
    const value = parseJsonExact(text) as Record<string, unknown>;
    expect(value['kA"']).toBe(SALT);
    expect(canon(rounded(value))).toBe(canon(JSON.parse(text)));
  });

  it('the four whitespace characters JSON allows, anywhere between tokens', () => {
    const ws = ' \t\n\r';
    const text = `${ws}{${ws}"a"${ws}:${ws}[${ws}${SALT_DIGITS}${ws},${ws}1${ws}]${ws},${ws}"b"${ws}:${ws}{${ws}}${ws}}${ws}`;
    expect(parseJsonExact(text)).toEqual({ a: [SALT, 1], b: {} });
  });

  it('reads nothing a polluted Object.prototype adds', () => {
    const proto = Object.prototype as Record<string, unknown>;
    let read: ReturnType<typeof attempt>;
    let invalid: ReturnType<typeof attempt>;
    try {
      // `get` would turn every descriptor into an accessor; the others would
      // make an object look like an array to a parser that asked with `in`.
      proto.get = () => 'polluted';
      for (const key of ['array', 'items', 'object']) proto[key] = [];
      proto.kind = 'array';
      read = attempt(() => parseJsonExact(`{"a":1,"s":${SALT_DIGITS}}`));
      invalid = attempt(() => parseJsonExact(`{"a":1,"s":${SALT_DIGITS}]`));
    } finally {
      for (const key of ['get', 'array', 'items', 'object', 'kind']) delete proto[key];
    }
    expect(read.error).toBeUndefined();
    expect(read.value).toEqual({ a: 1, s: SALT });
    expect(invalid.error).toBeInstanceOf(SyntaxError);
  });

  it('a value that is not a string is read as String(value), as JSON.parse reads it', () => {
    const buffer = Buffer.from(`{"salt":${SALT_DIGITS}}`);
    expect(parseJsonExact(buffer as unknown as string)).toEqual({ salt: SALT });
    expect(parseJsonExact(12 as unknown as string)).toBe(12);
    expect(() => JSON.parse(undefined as unknown as string)).toThrow(SyntaxError);
    expect(() => parseJsonExact(undefined as unknown as string)).toThrow(SyntaxError);
  });

  it('nesting as deep as JSON.parse reads it', () => {
    const depth = 50_000;
    for (const [open, close] of [['[', ']'], ['{"a":', '}']]) {
      const text = `${open.repeat(depth)}${SALT_DIGITS}${close.repeat(depth)}`;
      expect(() => JSON.parse(text)).not.toThrow();
      let value = parseJsonExact(text);
      for (let level = 0; level < depth; level++) {
        value = Array.isArray(value) ? value[0] : (value as { a: unknown }).a;
      }
      expect(value).toBe(SALT);
    }
  });
});

// ============================================================================
// What JSON.parse refuses, this refuses
// ============================================================================

const INVALID: string[] = [
  '', ' ', '[', ']', '{', '}', '[1,]', '{"a":1,}', '{"a" 1}', '{a:1}', "{'a':1}", "'a'",
  '01', '-01', '00', '+1', '.5', '1.', '1.e5', '1e', '1e+', '-', '--1', '- 1',
  'NaN', 'Infinity', '-Infinity', 'tru', 'nul', 'fals', 'True', 'NULL', 'truee', 'nulll',
  '[1 2]', '{"a":1 "b":2}', '"abc', '"\\x"', '"a\nb"', '"\t"', '"\\u12"', '"\\u12G4"', '"\\"',
  '﻿1', ' 1', '1 ', ' 1', '\v1', '\f1', '\u00001',
  '[1]]', '{}}', '[]]', '[,1]', '{,}', '"a"b', '1 2', 'null null', '[01]', '[-]',
  '{"a"}', '{"a":}', '{"a"x1}', '{"a";1}', '{"a"=1}', '{"a":1,"b"}', '[1,,2]', '{1:2}', '[true false]', '{"a":1}{',
  '/*c*/1', '1//c', 'undefined', '0x10', '1_000', '１',
  `${SALT_DIGITS}x`, `${SALT_DIGITS}.`, `${SALT_DIGITS}e`, `-${SALT_DIGITS}-`, `0${SALT_DIGITS}`,
  `+${SALT_DIGITS}`, `[${SALT_DIGITS} ${SALT_DIGITS}]`, `{"a":${SALT_DIGITS}`, `{"a":${SALT_DIGITS}]`,
  `[${SALT_DIGITS}}`, `{${SALT_DIGITS}:1}`, `[${SALT_DIGITS},]`, `"${SALT_DIGITS}`,
];

describe('parseJsonExact refuses what JSON.parse refuses, with a SyntaxError', () => {
  it.each(INVALID.flatMap((text) => [[text], [`[${SALT_DIGITS},${text}]`]]))('%j', (text) => {
    expect(() => JSON.parse(text)).toThrow(SyntaxError);
    expect(() => parseJsonExact(text)).toThrow(SyntaxError);
  });
});

// ============================================================================
// Seeded random documents, and random edits of them
// ============================================================================

/** mulberry32: a small deterministic PRNG, so a failure is reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random JSON text and the value it must parse to (bigints where they are wide). */
function document(random: () => number): { text: string; value: unknown } {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const ws = (): string => (random() < 0.7 ? '' : pick([' ', '\t', '\n', '\r', '  \n\t ']));
  const digits = (count: number): string =>
    String(1 + Math.floor(random() * 9)) +
    Array.from({ length: count - 1 }, () => String(Math.floor(random() * 10))).join('');

  const scalar = (): { text: string; value: unknown } => {
    switch (Math.floor(random() * 10)) {
      case 0:
        return pick([
          { text: 'null', value: null },
          { text: 'true', value: true },
          { text: 'false', value: false },
        ]);
      case 1: {
        const text = pick(['0', '-0', '7', '-12', '9007199254740991', '-9007199254740991']);
        return { text, value: JSON.parse(text) };
      }
      case 2: {
        const text = pick(['0.5', '-1.25e3', '1e21', '1E-7', '123456789012345678901234.5', '1e400', String(Number(SALT))]);
        return { text, value: JSON.parse(text) };
      }
      case 3:
      case 4: {
        // 16 to 78 digits, either sign: exact from 22 digits, as JSON.parse reads it below.
        // The last digit is odd, so no literal of 22 digits or more is shaped like a double.
        const width = 16 + Math.floor(random() * 63);
        const literal = `${random() < 0.3 ? '-' : ''}${digits(width - 1)}${pick(['1', '3', '5', '7', '9'])}`;
        return { text: literal, value: width >= 22 ? BigInt(literal) : Number(literal) };
      }
      case 5: {
        // Wider than any EIP-712 integer: the double JSON.parse reads.
        const text = '1'.repeat(79 + Math.floor(random() * 5));
        return { text, value: JSON.parse(text) };
      }
      default: {
        const chars = ['a', 'Z', '0', '9', ' ', '"', '\\', '/', '\n', '\t', '\u0001', 'é', '😀', '\ud800', '[', '{', ':', ','];
        const raw = Array.from({ length: Math.floor(random() * 6) }, () => pick(chars)).join('');
        let text = JSON.stringify(raw);
        // Sometimes spell a letter as \uXXXX, which JSON.stringify never does.
        if (random() < 0.3) text = text.replace(/a/g, '\\u0061');
        return { text, value: raw };
      }
    }
  };

  const value = (depth: number): { text: string; value: unknown } => {
    const roll = random();
    if (depth > 4 || roll < 0.45) return scalar();
    if (roll < 0.7) {
      const items = Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
      return {
        text: `[${ws()}${items.map((item) => `${item.text}${ws()}`).join(`,${ws()}`)}]`,
        value: items.map((item) => item.value),
      };
    }
    const keys = ['a', 'b', 'salt', '__proto__', '1', '0', 'constructor', 'é', ''];
    const members = Array.from({ length: Math.floor(random() * 5) }, () => ({
      key: pick(keys),
      member: value(depth + 1),
    }));
    const built: Record<string, unknown> = {};
    for (const { key, member } of members) put(built, key, member.value);
    return {
      text: `{${ws()}${members
        .map(({ key, member }) => `${JSON.stringify(key)}${ws()}:${ws()}${member.text}${ws()}`)
        .join(`,${ws()}`)}}`,
      value: built,
    };
  };

  const top = value(0);
  return { text: `${ws()}${top.text}${ws()}`, value: top.value };
}

describe('parseJsonExact against JSON.parse, seeded random texts', () => {
  const random = prng(0x5a17_3200);
  const docs = Array.from({ length: 400 }, () => document(random));

  it('a random document parses to its value, and JSON.parse reads the same value rounded', () => {
    const failures: string[] = [];
    for (const { text, value } of docs) {
      const exact = attempt(() => parseJsonExact(text));
      if (exact.error !== undefined || canon(exact.value) !== canon(value)) {
        failures.push(`${JSON.stringify(text)} -> ${exact.error ?? canon(exact.value)}, expected ${canon(value)}`);
      }
      if (canon(JSON.parse(text)) !== canon(rounded(value))) {
        failures.push(`the generator's value disagrees with JSON.parse for ${JSON.stringify(text)}`);
      }
    }
    expect(failures).toEqual([]);
    expect(docs.filter(({ text }) => /[0-9]{16}/.test(text)).length).toBeGreaterThan(100);
    expect(docs.filter(({ text }) => /[0-9]{22}/.test(text)).length).toBeGreaterThan(50);
  });

  it('every one-character edit: both parse it the same, or both refuse it', () => {
    const alphabet = [' ', '{', '}', '[', ']', ',', ':', '"', '\\', '-', '+', '.', 'e', 'E', '0', '1', '9', 't', 'n', 'u', 'x', ' '];
    const failures: string[] = [];
    let compared = 0;
    for (const { text } of docs) {
      for (let edit = 0; edit < 20; edit++) {
        const at = Math.floor(random() * (text.length + 1));
        const kind = Math.floor(random() * 3);
        const char = alphabet[Math.floor(random() * alphabet.length)];
        const mutated =
          kind === 0
            ? text.slice(0, at) + text.slice(at + 1)
            : kind === 1
              ? text.slice(0, at) + char + text.slice(at)
              : text.slice(0, at) + char + text.slice(at + 1);
        const native = attempt(() => JSON.parse(mutated));
        const exact = attempt(() => parseJsonExact(mutated));
        compared += 1;
        if ((native.error === undefined) !== (exact.error === undefined)) {
          failures.push(`${JSON.stringify(mutated)}: JSON.parse ${native.error ? 'refuses' : 'reads'} it, parseJsonExact ${exact.error ? 'refuses' : 'reads'} it`);
        } else if (exact.error !== undefined) {
          if (!(exact.error instanceof SyntaxError)) failures.push(`${JSON.stringify(mutated)}: ${String(exact.error)}`);
        } else if (canon(rounded(exact.value)) !== canon(native.value)) {
          failures.push(`${JSON.stringify(mutated)}: ${canon(exact.value)} vs ${canon(native.value)}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(compared).toBe(docs.length * 20);
  });
});
