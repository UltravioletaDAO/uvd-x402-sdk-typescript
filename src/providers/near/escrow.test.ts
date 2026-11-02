import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { encodeBase58 } from 'ethers';
import vectors from './vectors/arras-v1.json';
import {
  buildEscrowMsg, computePaymentId, paymentIdPreimage, createNearLocalSigner, signEscrowAuthorization,
  buildEscrowAuthorizationDelegate, validateEscrowAuthorizationDelegate, signEscrowLifecycle,
  release, refund, reclaim, withdraw, withdrawFor, NEAR_ESCROW_MIN_GAS, NEAR_ESCROW_MAX_GAS,
  type EscrowAuthorizationOptions, type NearEscrowPayment, type NearEscrowLifecycleMethod,
} from './escrow';

const v1 = vectors.payment_id.vectores[0];
const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
const signer = createNearLocalSigner(seed);
const options: EscrowAuthorizationOptions = {
  signer, network: 'near:testnet', senderId: v1.payer, escrowContract: 'arras-v1b-1101.testnet',
  token: v1.token, amount: v1.amount, msg: v1, nonce: '42', maxBlockHeight: '100000000',
};

/** Independent Borsh reader: inspect the signed wire, not the SDK's action object. */
function decode(payment: NearEscrowPayment) {
  const wire = Buffer.from(payment.payload.signedDelegateAction, 'base64');
  let at = 0;
  const take = (n: number) => { const r = wire.subarray(at, at + n); at += n; return r; };
  const int = (n: number) => { const b = take(n); return b.reduceRight((s, c) => s * 256n + BigInt(c), 0n); };
  const string = () => take(Number(int(4))).toString('utf8');
  const sender = string(), receiver = string(), count = int(4), actionTag = int(1);
  const method = string(), args = JSON.parse(string()), gas = int(8), deposit = int(16);
  const nonce = int(8), maxBlockHeight = int(8), keyTag = int(1), publicKey = take(32);
  const delegate = wire.subarray(0, at), signatureTag = int(1), signature = take(64);
  expect(at).toBe(wire.length);
  expect([count, actionTag, keyTag, signatureTag]).toEqual([1n, 2n, 0n, 0n]);
  // Node/OpenSSL verifies independently of the noble library used to sign.
  const pk = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]), format: 'der', type: 'spki' });
  const hash = createHash('sha256').update(Buffer.from('6e010040', 'hex')).update(delegate).digest();
  expect(verify(null, hash, pk, signature)).toBe(true);
  expect(verify(null, createHash('sha256').update(delegate).digest(), pk, signature)).toBe(false);
  return { sender, receiver, method, args, gas, deposit, nonce, maxBlockHeight, delegate, signature };
}

describe('Arras frozen Rust vectors (copied without regeneration)', () => {
  it('pins the unchanged vector artifact bytes', () => {
    const raw = readFileSync(new URL('./vectors/arras-v1.json', import.meta.url));
    expect(createHash('sha256').update(raw).digest('hex')).toBe('fe81bfc72bd1e90a5afb86fb00eece59cbd78fde983eda397c797bf65351709b');
  });
  it.each(vectors.payment_id.vectores)('$id: Borsh length, SHA-256 and base58', (v) => {
    const preimage = paymentIdPreimage(v);
    expect(preimage.length).toBe(v.preimagen_bytes);
    expect(createHash('sha256').update(preimage).digest('hex')).toBe(v.sha256);
    expect(computePaymentId(v)).toBe(v.payment_id);
    if ('preimagen_hex' in v) expect(Buffer.from(preimage).toString('hex')).toBe(v.preimagen_hex);
  });
  it('canonical msg equals the Rust vector byte for byte', () => {
    expect(buildEscrowMsg(v1)).toBe(vectors.msg_canonico_v1);
  });
  it('also accepts the 42-character Rust regression ID and a 32-byte zero hash', async () => {
    const id = computePaymentId({ ...v1, salt: '00000000000000000000000000000415' });
    expect(id).toBe('1y1ZbrieUbaioiUBHxX7EyZMNkCis2tLKCs5Xxezgy');
    expect(decode(await refund(options, id)).args.payment_id).toBe(id);
    expect(decode(await reclaim(options, '1'.repeat(32))).args.payment_id).toBe('1'.repeat(32));
  });
});

