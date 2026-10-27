/**
 * Canonical JSON and messageRef: the two places where the Python and
 * TypeScript SDKs must produce the same BYTES from the same input.
 *
 * Each expected string below is what Python 3 writes with
 * `json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ReputationError, canonicalJson, messageRef } from './index';

describe('canonicalJson', () => {
  it.each<[string, unknown, string]>([
    ['keys sorted, no spaces', { b: 1, a: [true, null, 'x'] }, '{"a":[true,null,"x"],"b":1}'],
    ['non-ASCII as itself', { s: 'créditos ✓ 🎬' }, '{"s":"créditos ✓ 🎬"}'],
    ['the short escapes', { s: '"\\\b\f\n\r\t' }, '{"s":"\\"\\\\\\b\\f\\n\\r\\t"}'],
    ['other control characters as \\u00xx', { s: '\u0001\u001f' }, '{"s":"\\u0001\\u001f"}'],
    ['DEL and U+2028 as themselves', { s: '\u007f ' }, '{"s":"\u007f "}'],
    ['nested objects sorted too', { z: { y: 1, x: 2 }, a: {} }, '{"a":{},"z":{"x":2,"y":1}}'],
    ['a bigint as its digits', { n: 2n ** 70n }, '{"n":1180591620717411303424}'],
    ['negative integers', { n: -5 }, '{"n":-5}'],
  ])('%s', (_name, value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it('sorts keys by code point, as Python does, not by UTF-16 unit', () => {
    // U+FF5E is one UTF-16 unit above the high surrogate of U+1F3AC; by code point it is below.
    expect(canonicalJson({ '\u{1F3AC}': 1, '～': 2 })).toBe('{"～":2,"\u{1F3AC}":1}');
  });

  it.each<[string, unknown]>([
    ['a float', { n: 1.5 }],
    ['NaN', { n: Number.NaN }],
    ['-0', { n: -0 }],
    ['an unsafe integer', { n: 2 ** 53 }],
    ['undefined', { n: undefined }],
    ['a Date', { n: new Date(0) }],
    ['a lone surrogate in a value', { s: '\uD800' }],
    ['a lone surrogate in a key', { ['\uDC00']: 1 }],
  ])('refuses %s', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(ReputationError);
  });
});

describe('messageRef', () => {
  const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

  it('is sha256 of namespace | parts, 64 lowercase hex digits', () => {
    expect(messageRef('credits-roll:v1', 'stream-42', 'msg-1')).toBe(sha('credits-roll:v1|stream-42|msg-1'));
    expect(messageRef('credits-roll:v1', 'stream-42', 'msg-1')).toMatch(/^[0-9a-f]{64}$/);
    expect(messageRef('ns', 42, 7n)).toBe(sha('ns|42|7'));
    expect(messageRef('ns', 'créditos 🎬')).toBe(sha('ns|créditos 🎬'));
  });

  it('separates namespaces', () => {
    expect(messageRef('karma-hello:v1', 's', 'm')).not.toBe(messageRef('credits-roll:v1', 's', 'm'));
  });

  it.each<[string, () => string]>([
    ['an empty namespace', () => messageRef('', 'a')],
    ['no parts', () => messageRef('ns')],
    ['a | in the namespace', () => messageRef('a|b', 'c')],
    ['a | in a part', () => messageRef('ns', 'a|b')],
    ['an empty part', () => messageRef('ns', 's', '')],
    ['a float part', () => messageRef('ns', 1.5)],
    ['an unsafe integer part', () => messageRef('ns', 2 ** 53)],
    ['a lone surrogate', () => messageRef('ns', '\uD83C')],
    ['a boolean', () => messageRef('ns', true as unknown as string)],
  ])('refuses %s', (_name, call) => {
    expect(call).toThrow(ReputationError);
  });

  // What `[c for c in range(sys.maxunicode + 1) if chr(c).isspace()]` lists in Python 3.11.
  const PYTHON_SPACES = [
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
    0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ];

  it.each(PYTHON_SPACES.map((c) => [c.toString(16).padStart(4, '0'), c]))(
    'a part or a namespace of U+%s only is blank, as Python strip() finds it',
    (_hex, c) => {
      const space = String.fromCharCode(c as number);
      expect(() => messageRef('ns', space + space)).toThrow(ReputationError);
      expect(() => messageRef(space, 'a')).toThrow(ReputationError);
      expect(messageRef('ns', space + 'a')).toBe(sha('ns|' + space + 'a'));
    }
  );

  it('U+FEFF is not blank to Python, so it is hashed, not refused', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(messageRef('ns', bom)).toBe(sha('ns|' + bom));
  });
});
