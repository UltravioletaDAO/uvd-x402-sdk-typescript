#!/usr/bin/env node
/**
 * Derive the shared reputation vectors: test/vectors/reputation/*.json.
 *
 * ONE SET OF FILES, TWO SDKs. The same bytes are meant to sit in
 * uvd-x402-sdk-python tests/vectors/reputation/ (same sha256), and each SDK's
 * suite checks its own `reputation` module against them:
 * src/reputation/vectors.test.ts here.
 *
 * INDEPENDENT EMITTER. This script does not import the module it vectors. It
 * rebuilds each value from its source with ethers and node:crypto:
 * - the v4 `RelayedGiveFeedback` typed data and digest from x402-rs
 *   `src/erc8004/relay_v4.rs` (pinned there against the delegate deployed on
 *   Base; `deployedContract` below repeats that pin);
 * - the EIP-7702 authorization digest from ethers' `hashAuthorization`;
 * - `paymentHash` from x402-rs `src/erc8004/types.rs::compute_payment_hash`;
 * - canonical JSON as Python's `json.dumps(sort_keys=True, ensure_ascii=False,
 *   separators=(",", ":"))` writes it;
 * - `messageRef` and commitments with node:crypto.
 * A vector the module then disagrees with is a disagreement between two
 * implementations, not a module checked against itself.
 *
 * Keys come from public seeds: private key = sha256(utf8(seed)). No key is
 * written to any file.
 *
 * Usage:  node scripts/derive-reputation-vectors.mjs [--check]
 *   --check  derive into memory and fail on any difference with the files
 */

import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'test', 'vectors', 'reputation');

const sha256Hex = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const keyOf = (seed) => new ethers.SigningKey('0x' + sha256Hex(seed));
const addressOf = (seed) => ethers.computeAddress(keyOf(seed).publicKey);
const clone = (v) => JSON.parse(JSON.stringify(v));

const RATER_SEED = 'uvd-x402 reputation vectors rater';
const RATER_KEY = keyOf(RATER_SEED);
const RATER = ethers.computeAddress(RATER_KEY.publicKey);
const VIEWER = addressOf('uvd-x402 reputation vectors viewer');
// The salt is written in the files as its seed, like the signer's key: no
// 32-byte secret-shaped literal sits in a file a scanner reads.
const SALT_SEED = 'uvd-x402 reputation vectors salt';
const SALT = '0x' + sha256Hex(SALT_SEED);

const BASE = 8453;
const DELEGATE = '0x260D3D0258680aA458D0EBB8BcAE8A2f68bf6163';
const REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const IDENTITY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ZERO32 = '0x' + '00'.repeat(32);

const DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];
const FIELDS = [
  { name: 'registry', type: 'address' },
  { name: 'agentId', type: 'uint256' },
  { name: 'value', type: 'int128' },
  { name: 'valueDecimals', type: 'uint8' },
  { name: 'tag1', type: 'string' },
  { name: 'tag2', type: 'string' },
  { name: 'endpoint', type: 'string' },
  { name: 'feedbackURI', type: 'string' },
  { name: 'feedbackHash', type: 'bytes32' },
  { name: 'deadline', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
];

// --- canonical JSON, Python's json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":")) ---
function codePointCompare(a, b) {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}
function pyString(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}
function canonical(v) {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`not an integer: ${v}`);
    return String(v);
  }
  if (typeof v === 'string') return pyString(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort(codePointCompare).map((k) => pyString(k) + ':' + canonical(v[k])).join(',') + '}';
}

