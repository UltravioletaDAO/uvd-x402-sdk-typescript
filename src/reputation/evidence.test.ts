/**
 * The public evidence: what it carries, what it never carries, and the bytes
 * its `feedbackHash` commits to. The bytes and the refusal codes are the
 * Python SDK's (evidence-document.json, in vectors.test.ts); this file walks
 * every guard one at a time.
 */
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import { contentHash } from '../dx402';
import {
  COMMITMENT_SCHEME,
  EVIDENCE_SCHEMA,
  ReputationError,
  canonicalJson,
  commitment,
  computePaymentHash,
  evidenceDocument,
  isPrivateKey,
  messageRef,
  newSalt,
  type EvidenceInput,
  type ProofOfPayment,
} from './index';
import { seedKey, seededAddress } from '../../test/reputation/doubles';

const RATER = seededAddress('uvd-x402 reputation evidence rater');
const VIEWER = seededAddress('uvd-x402 reputation evidence viewer');
const SALT = seedKey('uvd-x402 reputation evidence salt');
const TX = '0x' + 'cd'.repeat(32);
const PROOF: ProofOfPayment = {
  transactionHash: TX,
  blockNumber: 53_125_001,
  network: 'base',
  payer: RATER,
  payee: VIEWER,
  amount: '1000',
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  timestamp: 1_793_000_000,
  paymentHash: computePaymentHash({ transactionHash: TX, blockNumber: 53_125_001, payer: RATER, payee: VIEWER, amount: '1000' }),
};

const CHAT_LINE = 'aguante el stream, mi idea: usar USDC para los créditos';
const LOGIN = 'some_viewer_login';
const USER_ID = '987654321';
const MOMENT = messageRef('credits-roll:v1', 'stream-42', 'msg-1');

function input(extra: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    network: 'base',
    agentId: 18896,
    rater: RATER,
    subject: VIEWER,
    value: 90,
    tag1: 'moment:idea',
    tag2: 'credits-roll',
    endpoint: 'https://www.twitch.tv/example',
    createdAt: 1_793_000_000,
    salt: SALT,
    private: { moment_ref: MOMENT, user_id: USER_ID, login: LOGIN, message: CHAT_LINE },
    proof: PROOF,
    issuer: { name: 'Credits Roll', product: 'credits-roll' },
    context: { momentType: 'idea', stream: 'stream-42' },
    ...extra,
  };
}

function code(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(ReputationError);
    return (error as ReputationError).code;
  }
  return 'no error';
}

