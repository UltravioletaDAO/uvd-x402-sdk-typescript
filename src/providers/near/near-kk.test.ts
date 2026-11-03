import { createHash, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { decodeBase58 } from 'ethers';
import vectors from './vectors/near-kk.json';
import { createNearLocalSigner, signExactNearDelegate, NEAR_ESCROW_TOKENS, type NearExactDelegateOptions } from './escrow';
import { nep413Preimage, signNep413 } from './nep413';
import { buildArrasStorageDeposit, buildUsdcStorageDeposit } from './storage';
import { parseArrasEvents } from './events';

const signer = createNearLocalSigner(Uint8Array.from({ length: 32 }, (_, i) => i));
const nonce = Uint8Array.from({ length: 32 }, (_, i) => i);
const exact: NearExactDelegateOptions = { network: 'near:testnet', signer, senderId: 'payer-demo.testnet',
  token: NEAR_ESCROW_TOKENS['near:testnet'], payTo: 'worker-demo.testnet', amount: '1000000', nonce: '7', maxBlockHeight: '100000000' };
const message = { signer, accountId: 'payer-demo.testnet', message: 'hi', nonce, recipient: 'myapp.com', callbackUrl: 'myapp.com/callback' };
const storage = { network: 'near:testnet' as const, payerId: 'payer-demo.testnet', escrowContract: 'arras-v1b-1101.testnet' };
const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), signer.publicKey]), format: 'der', type: 'spki' });

function decode(b64: string) {
  const wire = Buffer.from(b64, 'base64');
  let at = 0;
  const take = (n: number) => { const part = wire.subarray(at, at + n); at += n; return part; };
  const int = (n: number) => take(n).reduceRight((a, b) => a * 256n + BigInt(b), 0n);
  const string = () => take(Number(int(4))).toString('utf8');
  const sender = string(), token = string();
  expect(int(4)).toBe(1n); expect(int(1)).toBe(2n);
  const method = string(), args = JSON.parse(string()), gas = int(8), deposit = int(16);
  const nextNonce = int(8), height = int(8);
  expect(int(1)).toBe(0n); expect(take(32)).toEqual(Buffer.from(signer.publicKey));
  const delegate = wire.subarray(0, at);
  expect(int(1)).toBe(0n);
  const signature = take(64);
  const digest = createHash('sha256').update(Buffer.from('6e010040', 'hex')).update(delegate).digest();
  expect(verify(null, digest, publicKey, signature)).toBe(true);
  expect(at).toBe(wire.length);
  return { sender, token, method, args, gas, deposit, nextNonce, height };
}

