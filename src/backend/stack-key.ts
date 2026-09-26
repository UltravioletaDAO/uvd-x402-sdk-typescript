/**
 * Stack key: the credential a service run by Ultravioleta DAO presents to the
 * facilitator, so that the facilitator's rate-limit policy does not answer it
 * `429`. It changes nothing else, and a facilitator that does not know the
 * header ignores it. Third-party integrations have no key and need none.
 *
 * The rules this file exists for:
 *
 * 1. A key that was read badly never breaks a payment. A key read from a file
 *    with a BOM or a trailing `\r\n`, or a value no header can carry, would
 *    make the HTTP layer throw before sending -- every `/verify` and `/settle`
 *    of the client would fail, and the thrown message would carry the value.
 *    So the key is cleaned and checked once, when the client is built; a key
 *    that does not pass is not sent, the client warns once without the value,
 *    and pays like any other client.
 * 2. The key only travels to a house facilitator. `UVD_STACK_KEY` is read by
 *    every client in the process, and a service may point one of them at a
 *    facilitator somebody else runs; that operator must never receive the key.
 *    So the URL of every request is checked before the key is attached.
 * 3. The key does not follow redirects. A request that carries the key goes
 *    out with `redirect: 'manual'`, and a redirect is answered with
 *    {@link StackKeyRedirectError}: the key is never sent again.
 *
 * {@link stackKeyFetch} is the only place the header is attached, so all three
 * hold wherever the SDK sends it.
 */

/** Header that carries the stack key on the facilitator calls that take it. */
export const STACK_KEY_HEADER = 'X-UVD-Stack-Key';

/** `uvdsk_` and 32 random bytes in base64url (43 characters), up to 128. */
const STACK_KEY_FORMAT = /^uvdsk_[A-Za-z0-9_-]{43,128}$/;

/**
 * What is removed before the format check: ONE leading U+FEFF (a BOM from a
 * file), then spaces, tabs, CR and LF at both ends. Nothing else -- the same
 * rule in both SDKs.
 */
const LEADING_BOM = /^\uFEFF/;
const EDGE_WHITESPACE = /^[ \t\r\n]+|[ \t\r\n]+$/g;

/** The facilitator Ultravioleta DAO runs. Always a house facilitator, over https. */
const HOUSE_FACILITATOR_HOSTS: readonly string[] = ['facilitator.ultravioletadao.xyz'];

/** Plain http carries the key only to these, and only when the client lists them. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];

/** The stack key options every client of the facilitator in this SDK takes. */
export interface StackKeyOptions {
  /**
   * Stack key of a service run by Ultravioleta DAO, sent as `X-UVD-Stack-Key`
   * on the calls this client makes to the facilitator. The facilitator exempts
   * a key it recognises from its rate-limit policy (`429`) and changes nothing
   * else; a facilitator that does not know the header ignores it. Third-party
   * integrations have no key and need none.
   *
   * Default: `process.env.UVD_STACK_KEY`, read once when the client is built.
   * `''` sends none and does not read the environment. One leading BOM and
   * the spaces, tabs, CR and LF at both ends are removed. A value that then is
   * not `uvdsk_` followed by 43-128 base64url characters is not sent: the
   * client warns once, without the value, and pays like any other client.
   *
   * The key only goes to a house facilitator: over `https://` to
   * `facilitator.ultravioletadao.xyz` or to a host in {@link stackKeyHosts},
   * checked on the URL of every request. Any other URL gets no header --
   * whether the key came from this option or from the environment -- and the
   * client warns once, naming the host and never the key.
   *
   * A request that carries the key does not follow redirects: a `3xx` answer
   * fails with {@link StackKeyRedirectError} and the key is not sent again.
   */
  stackKey?: string;
  /**
   * More hosts that may receive the stack key. They are ADDED to
   * `facilitator.ultravioletadao.xyz`, which cannot be removed (to send no key
   * at all, pass `stackKey: ''`). Hostnames only, no scheme, port or path;
   * each is compared with the request's hostname exactly, ignoring case.
   * Over `https://` only, except `127.0.0.1` and `localhost`, which, when
   * listed here, may also receive the key over plain `http://` (a local
   * facilitator or a test double).
   */
  stackKeyHosts?: string[];
}

/**
 * A request carrying the stack key was answered with a redirect. The key was
 * not sent to the redirect target and will not be: point the client at the
 * facilitator's final URL.
 */