// --- the facilitator's v4 typed data (x402-rs relay_v4.rs::give_feedback_typed_data) ---
function message(p, deadline, nonce) {
  return {
    registry: REGISTRY,
    agentId: String(p.agentId),
    value: String(p.value),
    valueDecimals: p.valueDecimals ?? 0,
    tag1: p.tag1 ?? '',
    tag2: p.tag2 ?? '',
    endpoint: p.endpoint ?? '',
    feedbackURI: p.feedbackUri ?? '',
    feedbackHash: (p.feedbackHash ?? ZERO32).toLowerCase(),
    deadline: String(deadline),
    nonce,
  };
}
function digestOf(chainId, account, msg) {
  return ethers.TypedDataEncoder.hash(
    { name: 'FeedbackDelegate', version: '1', chainId, verifyingContract: account },
    { RelayedGiveFeedback: FIELDS },
    msg
  ).toLowerCase();
}
function prepare(p, { deadline, nonce, delegated, accountNonce }) {
  const msg = message(p, deadline, nonce);
  const answer = {
    success: true,
    delegate: DELEGATE,
    data: '0x',
    digest: digestOf(BASE, RATER, msg),
    typedData: {
      domain: { name: 'FeedbackDelegate', version: '1', chainId: BASE, verifyingContract: RATER },
      primaryType: 'RelayedGiveFeedback',
      types: { EIP712Domain: DOMAIN_FIELDS, RelayedGiveFeedback: FIELDS },
      message: msg,
    },
    deadline,
    nonce,
    delegated,
    chainId: BASE,
    network: 'base',
  };
  if (!delegated) answer.accountNonce = accountNonce;
  return answer;
}
const serialized = (sig) => sig.serialized.toLowerCase();

