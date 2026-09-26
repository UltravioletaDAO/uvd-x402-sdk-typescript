/**
 * Stack key: the credential a service run by Ultravioleta DAO presents to the
 * facilitator, so that the facilitator's rate-limit policy does not answer it
 * `429`. It changes nothing else, and a facilitator that does not know the
 * header ignores it. Third-party integrations have no key and need none.
 *
 * Two rules this file exists for:
 *
 * 1. A key that was read badly never breaks a payment. A key read from a file
 *    with a trailing `\r\n`, or a value no header can carry, would make the
 *    HTTP layer throw before sending -- every `/verify` and `/settle` of the
 *    client would fail, and the thrown message would carry the value. So the
 *    key is trimmed and checked once, when the client is built; a key that
 *    does not pass is not sent, the client warns once without the value, and
 *    pays like any other client.
 * 2. The key only travels to a house facilitator. `UVD_STACK_KEY` is read by
 *    every client in the process, and a service may point one of them at a
 *    facilitator somebody else runs; that operator must never receive the key.
 *    So the client's base URL is checked once, when the client is built, and
 *    a client whose base URL is not a house facilitator sends no header.
 */

/** Header that carries the stack key on the facilitator calls that take it. */
export const STACK_KEY_HEADER = 'X-UVD-Stack-Key';

/** `uvdsk_` and 32 random bytes in base64url (43 characters), up to 128. */
const STACK_KEY_FORMAT = /^uvdsk_[A-Za-z0-9_-]{43,128}$/;

/** The facilitator Ultravioleta DAO runs. Always a house facilitator, over https. */
const HOUSE_FACILITATOR_HOSTS: readonly string[] = ['facilitator.ultravioletadao.xyz'];

/** Plain http carries the key only to these, and only when the client lists them. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];

/** The stack key options every facilitator client of this SDK takes. */
export interface StackKeyOptions {
  /**
   * Stack key of a service run by Ultravioleta DAO, sent as `X-UVD-Stack-Key`
   * on the calls this client makes to the facilitator. The facilitator exempts
   * a key it recognises from its rate-limit policy (`429`) and changes nothing
   * else; a facilitator that does not know the header ignores it. Third-party
   * integrations have no key and need none.
   *
   * Default: `process.env.UVD_STACK_KEY`, read once when the client is built.
   * `''` sends none and does not read the environment. Surrounding whitespace
   * is removed. A value that is not `uvdsk_` followed by 43-128 base64url
   * characters is not sent: the client warns once, without the value, and
   * pays like any other client.
   *
   * The key only goes to a house facilitator: over `https://` to
   * `facilitator.ultravioletadao.xyz` or to a host in {@link stackKeyHosts}.
   * A client with any other base URL sends no header -- whether the key came
   * from this option or from the environment -- and warns once, naming the
   * host and never the key.
   */
  stackKey?: string;
  /**
   * More hosts that may receive the stack key. They are ADDED to
   * `facilitator.ultravioletadao.xyz`, which cannot be removed (to send no key
   * at all, pass `stackKey: ''`). Hostnames only, no scheme, port or path;
   * each is compared with the base URL's hostname exactly, ignoring case.
   * Over `https://` only, except `127.0.0.1` and `localhost`, which, when
   * listed here, may also receive the key over plain `http://` (a local
   * facilitator or a test double).
   */
  stackKeyHosts?: string[];
}

/**
 * The key of each client, held here and not on the client: a field would print
 * with the client (`console.log`, `util.inspect`, `JSON.stringify`), and the
 * key with it.
 */
const keys = new WeakMap<object, string>();

/** One warning per process and per reason, however many clients are built. */
let warnedFormat = false;
let warnedHost = false;

function readEnv(): unknown {
  try {
    return typeof process !== 'undefined' ? process.env?.UVD_STACK_KEY : undefined;
  } catch {
    // A runtime that guards its environment (Deno without --allow-env) throws
    // on the read. No key is not a reason to fail building the client.
    return undefined;
  }
}

/** The `stackKey` option, or else `UVD_STACK_KEY`, trimmed and checked. */
function resolveKey(option: unknown): string | undefined {
  const fromOption = option !== undefined && option !== null;
  const raw = fromOption ? option : readEnv();
  if (raw === undefined || raw === null) return undefined;
  const key = typeof raw === 'string' ? raw.trim() : undefined;
  if (key === '') return undefined;
  if (key !== undefined && STACK_KEY_FORMAT.test(key)) return key;
  if (!warnedFormat) {
    warnedFormat = true;
    // The value is left out on purpose, and so is anything derived from it.
    console.warn(
      `[x402] stack key ignored (${fromOption ? 'stackKey option' : 'UVD_STACK_KEY'}): ` +
        `it is not "uvdsk_" followed by 43-128 base64url characters. ` +
        `Requests go out without ${STACK_KEY_HEADER}.`,
    );
  }
  return undefined;
}

/** The `stackKeyHosts` option as lowercase hostnames; anything else is dropped. */
function listedHosts(option: unknown): string[] {
  if (!Array.isArray(option)) return [];
  return option
    .filter((host): host is string => typeof host === 'string')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '');
}

/** https to a house host or a listed one; plain http only to a listed loopback host. */
function isHouseFacilitator(url: URL, listed: readonly string[]): boolean {
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'https:') return HOUSE_FACILITATOR_HOSTS.includes(host) || listed.includes(host);
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.includes(host) && listed.includes(host);
  return false;
}

/**
 * Decide, once, whether `client` sends a stack key to `baseUrl`, and which.
 * Never throws.
 */
export function bindStackKey(client: object, options: StackKeyOptions | undefined, baseUrl: string): void {
  const key = resolveKey(options?.stackKey);
  if (key === undefined) return;
  let url: URL | undefined;
  try {
    url = new URL(baseUrl);
  } catch {
    url = undefined;
  }
  if (url !== undefined && isHouseFacilitator(url, listedHosts(options?.stackKeyHosts))) {
    keys.set(client, key);
    return;
  }
  if (!warnedHost) {
    warnedHost = true;
    // Scheme and host only: a base URL can carry credentials in its userinfo,
    // path or query, and the key stays out of it like everywhere else.
    const where = url !== undefined ? `${url.protocol}//${url.host}` : 'an unparseable base URL';
    console.warn(
      `[x402] stack key not sent: ${where} is not a house facilitator. ` +
        `The key goes only over https to ${HOUSE_FACILITATOR_HOSTS.join(', ')} or to a host in ` +
        `stackKeyHosts (plain http only to 127.0.0.1 or localhost listed there).`,
    );
  }
}

/** `headers` plus the client's stack key, when it has one. */
export function withStackKey(client: object, headers: Record<string, string>): Record<string, string> {
  const key = keys.get(client);
  return key === undefined ? headers : { ...headers, [STACK_KEY_HEADER]: key };
}