describe('NEP-413 official example and independent fixed bytes', () => {
  it.each(vectors.nep413)('$id', async (v) => {
    const o = { ...message, message: v.message, recipient: v.recipient, callbackUrl: v.callbackUrl ?? undefined };
    const preimage = nep413Preimage(o);
    expect(Buffer.from(preimage).toString('hex')).toBe(v.preimageHex);
    const digest = createHash('sha256').update(preimage).digest();
    expect(digest.toString('hex')).toBe(v.digestHex);
    const signed = await signNep413(o);
    expect(signed.accountId).toBe(o.accountId);
    expect(signed.signature).toBe(v.signatureBase64);
    expect(signed.publicKey).toBe('ed25519:FAe4sisG95oZ42w7buUn5qEE4TAnfTTFPiguZUHmhiF');
    expect(verify(null, digest, publicKey, Buffer.from(signed.signature, 'base64'))).toBe(true);
    expect(verify(null, preimage, publicKey, Buffer.from(signed.signature, 'base64'))).toBe(false);
    if (v.id === 'official-example') {
      const mutated = preimage.slice(); mutated[0] ^= 1;
      expect(verify(null, createHash('sha256').update(mutated).digest(), publicKey, Buffer.from(signed.signature, 'base64'))).toBe(false);
    }
    expect(decodeBase58(signed.publicKey.slice(8))).toBeGreaterThan(0n);
  });
  it('distinguishes absent and empty callback, and copies caller nonce bytes', () => {
    const a = nep413Preimage({ ...message, callbackUrl: undefined });
    const b = nep413Preimage({ ...message, callbackUrl: '' });
    expect(a.at(-1)).toBe(0); expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
    const n = nonce.slice(); const before = nep413Preimage({ ...message, nonce: n }); n.fill(255);
    expect(before).toEqual(nep413Preimage(message));
  });
  it.each(['intents.near', 'INTENTS.NEAR', 'intents.near.', ' intents.near', 'intents.near\n', '', 'app.com ', null])('refuses recipient %s before signing', async (recipient) => {
    const spy = { publicKey: signer.publicKey, sign: vi.fn(signer.sign) };
    await expect(signNep413({ ...message, signer: spy, recipient: recipient as string })).rejects.toThrow(/recipient/);
    expect(spy.sign).not.toHaveBeenCalled();
  });
  it.each([new Uint8Array(31), new Uint8Array(33), [], '0'.repeat(32), null])('refuses malformed nonce %s', async (n) => {
    await expect(signNep413({ ...message, nonce: n as Uint8Array })).rejects.toThrow(/nonce/);
  });
  it.each([{ message: null }, { message: '\ud800' }, { message: '\udfff' }, { callbackUrl: '\ud800' }, { recipient: '\udfff' }, { callbackUrl: null }, { accountId: 'Payer.near' }, { accountId: 'a.near\n' }])('refuses malformed input %s', async (bad) => {
    const spy = { publicKey: signer.publicKey, sign: vi.fn(signer.sign) };
    await expect(signNep413({ ...message, ...bad, signer: spy } as never)).rejects.toThrow();
    expect(spy.sign).not.toHaveBeenCalled();
  });
  it('refuses a malformed public key before invoking an external signer', async () => {
    const spy = { publicKey: new Uint8Array(31), sign: vi.fn(signer.sign) };
    await expect(signNep413({ ...message, signer: spy })).rejects.toThrow(/public key/);
    expect(spy.sign).not.toHaveBeenCalled();
  });
  it.each([
    { publicKey: new Uint8Array(31), sign: signer.sign },
    { publicKey: signer.publicKey, sign: () => new Uint8Array(63) },
    { publicKey: signer.publicKey, sign: () => new Uint8Array(64) },
    { publicKey: signer.publicKey, sign: () => null },
  ])('checks external signer key and signature', async (badSigner) => {
    await expect(signNep413({ ...message, signer: badSigner } as never)).rejects.toThrow(/Ed25519/);
  });
});

describe('local exact NEP-366 reuses the escrow serializer', () => {
  it.each(vectors.exact)('$network: fixed bytes and OpenSSL verification', async (v) => {
    const signed = await signExactNearDelegate({ ...exact, ...v, network: v.network as NearExactDelegateOptions['network'] });
    expect(signed).toEqual({ x402Version: 2, scheme: 'exact', network: v.network, payload: { signedDelegateAction: v.signedDelegateAction } });
    expect(decode(signed.payload.signedDelegateAction)).toEqual({ sender: v.senderId, token: v.token, method: 'ft_transfer',
      args: { receiver_id: v.payTo, amount: v.amount }, gas: 30000000000000n, deposit: 1n, nextNonce: 7n, height: 100000000n });
  });
  it('serializes numeric/bigint amounts as decimal strings and accepts literal gas bounds', async () => {
    for (const gas of [1n, 30000000000000n]) {
      const d = decode((await signExactNearDelegate({ ...exact, gas, amount: 1000000n })).payload.signedDelegateAction);
      expect(d.args.amount).toBe('1000000'); expect(d.gas).toBe(gas);
    }
  });
  it('accepts the smallest positive expiry with the largest valid nonce below its ceiling', async () => {
    const d = decode((await signExactNearDelegate({ ...exact, maxBlockHeight: 1, nonce: 999999 })).payload.signedDelegateAction);
    expect(d.height).toBe(1n); expect(d.nextNonce).toBe(999999n);
  });
  it.each([
    { network: 'near' }, { token: NEAR_ESCROW_TOKENS['near:mainnet'] }, { token: 'usdc.testnet' },
    { payTo: 'intents.near' }, { payTo: 'INTENTS.NEAR' }, { payTo: 'a.near\n' }, { payTo: '' }, { payTo: null },
    { senderId: 'a' }, { senderId: 'Payer.near' }, { amount: 0 }, { amount: -1 }, { amount: '01' },
    { amount: '0x1' }, { amount: '0X1' }, { amount: '1\n' }, { amount: ' 1' }, { amount: 'ÃƒÂ¯Ã‚Â¼Ã¢â‚¬Ëœ' },
    { amount: 1.1 }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { amount: null }, { amount: 1n << 128n },
    { gas: 0n }, { gas: 30000000000001n }, { nonce: 0n }, { nonce: '100000000000000' },
    { nonce: 1n << 64n }, { maxBlockHeight: 0 }, { maxBlockHeight: 1n << 64n },
  ])('refuses %s before signing', async (bad) => {
    const spy = { publicKey: signer.publicKey, sign: vi.fn(signer.sign) };
    await expect(signExactNearDelegate({ ...exact, ...bad, signer: spy } as never)).rejects.toThrow();
    expect(spy.sign).not.toHaveBeenCalled();
  });
});