describe('exact input validation before signing', () => {
  it('rejects final line breaks rather than treating a JS $ match as the whole input', async () => {
    for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
      expect(() => buildEscrowMsg({ ...v1, operator_id: 'em' + ending })).toThrow(/operator/);
      expect(() => buildEscrowMsg({ ...v1, receiver: 'worker.near' + ending })).toThrow(/receiver/);
      expect(() => buildEscrowMsg({ ...v1, terms_hash: '0'.repeat(64 - ending.length) + ending })).toThrow(/terms_hash/);
      expect(() => buildEscrowMsg({ ...v1, salt: '0'.repeat(32 - ending.length) + ending })).toThrow(/salt/);
      await expect(signEscrowAuthorization({ ...options, amount: '1' + ending })).rejects.toThrow(/amount/);
    }
  });
  it.each(['', 'EM', ' em', 'em ', 'e m', 'ém', 'em.', 'a'.repeat(33), null])('operator %s', (operator_id) => {
    expect(() => buildEscrowMsg({ ...v1, operator_id: operator_id as string })).toThrow(/operator/);
  });
  it.each(['', 'A.near', ' a.near', 'a.near ', 'a..near', 'a_-b', '-near', 'near.', 'a', 'é.near', 'a'.repeat(65), null])('account %s', (receiver) => {
    expect(() => buildEscrowMsg({ ...v1, receiver: receiver as string })).toThrow(/receiver/);
  });
  it('valid account and operator boundary characters are preserved', () => {
    expect(JSON.parse(buildEscrowMsg({ ...v1, operator_id: 'a_-9', receiver: 'a-b_c.d9' })).receiver).toBe('a-b_c.d9');
  });
  it.each(['', '0x' + '00'.repeat(31), '0X' + '00'.repeat(31), 'AB'.repeat(32), 'gg'.repeat(32), '00'.repeat(31), null])('strict terms hex %s', (terms_hash) => {
    expect(() => buildEscrowMsg({ ...v1, terms_hash: terms_hash as string })).toThrow(/terms_hash/);
  });
  it.each(['', 'AB'.repeat(16), '0x' + '00'.repeat(15), '0X' + '00'.repeat(15), '00'.repeat(15), null])('strict salt %s', (salt) => {
    expect(() => buildEscrowMsg({ ...v1, salt: salt as string })).toThrow(/salt/);
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '', '01', '+1', ' 1', '1 ', '0x10', '1e6', '１', true, null])('exact amount %s', async (amount) => {
    const sign = vi.fn(signer.sign);
    await expect(signEscrowAuthorization({ ...options, amount: amount as string, signer: { ...signer, sign } })).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
  });
  it('accepts u128 maximum without rounding and rejects overflow', () => {
    const max = (1n << 128n) - 1n;
    expect(paymentIdPreimage({ ...v1, amount: max })).toEqual(paymentIdPreimage({ ...v1, amount: max.toString() }));
    expect(() => paymentIdPreimage({ ...v1, amount: max + 1n })).toThrow(/amount/);
  });
  it.each(['release_deadline', 'reclaim_after'] as const)('u64 overflow and unsafe number %s', (field) => {
    for (const value of [1n << 64n, Number(v1[field])]) expect(() => buildEscrowMsg({ ...v1, [field]: value })).toThrow(field);
  });
  it('u64 maximum, u16 maximum and deadline ordering', () => {
    expect(JSON.parse(buildEscrowMsg({ ...v1, reclaim_after: (1n << 64n) - 1n, fee_bps_max: 65535 })).fee_bps_max).toBe(65535);
    for (const release_deadline of [v1.reclaim_after, (BigInt(v1.reclaim_after) + 1n).toString()]) {
      expect(() => buildEscrowMsg({ ...v1, release_deadline })).toThrow(/precede/);
    }
    for (const fee_bps_max of [-1, 65536, 1.1, '1300', null]) expect(() => buildEscrowMsg({ ...v1, fee_bps_max: fee_bps_max as number })).toThrow(/fee_bps_max/);
  });
  it.each(['nonce', 'maxBlockHeight'] as const)('%s must be a positive u64', async (field) => {
    for (const n of [0n, 1n << 64n, Number.MAX_SAFE_INTEGER + 1]) await expect(signEscrowAuthorization({ ...options, [field]: n })).rejects.toThrow(field);
  });
  it('validates network, token, sender, escrow, amount and receiver before signing', async () => {
    for (const change of [{ network: 'near' }, { token: vectors.payment_id.vectores[2].token }, { senderId: 'Bad.near' },
      { escrowContract: '' }, { amount: '0' }, { msg: { ...v1, receiver: options.senderId } },
      { msg: { ...v1, receiver: options.escrowContract } }]) {
      const sign = vi.fn(signer.sign);
      await expect(signEscrowAuthorization({ ...options, ...change, signer: { ...signer, sign } } as EscrowAuthorizationOptions)).rejects.toThrow();
      expect(sign).not.toHaveBeenCalled();
    }
  });
});

