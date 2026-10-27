/**
 * Canonical JSON: the bytes a document's `feedbackHash` commits to.
 *
 * Byte for byte what Python writes with
 * `json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")`
 * (Karma Hello's `canonical_json`, `services/reputation/live.py`), so the
 * Python and TypeScript SDKs hash the same document to the same value:
 *
 * - object keys sorted by Unicode code point (Python's `str` order, not
 *   JavaScript's UTF-16 order, which differs above U+FFFF);
 * - no whitespace; non-ASCII written as itself;
 * - a string escapes `"`, `\`, `\b \f \n \r \t` and every other control
 *   character as `\u00xx`, which is what both `JSON.stringify` and Python do;
 * - integers only. A float, `NaN`, `-0` written as `-0`, `undefined`, a
 *   function or a class instance is refused: each one has a spelling that
 *   differs between the two languages, and a document that hashes differently
 *   in the other SDK is an anchor that fails to verify.
 */

import { ReputationError } from './errors';
import { LONE_SURROGATE } from './values';

function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i].codePointAt(0) as number) - (y[i].codePointAt(0) as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function str(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw new ReputationError('invalid_input', `${path} is not well-formed Unicode`);
  }
  return JSON.stringify(value);
}

function write(value: unknown, path: string, depth: number): string {
  if (depth > 32) throw new ReputationError('invalid_input', `${path} nests too deep`);
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return str(value, path);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new ReputationError('invalid_input', `${path} must be a safe integer`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => write(v, `${path}[${i}]`, depth + 1)).join(',')}]`;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value as object).sort(compareCodePoints);
    const parts = keys.map((k) => {
      const inner = (value as Record<string, unknown>)[k];
      return `${str(k, `${path}.${k}`)}:${write(inner, `${path}.${k}`, depth + 1)}`;
    });
    return `{${parts.join(',')}}`;
  }
  throw new ReputationError('invalid_input', `${path} is not a JSON value`);
}

/** The canonical text of `value`. */
export function canonicalJson(value: unknown): string {
  return write(value, '$', 0);
}

/** The canonical UTF-8 bytes of `value`. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
