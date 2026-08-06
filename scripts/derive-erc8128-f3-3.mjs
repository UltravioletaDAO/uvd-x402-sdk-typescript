#!/usr/bin/env node
/**
 * Derive the additive F3-3 ERC-8128 conformance vectors — THE single artefact.
 *
 * PROVENANCE — read this before touching the output file.
 *
 * F3-1 (`src/erc8128/erc8128.f3-1.json`) is a byte-identical copy of the
 * fleet's source of truth, `execution-market/shared/test-vectors/erc8128.json`
 * (9275 bytes, LF, sha256 3c82d81f66cc95c452dbb2892c4aee97c688dc5fe03b721d06c92ba98e4f9bfd).
 * It pins six wire vectors.
 *
 * F3-3 is ADDITIVE: it adds the cases where the fleet has three incompatible
 * Content-Digest predicates and no vector at all — a bodyless POST, a bodyless
 * DELETE and a POST with an empty-string body — plus a query-less GET, a
 * non-ASCII path that pins the EIP-191 UTF-8 BYTE length, the `legacy_no_alg`
 * twin of each, the policy presets as data, and the verify matrix.
 *
 * ONE FILE, THREE REPOS. The output must be byte-identical in:
 *   - uvd-x402-sdk-typescript  src/erc8128/erc8128.f3-3.json
 *   - uvd-x402-sdk-python      src/uvd_x402_sdk/erc8128/erc8128.f3-3.json
 *   - execution-market         shared/test-vectors/erc8128.f3-3.json
 * `--mirror` writes all copies it can resolve; `--check` fails on any drift.
 * `scripts/xlang/cross-language-conformance.mjs` re-checks the two SDK copies
 * on every CI run, so a hand-edited copy cannot stay green.
 *
 * These vectors are derived here with the SAME synthetic public test key that
 * already lives in the F3-1 fixture (`frozen.private_key`, stored without the
 * 0x prefix, documented there as a key that never held funds). Nothing secret
 * is read, written or printed by this script. The key is NOT copied into F3-3:
 * both SDKs read it from F3-1, and duplicating key material — even synthetic —
 * doubles the surface a secret scanner has to be right about.
 *
 * The derivation is anchored, not invented: four of the produced signatures
 * are pinned independently in the design spec
 * (docs/plans/UVD_SDK_ERC8128_UNIFICATION_SPEC.md §5.2, vectors V1/V4/V5/V7)
 * and `src/erc8128/conformance.test.ts` asserts those four literal strings, so
 * a silent drift in this script fails the suite.
 *
 * Signatures are deterministic (RFC 6979): re-running this script on the same
 * inputs reproduces the same bytes.
 *
 * Usage:  node scripts/derive-erc8128-f3-3.mjs [--check] [--mirror]
 *   --check   derive into memory and diff against every resolvable copy
 *   --mirror  also write the Python and execution-market copies
 *
 * Sibling repos are resolved from `UVD_X402_PY_ROOT` / `EM_ROOT`, falling back
 * to `../uvd-x402-sdk-python` and `../execution-market`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SRC = join(REPO, 'src', 'erc8128');
const F3_1_PATH = join(SRC, 'erc8128.f3-1.json');
const OUT_PATH = join(SRC, 'erc8128.f3-3.json');

const PY_ROOT = resolve(process.env.UVD_X402_PY_ROOT ?? join(REPO, '..', 'uvd-x402-sdk-python'));
const EM_ROOT = resolve(process.env.EM_ROOT ?? join(REPO, '..', 'execution-market'));

/**
 * Every copy of the one artefact, in the order they are reported. `root` is the
 * repo it lives in: when the repo IS checked out its copy is REQUIRED (missing
 * or stale = exit 1); only a repo that is absent entirely is reported as
 * out of scope for this run, which is the one honest form of "not checked".
 */
const COPIES = [
  { label: 'typescript', root: REPO, path: OUT_PATH },
  {
    label: 'python',
    root: PY_ROOT,
    path: join(PY_ROOT, 'src', 'uvd_x402_sdk', 'erc8128', 'erc8128.f3-3.json'),
  },
  {
    label: 'execution-market',
    root: EM_ROOT,
    path: join(EM_ROOT, 'shared', 'test-vectors', 'erc8128.f3-3.json'),
  },
];