describe('the single FT action and NEP-366 signature', () => {
  it('has scheme escrow, CAIP-2 network, FT receiver, escrow args, one yocto and exact nonce', async () => {
    const payment = await signEscrowAuthorization(options);
    expect(payment).toMatchObject({ x402Version: 2, scheme: 'escrow', network: 'near:testnet' });
    expect(decode(payment)).toMatchObject({ sender: v1.payer, receiver: v1.token, method: 'ft_transfer_call',
      args: { receiver_id: options.escrowContract, amount: '1000000', msg: vectors.msg_canonico_v1 },
      gas: NEAR_ESCROW_MAX_GAS, deposit: 1n, nonce: 42n, maxBlockHeight: 100000000n });
    expect(await signEscrowAuthorization(options)).toEqual(payment);
  });
  it('can sign mainnet offline with its own USDC token', async () => {
    const v = vectors.payment_id.vectores[2];
    const payment = await signEscrowAuthorization({ ...options, network: 'near:mainnet', senderId: v.payer,
      escrowContract: 'escrow.example.near', token: v.token, msg: v });
    expect(payment.network).toBe('near:mainnet');
    expect(decode(payment).receiver).toBe(v.token);
  });
  it.each([0n, 2n, (1n << 128n) - 1n])('refuses deposit %s', (deposit) => {
    const d = buildEscrowAuthorizationDelegate(options); d.actions[0].deposit = deposit;
    expect(() => validateEscrowAuthorizationDelegate(d, options)).toThrow(/deposit/);
  });
  it.each([0, 2])('refuses %i actions', (count) => {
    const d = buildEscrowAuthorizationDelegate(options); d.actions = Array(count).fill(d.actions[0]);
    expect(() => validateEscrowAuthorizationDelegate(d, options)).toThrow(/one action/);
  });
  it('rejects a different FT receiver, inner escrow receiver, method, sender, nonce or height', () => {
    for (const change of [{ receiverId: 'evil.testnet' }, { senderId: 'other.testnet' }, { nonce: '43' }, { maxBlockHeight: '999' }]) {
      expect(() => validateEscrowAuthorizationDelegate({ ...buildEscrowAuthorizationDelegate(options), ...change }, options)).toThrow(/match/);
    }
    for (const change of [{ methodName: 'ft_transfer' }, { args: JSON.stringify({ receiver_id: 'evil.testnet', amount: v1.amount, msg: buildEscrowMsg(v1) }) }]) {
      const d = buildEscrowAuthorizationDelegate(options); Object.assign(d.actions[0], change);
      expect(() => validateEscrowAuthorizationDelegate(d, options)).toThrow(/mismatch/);
    }
  });
  it('binds every FT argument byte (extra field, amount, msg whitespace)', () => {
    for (const change of [{ extra: 1 }, { amount: '2' }, { msg: ' ' + buildEscrowMsg(v1) }]) {
      const d = buildEscrowAuthorizationDelegate(options);
      d.actions[0].args = JSON.stringify({ ...JSON.parse(d.actions[0].args), ...change });
      expect(() => validateEscrowAuthorizationDelegate(d, options)).toThrow(/arguments/);
    }
  });
  it.each([NEAR_ESCROW_MIN_GAS, NEAR_ESCROW_MAX_GAS])('accepts gas boundary %s', async (gas) => {
    expect(decode(await signEscrowAuthorization({ ...options, gas })).gas).toBe(gas);
  });
  it.each([0n, NEAR_ESCROW_MIN_GAS - 1n, NEAR_ESCROW_MAX_GAS + 1n, 1n << 64n])('rejects gas %s before signing', async (gas) => {
    const sign = vi.fn(signer.sign);
    await expect(signEscrowAuthorization({ ...options, gas, signer: { ...signer, sign } })).rejects.toThrow(/gas/);
    expect(sign).not.toHaveBeenCalled();
  });
  it('seed copy, NEAR base58 secret, leading zero seed, inconsistent public half and key format', async () => {
    const localSeed = seed.slice(); const local = createNearLocalSigner(localSeed); localSeed.fill(0);
    const nearSecret = 'ed25519:' + encodeBase58(Buffer.concat([Buffer.from(seed), Buffer.from(signer.publicKey)]));
    expect(decode(await signEscrowAuthorization({ ...options, signer: createNearLocalSigner(nearSecret) })).signature)
      .toEqual(decode(await signEscrowAuthorization({ ...options, signer: local })).signature);
    for (const bad of [new Uint8Array(31), 'secp256k1:abc', 'ed25519:0', 'ed25519:' + '1'.repeat(64), 'ed25519:' + '1'.repeat(65), 'ed25519:' + encodeBase58(seed)]) {
      expect(() => createNearLocalSigner(bad)).toThrow();
    }
  });
  it('rejects wrong public key length and signatures, including NEP-413 style signatures', async () => {
    for (const badSigner of [{ ...signer, publicKey: new Uint8Array(31) }, { ...signer, sign: () => new Uint8Array(63) },
      { ...signer, sign: () => new Uint8Array(64) }, { ...signer, sign: () => signer.sign(new Uint8Array(32)) }]) {
      await expect(signEscrowAuthorization({ ...options, signer: badSigner })).rejects.toThrow(/Ed25519/);
    }
  });
});

