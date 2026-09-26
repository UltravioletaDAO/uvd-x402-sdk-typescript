/**
 * Stack key: the credential a service run by Ultravioleta DAO presents to the
 * facilitator, so that the facilitator's rate-limit policy does not answer it
 * `429`. It changes nothing else, and a facilitator that does not know the
 * header ignores it. Third-party integrations have no key and need none.
 *
 * The one rule this file exists for: a key that was read badly never breaks a
 * payment. A key read from a file with a trailing `\r\n`, or a value no header
 * can carry, would make the HTTP layer throw before sending -- every
 * `/verify` and `/settle` of the client would fail, and the thrown message
 * would carry the value. So the key is trimmed and checked once, when the
 * client is built; a key that does not pass is not sent, the client warns once
 * without the value, and pays like any other client.
 */

/** Header that carries the stack key on the facilitator calls that take it. */
export const STACK_KEY_HEADER = 'X-UVD-Stack-Key';

/** `uvdsk_` and 32 random bytes in base64url (43 characters), up to 128. */
const STACK_KEY_FORMAT = /^uvdsk_[A-Za-z0-9_-]{43,128}$/;

/**
 * The key of each client, held here and not on the client: a field would print
 * with the client (`console.log`, `util.inspect`, `JSON.stringify`), and the
 * key with it.
 */
const keys = new WeakMap<object, string>();

/** One warning per process, however many clients are built with a bad key. */
let warned = false;

function readEnv(): unknown {
  try {
    return typeof process !== 'undefined' ? process.env?.UVD_STACK_KEY : undefined;
  } catch {
    // A runtime that guards its environment (Deno without --allow-env) throws
    // on the read. No key is not a reason to fail building the client.
    return undefined;
  }
}

/**
 * Resolve the key `client` will send: the `stackKey` option, or else
 * `UVD_STACK_KEY`. `''` in the option sends none and does not read the
 * environment. Never throws.
 */
export function bindStackKey(client: object, option: unknown): void {
  const fromOption = option !== undefined && option !== null;
  const raw = fromOption ? option : readEnv();
  if (raw === undefined || raw === null) return;
  const key = typeof raw === 'string' ? raw.trim() : undefined;
  if (key === '') return;
  if (key !== undefined && STACK_KEY_FORMAT.test(key)) {
    keys.set(client, key);
    return;
  }
  if (!warned) {
    warned = true;
    // The value is left out on purpose, and so is anything derived from it.
    console.warn(
      `[x402] stack key ignored (${fromOption ? 'stackKey option' : 'UVD_STACK_KEY'}): ` +
        `it is not "uvdsk_" followed by 43-128 base64url characters. ` +
        `Requests go out without ${STACK_KEY_HEADER}.`,
    );
  }
}

/** `headers` plus the client's stack key, when it has one. */
export function withStackKey(client: object, headers: Record<string, string>): Record<string, string> {
  const key = keys.get(client);
  return key === undefined ? headers : { ...headers, [STACK_KEY_HEADER]: key };
}