describe('evidenceDocument', () => {
  it('carries the public facts and the payment where the facilitator looks for it', () => {
    const { document } = evidenceDocument(input({ rater: RATER.toLowerCase(), subject: VIEWER.toLowerCase() }));
    expect(document.schema).toBe(EVIDENCE_SCHEMA);
    expect(document.network).toBe('base');
    expect(document.chainId).toBe(8453);
    expect(document.agentRegistry).toBe('eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    expect(document.agentId).toBe('18896');
    expect(document.clientAddress).toBe(RATER);
    expect(document.subject).toEqual({ wallet: VIEWER, walletBinding: 'self_declared_unverified' });
    expect([document.value, document.valueDecimals]).toEqual([90, 0]);
    expect([document.tag1, document.tag2, document.endpoint]).toEqual(['moment:idea', 'credits-roll', 'https://www.twitch.tv/example']);
    // Python: datetime.fromtimestamp(1793000000, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    expect(document.createdAt).toBe('2026-10-26T07:33:20Z');
    expect(document.commitmentScheme).toBe(COMMITMENT_SCHEME);
    expect(document.issuer).toEqual({ name: 'Credits Roll', product: 'credits-roll' });
    expect(document.context).toEqual({ momentType: 'idea', stream: 'stream-42' });
    // x402-rs proof.rs::document_mentions_payment reads proofOfPayment.transactionHash.
    expect(document.proofOfPayment).toEqual(PROOF);
  });

  it('publishes exactly the ProofOfPayment fields, whatever else the object carries', () => {
    const { document } = evidenceDocument(input({ proof: { ...PROOF, rawTransaction: '0x02f8', secret: 'x' } as ProofOfPayment }));
    expect(Object.keys(document.proofOfPayment as object).sort()).toEqual(Object.keys(PROOF).sort());
  });

  it('leaves out the proof, the issuer and the context when there are none', () => {
    const { document } = evidenceDocument(input({ proof: null, issuer: null, context: undefined, walletBinding: 'eip191_verified' }));
    expect('proofOfPayment' in document || 'issuer' in document || 'context' in document).toBe(false);
    expect((document.subject as any).walletBinding).toBe('eip191_verified');
  });

  it('never carries the chat line, the login or the user id, only their commitments', () => {
    const { json, document } = evidenceDocument(input());
    for (const secret of [CHAT_LINE, LOGIN, USER_ID, MOMENT]) expect(json).not.toContain(secret);
    expect(document.commitments).toEqual({
      moment_ref: commitment(SALT, 'moment_ref', MOMENT),
      user_id: commitment(SALT, 'user_id', USER_ID),
      login: commitment(SALT, 'login', LOGIN),
      message: commitment(SALT, 'message', CHAT_LINE),
    });
  });

  it('hashes its canonical bytes with keccak256, as dx402.contentHash does', () => {
    const doc = evidenceDocument(input());
    expect(doc.contentHash).toBe(contentHash(doc.body).toLowerCase());
    expect(doc.json).toBe(canonicalJson(JSON.parse(doc.json)));
    expect(new TextDecoder().decode(doc.body)).toBe(doc.json);
  });

  it('gives the same bytes whatever order the caller writes the input in', () => {
    const a = evidenceDocument(input());
    const reordered = evidenceDocument({
      ...input(),
      context: { stream: 'stream-42', momentType: 'idea' },
      issuer: { product: 'credits-roll', name: 'Credits Roll' },
      private: { message: CHAT_LINE, login: LOGIN, user_id: USER_ID, moment_ref: MOMENT },
    });
    expect(reordered.contentHash).toBe(a.contentHash);
  });

  it.each<[string, Partial<EvidenceInput> | Record<string, unknown>, string]>([
    ['a network without a relay', { network: 'avalanche' }, 'unknown_network'],
    ['a binding that is not one', { walletBinding: 'trusted' as any }, 'wallet_binding'],
    ['a value of 101', { value: 101 }, 'value'],
    ['a negative value', { value: -1 }, 'value'],
    ['a fractional value', { value: 9.5 }, 'value'],
    ['a value as text', { value: '90' as any }, 'value'],
    ['a negative agent', { agentId: -1 }, 'agent_id'],
    ['an agent that is not a number', { agentId: 'x' }, 'agent_id'],
    ['an agent as a boolean', { agentId: true as any }, 'agent_id'],
    ['nothing committed', { private: {} }, 'private'],
    ['no private map', { private: undefined as any }, 'private'],
    ['a 15-byte salt', { salt: '0x' + '11'.repeat(15) }, 'salt'],
    ['a salt that is not hex', { salt: 'not hex at all, really not' }, 'salt'],
    ['a camelCase label', { private: { momentRef: MOMENT } }, 'commitment_label'],
    ['a label with a dash', { private: { 'moment-ref': MOMENT } }, 'commitment_label'],
    ['a 33-character label', { private: { ['a'.repeat(33)]: MOMENT } }, 'commitment_label'],
    ['a committed number', { private: { user_id: 987654321 as any } }, 'commitment_value'],
    ['a committed lone surrogate', { private: { login: 'a\uD800b' } }, 'commitment_value'],
    ['a rater that is not an address', { rater: 'not-an-address' }, 'address'],
    ['a subject that is not an address', { subject: VIEWER.slice(0, 41) }, 'address'],
    ['a negative createdAt', { createdAt: -1 }, 'created_at'],
    ['a fractional createdAt', { createdAt: 1.5 }, 'created_at'],
    ['an ISO createdAt', { createdAt: '2026-10-26T18:00:00Z' as any }, 'created_at'],
    ['a createdAt past the year 9999', { createdAt: 253_402_300_800 }, 'created_at'],
    ['a proof that does not hash', { proof: { ...PROOF, amount: '1001' } }, 'proof'],
    ['a proof for another network', { proof: { ...PROOF, network: 'polygon' } }, 'proof'],
    ['a proof without its token', { proof: { ...PROOF, token: undefined } as any }, 'proof'],
    ['a proof without a payer', { proof: { ...PROOF, payer: 'nobody' } }, 'proof'],
    ['a tag that is not text', { tag1: 5 as any }, 'invalid_input'],
  ])('refuses %s', (_name, extra, expected) => {
    expect(code(() => evidenceDocument(input(extra as Partial<EvidenceInput>)))).toBe(expected);
  });

  it('a proof on base-mainnet is the same network as base', () => {
    expect(code(() => evidenceDocument(input({ proof: { ...PROOF, network: 'base-mainnet' } })))).toBe('no error');
  });
});

describe('evidenceDocument: no key names chat content or a person, at any depth', () => {
  it.each([
    ['message'],
    ['author'],
    ['AUTHOR'],
    ['username'],
    ['user_id'],
    ['userId'],
    ['displayName'],
    ['chatText'],
    ['author_name'],
    ['viewer-login'],
    ['userAgent'],
    ['msgId'],
    ['mensaje'],
    ['nombre_autor'],
    ['correoElectronico'],
  ])('refuses %s in context', (key) => {
    expect(code(() => evidenceDocument(input({ context: { [key]: 'x' } })))).toBe('private_field');
  });

  it('refuses it nested, in a list or in the issuer', () => {
    expect(code(() => evidenceDocument(input({ context: { moment: { login: 'x' } } })))).toBe('private_field');
    expect(code(() => evidenceDocument(input({ context: { moments: [{ kind: 'idea' }, { text: 'x' }] } })))).toBe('private_field');
    expect(code(() => evidenceDocument(input({ issuer: { name: 'Credits Roll', email: 'x@example.com' } })))).toBe('private_field');
  });

  it('takes the words that do not name one', () => {
    for (const key of ['kind', 'momentType', 'stream', 'name', 'product', 'itemsCount']) {
      expect(isPrivateKey(key)).toBe(false);
    }
    expect(code(() => evidenceDocument(input({ context: { kind: 'idea', round: 3, live: true, gap: null, tags: ['a'] } })))).toBe('no error');
  });

  it('the private labels themselves are not refused: their values are HMACs', () => {
    expect(code(() => evidenceDocument(input({ private: { message: CHAT_LINE, login: LOGIN, author: 'x', text: 'y' } })))).toBe('no error');
  });
});

describe('evidenceDocument: only JSON integers, strings, booleans, null, lists and plain objects', () => {
  it.each<[string, unknown]>([
    ['1.5', 1.5],
    ['NaN', Number.NaN],
    ['2^53', 2 ** 53],
    ['-0', -0],
  ])('refuses the number %s', (_name, value) => {
    expect(code(() => evidenceDocument(input({ context: { round: value } })))).toBe('float_in_evidence');
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['a Map', new Map()],
    ['a Date', new Date(0)],
    ['a function', () => 1],
    ['bytes', new Uint8Array(2)],
  ])('refuses %s', (_name, value) => {
    expect(code(() => evidenceDocument(input({ context: { round: value } })))).toBe('evidence_type');
  });

  it('takes a bigint as the integer it is', () => {
    const { json } = evidenceDocument(input({ context: { round: 2n ** 70n } }));
    expect(json).toContain(`"round":${2n ** 70n}`);
  });
});

describe('evidenceDocument: a private value never rides along in a public string', () => {
  it.each<[string, Partial<EvidenceInput>]>([
    ['the chat line in tag2', { tag2: `credits-roll|${CHAT_LINE}` }],
    ['the chat line, other case, in tag1', { tag1: CHAT_LINE.toUpperCase() }],
    ['the login in the endpoint', { endpoint: `https://www.twitch.tv/${LOGIN}` }],
    ['the user id in the issuer', { issuer: { name: `viewer ${USER_ID}` } }],
    ['the moment ref in the context', { context: { ref: MOMENT } }],
  ])('refuses %s', (_name, extra) => {
    expect(code(() => evidenceDocument(input(extra)))).toBe('private_value_leaked');
  });

  it('finds a value with quotes in its JSON-escaped form', () => {
    const quoted = 'dice "hola" amigos';
    expect(code(() => evidenceDocument(input({ private: { message: quoted }, context: { note: quoted } })))).toBe('private_value_leaked');
  });

  it('eight characters and up: anywhere, even inside a word', () => {
    expect(code(() => evidenceDocument(input({ private: { login: 'abcdefgh' }, context: { note: 'xabcdefghx' } })))).toBe('private_value_leaked');
    expect(code(() => evidenceDocument(input({ private: { login: 'abcdefgh' }, tag2: 'xabcdefghx' })))).toBe('private_value_leaked');
  });

  it('four to seven characters: as a whole word, in the issuer and the context only', () => {
    expect(code(() => evidenceDocument(input({ private: { login: 'pepe' }, context: { note: 'gracias pepe' } })))).toBe('private_value_leaked');
    expect(code(() => evidenceDocument(input({ private: { login: 'abcdefg' }, issuer: { name: 'Abcdefg' } })))).toBe('private_value_leaked');
    expect(code(() => evidenceDocument(input({ private: { login: 'pepe' }, context: { note: 'pepetono' } })))).toBe('no error');
    expect(code(() => evidenceDocument(input({ private: { login: 'abcdefg' }, context: { note: 'xabcdefgx' } })))).toBe('no error');
    expect(code(() => evidenceDocument(input({ private: { login: 'pepe' }, tag2: 'pepe' })))).toBe('no error');
  });

  it('shorter than four characters: never searched for', () => {
    expect(code(() => evidenceDocument(input({ private: { login: 'abc' }, context: { note: 'abc' } })))).toBe('no error');
  });
});

describe('commitment', () => {
  it('is HMAC-SHA256(salt, label "|" value)', () => {
    const expected = '0x' + bytesToHex(hmac(sha256, ethers.getBytes(SALT), new TextEncoder().encode(`login|${LOGIN}`)));
    expect(commitment(SALT, 'login', LOGIN)).toBe(expected);
    expect(commitment(ethers.getBytes(SALT), 'login', LOGIN)).toBe(expected);
    expect(commitment(SALT.slice(2), 'login', LOGIN)).toBe(expected);
  });

  it('changes with the salt, so a destroyed salt unlinks it', () => {
    expect(commitment(seedKey('another salt'), 'login', LOGIN)).not.toBe(commitment(SALT, 'login', LOGIN));
  });

  it('takes a 16-byte salt and an empty value; refuses less', () => {
    expect(code(() => commitment('0x' + '11'.repeat(16), 'login', ''))).toBe('no error');
    expect(code(() => commitment(new Uint8Array(15), 'login', LOGIN))).toBe('salt');
    expect(code(() => commitment(SALT, 'a|b', LOGIN))).toBe('commitment_label');
  });

  it('newSalt gives 32 fresh bytes each time', () => {
    const a = newSalt();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(newSalt()).not.toBe(a);
  });
});
