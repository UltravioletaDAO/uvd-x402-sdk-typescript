/** Internal exact Borsh primitives shared by NEAR signing and storage builders. */
import type { NearUnsigned } from './escrow';

// Signed values must match in full, without trimming or normalization.
export function fullMatch(pattern: RegExp, value: string): boolean {
  return pattern.exec(value)?.[0] === value;
}

export function uint(value: NearUnsigned, bits: number, name: string): bigint {
  if ((typeof value !== 'bigint' && typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'number' && !Number.isSafeInteger(value)) ||
      (typeof value === 'string' && !fullMatch(/^(0|[1-9][0-9]*)$/, value))) {
    throw new Error(`${name}: expected an exact unsigned integer`);
  }
  const n = BigInt(value);
  if (n < 0n || n >= 1n << BigInt(bits)) throw new Error(`${name}: out of u${bits} range`);
  return n;
}
export function operatorId(value: string, name: string): void {
  if (typeof value !== 'string' || !fullMatch(/^[a-z0-9_-]{1,32}$/, value)) throw new Error(`${name}: expected [a-z0-9_-]{1,32}`);
}
export function account(value: string, name: string): void {
  if (typeof value !== 'string' || value.length < 2 || value.length > 64 ||
      !fullMatch(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, value)) throw new Error(`${name}: invalid NEAR account`);
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
export function le(n: bigint, size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => Number(n >> BigInt(i * 8) & 255n));
}
export function str(s: string): Uint8Array {
  for (const c of s) {
    const point = c.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) throw new Error('Expected valid Unicode scalar values');
  }
  const bytes = new TextEncoder().encode(s);
  return concat(le(BigInt(bytes.length), 4), bytes);
}
export function unbase58(value: string): Uint8Array {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (!value || value.length > 128) throw new Error('Invalid base58 length');
  let n = 0n;
  for (const c of value) {
    const digit = alphabet.indexOf(c);
    if (digit < 0) throw new Error('Invalid base58 character');
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.push(Number(n & 255n)); n >>= 8n; }
  const zeros = value.match(/^1*/u)![0].length;
  return concat(new Uint8Array(zeros), Uint8Array.from(bytes.reverse()));
}