describe('v1 lifecycle closed method list and zero deposit', () => {
  it('release/refund/reclaim/withdraw/withdraw_for sign their actual Rust args', async () => {
    const calls = [await release(options, v1.payment_id), await release(options, v1.payment_id, '400000'),
      await refund(options, v1.payment_id), await reclaim(options, v1.payment_id), await withdraw(options), await withdrawFor(options, v1.receiver)];
    const expected = [ ['release', { payment_id: v1.payment_id, amount: null }], ['release', { payment_id: v1.payment_id, amount: '400000' }],
      ['refund', { payment_id: v1.payment_id }], ['reclaim', { payment_id: v1.payment_id }], ['withdraw', {}], ['withdraw_for', { account: v1.receiver }] ];
    calls.forEach((p, i) => {
      const d = decode(p);
      expect([d.method, d.args]).toEqual(expected[i]); expect(d.deposit).toBe(0n); expect(d.receiver).toBe(options.escrowContract);
    });
  });
  it.each(['pause', 'on_withdraw', 'authorize_from_budget', 'open_dispute', 'resolve_dispute', 'toString', 'constructor', 'Release', 'release '])('forbids method %s', async (method) => {
    await expect(signEscrowLifecycle(options, method as NearEscrowLifecycleMethod)).rejects.toThrow(/not allowed/);
  });
  it.each(['', '0', '1'.repeat(31), '1'.repeat(33), 'l'.repeat(44), '1'.repeat(45)])('refuses payment ID %s', async (id) => {
    await expect(refund(options, id)).rejects.toThrow();
  });
  it('rejects unexpected args, empty withdrawal account, zero release and method gas boundaries', async () => {
    await expect(signEscrowLifecycle(options, 'withdraw', { account: v1.receiver })).rejects.toThrow(/argument/);
    await expect(signEscrowLifecycle(options, 'refund', { payment_id: v1.payment_id, amount: '1' })).rejects.toThrow(/argument/);
    await expect(withdrawFor(options, '')).rejects.toThrow(/account/);
    await expect(release(options, v1.payment_id, '0')).rejects.toThrow(/amount/);
    for (const [method, args, min, max] of [
      ['release', { payment_id: v1.payment_id }, 3_000_000_000_000n, 30_000_000_000_000n],
      ['withdraw', {}, 29_000_000_000_000n, 50_000_000_000_000n],
    ] as const) {
      for (const gas of [min - 1n, max + 1n]) await expect(signEscrowLifecycle({ ...options, gas }, method, args)).rejects.toThrow(/gas/);
      for (const gas of [min, max]) expect(decode(await signEscrowLifecycle({ ...options, gas }, method, args)).gas).toBe(gas);
    }
  });
  it('exports through the existing near subpath', async () => {
    const near = await import('./index');
    expect(near.signEscrowAuthorization).toBe(signEscrowAuthorization);
    expect(near.computePaymentId).toBe(computePaymentId);
    expect(near.withdrawFor).toBe(withdrawFor);
  });
});