const f3_1 = JSON.parse(readFileSync(F3_1_PATH, 'utf8'));
const FROZEN = f3_1.frozen;

// The fixture stores the key without the 0x prefix (the pre-commit secret
// scanner blocks a literal 0x + 64 hex). Re-prefix at runtime; never inline.
const wallet = new ethers.Wallet(`0x${FROZEN.private_key}`);
const KEYID = `erc8128:${FROZEN.chain_id}:${FROZEN.address}`;

/** The new requests. post_emptybody is the SAME call as post_nobody — that is
 *  the whole point: `body-present` emits a digest of "" there, `body-truthy`
 *  emits no digest at all, and the two produce different bytes.
 *  utf8_path is the one vector whose signature base is longer in BYTES than in
 *  characters: an implementation that measures the EIP-191 prefix in
 *  characters signs a different message and only this vector catches it.
 *
 *  THE `authority_*` BLOCK EXISTS BECAUSE NOTHING ELSE HERE COULD SEE THE
 *  AUTHORITY RULE. Every other pinned URL is lowercase with no explicit port,
 *  so `@authority` comes out the same under the correct per-scheme rule and
 *  under the scheme-blind one that used to ship. A guard that cannot fail is
 *  not a guard: reverting either SDK's authority handling left all 180
 *  cross-language checks green. These six are the SAME call written six ways;
 *  three normalise down to the bare host and three keep a port, and the last
 *  two only keep it under the per-scheme rule. */
const REQUESTS = {
  get_noquery: {
    method: 'GET',
    url: 'https://api.execution.market/api/v1/tasks',
    body: null,
  },
  post_nobody: {
    method: 'POST',
    url: 'https://api.execution.market/api/v1/tasks/abc/cancel',
    body: null,
  },
  delete_nobody: {
    method: 'DELETE',
    url: 'https://api.execution.market/api/v1/tasks/abc',
    body: null,
  },
  post_emptybody: {
    method: 'POST',
    url: 'https://api.execution.market/api/v1/tasks/abc/cancel',
    body: '',
  },
  utf8_path: {
    method: 'GET',
    url: 'https://api.execution.market/api/v1/tareas/ñandú?buscar=café',
    body: null,
  },

  // ── the authority rule, made observable ────────────────────────────────
  // Formatting only: an uppercase host lowercases, and a port that IS this
  // scheme's default is not part of @authority. All three sign the exact
  // bytes canonical/get_noquery signs.
  authority_uppercase_host: {
    method: 'GET',
    url: 'https://API.EXECUTION.MARKET/api/v1/tasks',
    body: null,
  },
  authority_https_on_443: {
    method: 'GET',
    url: 'https://api.execution.market:443/api/v1/tasks',
    body: null,
  },
  authority_http_on_80: {
    method: 'GET',
    url: 'http://api.execution.market:80/api/v1/tasks',
    body: null,
  },
  // A non-default port IS part of the authority and is signed.
  authority_https_on_8443: {
    method: 'GET',
    url: 'https://api.execution.market:8443/api/v1/tasks',
    body: null,
  },
  // THE TWO THAT SEPARATE THE RULES. 443 is ordinary under http and 80 is
  // ordinary under https, so both are PRESERVED: these sign
  // `api.execution.market:443` and `api.execution.market:80`. A scheme-blind
  // "drop 443 and 80" rule signs the bare host for both and moves these two
  // pinned signatures — which is exactly how the sabotage is detected.
  authority_http_on_443: {
    method: 'GET',
    url: 'http://api.execution.market:443/api/v1/tasks',
    body: null,
  },
  authority_https_on_80: {
    method: 'GET',
    url: 'https://api.execution.market:80/api/v1/tasks',
    body: null,
  },
};

function contentDigest(body) {
  const b64 = ethers.encodeBase64(ethers.getBytes(ethers.sha256(ethers.toUtf8Bytes(body))));
  return `sha-256=:${b64}:`;
}

