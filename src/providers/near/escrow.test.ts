import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { encodeBase58 } from 'ethers';
import vectors from './vectors/arras-v1.json';
import {
  buildEscrowMsg, computePaymentId, paymentIdPreimage, createNearLocalSigner, signEscrowAuthorization,
  buildEscrowAuthorizationDelegate, validateEscrowAuthorizationDelegate, signEscrowLifecycle,
  release, refund, reclaim, withdraw, withdrawFor, NEAR_ESCROW_MIN_GAS, NEAR_ESCROW_MAX_GAS, NEAR_ESCROW_CONTRACTS,
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
  it('rejects final line breaks without trimming signed values', async () => {
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
  it('refuses nonce >= maxBlockHeight * 10^6 before signing (NEAR DelegateActionNonceTooLarge)', async () => {
    for (const [nonce, maxBlockHeight] of [['99999999', '100'], ['18446744073709551615', '18446744073709551615']]) {
      expect(decode(await signEscrowAuthorization({ ...options, nonce, maxBlockHeight })).nonce).toBe(BigInt(nonce));
      expect(decode(await withdraw({ ...options, nonce, maxBlockHeight })).nonce).toBe(BigInt(nonce));
    }
    for (const [nonce, maxBlockHeight] of [['100000000', '100'], ['1000000', '1'], ['18446744073709551615', '1000']]) {
      const sign = vi.fn(signer.sign);
      const o = { ...options, nonce, maxBlockHeight, signer: { ...signer, sign } };
      await expect(signEscrowAuthorization(o)).rejects.toThrow(/nonce must be below/);
      await expect(withdraw(o)).rejects.toThrow(/nonce must be below/);
      expect(sign).not.toHaveBeenCalled();
    }
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
  // Facilitator literals written by hand, so a drifted SDK constant cannot validate itself.
  it('pins the authorization gas constants to 38 and 100 TGas, with 100 TGas as default', async () => {
    expect([NEAR_ESCROW_MIN_GAS, NEAR_ESCROW_MAX_GAS]).toEqual([38_000_000_000_000n, 100_000_000_000_000n]);
    expect(decode(await signEscrowAuthorization(options)).gas).toBe(100_000_000_000_000n);
  });
  it.each([38_000_000_000_000n, 100_000_000_000_000n])('accepts gas boundary %s', async (gas) => {
    expect(decode(await signEscrowAuthorization({ ...options, gas })).gas).toBe(gas);
  });
  it.each([0n, 37_999_999_999_999n, 100_000_000_000_001n, 1n << 64n])('rejects gas %s before signing', async (gas) => {
    const sign = vi.fn(signer.sign);
    await expect(signEscrowAuthorization({ ...options, gas, signer: { ...signer, sign } })).rejects.toThrow(/gas/);
    expect(sign).not.toHaveBeenCalled();
  });
  it('seed copy, NEAR base58 secret, leading zero seed, inconsistent public half and key format', async () => {
    const localSeed = seed.slice(); const local = createNearLocalSigner(localSeed); localSeed.fill(0);
    const nearSecret = 'ed25519:' + encodeBase58(Buffer.concat([Buffer.from(seed), Buffer.from(signer.publicKey)]));
    for (const prefix of ['ED25519:', 'ed25519 ', 'xx25519:']) {
      expect(() => createNearLocalSigner(prefix + nearSecret.slice(8))).toThrow(/ed25519:/);
    }
    expect(decode(await signEscrowAuthorization({ ...options, signer: createNearLocalSigner(nearSecret) })).signature)
      .toEqual(decode(await signEscrowAuthorization({ ...options, signer: local })).signature);
    for (const bad of [new Uint8Array(31), new Uint8Array(33), 'secp256k1:abc', 'ed25519:0', 'ed25519:' + '1'.repeat(64), 'ed25519:' + '1'.repeat(65), 'ed25519:' + encodeBase58(seed)]) {
      expect(() => createNearLocalSigner(bad)).toThrow();
    }
  });
  it('rejects wrong public key length and signatures, including NEP-413 style signatures', async () => {
    for (const badSigner of [{ ...signer, publicKey: new Uint8Array(31) }, { ...signer, sign: () => new Uint8Array(63) },
      { ...signer, sign: () => new Uint8Array(64) }, { ...signer, sign: () => signer.sign(new Uint8Array(32)) }]) {
      await expect(signEscrowAuthorization({ ...options, signer: badSigner })).rejects.toThrow(/Ed25519/);
    }
  });
  it('snapshots the network and refuses a signer that mutates its digest argument', async () => {
    const mutable = { ...options };
    mutable.signer = { ...signer, sign: (digest) => { mutable.network = 'near:mainnet'; return signer.sign(digest); } };
    expect((await signEscrowAuthorization(mutable)).network).toBe('near:testnet');
    await expect(signEscrowAuthorization({ ...options, signer: { ...signer,
      sign: (digest) => { digest.fill(0); return signer.sign(digest); } } })).rejects.toThrow(/signature/);
  });
});

describe('per-network Arras escrow registry', () => {
  const v3 = vectors.payment_id.vectores[2];
  const mainnet: EscrowAuthorizationOptions = { ...options, network: 'near:mainnet', senderId: v3.payer, token: v3.token, msg: v3 };
  const signedBy = (o: EscrowAuthorizationOptions) => [() => signEscrowAuthorization(o), () => release(o, v1.payment_id),
    () => refund(o, v1.payment_id), () => reclaim(o, v1.payment_id), () => withdraw(o), () => withdrawFor(o, v1.receiver)];
  it('is frozen: one testnet deployment and no mainnet contract yet', () => {
    expect(NEAR_ESCROW_CONTRACTS).toEqual({ 'near:testnet': ['arras-v1b-1101.testnet'], 'near:mainnet': [] });
    expect(() => { (NEAR_ESCROW_CONTRACTS['near:mainnet'] as string[]).push('evil-sink.near'); }).toThrow(TypeError);
    expect(() => { (NEAR_ESCROW_CONTRACTS as Record<string, readonly string[]>)['near:mainnet'] = ['evil-sink.near']; }).toThrow(TypeError);
    expect(NEAR_ESCROW_CONTRACTS['near:mainnet']).toEqual([]);
  });
  it.each(['evil-sink.near', 'arras-v1b-1101.testnet', 'arras.near', 'escrow.example.near'])(
    'mainnet refuses %s for authorization and every lifecycle call without calling the signer', async (escrowContract) => {
      const sign = vi.fn(signer.sign);
      const o = { ...mainnet, escrowContract, signer: { ...signer, sign } };
      expect(() => buildEscrowAuthorizationDelegate(o)).toThrow(/escrowContract/);
      for (const call of signedBy(o)) await expect(call()).rejects.toThrow(/escrowContract/);
      expect(sign).not.toHaveBeenCalled();
    });
  it.each(['evil-sink.testnet', 'arras.testnet', 'sub.arras-v1b-1101.testnet', 'arras-v1b-1101', 'arras-v1b-1101.testnet ', 'ARRAS-V1B-1101.TESTNET'])(
    'testnet refuses %s without calling the signer', async (escrowContract) => {
      const sign = vi.fn(signer.sign);
      for (const call of signedBy({ ...options, escrowContract, signer: { ...signer, sign } })) await expect(call()).rejects.toThrow(/escrowContract/);
      expect(sign).not.toHaveBeenCalled();
    });
  it('signs the contract it checked, even if an options getter changes after the first read', async () => {
    const flipping = () => {
      let reads = 0;
      return { ...options, get escrowContract() { return reads++ === 0 ? 'arras-v1b-1101.testnet' : 'evil-sink.testnet'; } };
    };
    expect(decode(await signEscrowAuthorization(flipping())).args.receiver_id).toBe('arras-v1b-1101.testnet');
    expect(decode(await withdraw(flipping())).receiver).toBe('arras-v1b-1101.testnet');
  });
});

describe('v1 lifecycle closed method list and zero deposit', () => {
  it('rejects an unknown network in lifecycle before asking for a signature', async () => {
    const sign = vi.fn(signer.sign);
    await expect(withdraw({ ...options, network: 'near' as 'near:mainnet', signer: { ...signer, sign } })).rejects.toThrow(/network/);
    expect(sign).not.toHaveBeenCalled();
  });
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
  it('rejects an empty withdrawal account and a zero release', async () => {
    await expect(withdrawFor(options, '')).rejects.toThrow(/account/);
    await expect(release(options, v1.payment_id, '0')).rejects.toThrow(/amount/);
  });
  // Facilitator gas limits written by hand (x402-rs escrow.rs), plus the argument a sibling method takes.
  const lifecycleTable = [
    ['release', { payment_id: v1.payment_id }, 3_000_000_000_000n, 30_000_000_000_000n, { account: v1.receiver }],
    ['refund', { payment_id: v1.payment_id }, 3_000_000_000_000n, 30_000_000_000_000n, { amount: '1' }],
    ['reclaim', { payment_id: v1.payment_id }, 3_000_000_000_000n, 30_000_000_000_000n, { amount: '1' }],
    ['withdraw', {}, 29_000_000_000_000n, 50_000_000_000_000n, { account: v1.receiver }],
    ['withdraw_for', { account: v1.receiver }, 29_000_000_000_000n, 50_000_000_000_000n, { payment_id: v1.payment_id }],
  ] as const;
  it.each(lifecycleTable)('%s gas: refuses min-1 and max+1, signs min and max, defaults to max', async (method, args, min, max) => {
    for (const gas of [min - 1n, max + 1n]) {
      const sign = vi.fn(signer.sign);
      await expect(signEscrowLifecycle({ ...options, gas, signer: { ...signer, sign } }, method, args)).rejects.toThrow(/gas/);
      expect(sign).not.toHaveBeenCalled();
    }
    for (const gas of [min, max]) expect(decode(await signEscrowLifecycle({ ...options, gas }, method, args)).gas).toBe(gas);
    expect(decode(await signEscrowLifecycle(options, method, args)).gas).toBe(max);
  });
  it.each(lifecycleTable)('%s refuses one extra argument before signing', async (method, args, _min, _max, extra) => {
    const sign = vi.fn(signer.sign);
    await expect(signEscrowLifecycle({ ...options, signer: { ...signer, sign } }, method, { ...args, ...extra })).rejects.toThrow(/argument/);
    expect(sign).not.toHaveBeenCalled();
  });
  it('exports through the existing near subpath', async () => {
    const near = await import('./index');
    expect(near.signEscrowAuthorization).toBe(signEscrowAuthorization);
    expect(near.computePaymentId).toBe(computePaymentId);
    expect(near.withdrawFor).toBe(withdrawFor);
  });
});
