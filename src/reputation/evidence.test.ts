/**
 * The public evidence: what it carries, what it never carries, and the bytes
 * its `feedbackHash` commits to.
 */
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import { contentHash } from '../dx402';
import {
  COMMITMENT_SCHEME,
  ReputationError,
  canonicalJson,
  commitment,
  computePaymentHash,
  evidenceDocument,
  messageRef,
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

function input(extra: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    network: 'base',
    agentId: 18896,
    rater: RATER,
    subject: { wallet: VIEWER, walletBinding: 'self_declared_unverified', type: 'chat_participant' },
    value: 90,
    tag1: 'moment:idea',
    tag2: 'credits-roll',
    endpoint: 'https://www.twitch.tv/example',
    createdAt: '2026-10-26T18:00:00Z',
    issuer: { name: 'Credits Roll', product: 'credits-roll' },
    context: { kind: 'idea', stream: 'stream-42' },
    commitments: { momentRef: messageRef('credits-roll:v1', 'stream-42', 'msg-1'), viewerId: USER_ID, login: LOGIN },
    salt: SALT,
    proof: PROOF,
    ...extra,
  };
}

describe('evidenceDocument', () => {
  it('carries the public facts and the payment where the facilitator looks for it', () => {
    const { document } = evidenceDocument(input());
    expect(document.agentRegistry).toBe('eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    expect(document.agentId).toBe('18896');
    expect(document.clientAddress).toBe(RATER);
    expect((document.subject as any).wallet).toBe(VIEWER);
    expect((document.subject as any).walletBinding).toBe('self_declared_unverified');
    // x402-rs proof.rs::document_mentions_payment reads proofOfPayment.transactionHash.
    expect((document.proofOfPayment as any).transactionHash).toBe(TX);
    expect((document.proofOfPayment as any).paymentHash).toBe(PROOF.paymentHash);
  });

  it('never carries the chat line, the login or the user id, only commitments to them', () => {
    const { json } = evidenceDocument(input({ commitments: { momentRef: 'm', viewerId: USER_ID, login: LOGIN, line: CHAT_LINE } }));
    expect(json).not.toContain(CHAT_LINE);
    expect(json).not.toContain(LOGIN);
    expect(json).not.toContain(USER_ID);
    const { document } = evidenceDocument(input());
    expect((document.commitments as any).scheme).toBe(COMMITMENT_SCHEME);
    expect((document.commitments as any).values.login).toBe(commitment(SALT, 'login', LOGIN));
  });

  it.each([
    ['message'],
    ['author'],
    ['username'],
    ['login'],
    ['userId'],
    ['user_id'],
    ['displayName'],
    ['TEXT'],
    ['viewer-id'.replace('-', '_')],
  ])('refuses a %s key in context', (key) => {
    let caught: unknown;
    try {
      evidenceDocument(input({ context: { [key]: 'x' } }));
    } catch (error) {
      caught = error;
    }
    expect((caught as ReputationError).code).toBe('forbidden_field');
  });

  it('refuses nested, long or control-character values in context and issuer', () => {
    expect(() => evidenceDocument(input({ context: { kind: { message: CHAT_LINE } as any } }))).toThrow(ReputationError);
    expect(() => evidenceDocument(input({ context: { kind: 'x'.repeat(201) } }))).toThrow(ReputationError);
    expect(() => evidenceDocument(input({ context: { kind: 'a\nb' } }))).toThrow(ReputationError);
    expect(() => evidenceDocument(input({ issuer: { name: 1 as any } }))).toThrow(ReputationError);
    expect(() => evidenceDocument(input({ context: { score: 1.5 } }))).toThrow(ReputationError);
  });

  it('needs a salt for commitments, a binding for the wallet and a UTC timestamp', () => {
    expect(() => evidenceDocument(input({ salt: undefined }))).toThrow(ReputationError);
    expect(() => evidenceDocument(input({ subject: { wallet: VIEWER } as any }))).toThrow(ReputationError);
    expect(() => evidenceDocument(input({ createdAt: '2026-10-26 18:00' }))).toThrow(ReputationError);
    expect(() => evidenceDocument(input({ createdAt: '2026-10-26T18:00:00+02:00' }))).toThrow(ReputationError);
  });

  it('refuses a proof that does not hash to its paymentHash, or is for another network', () => {
    expect(() => evidenceDocument(input({ proof: { ...PROOF, amount: '1001' } }))).toThrow(ReputationError);
    expect(() => evidenceDocument(input({ proof: { ...PROOF, network: 'polygon' } }))).toThrow(ReputationError);
  });

  it('hashes its canonical bytes with keccak256, as dx402.contentHash does', () => {
    const doc = evidenceDocument(input());
    expect(doc.contentHash).toBe(contentHash(doc.bytes).toLowerCase());
    expect(doc.json).toBe(canonicalJson(JSON.parse(doc.json)));
    expect(new TextDecoder().decode(doc.bytes)).toBe(doc.json);
  });

  it('gives the same bytes whatever order the caller writes the input in', () => {
    const a = evidenceDocument(input());
    const reordered = evidenceDocument({
      ...input(),
      context: { stream: 'stream-42', kind: 'idea' },
      issuer: { product: 'credits-roll', name: 'Credits Roll' },
    });
    expect(reordered.contentHash).toBe(a.contentHash);
  });
});

describe('commitment', () => {
  it('is HMAC-SHA256(salt, name "|" value)', () => {
    const expected = '0x' + bytesToHex(hmac(sha256, ethers.getBytes(SALT), new TextEncoder().encode(`login|${LOGIN}`)));
    expect(commitment(SALT, 'login', LOGIN)).toBe(expected);
  });

  it('changes with the salt, so a destroyed salt unlinks it', () => {
    expect(commitment(seedKey('another salt'), 'login', LOGIN)).not.toBe(commitment(SALT, 'login', LOGIN));
  });

  it('needs a 32-byte salt, a short name and a value', () => {
    expect(() => commitment('0x1234', 'login', LOGIN)).toThrow(ReputationError);
    expect(() => commitment(SALT, 'a|b', LOGIN)).toThrow(ReputationError);
    expect(() => commitment(SALT, 'login', '')).toThrow(ReputationError);
  });
});