describe('payer-funded NEP-145 transactions', () => {
  it('Arras keeps the 0.05 NEAR deposit available; USDC only registers with 0.00125 NEAR', () => {
    expect(buildArrasStorageDeposit(storage)).toEqual({ signerId: storage.payerId, receiverId: storage.escrowContract,
      actions: [{ type: 'FunctionCall', params: { methodName: 'storage_deposit',
        args: { account_id: storage.payerId, registration_only: false }, gas: '30000000000000', deposit: '50000000000000000000000' } }] });
    for (const network of ['near:mainnet', 'near:testnet'] as const) {
      const tx = buildUsdcStorageDeposit({ ...storage, network, accountId: 'worker.near' });
      expect(tx.signerId).toBe(storage.payerId); expect(tx.receiverId).toBe(NEAR_ESCROW_TOKENS[network]);
      expect(tx.actions[0].params).toEqual({ methodName: 'storage_deposit', gas: '30000000000000', deposit: '1250000000000000000000',
        args: { account_id: 'worker.near', registration_only: true } });
      expect(tx).not.toHaveProperty('payload');
    }
  });
  it('supports the queried deposit, topping up another account, with exact integers', () => {
    const tx = buildArrasStorageDeposit({ ...storage, accountId: 'worker.testnet', deposit: 60000000000000000000000n });
    expect(tx.actions[0].params.deposit).toBe('60000000000000000000000');
    expect(tx.actions[0].params.args.account_id).toBe('worker.testnet');
  });
  it.each([{ network: 'near' }, { payerId: '' }, { payerId: 'a.near\n' }, { accountId: 'A.near' },
    { deposit: 0 }, { deposit: -1 }, { deposit: '01' }, { deposit: '1 ' }, { deposit: '0x1' }, { deposit: '0X1' },
    { deposit: Number.MAX_SAFE_INTEGER + 1 }, { deposit: 1n << 128n }])('refuses %s', (bad) => {
    expect(() => buildArrasStorageDeposit({ ...storage, ...bad } as never)).toThrow();
    expect(() => buildUsdcStorageDeposit({ ...storage, ...bad } as never)).toThrow();
  });
  it.each(['A.near', 'arras-v1b-1101.testnet\n', 'intents.near'])('rejects invalid storage target %s', (escrowContract) => {
    expect(() => buildArrasStorageDeposit({ ...storage, escrowContract })).toThrow();
  });
  it('uses the explicit mainnet deployment configuration without guessing an account parent', () => {
    expect(buildArrasStorageDeposit({ ...storage, network: 'near:mainnet', escrowContract: 'v1.arras-escrow.near' }).receiverId).toBe('v1.arras-escrow.near');
  });
});

// The same constructed Rust event envelopes are consumed by the Python conformance runner.
const data = Object.fromEntries(vectors.arrasEvents.map((line) => {
  const envelope = JSON.parse(line.slice(11));
  return [envelope.event, envelope.data[0]];
})) as Record<string, any>;
const log = (event: string, datum: unknown, override: Record<string, unknown> = {}) =>
  'EVENT_JSON:' + JSON.stringify({ standard: 'arras', version: '1.0.0', event, data: [datum], ...override });