function relayedFeedback() {
  const now = 1793000000;
  const params = {
    network: 'base',
    agentId: '18896',
    value: 90,
    valueDecimals: 0,
    tag1: 'moment:idea',
    tag2: 'credits-roll',
    endpoint: 'https://www.twitch.tv/example',
    feedbackUri: 'https://evidence.example/a.json',
    feedbackHash: ethers.keccak256(ethers.toUtf8Bytes('vector evidence')).toLowerCase(),
  };
  const nonce = ethers.keccak256(ethers.toUtf8Bytes('vector nonce 1')).toLowerCase();
  const nonce2 = ethers.keccak256(ethers.toUtf8Bytes('vector nonce 2')).toLowerCase();
  const first = prepare(params, { deadline: now + 900, nonce, delegated: false, accountNonce: 1 });
  const authDigest = ethers.hashAuthorization({ chainId: BigInt(BASE), address: DELEGATE, nonce: 1n }).toLowerCase();
  const authSig = RATER_KEY.sign(authDigest);
  const unicodeParams = { ...params, agentId: '7', value: -5, tag1: 'momento:idea ✓', tag2: 'crédits 🎬', feedbackHash: undefined };
  const second = prepare(unicodeParams, { deadline: now + 900, nonce: nonce2, delegated: true });
  const set = (path, value) => ({ op: 'set', path, value });
  const del = (path) => ({ op: 'delete', path });
  return {
    schema: 'uvd-x402.reputation.vectors.relayed-feedback/v1',
    signer: {
      seed: RATER_SEED,
      keyRule: 'private key = sha256(utf8(seed))',
      address: RATER,
    },
    deployedContract: {
      source: 'x402-rs src/erc8004/relay_v4.rs the_vector_matches_the_deployed_v4_contract (eth_call on Base, 2026-08-25)',
      chainId: BASE,
      verifyingContract: DELEGATE,
      domainSeparator: '0xae792427891b13b5663e321e5c8802c304437aad75338e22a4b8e1a47243d09d',
      message: {
        registry: REGISTRY,
        agentId: '2106',
        value: '95',
        valueDecimals: 0,
        tag1: 'quality',
        tag2: 'api',
        endpoint: 'https://agent.example',
        feedbackURI: 'https://execution.market/feedback/abc',
        feedbackHash: ZERO32,
        deadline: '1787662172',
        nonce: '0x' + '42'.repeat(32),
      },
      digest: '0xa7a2a62dd18c44c79f7c252d628f32b3c46234b20d237866154dbe118ebaf6e1',
    },
    cases: [
      {
        name: 'first rating on base: not delegated, the authorization is signed',
        now,
        params,
        prepare: first,
        expected: {
          digest: first.digest,
          signature: serialized(RATER_KEY.sign(first.digest)),
          authorizationDigest: authDigest,
          authorization: {
            chainId: BASE,
            address: DELEGATE,
            nonce: 1,
            yParity: authSig.yParity,
            r: authSig.r.toLowerCase(),
            s: authSig.s.toLowerCase(),
          },
        },
      },
      {
        name: 'delegated rater, negative value, non-ASCII tags, no feedbackHash (zero)',
        now,
        params: Object.fromEntries(Object.entries(unicodeParams).filter(([, v]) => v !== undefined)),
        prepare: second,
        expected: {
          digest: second.digest,
          signature: serialized(RATER_KEY.sign(second.digest)),
          authorizationDigest: null,
          authorization: null,
        },
      },
    ],
    rejections: [
      { name: 'a revoke instead of a rating', case: 0, patch: [set(['typedData', 'primaryType'], 'RelayedRevokeFeedback')], error: 'primary_type' },
      { name: 'another delegate', case: 0, patch: [set(['delegate'], '0x000000000000000000000000000000000000dEaD')], error: 'delegate_mismatch' },
      { name: 'the delegate as verifyingContract', case: 0, patch: [set(['typedData', 'domain', 'verifyingContract'], DELEGATE)], error: 'domain_verifying_contract' },
      { name: 'a domain on another chain', case: 0, patch: [set(['typedData', 'domain', 'chainId'], 1)], error: 'domain_chain_id' },
      { name: 'another chain id on the prepare', case: 0, patch: [set(['chainId'], 1)], error: 'chain_mismatch' },
      { name: 'another score', case: 0, patch: [set(['typedData', 'message', 'value'], '100')], error: 'field_mismatch' },
      { name: 'another feedbackURI', case: 0, patch: [set(['typedData', 'message', 'feedbackURI'], 'https://evil.example')], error: 'field_mismatch' },
      { name: 'the testnet registry', case: 0, patch: [set(['typedData', 'message', 'registry'], '0x8004B663056A597Dffe9eCcC1965A193B7388713')], error: 'registry' },
      { name: 'two fields swapped in the types', case: 0, patch: [set(['typedData', 'types', 'RelayedGiveFeedback', 0], FIELDS[1]), set(['typedData', 'types', 'RelayedGiveFeedback', 1], FIELDS[0])], error: 'types_mismatch' },
      { name: 'no typed data (v3)', case: 0, patch: [del(['typedData'])], error: 'typed_data_missing' },
      { name: 'an extra message field', case: 0, patch: [set(['typedData', 'message', 'extra'], '1')], error: 'message_shape' },
      { name: 'a digest that is not this rating', case: 0, patch: [set(['digest'], '0x' + '5a'.repeat(32))], error: 'digest_mismatch' },
      { name: 'no account nonce on a first rating', case: 0, patch: [del(['accountNonce'])], error: 'account_nonce' },
      { name: 'a deadline more than an hour out', case: 0, patch: [set(['deadline'], now + 3601), set(['typedData', 'message', 'deadline'], String(now + 3601))], error: 'deadline' },
      { name: 'a deadline 15 seconds out', case: 0, patch: [set(['deadline'], now + 15), set(['typedData', 'message', 'deadline'], String(now + 15))], error: 'deadline' },
    ],
  };
}

function messageRefs() {
  const ref = (ns, parts) => sha256Hex([ns, ...parts.map(String)].join('|'));
  const cases = [
    ['credits-roll:v1', ['stream-42', 'msg-0001']],
    ['karma-hello:v1', ['0xultravioleta', 'some_viewer', '2026-10-26T18:00:00Z', 'msg']],
    ['ns', [42, 'x']],
    ['ns', ['créditos 🎬']],
  ];
  return {
    schema: 'uvd-x402.reputation.vectors.message-ref/v1',
    rule: 'sha256(utf8(namespace + "|" + "|".join(parts))) as 64 lowercase hex digits; an integer part is written in decimal',
    cases: cases.map(([namespace, parts]) => ({ namespace, parts, ref: ref(namespace, parts) })),
    invalid: [
      { name: 'empty namespace', namespace: '', parts: ['a'] },
      { name: 'no parts', namespace: 'ns', parts: [] },
      { name: '| in the namespace', namespace: 'a|b', parts: ['c'] },
      { name: '| in a part', namespace: 'ns', parts: ['a|b'] },
      { name: 'an empty part', namespace: 'ns', parts: ['s', ''] },
      { name: 'a blank part', namespace: 'ns', parts: ['   '] },
      { name: 'a blank namespace', namespace: '  ', parts: ['a'] },
      { name: 'a fractional part', namespace: 'ns', parts: [1.5] },
    ],
  };
}