/** The default port of each scheme this SDK speaks. Written out here rather
 *  than imported: this script is the INDEPENDENT emitter, and importing the
 *  table from the code under test would let one typo agree with itself. */
const DEFAULT_PORTS = { http: '80', https: '443', ws: '80', wss: '443' };

/**
 * Split a URL the way the wire does: RAW. `new URL()` is deliberately NOT used
 * — it percent-encodes a non-ASCII path, and `utf8_path` would then be signed
 * over `/api/v1/tareas/%C3%B1and%C3%BA` in TypeScript and over the raw UTF-8
 * in Python's `urlsplit()`. Same URL, two signature bases, one silent 401.
 *
 * The AUTHORITY is normalised per RFC 9421 §2.2.3: lowercased, and the port
 * dropped only when it is the default FOR THIS URL'S OWN SCHEME. `:443` under
 * `http` and `:80` under `https` are ordinary ports there and stay.
 */
function splitUrl(url) {
  const absolute = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(url);
  let authority;
  if (absolute) {
    const lower = absolute[2].toLowerCase();
    const portAt = lower.lastIndexOf(':');
    // `lastIndexOf(']')` is what keeps an IPv6 literal's own colons from
    // reading as a port.
    const port = portAt > lower.lastIndexOf(']') ? lower.slice(portAt + 1) : undefined;
    authority =
      port !== undefined && port === DEFAULT_PORTS[absolute[1].toLowerCase()]
        ? lower.slice(0, portAt)
        : lower;
  }
  let rest = absolute ? url.slice(absolute[0].length) : url;
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  const mark = rest.indexOf('?');
  const path = (mark >= 0 ? rest.slice(0, mark) : rest) || '/';
  const rawQuery = mark >= 0 ? rest.slice(mark + 1) : '';
  return { authority, path, query: rawQuery ? `?${rawQuery}` : undefined };
}

/** Independent re-implementation of the canonical emitter (em_plugin_sdk/
 *  erc8128.py:222-278). Deliberately NOT importing the SDK module under test —
 *  golden data must not be generated by the code it pins. */
function buildBase({ method, authority, path, query, digest, covered, alg }) {
  const lines = [];
  for (const component of covered) {
    if (component === '@method') lines.push(`"@method": ${method.toUpperCase()}`);
    else if (component === '@authority') lines.push(`"@authority": ${authority}`);
    else if (component === '@path') lines.push(`"@path": ${path}`);
    else if (component === '@query') lines.push(`"@query": ${query || '?'}`);
    else if (component === 'content-digest') lines.push(`"content-digest": ${digest || ''}`);
  }
  const compStr = covered.map((c) => `"${c}"`).join(' ');
  const parts = [
    `(${compStr})`,
    `created=${FROZEN.created}`,
    `expires=${FROZEN.expires}`,
    `nonce="${FROZEN.nonce}"`,
    `keyid="${KEYID}"`,
  ];
  if (alg) parts.push('alg="eip191"');
  const sigParams = parts.join(';');
  lines.push(`"@signature-params": ${sigParams}`);
  return { base: lines.join('\n'), sigParams };
}

async function makeVector(request, { alg }) {
  const { authority, path, query } = splitUrl(request.url);
  const covered = ['@method', '@authority', '@path'];
  if (query) covered.push('@query');
  let digest;
  if (request.body !== null && request.body !== undefined) {
    digest = contentDigest(request.body);
    covered.push('content-digest');
  }

  const { base: signatureBase, sigParams } = buildBase({
    method: request.method,
    authority,
    path,
    query,
    digest,
    covered,
    alg,
  });

  const sigHex = await wallet.signMessage(signatureBase);
  const sigB64 = ethers.encodeBase64(ethers.getBytes(sigHex));

  const headers = {
    Signature: `eth=:${sigB64}:`,
    'Signature-Input': `eth=${sigParams}`,
  };
  if (digest) headers['Content-Digest'] = digest;

  return { signature_base: signatureBase, headers };
}

