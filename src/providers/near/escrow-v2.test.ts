import { readFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBase58 } from 'ethers';
import v2 from './vectors/arras-v2.json';
import v1vectors from './vectors/arras-v1.json';
import {
  buildEscrowMsg, computePaymentId, createNearLocalSigner, signEscrowAuthorization, buildEscrowAuthorizationDelegate,
  validateEscrowAuthorizationDelegate, signEscrowLifecycle, NEAR_ESCROW_TOKENS,
  type EscrowAuthorizationOptions, type EscrowMsgParams, type NearEscrowPayment, type NearEscrowLifecycleMethod,
} from './escrow';
import {
  OPERATOR_TICKET_DOMAIN, operatorTicketMessage, signOperatorTicket, verifyOperatorTicket, checkOperatorTicket,
  decodeOperatorTicketSig, canonicalOperatorTicket, parseTicketPubkey,
  type OperatorTicket, type OperatorTicketSigner, type OperatorTicketSubject,
} from './ticket';

/*
 * Arras v2 (UltravioletaDAO/arras 9f8332f): docs/vectores.json copied byte for byte as vectors/arras-v2.json, and
 * contracts/escrow-v2/src read for every rule pinned here (ticket.rs, msg.rs, authorize.rs, lib.rs, views.rs).
 */
const ticketVectors = v2.v2.operator_ticket;
const [T1, T2] = ticketVectors.vectores;
const testKey = ticketVectors.llave_de_prueba;
const seed = Uint8Array.from(Buffer.from(testKey.semilla_hex, 'hex'));
const operator = createNearLocalSigner(seed);
const expiry = BigInt(T1.expiry);
const justBefore = expiry - 1n;

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
/** Borsh by hand, as the contract's own test does (ticket.rs:125-157): no SDK encoder involved. */
const borshStr = (s: string) => { const b = Buffer.from(s, 'utf8'); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
/** Node/OpenSSL Ed25519, independent of the noble library the SDK uses. */
const opensslPublic = (pk: Uint8Array) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pk]), format: 'der', type: 'spki' });
const opensslPrivate = (s: Uint8Array) => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), s]), format: 'der', type: 'pkcs8' });

const paymentT1 = T1.subject as OperatorTicketSubject;
const budgetT2 = T2.subject as OperatorTicketSubject;
const t1Ticket: OperatorTicket = { expiry: T1.expiry, sig: T1.sig };
const t2Ticket: OperatorTicket = { expiry: T2.expiry, sig: T2.sig };