function paymentHashes() {
  const hash = (p) =>
    ethers.keccak256(
      ethers.concat([
        p.transactionHash,
        ethers.zeroPadValue(ethers.toBeArray(BigInt(p.blockNumber)), 8),
        ethers.toUtf8Bytes(ethers.getAddress(p.payer)),
        ethers.toUtf8Bytes(ethers.getAddress(p.payee)),
        ethers.zeroPadValue(ethers.toBeArray(BigInt(p.amount)), 32),
      ])
    ).toLowerCase();
  const cases = [
    { transactionHash: ethers.keccak256(ethers.toUtf8Bytes('vector payment 1')).toLowerCase(), blockNumber: 53125001, payer: RATER, payee: VIEWER, amount: '1000' },
    { transactionHash: '0x' + '01'.repeat(32), blockNumber: 123, payer: '0x' + '11'.repeat(20), payee: '0x' + '22'.repeat(20), amount: '1000' },
    { transactionHash: '0x' + 'ab'.repeat(32), blockNumber: 1, payer: RATER.toLowerCase(), payee: VIEWER.toLowerCase(), amount: '115792089237316195423570985008687907853269984665640564039457584007913129639935' },
  ];
  return {
    schema: 'uvd-x402.reputation.vectors.payment-hash/v1',
    rule: 'keccak256(txHash[32] || blockNumber u64 big-endian [8] || utf8(EIP-55 payer) || utf8(EIP-55 payee) || amount u256 big-endian [32]), x402-rs types.rs::compute_payment_hash',
    cases: cases.map((c) => ({ ...c, paymentHash: hash(c) })),
  };
}