/** The three live postures, as DATA — nonce mode and consume ORDER included,
 *  because the ordering belongs to the preset even though the store does not.
 *
 *  SNAKE_CASE, FLAT. This block is read by BOTH SDKs, so it cannot carry one
 *  language's field spelling: it is the wire projection, in the same casing as
 *  every other key in F3-1 and F3-3 (`content_digest`, `chain_id`,
 *  `observed_profile`). TypeScript's `presetAsData()` and Python's
 *  `preset_as_data()` both emit exactly this and both assert deep-equality
 *  against it, so a preset edited without a matching vector edit fails the
 *  suite in BOTH languages (spec §5.2, "Bloque policies"). */
const POLICIES = {
  'meshrelay-strict': {
    accept: 'accept-both',
    components: 'exact-ordered',
    content_digest: 'non-idempotent-methods',
    allowed_chain_ids: [8453],
    max_validity_sec: 300,
    clock_skew_future_sec: 30,
    clock_skew_past_expiry_sec: 0,
    label: 'eth',
    nonce_mode: 'required',
    nonce_consume: 'after-verify',
  },
  'em-lenient': {
    accept: 'accept-both',
    components: 'request-bound-subset',
    content_digest: 'body-present',
    allowed_chain_ids: null,
    max_validity_sec: 300,
    clock_skew_future_sec: 30,
    clock_skew_past_expiry_sec: 30,
    label: 'any',
    nonce_mode: 'required',
    nonce_consume: 'before-verify',
  },
  // "strict" that accepts any chain is not strict: 8453 is the production auth
  // chain of both products.
  'canonical-strict': {
    accept: 'canonical',
    components: 'exact-ordered',
    content_digest: 'body-present',
    allowed_chain_ids: [8453],
    max_validity_sec: 300,
    clock_skew_future_sec: 30,
    clock_skew_past_expiry_sec: 0,
    label: 'eth',
    nonce_mode: 'required',
    nonce_consume: 'after-verify',
  },
};

const WALLET = FROZEN.address;

/** The authority the fleet actually runs, and the default a verify case gets
 *  when it does not name one. `frozen.authority` in the output. */
const AUTHORITY = 'api.execution.market';

/**
 * The FULL matrix: every vector across both generations × all three postures.
 *
 * `observed_profile` is carried on reject rows too — the profile a verifier
 * REPORTS for a rejected signature is part of the contract (it is what an
 * operator greps for when the fleet starts failing), and leaving it off the
 * reject rows is how the two suites ended up pinning different things. It is
 * `null` when the request is refused before `Signature-Input` is ever parsed,
 * which is where a misconfigured authority lands.
 *
 * `status` is pinned on every reject row. The distinction the authority rule
 * turns on is 401-vs-503 — blame the client, or blame the operator — and a
 * matrix that pins only the code lets one side answer 401 for a config typo
 * and still look green.
 *
 * `authority` is the value CONFIGURED into the policy, omitted when it is the
 * plain `frozen.authority`. It is a per-case field because the configured
 * authority is not derivable from the request: that is the entire content of
 * rule R2, and a runner that derived it from the URL (Python did, from
 * `urlsplit().netloc`) silently tested a different rule than one that read it
 * from `frozen` (TypeScript did).
 */
