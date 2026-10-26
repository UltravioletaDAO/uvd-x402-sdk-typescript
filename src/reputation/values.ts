/**
 * Strict readers for values that arrive from outside the module: a prepare,
 * an RPC answer, a row read back from storage. Each returns `null` for
 * anything it does not recognise; the caller decides which error that is.
 *
 * Integers come as a JSON number only while it is a safe integer, otherwise
 * as a decimal string, which is how the facilitator writes every `uint256`
 * (a `deadline` or an `agentId` past 2**53 rounded by `JSON.parse` would hash
 * to a different struct).
 */

const DECIMAL = /^[0-9]{1,78}$/;
const SIGNED_DECIMAL = /^-?[0-9]{1,39}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^(0x)?[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;

export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT64 = (1n << 64n) - 1n;
export const MIN_INT128 = -(1n << 127n);
export const MAX_INT128 = (1n << 127n) - 1n;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exactly these own keys, no more and no fewer. */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
}

/** A non-negative integer up to `max`, from a safe JSON integer, a bigint or a decimal string. */
export function uintOf(value: unknown, max: bigint = MAX_UINT256): bigint | null {
  let n: bigint | null = null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'bigint') n = value;
  else if (typeof value === 'string' && DECIMAL.test(value)) n = BigInt(value);
  return n !== null && n >= 0n && n <= max ? n : null;
}

/** An `int128`, from a safe JSON integer, a bigint or a signed decimal string. */
export function int128Of(value: unknown): bigint | null {
  let n: bigint | null = null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'bigint') n = value;
  else if (typeof value === 'string' && SIGNED_DECIMAL.test(value) && value !== '-0') n = BigInt(value);
  return n !== null && n >= MIN_INT128 && n <= MAX_INT128 ? n : null;
}

/** A safe non-negative integer as a `number`, or `null`. */
export function safeUint(value: unknown): number | null {
  const n = uintOf(value, BigInt(Number.MAX_SAFE_INTEGER));
  return n === null ? null : Number(n);
}

export function isAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS.test(value);
}

export function sameAddress(a: unknown, b: unknown): boolean {
  return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

/** 32 bytes as lowercase `0x` hex, whatever the case and whether or not a `0x` leads. */
export function bytes32Of(value: unknown): string | null {
  if (typeof value !== 'string' || !BYTES32.test(value)) return null;
  return '0x' + value.toLowerCase().replace(/^0x/, '');
}

/** A JSON-RPC quantity (`0x`-prefixed hex, no leading-zero rule enforced) as a bigint. */
export function quantityOf(value: unknown): bigint | null {
  return typeof value === 'string' && QUANTITY.test(value) ? BigInt(value) : null;
}

/** 32 bytes left-padded, as a log topic. */
export function topicOf(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.toLowerCase().replace(/^0x/, '');
  return '0x' + hex.padStart(64, '0');
}

/** Control characters (C0 and DEL), which no field this module publishes may carry. */
export const CONTROL = /[\u0000-\u001f\u007f]/;

/** An unpaired UTF-16 surrogate: a string with one has no UTF-8 encoding (Python refuses to encode it). */
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
