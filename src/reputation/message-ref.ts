/**
 * A deterministic reference for one thing that may earn a rating.
 *
 *     messageRef(namespace, ...parts) = sha256(utf8(namespace + "|" + parts.join("|")))
 *
 * as 64 lowercase hex digits, no `0x`. The same message always gives the same
 * ref, so it is the outbox key: a restart, a replay or a second enqueue of the
 * same moment lands on the row that already exists instead of a second
 * rating. Karma Hello keys its ledger the same way
 * (`agents/coordinator.py::build_message_ref`); the namespace is new, so two
 * products can never share a ref.
 *
 * Refused rather than guessed, because a collision here is a rating that
 * silently never happens: a `|` inside the namespace or a part (`("a|b", "c")`
 * and `("a", "b|c")` would be one ref), an empty part (a missing stream id
 * would merge every moment of every stream), a non-integer number, and a
 * string with an unpaired surrogate (it has no UTF-8 encoding; Python refuses
 * to encode it, and `TextEncoder` would quietly turn it into U+FFFD).
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ReputationError } from './errors';
import { LONE_SURROGATE } from './values';

const SEPARATOR = '|';

export type MessageRefPart = string | number | bigint;

function partText(part: MessageRefPart, index: number): string {
  let text: string;
  if (typeof part === 'string') text = part;
  else if (typeof part === 'bigint') text = part.toString();
  else if (typeof part === 'number' && Number.isSafeInteger(part)) text = String(part);
  else {
    throw new ReputationError(
      'invalid_input',
      `messageRef part ${index} must be a string, a bigint or a safe integer`
    );
  }
  if (text === '') throw new ReputationError('invalid_input', `messageRef part ${index} is empty`);
  if (text.includes(SEPARATOR)) {
    throw new ReputationError('invalid_input', `messageRef part ${index} contains "|"`);
  }
  if (LONE_SURROGATE.test(text)) {
    throw new ReputationError('invalid_input', `messageRef part ${index} is not well-formed Unicode`);
  }
  return text;
}

export function messageRef(namespace: string, ...parts: MessageRefPart[]): string {
  if (typeof namespace !== 'string' || namespace === '') {
    throw new ReputationError('invalid_input', 'messageRef needs a non-empty namespace');
  }
  if (namespace.includes(SEPARATOR) || LONE_SURROGATE.test(namespace)) {
    throw new ReputationError('invalid_input', 'messageRef namespace contains "|" or is not well-formed');
  }
  if (parts.length === 0) {
    throw new ReputationError('invalid_input', 'messageRef needs at least one part');
  }
  const text = [namespace, ...parts.map(partText)].join(SEPARATOR);
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}