const VERIFY_CASES = [
  // The three postures agree on everything the fleet actually emits today.
  { vector_id: 'canonical/get_query', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/get_query', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/get_query', policy: 'canonical-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/post_body', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/post_body', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/post_body', policy: 'canonical-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/get_noquery', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/get_noquery', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/get_noquery', policy: 'canonical-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },

  // Empty-string body: signer and EM's verifier classify it differently
  // (`body is not None` vs content-length "0") but agree on the bytes, because
  // a voluntarily covered digest is still verified.
  { vector_id: 'canonical/post_emptybody', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/post_emptybody', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/post_emptybody', policy: 'canonical-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },

  // Non-ASCII path: the byte-vs-character trap in the EIP-191 prefix.
  { vector_id: 'canonical/utf8_path', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/utf8_path', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/utf8_path', policy: 'canonical-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },

  // THE open contract divergence (spec §3.4 / §10 Q1): a bodyless POST and any
  // bodyless DELETE pass at EM and 401 at MeshRelay.
  { vector_id: 'canonical/post_nobody', policy: 'meshrelay-strict', expect: 'reject', code: 'content_digest_required', status: 401, observed_profile: 'canonical' },
  { vector_id: 'canonical/post_nobody', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/post_nobody', policy: 'canonical-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/delete_nobody', policy: 'meshrelay-strict', expect: 'reject', code: 'content_digest_required', status: 401, observed_profile: 'canonical' },
  { vector_id: 'canonical/delete_nobody', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/delete_nobody', policy: 'canonical-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },

  // Legacy tolerance: both live postures accept it, canonical-strict (S3) does not.
  { vector_id: 'legacy_no_alg/get_query', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/get_query', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/get_query', policy: 'canonical-strict', expect: 'reject', code: 'alg_missing', status: 401, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/post_body', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/post_body', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/post_body', policy: 'canonical-strict', expect: 'reject', code: 'alg_missing', status: 401, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/get_noquery', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/get_noquery', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/get_noquery', policy: 'canonical-strict', expect: 'reject', code: 'alg_missing', status: 401, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/post_emptybody', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/post_emptybody', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/post_emptybody', policy: 'canonical-strict', expect: 'reject', code: 'alg_missing', status: 401, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/utf8_path', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/utf8_path', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/utf8_path', policy: 'canonical-strict', expect: 'reject', code: 'alg_missing', status: 401, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/post_nobody', policy: 'meshrelay-strict', expect: 'reject', code: 'content_digest_required', status: 401, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/post_nobody', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/post_nobody', policy: 'canonical-strict', expect: 'reject', code: 'alg_missing', status: 401, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/delete_nobody', policy: 'meshrelay-strict', expect: 'reject', code: 'content_digest_required', status: 401, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/delete_nobody', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_no_alg' },
  { vector_id: 'legacy_no_alg/delete_nobody', policy: 'canonical-strict', expect: 'reject', code: 'alg_missing', status: 401, observed_profile: 'legacy_no_alg' },

  { vector_id: 'legacy_alg_checksum_keyid/get_query', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_alg_checksum_keyid' },
  { vector_id: 'legacy_alg_checksum_keyid/get_query', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_alg_checksum_keyid' },
  { vector_id: 'legacy_alg_checksum_keyid/get_query', policy: 'canonical-strict', expect: 'reject', code: 'keyid_not_lowercase', status: 401, observed_profile: 'legacy_alg_checksum_keyid' },
  { vector_id: 'legacy_alg_checksum_keyid/post_body', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_alg_checksum_keyid' },
  { vector_id: 'legacy_alg_checksum_keyid/post_body', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'legacy_alg_checksum_keyid' },
  { vector_id: 'legacy_alg_checksum_keyid/post_body', policy: 'canonical-strict', expect: 'reject', code: 'keyid_not_lowercase', status: 401, observed_profile: 'legacy_alg_checksum_keyid' },

  // ── R1 · the URL-derived rule, observed end to end ───────────────────────
  // Uppercase host and a default port FOR THE URL'S OWN SCHEME are formatting:
  // all three sign the bare host and verify against the plain configured
  // authority under every posture.
  { vector_id: 'canonical/authority_uppercase_host', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/authority_uppercase_host', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/authority_uppercase_host', policy: 'canonical-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/authority_https_on_443', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/authority_https_on_443', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/authority_https_on_443', policy: 'canonical-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/authority_http_on_80', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/authority_http_on_80', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },
  { vector_id: 'canonical/authority_http_on_80', policy: 'canonical-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical' },

  // A NON-default port is part of the authority. Configure it the way it is
  // signed and it verifies; strip it and the base no longer recovers the
  // signer — which is what makes the port load-bearing rather than cosmetic.
  { vector_id: 'canonical/authority_https_on_8443', policy: 'meshrelay-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical', authority: 'api.execution.market:8443' },
  { vector_id: 'canonical/authority_https_on_8443', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'canonical', authority: 'api.execution.market:8443' },
  { vector_id: 'canonical/authority_https_on_8443', policy: 'canonical-strict', expect: 'accept', wallet: WALLET, observed_profile: 'canonical', authority: 'api.execution.market:8443' },
  { vector_id: 'canonical/authority_https_on_8443', policy: 'em-lenient', expect: 'reject', code: 'wallet_mismatch', status: 401, observed_profile: 'canonical', authority: AUTHORITY },

  // THE TWO ROWS THE OLD MATRIX COULD NOT EXPRESS. `:443` under http and `:80`
  // under https are ordinary ports, so the signer keeps them. A scheme-blind
  // rule drops them, the base becomes the bare host, and these two would
  // ACCEPT against the portless authority. They must reject.
  { vector_id: 'canonical/authority_http_on_443', policy: 'em-lenient', expect: 'reject', code: 'wallet_mismatch', status: 401, observed_profile: 'canonical', authority: AUTHORITY },
  { vector_id: 'canonical/authority_https_on_80', policy: 'em-lenient', expect: 'reject', code: 'wallet_mismatch', status: 401, observed_profile: 'canonical', authority: AUTHORITY },

  // ── R2 · the CONFIGURED authority ────────────────────────────────────────
  // …and those same two deployments cannot CONFIGURE what they sign: a default
  // port of EITHER scheme in the configured value is an operator error. 503,
  // with its own message, never a 401 aimed at a client that did nothing wrong.
  { vector_id: 'canonical/authority_http_on_443', policy: 'em-lenient', expect: 'reject', code: 'authority_invalid', status: 503, observed_profile: null, authority: 'api.execution.market:443' },
  { vector_id: 'canonical/authority_https_on_80', policy: 'em-lenient', expect: 'reject', code: 'authority_invalid', status: 503, observed_profile: null, authority: 'api.execution.market:80' },

  // The configured value is lowercased and trimmed — FORMATTING — and nothing
  // else. Both of these are the same authority written badly, and both accept.
  { vector_id: 'canonical/get_noquery', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'canonical', authority: 'API.Execution.Market' },
  { vector_id: 'canonical/get_noquery', policy: 'em-lenient', expect: 'accept', wallet: WALLET, observed_profile: 'canonical', authority: '  api.execution.market\t' },

  // Every one of these is a 503 the operator has to fix. CR, LF, VT, FF and
  // NBSP are named individually because they used to pass the blacklist and get
  // EMBEDDED verbatim into the rebuilt signature base — a corrupted base that
  // then answered 401, blaming the client for the server's config.
  //
  // THE LAST ROW CONTAINS A LITERAL U+00A0 (NBSP) BETWEEN `execution` and
  // `market`. It looks like a space and is not one. It is here because JS `\s`
  // matches NBSP and Python `\s` does not, so a rule written `\s` on both sides
  // rejects two DIFFERENT input sets; both SDKs enumerate the class instead,
  // and this row is what proves the two enumerations agree. escapeInvisible()
  // below turns it into a visible ` ` on the way into the JSON, so the
  // shared artefact carries no invisible bytes even though this source does.
  { vector_id: 'canonical/get_noquery', policy: 'em-lenient', expect: 'reject', code: 'authority_invalid', status: 503, observed_profile: null, authority: 'api.execution\nmarket' },
  { vector_id: 'canonical/get_noquery', policy: 'em-lenient', expect: 'reject', code: 'authority_invalid', status: 503, observed_profile: null, authority: 'api.execution\rmarket' },
  { vector_id: 'canonical/get_noquery', policy: 'em-lenient', expect: 'reject', code: 'authority_invalid', status: 503, observed_profile: null, authority: 'api.execution\vmarket' },
  { vector_id: 'canonical/get_noquery', policy: 'em-lenient', expect: 'reject', code: 'authority_invalid', status: 503, observed_profile: null, authority: 'api.execution\fmarket' },
  { vector_id: 'canonical/get_noquery', policy: 'em-lenient', expect: 'reject', code: 'authority_invalid', status: 503, observed_profile: null, authority: 'api.execution market' },
];

async function derive() {
  const vectors = { canonical: {}, legacy_no_alg: {} };
  for (const [name, request] of Object.entries(REQUESTS)) {
    vectors.canonical[name] = await makeVector(request, { alg: true });
    vectors.legacy_no_alg[name] = await makeVector(request, { alg: false });
  }

  return {
    _note: [
      'F3-3 ADDITIVE conformance vectors for ERC-8128. F3-1 stays the pinned',
      'wire format; this file only adds cases F3-1 has no vector for — a',
      'bodyless POST, a bodyless DELETE, a POST with an empty-string body, a',
      'query-less GET and a non-ASCII path that pins the EIP-191 UTF-8 BYTE',
      'length — plus their legacy_no_alg twins, the policy presets as data,',
      'and the verify matrix that turns accept/reject into data instead of two',
      'hand-written suites.',
      'THIS FILE IS ONE ARTEFACT. It must stay BYTE-IDENTICAL in uvd-x402-sdk',
      '(npm) src/erc8128/, uvd-x402-sdk (PyPI) src/uvd_x402_sdk/erc8128/ and',
      'execution-market shared/test-vectors/. It is stored LF and read as',
      'BYTES; every repo pins it to LF in .gitattributes so a Windows checkout',
      'cannot change its hash. Never hand-edit a copy: run',
      '`npm run vectors:gen` in the TypeScript SDK and commit all three.',
      'Generated by scripts/derive-erc8128-f3-3.mjs with the SAME synthetic',
      'public test key already published in erc8128.f3-1.json (frozen.',
      'private_key — a key that never held funds). It is NOT duplicated here;',
      'both SDKs read it from F3-1. Signatures are deterministic (RFC 6979),',
      'so the derivation is reproducible.',
      'Four of these signatures (canonical/get_noquery, canonical/post_nobody,',
      'canonical/delete_nobody, canonical/post_emptybody) are pinned',
      'independently as V1/V4/V5/V7 in the design spec and asserted as literal',
      'strings in src/erc8128/conformance.test.ts.',
      'The authority_* requests and the verify_cases that carry their own',
      '`authority` exist because NOTHING ELSE HERE COULD SEE THE AUTHORITY',
      'RULE: every other pinned URL is lowercase with no explicit port, so the',
      'per-scheme rule and the scheme-blind one produce the same bytes for all',
      'of them. Reverting either SDK to the scheme-blind rule left the whole',
      'cross-language run green. A guard that cannot fail is not a guard.',
      'Two of these vectors carry a control character or a U+00A0 NBSP inside a',
      'CONFIGURED authority; they are written as \\uXXXX escapes so the bytes',
      'are visible in an editor and survive a copy-paste between the three',
      'repos.',
    ],
    generation: 'F3-3',
    extends: 'F3-1',
    frozen: {
      // The private key is NOT duplicated here; loaders read it from F3-1.
      address: FROZEN.address,
      address_checksummed: FROZEN.address_checksummed,
      chain_id: FROZEN.chain_id,
      created: FROZEN.created,
      expires: FROZEN.expires,
      nonce: FROZEN.nonce,
      authority: AUTHORITY,
      label: 'eth',
    },
    policy: {
      // The authority rule, as the table it was decided from. `signs` is the
      // `@authority` line the SIGNER emits for that deployment; `configure` is
      // what the operator must put in `VerifyPolicy.authority`. The last two
      // rows are the ones a scheme-blind rule gets wrong, and the ones whose
      // configured value is REFUSED (503) rather than silently re-normalised.
      authority: {
        decided: '2026-08-06 (owner, R1/R2/R3)',
        url_rule: 'rfc9421-2.2.3, default port of THAT scheme only',
        configured_rule: 'lowercase + trim, ports NEVER touched',
        shapes: [
          { deployment: 'https on :443', url_authority: 'host:443', signs: 'host', configure: 'host' },
          { deployment: 'http on :80', url_authority: 'host:80', signs: 'host', configure: 'host' },
          { deployment: 'https on :8443', url_authority: 'host:8443', signs: 'host:8443', configure: 'host:8443' },
          { deployment: 'https on :80', url_authority: 'host:80', signs: 'host:80', configure: null },
          { deployment: 'http on :443', url_authority: 'host:443', signs: 'host:443', configure: null },
        ],
        note: [
          'A CONFIGURED authority is the EXPECTED OUTPUT of the URL rule, not',
          'another input to it: it carries no scheme, so "the default port"',
          'has no answer for it and every guess breaks a real deployment.',
          'Hence `configure: null` on the last two rows — they sign a default',
          'port, and a config carrying one is answered 503 authority_invalid',
          'with a message naming the fix. 503 and not 401: the operator made',
          'the mistake, and a client cannot see, let alone fix, it.',
        ],
      },
      content_digest: {
        decided: '2026-08-03 (owner, spec §10 Q1)',
        rule: 'body-present',
        note: [
          "Execution Market's body-presence rule is canonical for the SDK: a",
          'Content-Digest is REQUIRED, and MUST be in the signed component',
          'list, if and only if the request carries a body. A bodyless request',
          'may cover it voluntarily, in which case it is still verified.',
          'MeshRelay keeps its method-driven rule via the',
          "'non-idempotent-methods' knob, so adopting the SDK changes none of",
          'its behaviour.',
        ],
      },
    },
    requests: REQUESTS,
    vectors,
    policies: POLICIES,
    verify_cases: VERIFY_CASES,
  };
}

const derived = await derive();

/**
 * `JSON.stringify` escapes the C0 controls but emits U+00A0 as a raw byte pair.
 * This artefact is compared BYTE for byte across three repos and pinned by
 * sha256, so an invisible character in it is a hash that no reviewer can see
 * and that any well-meaning editor can silently "clean". Escape it. Both
 * parsers decode `\\u00a0` to exactly the same code point, so the VALUE the
 * vectors carry is unchanged — only its spelling on disk is.
 */
function escapeInvisible(json) {
  return json.replace(/ /g, '\\u00a0');
}

// LF, always. The bytes ARE the contract: CONFORMANCE_SHA256 covers them and
// three repos compare them.
const text = `${escapeInvisible(JSON.stringify(derived, null, 2))}\n`;

const check = process.argv.includes('--check');
const mirror = process.argv.includes('--mirror');
const targets = check || mirror ? COPIES : [COPIES[0]];

let drift = 0;
let outOfScope = 0;
for (const copy of targets) {
  if (!existsSync(copy.root)) {
    console.log(`  · ${copy.label}: repo not checked out at ${copy.root} — out of scope here`);
    outOfScope += 1;
    continue;
  }
  if (!existsSync(copy.path)) {
    // The repo IS here, so its copy of the artefact has to be here too.
    console.error(`  ✗ ${copy.label}: MISSING at ${copy.path}`);
    if (!check) {
      writeFileSync(copy.path, Buffer.from(text, 'utf8'));
      console.log(`    wrote it`);
      continue;
    }
    drift += 1;
    continue;
  }
  if (check) {
    // Read as BYTES and compare to the UTF-8 bytes we would write: a CRLF
    // working copy is drift, not a formatting detail.
    const current = readFileSync(copy.path);
    if (!current.equals(Buffer.from(text, 'utf8'))) {
      console.error(`  ✗ ${copy.label}: ${copy.path} differs from the derivation`);
      drift += 1;
    } else {
      console.log(`  ✓ ${copy.label}: ${copy.path}`);
    }
  } else {
    writeFileSync(copy.path, Buffer.from(text, 'utf8'));
    console.log(`wrote ${copy.path} (${Buffer.byteLength(text, 'utf8')} bytes)`);
  }
}

if (check) {
  if (drift) {
    console.error(
      `erc8128.f3-3.json is stale in ${drift} copy/copies — run: node scripts/derive-erc8128-f3-3.mjs --mirror`
    );
    process.exit(1);
  }
  console.log(
    `erc8128.f3-3.json is up to date (${targets.length - outOfScope} of ${targets.length} copies checked)`
  );
}