function spy(base: OperatorTicketSigner = operator) {
  const sign = vi.fn((m: Uint8Array) => base.sign(m));
  return { signer: { publicKey: base.publicKey, sign }, sign };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('the Arras v2 vector artifact', () => {
  it('is docs/vectores.json of arras 9f8332f, byte for byte', () => {
    const raw = readFileSync(new URL('./vectors/arras-v2.json', import.meta.url));
    expect(createHash('sha256').update(raw).digest('hex')).toBe('5a78be59d03ee2c57aae49aac6f64488b996f0e5868dda095c063a1372eb2f70');
    // The git blob ID of arras:docs/vectores.json at 9f8332f.
    const blob = createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex');
    expect(blob).toBe('246303c1f0b550521663de1a0808ff5b39f4b704');
  });
  it('keeps v1 unchanged: V-1..V-3 are the same vectors as arras-v1.json', () => {
    for (const [i, v] of v2.payment_id.vectores.entries()) {
      expect(computePaymentId(v)).toBe(v.payment_id);
      expect(v.payment_id).toBe(v1vectors.payment_id.vectores[i].payment_id);
    }
    expect(v2.msg_canonico_v1).toBe(v1vectors.msg_canonico_v1);
  });
});

describe('operator ticket vectors T-1 and T-2 (ticket.rs:159-185)', () => {
  it('the test key: seed 01 x 32, its public key and its ed25519: form', () => {
    expect(hex(operator.publicKey)).toBe(testKey.pubkey_hex);
    expect(hex(parseTicketPubkey(testKey.ticket_pubkey))).toBe(testKey.pubkey_hex);
    expect(hex(parseTicketPubkey(operator.publicKey))).toBe(testKey.pubkey_hex);
  });
  it.each([T1, T2])('$id: message bytes equal the vector and a hand-built Borsh', (t) => {
    const subject = t.subject as OperatorTicketSubject;
    const m = operatorTicketMessage(t.contract, subject, t.expiry);
    expect(hex(m)).toBe(t.mensaje_hex);
    const s = t.subject as { payment?: { payment_id: string }; budget?: { operator_id: string; owner: string; agent: string } };
    const tail = s.payment
      ? [Buffer.of(0), borshStr(s.payment.payment_id)]
      : [Buffer.of(1), borshStr(s.budget!.operator_id), borshStr(s.budget!.owner), borshStr(s.budget!.agent)];
    expect(hex(m)).toBe(Buffer.concat([borshStr('arras:v2:operator_ticket'), borshStr(t.contract), ...tail, u64(BigInt(t.expiry))]).toString('hex'));
    expect(OPERATOR_TICKET_DOMAIN).toBe('arras:v2:operator_ticket');
  });
  it.each([T1, T2])('$id: signOperatorTicket gives the vector signature, and OpenSSL verifies it', async (t) => {
    const subject = t.subject as OperatorTicketSubject;
    const ticket = await signOperatorTicket({ signer: operator, contract: t.contract, subject, expiry: t.expiry, now: justBefore });
    expect(ticket).toEqual({ expiry: t.expiry, sig: t.sig });
    expect(Object.keys(ticket)).toEqual(['expiry', 'sig']);
    const message = Buffer.from(t.mensaje_hex, 'hex');
    expect(nodeVerify(null, message, opensslPublic(operator.publicKey), Buffer.from(decodeOperatorTicketSig(t.sig)!))).toBe(true);
    expect(verifyOperatorTicket({ publicKey: testKey.ticket_pubkey, contract: t.contract, subject, ticket, now: justBefore })).toBe(true);
  });
  it('an external signer (OpenSSL, async) signs the same tickets: the key is injected, never read from a file', async () => {
    const key = opensslPrivate(seed);
    const external: OperatorTicketSigner = { publicKey: operator.publicKey, sign: async (m) => new Uint8Array(nodeSign(null, m, key)) };
    expect(await signOperatorTicket({ signer: external, contract: T1.contract, subject: paymentT1, expiry: T1.expiry, now: 0n })).toEqual(t1Ticket);
    expect(await signOperatorTicket({ signer: external, contract: T2.contract, subject: budgetT2, expiry: T2.expiry, now: 0n })).toEqual(t2Ticket);
    // A NEAR ed25519: secret (seed + public key) is the same key.
    const nearSecret = 'ed25519:' + encodeBase58(Buffer.concat([Buffer.from(seed), Buffer.from(operator.publicKey)]));
    expect(await signOperatorTicket({ signer: createNearLocalSigner(nearSecret), contract: T1.contract, subject: paymentT1, expiry: T1.expiry, now: 0n })).toEqual(t1Ticket);
  });
});

describe('a ticket verifies only for its contract, subject, expiry and key, before expiry (authorize.rs:263-285)', () => {
  const check = (over: Partial<Parameters<typeof checkOperatorTicket>[0]> = {}) =>
    checkOperatorTicket({ ticketPubkey: testKey.ticket_pubkey, contract: T1.contract, subject: paymentT1, ticket: t1Ticket, now: justBefore, ...over });
  it('passes as signed', () => {
    expect(check()).toBeNull();
    expect(check({ subject: budgetT2, ticket: t2Ticket })).toBeNull();
    expect(check({ now: 0n })).toBeNull();
  });
  it('expired: now == expiry and later are E54, checked before the signature', () => {
    for (const now of [expiry, expiry + 1n, (1n << 64n) - 1n]) {
      expect(check({ now })).toBe('E54_TICKET_VENCIDO');
      expect(check({ now, ticket: { ...t1Ticket, sig: T2.sig } })).toBe('E54_TICKET_VENCIDO');
      expect(verifyOperatorTicket({ publicKey: testKey.ticket_pubkey, contract: T1.contract, subject: paymentT1, ticket: t1Ticket, now })).toBe(false);
    }
  });
  it('another contract does not verify', () => {
    for (const contract of ['v2b.arras-dev.testnet', 'v2.arras-escrow.near', 'v1.arras-escrow.near', 'arras-dev.testnet']) {
      expect(check({ contract })).toBe('E53_TICKET_INVALIDO');
    }
  });
  it('another subject does not verify: another payment, the other kind, another budget pair', () => {
    const others: OperatorTicketSubject[] = [
      { payment: { payment_id: v2.payment_id.vectores[1].payment_id } },
      { payment: { payment_id: v2.payment_id.vectores[2].payment_id } },
      budgetT2,
      { budget: { operator_id: 'em', owner: 'payer-demo.testnet', agent: (paymentT1 as { payment: { payment_id: string } }).payment.payment_id.toLowerCase() } },
      { budget: { operator_id: 'em', owner: 'agent-demo.testnet', agent: 'payer-demo.testnet' } },
      { budget: { operator_id: 'em2', owner: 'payer-demo.testnet', agent: 'agent-demo.testnet' } },
    ];
    for (const subject of others) expect(check({ subject })).toBe('E53_TICKET_INVALIDO');
    expect(check({ subject: paymentT1, ticket: t2Ticket })).toBe('E53_TICKET_INVALIDO');
  });
  it('another expiry or another key does not verify', () => {
    expect(check({ ticket: { ...t1Ticket, expiry: (expiry + 1n).toString() } })).toBe('E53_TICKET_INVALIDO');
    expect(check({ ticket: { ...t1Ticket, expiry: (expiry - 1n).toString() }, now: 0n })).toBe('E53_TICKET_INVALIDO');
    const other = operator.publicKey; other[0] ^= 1;
    expect(check({ ticketPubkey: other })).toBe('E53_TICKET_INVALIDO');
    expect(check({ ticketPubkey: createNearLocalSigner(new Uint8Array(32).fill(2)).publicKey })).toBe('E53_TICKET_INVALIDO');
  });
  it('key and ticket must come together: none passes, either one alone is E53', () => {
    expect(check({ ticketPubkey: null, ticket: null })).toBeNull();
    expect(check({ ticketPubkey: undefined, ticket: undefined })).toBeNull();
    expect(check({ ticketPubkey: null })).toBe('E53_TICKET_INVALIDO');
    expect(check({ ticket: null })).toBe('E53_TICKET_INVALIDO');
    expect(verifyOperatorTicket({ publicKey: testKey.ticket_pubkey, contract: T1.contract, subject: paymentT1, ticket: null as never, now: 0n })).toBe(false);
  });
  it('malformed signatures are E53 and do not decode (ticket.rs:222-264)', () => {
    const sig = T1.sig;
    const bytes = decodeOperatorTicketSig(sig)!;
    expect(bytes).toHaveLength(64);
    const zeroFirst = bytes.slice(); zeroFirst[0] = 0;
    const withZero = encodeBase58(zeroFirst);
    expect(decodeOperatorTicketSig(withZero)).toEqual(zeroFirst); // leading zeros: shorter, still canonical
    for (const bad of ['', '0', sig + '1', '1' + sig, 'l' + sig.slice(1), '1'.repeat(89), encodeBase58(new Uint8Array(63).fill(7)),
      encodeBase58(new Uint8Array(65).fill(7)), encodeBase58(new Uint8Array(64)).slice(1), ' ' + sig, sig + '\n', sig.toLowerCase()]) {
      expect(decodeOperatorTicketSig(bad), bad).toBeNull();
      expect(check({ ticket: { expiry: T1.expiry, sig: bad } }), bad).toBe('E53_TICKET_INVALIDO');
    }
    for (const other of [sig.slice(0, -1), withZero, encodeBase58(new Uint8Array(64).fill(7))]) {
      expect(check({ ticket: { expiry: T1.expiry, sig: other } }), other).toBe('E53_TICKET_INVALIDO');
    }
    for (const bad of [null, 7, ['x'], { sig }]) expect(decodeOperatorTicketSig(bad)).toBeNull();
  });
  it('malformed ticket objects are E53', () => {
    for (const ticket of [{ ...t1Ticket, extra: 1 }, { expiry: T1.expiry }, { sig: T1.sig }, { expiry: Number(T1.expiry), sig: T1.sig },
      { expiry: 5, sig: T1.sig },
      { expiry: '0' + T1.expiry, sig: T1.sig }, { expiry: '+' + T1.expiry, sig: T1.sig }, { expiry: ' ' + T1.expiry, sig: T1.sig },
      { expiry: (1n << 64n).toString(), sig: T1.sig }, { expiry: '-1', sig: T1.sig }, [T1.expiry, T1.sig], 'ticket']) {
      expect(check({ ticket: ticket as never }), JSON.stringify(ticket)).toBe('E53_TICKET_INVALIDO');
    }
  });
  it('a small-order key never verifies (strict RFC 8032): R = identity, S = 0 would pass a cofactorless check', () => {
    const identity = new Uint8Array(32); identity[0] = 1;
    const forged = new Uint8Array(64); forged[0] = 1;
    expect(check({ ticketPubkey: identity, ticket: { expiry: T1.expiry, sig: encodeBase58(forged) } })).toBe('E53_TICKET_INVALIDO');
  });
  it('reads the subject once: a flipping getter cannot verify one subject and report another', () => {
    let reads = 0;
    const payment = { get payment_id() { return reads++ === 0 ? v2.payment_id.vectores[1].payment_id : T1.subject.payment!.payment_id; } };
    expect(check({ subject: { payment } })).toBe('E53_TICKET_INVALIDO');
    expect(reads).toBe(1);
  });
  it('defaults now to the wall clock in nanoseconds', () => {
    const atMs = Number(expiry / 1_000_000n);
    vi.spyOn(Date, 'now').mockReturnValue(atMs - 1);
    expect(checkOperatorTicket({ ticketPubkey: testKey.ticket_pubkey, contract: T1.contract, subject: paymentT1, ticket: t1Ticket })).toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(atMs);
    expect(checkOperatorTicket({ ticketPubkey: testKey.ticket_pubkey, contract: T1.contract, subject: paymentT1, ticket: t1Ticket })).toBe('E54_TICKET_VENCIDO');
  });
  it('a malformed key, contract or subject is a caller error, not a verdict', () => {
    for (const ticketPubkey of ['ed25519:', 'secp256k1:' + testKey.ticket_pubkey.slice(8), 'ED25519:' + testKey.ticket_pubkey.slice(8),
      testKey.ticket_pubkey + '1', testKey.ticket_pubkey.slice(8), new Uint8Array(31), new Uint8Array(33),
      'ed25519:' + '1'.repeat(33), 'ed25519:' + encodeBase58(new Uint8Array(31).fill(9)), 'ed25519:' + encodeBase58(new Uint8Array(33).fill(9)),
      ' ' + testKey.ticket_pubkey, testKey.ticket_pubkey + '\n', [...operator.publicKey] as never]) {
      expect(() => check({ ticketPubkey })).toThrow(/ticket_pubkey/);
    }
    expect(() => check({ contract: 'V2.arras-dev.testnet' })).toThrow(/contract/);
    expect(() => check({ subject: {} as never })).toThrow(/subject/);
    expect(() => check({ ticketPubkey: null, ticket: null, contract: '' })).toThrow(/contract/);
  });
});

describe('signOperatorTicket refuses before calling the signer', () => {
  const base = { contract: T1.contract, subject: paymentT1, expiry: T1.expiry, now: justBefore };
  it('an expiry at or before now (E54), including the default wall clock', async () => {
    for (const now of [expiry, expiry + 1n]) {
      const { signer, sign } = spy();
      await expect(signOperatorTicket({ ...base, signer, now })).rejects.toThrow(/expired/);
      expect(sign).not.toHaveBeenCalled();
    }
    const atMs = Number(expiry / 1_000_000n);
    vi.spyOn(Date, 'now').mockReturnValue(atMs);
    const { signer, sign } = spy();
    await expect(signOperatorTicket({ signer, contract: T1.contract, subject: paymentT1, expiry: T1.expiry })).rejects.toThrow(/expired/);
    expect(sign).not.toHaveBeenCalled();
    vi.spyOn(Date, 'now').mockReturnValue(atMs - 1);
    expect(await signOperatorTicket({ signer: operator, contract: T1.contract, subject: paymentT1, expiry: T1.expiry })).toEqual(t1Ticket);
  });
  it.each([
    ['contract', { contract: 'V2.arras-dev.testnet' }], ['contract', { contract: ' v2.arras-dev.testnet' }],
    ['contract', { contract: 'v2.arras-dev.testnet\n' }], ['contract', { contract: 'v2.аrras-dev.testnet' }],
    ['contract', { contract: '' }], ['contract', { contract: null }], ['contract', { contract: 'a'.repeat(65) }],
    ['expiry', { expiry: 1n << 64n }], ['expiry', { expiry: '0' + T1.expiry }], ['expiry', { expiry: Number(T1.expiry) }],
    ['expiry', { expiry: -1 }], ['now', { now: -1 }], ['now', { now: '1.5' }],
    ['subject', { subject: {} }], ['subject', { subject: null }], ['subject', { subject: { ...paymentT1, ...budgetT2 } }],
    ['subject', { subject: { refund: { payment_id: T1.subject.payment!.payment_id } } }],
    ['subject', { subject: { payment: { payment_id: T1.subject.payment!.payment_id, amount: '1' } } }],
    ['subject', { subject: { budget: { operator_id: 'em', owner: 'payer-demo.testnet' } } }],
    ['payment_id', { subject: { payment: { payment_id: '1'.repeat(31) } } }],
    ['payment_id', { subject: { payment: { payment_id: '1'.repeat(33) } } }],
    ['payment_id', { subject: { payment: { payment_id: 'l'.repeat(44) } } }],
    ['payment_id', { subject: { payment: { payment_id: T1.subject.payment!.payment_id + '\n' } } }],
    ['payment_id', { subject: { payment: { payment_id: '0' + T1.subject.payment!.payment_id.slice(1) } } }],
    ['payment_id', { subject: { payment: { payment_id: 7 } } }],
    ['operator_id', { subject: { budget: { ...T2.subject.budget!, operator_id: 'EM' } } }],
    ['operator_id', { subject: { budget: { ...T2.subject.budget!, operator_id: 'em ' } } }],
    ['operator_id', { subject: { budget: { ...T2.subject.budget!, operator_id: '' } } }],
    ['owner', { subject: { budget: { ...T2.subject.budget!, owner: 'Payer.testnet' } } }],
    ['owner', { subject: { budget: { ...T2.subject.budget!, owner: 'payer-demo.testnet ' } } }],
    ['agent', { subject: { budget: { ...T2.subject.budget!, agent: '' } } }],
    ['agent', { subject: { budget: { ...T2.subject.budget!, agent: 'agent_.testnet' } } }],
  ])('bad %s (case %#)', async (field, change) => {
    const { signer, sign } = spy();
    await expect(signOperatorTicket({ ...base, signer, ...change } as never)).rejects.toThrow(field === 'payment_id' ? /payment_id/ : new RegExp(field));
    expect(sign).not.toHaveBeenCalled();
  });
  it('accepts every NEAR account form for owner and agent: implicit, sub-accounts, boundary characters', async () => {
    for (const agent of ['a'.repeat(64), 'agent-1_x.sub.near', '0x' + 'ab'.repeat(20), 'ab']) {
      const subject = { budget: { operator_id: 'a_-9', owner: 'payer-demo.testnet', agent } };
      const ticket = await signOperatorTicket({ ...base, signer: operator, subject });
      expect(verifyOperatorTicket({ publicKey: operator.publicKey, contract: T1.contract, subject, ticket, now: justBefore })).toBe(true);
    }
  });
  it('a signer that fails, mutates its argument, or holds another key is refused after signing', async () => {
    const wrong = createNearLocalSigner(new Uint8Array(32).fill(2));
    for (const bad of [
      { publicKey: operator.publicKey, sign: () => new Uint8Array(63) },
      { publicKey: operator.publicKey, sign: () => new Uint8Array(64) },
      { publicKey: operator.publicKey, sign: (m: Uint8Array) => { m[m.length - 1] ^= 1; return operator.sign(m); } },
      { publicKey: operator.publicKey, sign: (m: Uint8Array) => wrong.sign(m) },
      { publicKey: operator.publicKey, sign: () => Array.from(decodeOperatorTicketSig(T1.sig)!) as unknown as Uint8Array },
    ]) {
      await expect(signOperatorTicket({ ...base, signer: bad })).rejects.toThrow(/Invalid Ed25519 ticket signature/);
    }
    for (const publicKey of [new Uint8Array(31), new Uint8Array(33), Array.from(operator.publicKey)]) {
      const sign = vi.fn(operator.sign);
      await expect(signOperatorTicket({ ...base, signer: { publicKey: publicKey as Uint8Array, sign } })).rejects.toThrow(/public key/);
      expect(sign).not.toHaveBeenCalled();
    }
    await expect(signOperatorTicket({ ...base, signer: null as never })).rejects.toThrow(/signer/);
  });
  it('signs the contract and subject it checked, even if a getter changes after the first read', async () => {
    let reads = 0;
    const flipping = { ...base, signer: operator, get contract() { return reads++ === 0 ? T1.contract : 'evil.testnet'; } };
    const ticket = await signOperatorTicket(flipping);
    expect(ticket).toEqual(t1Ticket);
    let subjectReads = 0;
    const payment = { get payment_id() { return subjectReads++ === 0 ? T1.subject.payment!.payment_id : v2.payment_id.vectores[1].payment_id; } };
    expect(await signOperatorTicket({ ...base, signer: operator, subject: { payment } })).toEqual(t1Ticket);
  });
});

describe('the v2 authorize msg (msg.rs:3-11, 53-104)', () => {
  const vm = v2.v2.msg_authorize;
  const v1 = v2.payment_id.vectores[0];
  const base: EscrowMsgParams = { operator_id: v1.operator_id, receiver: v1.receiver, release_deadline: v1.release_deadline,
    reclaim_after: v1.reclaim_after, fee_bps_max: v1.fee_bps_max, terms_hash: v1.terms_hash, salt: v1.salt };
  const pid = (p: EscrowMsgParams) => computePaymentId({ ...p, token: v1.token, payer: v1.payer, amount: v1.amount });
  it('a v1 msg is the v2 canonical without the new fields, and v1 bytes do not change', () => {
    expect(buildEscrowMsg(base)).toBe(vm.canonico_v1_en_v2);
    expect(buildEscrowMsg(base)).toBe(v1vectors.msg_canonico_v1);
    expect(buildEscrowMsg({ ...base, dispute_deadline: null, operator_ticket: null })).toBe(vm.canonico_v1_en_v2);
    expect(buildEscrowMsg({ ...base, dispute_deadline: undefined, operator_ticket: undefined })).toBe(vm.canonico_v1_en_v2);
  });
  it('dispute_deadline, then operator_ticket, at the end and in that order', () => {
    expect(buildEscrowMsg({ ...base, dispute_deadline: v1.release_deadline })).toBe(vm.canonico_con_dispute_deadline);
    expect(buildEscrowMsg({ ...base, dispute_deadline: BigInt(v1.release_deadline), operator_ticket: t1Ticket })).toBe(vm.canonico_con_ticket_t1);
    expect(buildEscrowMsg({ ...base, operator_ticket: t1Ticket, dispute_deadline: v1.release_deadline })).toBe(vm.canonico_con_ticket_t1);
    expect(buildEscrowMsg({ ...base, operator_ticket: t1Ticket }))
      .toBe(vm.canonico_v1_en_v2.slice(0, -1) + `,"operator_ticket":{"expiry":"${T1.expiry}","sig":"${T1.sig}"}}`);
  });
  it('the new fields do not enter the payment ID (all three are V-1, and T-1 is its ticket)', () => {
    expect(vm.payment_id_de_los_tres).toBe(v1.payment_id);
    for (const p of [base, { ...base, dispute_deadline: v1.release_deadline }, { ...base, dispute_deadline: v1.release_deadline, operator_ticket: t1Ticket }]) {
      expect(pid(p)).toBe(vm.payment_id_de_los_tres);
    }
    expect((paymentT1 as { payment: { payment_id: string } }).payment.payment_id).toBe(vm.payment_id_de_los_tres);
  });
  it('VB-1: a budget payment ID is computePaymentId with payer = the budget owner', () => {
    const vb = v2.v2.authorize_from_budget.vectores[0];
    expect(computePaymentId({ ...vb, token: v1.token, payer: vb.owner })).toBe(vb.payment_id);
  });
  it('dispute_deadline: release_deadline <= dispute_deadline <= reclaim_after (E67, E11), as an exact u64', () => {
    const release = BigInt(v1.release_deadline), reclaim = BigInt(v1.reclaim_after);
    for (const ok of [release, release + 1n, reclaim - 1n, reclaim]) {
      expect(JSON.parse(buildEscrowMsg({ ...base, dispute_deadline: ok })).dispute_deadline).toBe(ok.toString());
    }
    for (const bad of [release - 1n, 0n, reclaim + 1n]) expect(() => buildEscrowMsg({ ...base, dispute_deadline: bad })).toThrow(/dispute_deadline must satisfy/);
    for (const bad of [1n << 64n, '0' + v1.release_deadline, ' ' + v1.release_deadline, -1, 1.5, Number(v1.release_deadline), true, '1e18'])
      expect(() => buildEscrowMsg({ ...base, dispute_deadline: bad as never })).toThrow(/dispute_deadline/);
  });
  it('operator_ticket: exactly { expiry, sig }, expiry a u64 decimal, sig canonical base58 of 64 bytes', () => {
    for (const bad of [{ ...t1Ticket, extra: 1 }, { expiry: T1.expiry }, { sig: T1.sig }, { expiry: Number(T1.expiry), sig: T1.sig },
      { expiry: '0' + T1.expiry, sig: T1.sig }, { expiry: T1.expiry, sig: '' }, { expiry: T1.expiry, sig: T1.sig + '1' },
      { expiry: T1.expiry, sig: 7 }, [T1.expiry, T1.sig], 'x', 0]) {
      expect(() => buildEscrowMsg({ ...base, operator_ticket: bad as never }), JSON.stringify(bad)).toThrow(/operator_ticket/);
    }
    expect(canonicalOperatorTicket({ expiry: BigInt(T1.expiry) as never, sig: T1.sig })).toEqual(t1Ticket);
    expect(Object.keys(canonicalOperatorTicket({ sig: T1.sig, expiry: T1.expiry }))).toEqual(['expiry', 'sig']);
  });
  it('reads each field once: a flipping getter cannot write a value other than the one checked', () => {
    let reads = 0;
    const p = { ...base, get dispute_deadline() { return reads++ === 0 ? v1.release_deadline : '1'; } };
    expect(buildEscrowMsg(p)).toBe(vm.canonico_con_dispute_deadline);
    let ticketReads = 0;
    const q = { ...base, get operator_ticket() { return ticketReads++ === 0 ? t1Ticket : { expiry: '1', sig: T2.sig }; } };
    expect(JSON.parse(buildEscrowMsg(q)).operator_ticket).toEqual(t1Ticket);
  });
});

/** Independent Borsh reader of the signed NEP-366 wire (as in escrow.test.ts). */
function decode(payment: NearEscrowPayment) {
  const wire = Buffer.from(payment.payload.signedDelegateAction, 'base64');
  let at = 0;
  const take = (n: number) => { const r = wire.subarray(at, at + n); at += n; return r; };
  const int = (n: number) => { const b = take(n); return b.reduceRight((s, c) => s * 256n + BigInt(c), 0n); };
  const string = () => take(Number(int(4))).toString('utf8');
  const sender = string(), receiver = string(); int(4); int(1);
  const method = string(), argsText = string(), gas = int(8), deposit = int(16);
  int(8); int(8); int(1); const publicKey = take(32);
  const delegate = wire.subarray(0, at); int(1); const signature = take(64);
  expect(at).toBe(wire.length);
  const hash = createHash('sha256').update(Buffer.from('6e010040', 'hex')).update(delegate).digest();
  expect(nodeVerify(null, hash, opensslPublic(publicKey), signature)).toBe(true);
  return { sender, receiver, method, argsText, args: JSON.parse(argsText), gas, deposit };
}

describe('the NEAR escrow client on Arras v2 (mainnet v2.arras-escrow.near)', () => {
  const v3 = v2.payment_id.vectores[2];
  const payer = createNearLocalSigner(Uint8Array.from({ length: 32 }, (_, i) => i));
  const msgV3: EscrowMsgParams = { operator_id: v3.operator_id, receiver: v3.receiver, release_deadline: v3.release_deadline,
    reclaim_after: v3.reclaim_after, fee_bps_max: v3.fee_bps_max, terms_hash: v3.terms_hash, salt: v3.salt };
  const options: EscrowAuthorizationOptions = { network: 'near:mainnet', signer: payer, senderId: v3.payer,
    escrowContract: 'v2.arras-escrow.near', token: NEAR_ESCROW_TOKENS['near:mainnet'], amount: v3.amount, msg: msgV3,
    nonce: '42', maxBlockHeight: '100000000' };
  const subject = { payment: { payment_id: v3.payment_id } };
  const ticketFor = (contract: string) => signOperatorTicket({ signer: operator, contract, subject, expiry: T1.expiry, now: 0n });

  it('signs ft_transfer_call to v2 with dispute_deadline and the operator ticket in the canonical msg', async () => {
    const operator_ticket = await ticketFor('v2.arras-escrow.near');
    const msg = { ...msgV3, dispute_deadline: v3.release_deadline, operator_ticket };
    const d = decode(await signEscrowAuthorization({ ...options, msg }));
    expect(d).toMatchObject({ sender: v3.payer, receiver: NEAR_ESCROW_TOKENS['near:mainnet'], method: 'ft_transfer_call', deposit: 1n });
    expect(d.argsText).toBe(JSON.stringify({ receiver_id: 'v2.arras-escrow.near', amount: v3.amount, msg: buildEscrowMsg(msg) }));
    const inner = JSON.parse(d.args.msg);
    expect(Object.keys(inner).slice(-2)).toEqual(['dispute_deadline', 'operator_ticket']);
    // The payment ID the contract derives is the v1 one, and the ticket in the signed msg is for it, in this contract.
    expect(computePaymentId({ ...msgV3, token: options.token, payer: v3.payer, amount: v3.amount })).toBe(v3.payment_id);
    expect(verifyOperatorTicket({ publicKey: operator.publicKey, contract: d.args.receiver_id, subject, ticket: inner.operator_ticket, now: 0n })).toBe(true);
    expect(verifyOperatorTicket({ publicKey: operator.publicKey, contract: 'v1.arras-escrow.near', subject, ticket: inner.operator_ticket, now: 0n })).toBe(false);
  });
  it('a v1 msg to v2 is the v1 authorization with only the escrow account changed', async () => {
    const toV2 = decode(await signEscrowAuthorization(options));
    const toV1 = decode(await signEscrowAuthorization({ ...options, escrowContract: 'v1.arras-escrow.near' }));
    expect(toV2.args).toEqual({ ...toV1.args, receiver_id: 'v2.arras-escrow.near' });
    expect(toV2.args.msg).toBe(buildEscrowMsg(msgV3));
  });
  it('v1 contracts refuse a msg with v2 fields before the signer is called', async () => {
    const operator_ticket = await ticketFor('v1.arras-escrow.near');
    const v1Options = (network: 'near:mainnet' | 'near:testnet') => network === 'near:mainnet'
      ? { ...options, escrowContract: 'v1.arras-escrow.near' }
      : { ...options, network, escrowContract: 'arras-v1b-1101.testnet', token: NEAR_ESCROW_TOKENS['near:testnet'] };
    for (const network of ['near:mainnet', 'near:testnet'] as const) {
      for (const extra of [{ dispute_deadline: v3.release_deadline }, { operator_ticket }, { dispute_deadline: v3.reclaim_after, operator_ticket }]) {
        const sign = vi.fn(payer.sign);
        const o = { ...v1Options(network), signer: { ...payer, sign }, msg: { ...msgV3, ...extra } } as EscrowAuthorizationOptions;
        expect(() => buildEscrowAuthorizationDelegate(o)).toThrow(/escrowContract: dispute_deadline and operator_ticket need an Arras v2 escrow/);
        await expect(signEscrowAuthorization(o)).rejects.toThrow(/Arras v2 escrow/);
        expect(sign).not.toHaveBeenCalled();
      }
    }
  });
  it('the delegate binds the ticket bytes: dropping or swapping it is a mismatch', async () => {
    const operator_ticket = await ticketFor('v2.arras-escrow.near');
    const o = { ...options, msg: { ...msgV3, operator_ticket } };
    const good = buildEscrowAuthorizationDelegate(o);
    expect(() => validateEscrowAuthorizationDelegate(good, o)).not.toThrow();
    for (const msg of [buildEscrowMsg(msgV3), buildEscrowMsg({ ...msgV3, operator_ticket: t1Ticket })]) {
      const d = buildEscrowAuthorizationDelegate(o);
      d.actions[0].args = JSON.stringify({ receiver_id: 'v2.arras-escrow.near', amount: v3.amount, msg });
      expect(() => validateEscrowAuthorizationDelegate(d, o)).toThrow(/arguments/);
    }
  });
  it.each([
    ['release', { payment_id: v3.payment_id }], ['release', { payment_id: v3.payment_id, amount: '400000' }],
    ['refund', { payment_id: v3.payment_id }], ['reclaim', { payment_id: v3.payment_id }], ['withdraw', {}],
    ['withdraw_for', { account: v3.receiver }],
  ] as [NearEscrowLifecycleMethod, Record<string, string>][])(
    'lifecycle %s on v2: the same method and arguments as v1 (lifecycle.rs:17-74, withdraw.rs:19-24)', async (method, args) => {
      const onV2 = decode(await signEscrowLifecycle(options, method, args));
      const onV1 = decode(await signEscrowLifecycle({ ...options, escrowContract: 'v1.arras-escrow.near' }, method, args));
      expect(onV2.receiver).toBe('v2.arras-escrow.near');
      expect([onV2.method, onV2.argsText, onV2.gas, onV2.deposit]).toEqual([onV1.method, onV1.argsText, onV1.gas, onV1.deposit]);
    });
  it.each(['authorize_from_budget', 'open_dispute', 'resolve_dispute', 'resolve_expired_dispute', 'withdraw_budget',
    'revoke_agent', 'set_budget_caps'])('does not sign the v2-only method %s', async (method) => {
    await expect(signEscrowLifecycle(options, method as NearEscrowLifecycleMethod)).rejects.toThrow(/not allowed/);
  });
});

describe('exports', () => {
  it('ticket helpers come through the near subpath', async () => {
    const near = await import('./index');
    expect(near.signOperatorTicket).toBe(signOperatorTicket);
    expect(near.verifyOperatorTicket).toBe(verifyOperatorTicket);
    expect(near.checkOperatorTicket).toBe(checkOperatorTicket);
    expect(near.operatorTicketMessage).toBe(operatorTicketMessage);
    expect(near.NEAR_ESCROW_V2_CONTRACTS['near:mainnet']).toEqual(['v2.arras-escrow.near']);
  }, 60_000); // the first import of the near index transforms the provider and its types: slow on a loaded runner
});