function evidence() {
  const commit = (name, value) => '0x' + createHmac('sha256', Buffer.from(SALT.slice(2), 'hex')).update(`${name}|${value}`, 'utf8').digest('hex');
  const tx = ethers.keccak256(ethers.toUtf8Bytes('vector payment 1')).toLowerCase();
  const proof = {
    transactionHash: tx,
    blockNumber: 53125001,
    network: 'base',
    payer: RATER,
    payee: VIEWER,
    amount: '1000',
    token: USDC,
    timestamp: 1793000000,
    paymentHash: paymentHashes().cases[0].paymentHash,
  };
  const input = {
    network: 'base',
    agentId: '18896',
    rater: RATER,
    subject: { wallet: VIEWER, walletBinding: 'self_declared_unverified', type: 'chat_participant' },
    value: 90,
    valueDecimals: 0,
    tag1: 'moment:idea',
    tag2: 'credits-roll',
    endpoint: 'https://www.twitch.tv/example',
    createdAt: '2026-10-26T18:00:00Z',
    issuer: { name: 'Credits Roll', product: 'credits-roll' },
    context: { kind: 'idea', anchored: true, momentIndex: 3 },
    commitments: { momentRef: sha256Hex('credits-roll:v1|stream-42|msg-0001'), viewerId: '987654321', login: 'some_viewer' },
    proof,
  };
  const document = {
    schema: 'uvd-x402.reputation.evidence/v1',
    agentRegistry: `eip155:${BASE}:${IDENTITY}`,
    agentId: input.agentId,
    clientAddress: RATER,
    subject: clone(input.subject),
    createdAt: input.createdAt,
    value: input.value,
    valueDecimals: 0,
    tag1: input.tag1,
    tag2: input.tag2,
    endpoint: input.endpoint,
    issuer: clone(input.issuer),
    context: clone(input.context),
    commitments: {
      scheme: 'hmac-sha256(salt, name "|" value)/v1',
      values: Object.fromEntries(Object.entries(input.commitments).map(([k, v]) => [k, commit(k, v)])),
    },
    proofOfPayment: clone(proof),
  };
  const json = canonical(document);
  const bare = { ...clone(input), commitments: undefined, proof: undefined, issuer: undefined, context: undefined, subject: { wallet: VIEWER, walletBinding: 'eip191_verified' } };
  const bareDocument = {
    schema: 'uvd-x402.reputation.evidence/v1',
    agentRegistry: `eip155:${BASE}:${IDENTITY}`,
    agentId: input.agentId,
    clientAddress: RATER,
    subject: { type: 'participant', wallet: VIEWER, walletBinding: 'eip191_verified' },
    createdAt: input.createdAt,
    value: input.value,
    valueDecimals: 0,
    tag1: input.tag1,
    tag2: input.tag2,
    endpoint: input.endpoint,
    issuer: {},
    context: {},
  };
  const bareJson = canonical(bareDocument);
  return {
    schema: 'uvd-x402.reputation.vectors.evidence/v1',
    canonicalRule: 'Python json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8"); contentHash = keccak256(those bytes)',
    salt: {
      seed: SALT_SEED,
      rule: 'salt = 0x + hex(sha256(utf8(seed))); every commitment below, and every document input with commitments, uses it',
    },
    canonical: [
      { value: { b: 1, a: [true, null, 'x'] }, json: '{"a":[true,null,"x"],"b":1}' },
      { value: { s: 'créditos ✓ 🎬', n: -5 }, json: canonical({ s: 'créditos ✓ 🎬', n: -5 }) },
      { value: { s: '"\\\b\f\n\r\t\u0001\u001f\u007f' }, json: canonical({ s: '"\\\b\f\n\r\t\u0001\u001f\u007f' }) },
      { value: { '\u{1F3AC}': 1, '～': 2, z: { y: 1, x: 2 } }, json: canonical({ '\u{1F3AC}': 1, '～': 2, z: { y: 1, x: 2 } }) },
    ],
    commitments: [
      { name: 'login', value: 'some_viewer', commitment: commit('login', 'some_viewer') },
      { name: 'viewerId', value: '987654321', commitment: commit('viewerId', '987654321') },
    ],
    documents: [
      { name: 'a moment with its payment and commitments', input, json, contentHash: ethers.keccak256(ethers.toUtf8Bytes(json)).toLowerCase() },
      {
        name: 'the minimum: no payment, no commitments, a verified wallet',
        input: Object.fromEntries(Object.entries(bare).filter(([, v]) => v !== undefined)),
        json: bareJson,
        contentHash: ethers.keccak256(ethers.toUtf8Bytes(bareJson)).toLowerCase(),
      },
    ],
    forbidden: [
      { name: 'the chat line in context', patch: { context: { message: 'aguante el stream' } }, error: 'forbidden_field' },
      { name: 'the author in context', patch: { context: { author: 'some_viewer' } }, error: 'forbidden_field' },
      { name: 'a login in context', patch: { context: { login: 'some_viewer' } }, error: 'forbidden_field' },
      { name: 'a user id in context', patch: { context: { user_id: '987654321' } }, error: 'forbidden_field' },
    ],
  };
}

const files = {
  'message-ref.json': messageRefs(),
  'relayed-feedback.json': relayedFeedback(),
  'payment-hash.json': paymentHashes(),
  'evidence.json': evidence(),
};

const check = process.argv.includes('--check');
mkdirSync(OUT, { recursive: true });
let drift = false;
for (const [name, value] of Object.entries(files)) {
  const text = JSON.stringify(value, null, 2) + '\n';
  const path = join(OUT, name);
  if (check) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = '';
    }
    if (current !== text) {
      console.error(`${name}: differs from what this script derives`);
      drift = true;
    }
  } else {
    writeFileSync(path, text);
  }
  console.log(`${name}  sha256 ${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`);
}
if (drift) process.exit(1);