export class StackKeyRedirectError extends Error {
  /** The redirect status, or `0` for an opaque redirect (browsers). */
  readonly status: number;

  constructor(status: number) {
    super(
      `[x402] the facilitator answered a redirect (${status || 'opaque'}) to a request carrying ` +
        `${STACK_KEY_HEADER}; the stack key does not follow redirects. ` +
        `Point the client at the facilitator's final URL.`,
    );
    this.name = 'StackKeyRedirectError';
    this.status = status;
  }
}

/** What a client may send: the key, and the hosts its options added. */
interface Binding {
  readonly key: string;
  readonly hosts: readonly string[];
}

/**
 * The binding of each client, held here and not on the client: a field would
 * print with the client (`console.log`, `util.inspect`, `JSON.stringify`), and
 * the key with it.
 */
const bindings = new WeakMap<object, Binding>();

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

/** The `stackKey` option, or else `UVD_STACK_KEY`, cleaned and checked. */
function resolveKey(option: unknown): string | undefined {
  const fromOption = option !== undefined && option !== null;
  const raw = fromOption ? option : readEnv();
  if (raw === undefined || raw === null) return undefined;
  const key = typeof raw === 'string' ? raw.replace(LEADING_BOM, '').replace(EDGE_WHITESPACE, '') : undefined;
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
 * Resolve, once, the key `owner` may send and the hosts it added. `owner` is a
 * client, or a throwaway object for a one-off call. Never throws.
 */
export function bindStackKey(owner: object, options: StackKeyOptions | undefined): void {
  const key = resolveKey(options?.stackKey);
  if (key !== undefined) bindings.set(owner, { key, hosts: listedHosts(options?.stackKeyHosts) });
}

/** The key `owner` sends to `url`, or `undefined` when that URL must not get it. */
function keyFor(owner: object, url: string): string | undefined {
  const binding = bindings.get(owner);
  if (binding === undefined) return undefined;
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined && isHouseFacilitator(parsed, binding.hosts)) return binding.key;
  if (!warnedHost) {
    warnedHost = true;
    // Scheme and host only: a URL can carry credentials in its userinfo, path
    // or query, and the key stays out of it like everywhere else.
    const where = parsed !== undefined ? `${parsed.protocol}//${parsed.host}` : 'an unparseable URL';
    console.warn(
      `[x402] stack key not sent: ${where} is not a house facilitator. ` +
        `The key goes only over https to ${HOUSE_FACILITATOR_HOSTS.join(', ')} or to a host in ` +
        `stackKeyHosts (plain http only to 127.0.0.1 or localhost listed there).`,
    );
  }
  return undefined;
}

/** `headers` as a plain record, with the stack key set once, in one spelling. */
function headersWithKey(headers: HeadersInit | undefined, key: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, name) => {
      out[name] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [name, value] of headers) out[name] = value;
  } else if (headers) {
    Object.assign(out, headers);
  }
  for (const name of Object.keys(out)) {
    if (name.toLowerCase() === STACK_KEY_HEADER.toLowerCase()) delete out[name];
  }
  out[STACK_KEY_HEADER] = key;
  return out;
}

/** A 3xx, or the opaque redirect a browser returns for `redirect: 'manual'`. */
function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

/**
 * `fetch(url, init)`, plus the stack key of `owner` when `url` is a house
 * facilitator. With the key the request never follows a redirect: it goes out
 * with `redirect: 'manual'`, and a redirect throws
 * {@link StackKeyRedirectError}. Without it, the request is exactly `init`.
 */
export async function stackKeyFetch(
  owner: object,
  url: string,
  init?: RequestInit,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const doFetch = fetchImpl ?? fetch;
  const key = keyFor(owner, url);
  if (key === undefined) return doFetch(url, init);
  const response = await doFetch(url, { ...init, headers: headersWithKey(init?.headers, key), redirect: 'manual' });
  if (isRedirect(response)) {
    try {
      await response.body?.cancel();
    } catch {
      // Nothing to release.
    }
    throw new StackKeyRedirectError(response.status);
  }
  return response;
}

/** {@link stackKeyFetch} for `owner`, shaped as a `fetch` (for `facilitatorFetch`). */
export function stackKeyFetcher(owner: object, fetchImpl?: typeof fetch): typeof fetch {
  return (input, init) =>
    stackKeyFetch(
      owner,
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      init,
      fetchImpl,
    );
}
