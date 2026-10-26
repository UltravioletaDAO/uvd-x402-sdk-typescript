/**
 * What may reach a log from this module.
 *
 * A rater's address, a viewer's wallet, a payment proof and a signature are
 * all public or harmless one at a time, and a log is where they get joined to
 * a username. So every long hex value is shortened to its first and last four
 * digits (enough to correlate two lines, not enough to look anything up), and
 * the fields that carry proofs, signatures or a signed transaction are
 * replaced whole. A private key never enters the module, and a hex string of
 * key length is shortened like any other.
 */

/** Keys whose value is dropped from a log entirely, compared case-insensitively. */
const DROPPED_KEYS = new Set([
  'proof',
  'proofofpayment',
  'signature',
  'authorization',
  'rawtransaction',
  'privatekey',
  'secret',
  'salt',
]);

const PREFIXED_HEX = /0[xX][0-9a-fA-F]{40,}/g;
const BARE_HEX = /(?<![0-9a-fA-FxX])[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g;

/** Shorten every `0x` value of 40+ hex digits, and every bare run of 64+. */
export function redactText(text: string): string {
  return text
    .replace(PREFIXED_HEX, (m) => `${m.slice(0, 6)}…${m.slice(-4)}`)
    .replace(BARE_HEX, (m) => `${m.slice(0, 4)}…${m.slice(-4)}`);
}

/** A copy of `value` fit for a log: strings shortened, sensitive fields dropped, depth bounded. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return redactText(value.toString());
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[…]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return redactText(`${value.name}: ${value.message}`);
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = DROPPED_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(inner, depth + 1);
  }
  return out;
}

/** Where the module writes what it does. Every argument it receives was already redacted. */
export interface ReputationLogger {
  debug?(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
  error?(message: string, fields?: Record<string, unknown>): void;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

/** The module's only way to a logger: redacts, and never lets a logger that throws break a write. */
export function log(
  logger: ReputationLogger | undefined,
  level: Level,
  message: string,
  fields?: Record<string, unknown>
): void {
  const sink = logger?.[level];
  if (!sink) return;
  try {
    sink.call(
      logger,
      redactText(message),
      fields === undefined ? undefined : (redact(fields) as Record<string, unknown>)
    );
  } catch {
    /* a broken logger must not decide whether money moves */
  }
}
