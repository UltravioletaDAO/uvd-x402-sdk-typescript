/**
 * What reaches a log: long hex shortened, proofs and signatures dropped, a
 * logger that throws never deciding whether money moves.
 */
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import { log } from './redact';
import { ReputationError, checkSignature, errorCode, redact, redactText, walletDirectory } from './index';
import { seedKey, seededAddress } from '../../test/reputation/doubles';

const ADDRESS = seededAddress('redact viewer');
const HASH = ethers.keccak256(ethers.toUtf8Bytes('redact'));
const KEY = seedKey('redact key');

describe('redactText', () => {
  it('shortens addresses, hashes, signatures and bare key-length hex', () => {
    const signature = '0x' + 'ab'.repeat(65);
    const text = redactText(`to ${ADDRESS} tx ${HASH} sig ${signature} key ${KEY.slice(2)} upper 0X${'CD'.repeat(20)}`);
    expect(text).not.toMatch(/[0-9a-fA-F]{40}/);
    expect(text).toContain(`${ADDRESS.slice(0, 6)}…${ADDRESS.slice(-4)}`);
    expect(text).toContain(`${HASH.slice(0, 6)}…${HASH.slice(-4)}`);
    expect(text).toContain(`${KEY.slice(2, 6)}…${KEY.slice(-4)}`);
  });

  it('drops URLs, which carry API keys', () => {
    const text = redactText('POST https://base-mainnet.example/v2/SECRETKEY123?x=1 failed; see wss://node.example/ws/KEY456.');
    expect(text).toBe('POST [url] failed; see [url]');
  });

  it('leaves short hex and plain text alone', () => {
    expect(redactText('chain 0x2105, block 0x10, code 429')).toBe('chain 0x2105, block 0x10, code 429');
  });
});

describe('redact', () => {
  it('drops proof, signature, authorization, raw transaction, key and salt fields, at any depth and case', () => {
    const out = redact({
      ref: 'r',
      row: {
        proof: { paymentHash: HASH },
        Signature: '0x' + 'ab'.repeat(65),
        submission: { authorization: { r: HASH }, nonce: HASH },
        payment: { rawTransaction: '0x02' + 'ff'.repeat(100), payer: ADDRESS },
        privateKey: KEY,
        salt: KEY,
        proofOfPayment: {},
      },
      list: [ADDRESS],
      n: 5n,
      e: new ReputationError('rpc_failed', `failed for ${ADDRESS}`),
    }) as any;
    expect(out.row.proof).toBe('[redacted]');
    expect(out.row.Signature).toBe('[redacted]');
    expect(out.row.submission.authorization).toBe('[redacted]');
    expect(out.row.payment.rawTransaction).toBe('[redacted]');
    expect(out.row.privateKey).toBe('[redacted]');
    expect(out.row.salt).toBe('[redacted]');
    expect(out.row.proofOfPayment).toBe('[redacted]');
    expect(JSON.stringify(out)).not.toMatch(/[0-9a-fA-F]{40}/);
    expect(out.n).toBe('5');
    expect(out.e).toMatch(/^ReputationError: failed for 0x/);
  });

  it('stops at a depth instead of following a cycle', () => {
    const a: any = { x: 1 };
    a.self = a;
    expect(() => JSON.stringify(redact(a))).not.toThrow();
  });
});

describe('log', () => {
  it('hands the logger redacted text and fields', () => {
    const seen: unknown[] = [];
    log({ warn: (m, f) => seen.push(m, f) }, 'warn', `paying ${ADDRESS}`, { tx: HASH, proof: { a: 1 } });
    expect(JSON.stringify(seen)).not.toMatch(/[0-9a-fA-F]{40}/);
    expect((seen[1] as any).proof).toBe('[redacted]');
  });

  it('swallows a logger that throws, and skips a level the logger lacks', () => {
    expect(() => log({ error: () => { throw new Error('broken sink'); } }, 'error', 'x')).not.toThrow();
    expect(() => log({}, 'info', 'x')).not.toThrow();
    expect(() => log(undefined, 'info', 'x')).not.toThrow();
  });
});

describe('error messages are log-safe', () => {
  it('a signature_mismatch names the addresses shortened', () => {
    const digest = HASH;
    const other = new ethers.SigningKey(seedKey('redact other')).sign(digest).serialized;
    let message = '';
    try {
      checkSignature(other, digest, ADDRESS);
    } catch (error) {
      message = (error as Error).message;
      expect(errorCode(error)).toBe('signature_mismatch');
    }
    expect(message).toContain('…');
    expect(message).not.toMatch(/[0-9a-fA-F]{40}/);
  });

  it('errorCode never returns a message', () => {
    expect(errorCode(new Error(`boom ${ADDRESS}`))).toBe('Error');
    expect(errorCode('text')).toBe('Error');
    expect(errorCode(new TypeError('x'))).toBe('TypeError');
  });
});

describe('walletDirectory', () => {
  const entries = [
    { login: 'Alice', wallet: seededAddress('alice') },
    { login: 'bob', wallet: seededAddress('shared') },
    { login: 'carol', wallet: seededAddress('shared').toLowerCase() },
    { login: 'dave', wallet: seededAddress('dave 1') },
    { login: 'DAVE ', wallet: seededAddress('dave 2') },
    { login: 'erin', wallet: 'erin.near' },
    { login: '', wallet: seededAddress('nobody') },
  ];
  const dir = walletDirectory(entries);

  it('resolves a login with one wallet of its own, case- and space-insensitively, lowercased', () => {
    expect(dir.lookup('alice')).toBe(seededAddress('alice').toLowerCase());
    expect(dir.lookup(' ALICE ')).toBe(seededAddress('alice').toLowerCase());
  });

  it('a wallet shared by two logins resolves to nobody, for either login', () => {
    expect(dir.lookup('bob')).toBeNull();
    expect(dir.lookup('carol')).toBeNull();
    expect([...dir.shared]).toEqual([seededAddress('shared').toLowerCase()]);
  });

  it('a login listed with two wallets resolves to nobody', () => {
    expect(dir.lookup('dave')).toBeNull();
    expect([...dir.ambiguous]).toEqual(['dave']);
  });

  it('ignores entries that are not EVM wallets, and unknown logins', () => {
    expect(dir.lookup('erin')).toBeNull();
    expect(dir.lookup('zed')).toBeNull();
    expect(dir.lookup(undefined as unknown as string)).toBeNull();
  });

  it('strips what Python strip() strips (U+001F, U+0085), and keeps U+FEFF', () => {
    const us = String.fromCharCode(0x1f);
    const nel = String.fromCharCode(0x85);
    const bom = String.fromCharCode(0xfeff);
    expect(dir.lookup(us + 'alice' + nel)).toBe(seededAddress('alice').toLowerCase());
    expect(dir.lookup(bom + 'alice')).toBeNull();
    expect(walletDirectory([{ login: us + nel, wallet: seededAddress('blank') }]).lookup('')).toBeNull();
  });
});