describe('Arras events.rs NEP-297 vectors', () => {
  it.each(Object.entries(data))('%s: preserves typed fields and data batches', (event, datum) => {
    expect(parseArrasEvents([log(event, datum)])).toEqual([{ standard: 'arras', version: '1.0.0', event, data: [datum] }]);
    expect(parseArrasEvents([log(event, datum, { data: [datum, datum] })])[0].data).toEqual([datum, datum]);
  });
  it('matches the literal Rust released event vector, and accepts empty Vec', () => {
    const rust = 'EVENT_JSON:{"standard":"arras","version":"1.0.0","event":"released","data":[{"payment_id":"DN5eMA3sNES7xsoy6qvy24cVF6Dmwjxpkvd2b4e8P38M","amount":"1000000","net":"870000","fee":"130000"}]}';
    expect(parseArrasEvents([rust])[0].data).toEqual([data.released]);
    expect(parseArrasEvents([log('released', {}, { data: [] })])[0].data).toEqual([]);
  });
  it.each([undefined, null, 3, {}, 'EVENT_JSON:', 'EVENT_JSON:null', 'EVENT_JSON:[]', 'EVENT_JSON:{',
    'event_json:{}', ' EVENT_JSON:{}', 'log: EVENT_JSON:{}'])('skips foreign or malformed log %s', (bad) => {
    expect(parseArrasEvents([bad, log('withdrawn', data.withdrawn)])).toHaveLength(1);
  });
  it.each([{ standard: 'nep141' }, { standard: 'ARRAS' }, { standard: 'arras ' }, { version: '2.0.0' },
    { version: '1.0.0\n' }, { event: 'future' }, { event: '__proto__' }, { event: 'toString' },
    { data: {} }, { data: null }, { data: [null] }, { data: [{}] }])('skips unknown envelope %s', (override) => {
    expect(parseArrasEvents([log('released', data.released, override), log('released', data.released)])).toHaveLength(1);
  });
  it.each(Object.entries(data))('%s rejects every missing required or invalid present field', (event, datum) => {
    for (const key of Object.keys(datum)) {
      expect(parseArrasEvents([log(event, { ...datum, [key]: null })])).toEqual([]);
      if (event.startsWith('operator_') && key !== 'operator_id') continue; // Rust Option fields may be absent
      const missing = { ...datum } as Record<string, unknown>; delete missing[key];
      expect(parseArrasEvents([log(event, missing)])).toEqual([]);
    }
  });
  it.each(['', '-1', '01', '0x1', '0X1', '1e6', '1 ', '1\n', 'ÃƒÂ¯Ã‚Â¼Ã¢â‚¬Ëœ', (1n << 128n).toString(), 1000000, true])('rejects malformed U128 %s', (amount) => {
    expect(parseArrasEvents([log('refunded', { ...data.refunded, amount })])).toEqual([]);
  });
  it.each([-1, 65536, 1.5, '1300', null])('rejects malformed u16 fee %s', (fee_bps) => {
    expect(parseArrasEvents([log('authorized', { ...data.authorized, fee_bps })])).toEqual([]);
  });
  it('pins boolean, U64, string array validation, and skips the entire malformed batch', () => {
    expect(parseArrasEvents([log('paused', { ...data.paused, at: (1n << 64n).toString() })])).toEqual([]);
    expect(parseArrasEvents([log('withdrawn', { ...data.withdrawn, ok: 'false' })])).toEqual([]);
    expect(parseArrasEvents([log('operator_updated', { operator_id: 'em', capturers: [1] })])).toEqual([]);
    expect(parseArrasEvents([log('released', {}, { data: [data.released, {}] })])).toEqual([]);
    expect(parseArrasEvents([log('refunded', { ...data.refunded, amount: ((1n << 128n) - 1n).toString() })])).toHaveLength(1);
    expect(parseArrasEvents(null as never)).toEqual([]);
  });
});
