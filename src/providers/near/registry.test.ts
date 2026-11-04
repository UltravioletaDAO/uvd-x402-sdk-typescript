import { describe, expect, it, vi } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha256';
import { encodeBase58 } from 'ethers';
import { createNearLocalSigner } from './escrow';
import * as r from './registry';
import vectors from './vectors/near-registry.json';

const common = { network: 'near:mainnet' as const, signerId: 'payer.near' };
const identity = { ...common, agent_uri: 'https://agente.example/card.json' };
const payment = { escrow: 'v1.arras-escrow.near', payment_id: '1'.repeat(32) };
const feedback = { ...common, ...payment, score: 90 };
const signer = createNearLocalSigner(new Uint8Array(32).fill(1));
const blockHash = encodeBase58(new Uint8Array(32).fill(2));
const agent: r.AgentView = { account_id: 'agente.near', agent_uri: identity.agent_uri, metadata: null, registered_at: '5', updated_at: '6' };
const row: r.FeedbackView = { feedback_id: 0, rater: 'payer.near', ratee: 'worker.near', ratee_role: 'receiver',
  ...payment, operator_id: 'em', released: '1000000', score: 90, tag1: 'quality', tag2: null,
  feedback_uri: null, feedback_hash: null, created_at: '7', revoked: false, revoked_at: null };
const stats = { count: 0, revoked: 0, score_sum: '0', average_x100: null };
const summary: r.SummaryView = { account_id: 'worker.near', ...stats, as_payer: { ...stats }, as_receiver: { ...stats }, last_feedback_id: null, last_at: null };
const config: r.RegistryConfigView = { version: 'arras-registry-v1', escrows: [payment.escrow], agents: 0, feedbacks: 0,
  register_deposit: r.REGISTER_DEPOSIT, feedback_deposit: r.FEEDBACK_DEPOSIT, min_gas_give_feedback: r.MIN_GIVE_FEEDBACK_GAS,
  limits: { max_agent_uri_len: 512, max_metadata_len: 1024, max_feedback_uri_len: 512, max_tag_len: 64,
    max_payment_id_len: 64, max_score: 100, max_list_limit: 50, pending_ttl_blocks: '1000' } };
const response = (v: unknown) => ({ result: [...new TextEncoder().encode(JSON.stringify(v))] });
const withRpc = (v: unknown) => ({ network: common.network, rpc: vi.fn(async () => response(v)) });
const params = (tx: r.RegistryTransaction) => tx.actions[0].params;

// Every test has a transport double. Any accidental network call fails immediately.
vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden'); }));

describe('registry builders: exact contract boundaries', () => {
  it('pins immutable registries and defaults, including empty testnet', () => {
    expect(r.NEAR_REGISTRY_CONTRACTS).toEqual({ 'near:mainnet': ['registry.arras-escrow.near'], 'near:testnet': [] });
    expect(r.NEAR_REGISTRY_ESCROWS).toEqual({ 'near:mainnet': [payment.escrow], 'near:testnet': [] });
    for (const map of [r.NEAR_REGISTRY_CONTRACTS, r.NEAR_REGISTRY_ESCROWS]) {
      expect(Object.isFrozen(map)).toBe(true); expect(Object.isFrozen(map['near:mainnet'])).toBe(true);
    }
    expect(params(r.buildRegistryRegister(identity))).toEqual({ methodName: 'register', args: { agent_uri: identity.agent_uri }, gas: '30000000000000', deposit: '17510000000000000000000' });
    expect(params(r.buildRegistryUpdate(identity)).methodName).toBe('update');
    expect(params(r.buildGiveFeedback(feedback))).toMatchObject({ methodName: 'give_feedback', gas: '100000000000000', deposit: '18640000000000000000000' });
    expect(params(r.buildRevokeFeedback({ ...common, ...payment }))).toMatchObject({ methodName: 'revoke_feedback', gas: '30000000000000', deposit: '1' });
  });
  const badUris = ['', ' https://x', 'https://x ', 'https://a b', 'https://x\t', 'https://x\n', 'https://\x7f', 'https://agénte', 'sin-esquema', ':x', '1http:x', 'ht_tp:x', 'https:', 'a:', 'a:' + 'x'.repeat(511), null, 42];
  for (const build of [r.buildRegistryRegister, r.buildRegistryUpdate]) {
    it.each(badUris)(`${build.name} rejects agent URI %j with E01`, (agent_uri) => {
      expect(() => build({ ...identity, agent_uri } as any)).toThrow('ARRAS_REG_E01');
    });
    it(`${build.name} accepts URI schemes without normalization and 512 bytes`, () => {
      for (const agent_uri of ['a:b', 'HTTPS://AGENTE.EXAMPLE', 'x+y-z.w:1', 'ipfs://bafy', 'ar://abc', 'data:application/json,x', 'did:near:x', 'javascript:alert(1)', 'a:' + 'x'.repeat(510)]) {
        expect(params(build({ ...identity, agent_uri })).args.agent_uri).toBe(agent_uri);
      }
    });
    it.each(['', 'm'.repeat(1025), 'ñ'.repeat(512) + 'x', 'a\nb', '\t', '\x00', '\x7f', '\ud800', '\udfff', 42])(`${build.name} rejects metadata %j with E02`, (metadata) => {
      expect(() => build({ ...identity, metadata } as any)).toThrow('ARRAS_REG_E02');
    });
    it(`${build.name} accepts 1024 UTF-8 bytes, C1, bidi, emoji and omits absent metadata`, () => {
      for (const metadata of ['m', 'm'.repeat(1024), 'ñ'.repeat(512), '😀'.repeat(256), 'a\u0085\u202e\u200b']) {
        expect(params(build({ ...identity, metadata })).args.metadata).toBe(metadata);
      }
      for (const metadata of [undefined, null]) expect(JSON.stringify(params(build({ ...identity, metadata })).args)).toBe(JSON.stringify({ agent_uri: identity.agent_uri }));
    });
  }
  it.each(badUris.filter((v) => v !== null))('rejects feedback URI %j with E14', (feedback_uri) => {
    expect(() => r.buildGiveFeedback({ ...feedback, feedback_uri } as any)).toThrow('ARRAS_REG_E14');
  });
  it('accepts feedback URI at 512 bytes', () => {
    expect(params(r.buildGiveFeedback({ ...feedback, feedback_uri: 'a:' + 'x'.repeat(510) })).args.feedback_uri).toHaveLength(512);
  });
  for (const field of ['tag1', 'tag2']) {
    it.each(['', 't'.repeat(65), ' quality', 'quality ', 'a b', 'ñ', 'a#b', 'a\n', 1])(`rejects ${field} %j with E13`, (value) => {
      expect(() => r.buildGiveFeedback({ ...feedback, [field]: value })).toThrow('ARRAS_REG_E13');
    });
    it(`accepts ${field} alphabet and exact maximum`, () => {
      for (const value of ['t'.repeat(64), 'quality', 'successRate', 'em:task/123', 'a.b_c-d']) {
        expect(params(r.buildGiveFeedback({ ...feedback, [field]: value })).args[field]).toBe(value);
      }
    });
  }
  it.each(['', '0'.repeat(63), '0'.repeat(65), '0x' + '0'.repeat(62), '0X' + '0'.repeat(62), 'F'.repeat(64), ...['g', ' ', '/', ':', '`', '\n'].map((c) => '0'.repeat(63) + c), 42])('rejects hash %j with E15', (feedback_hash) => {
    expect(() => r.buildGiveFeedback({ ...feedback, feedback_hash } as any)).toThrow('ARRAS_REG_E15');
  });
  it('preserves canonical field order and omits all null optionals', () => {
    const args = params(r.buildGiveFeedback({ feedback_hash: 'ab'.repeat(32), tag2: 'successRate', feedback_uri: 'https://x', ...feedback, tag1: 'quality' })).args;
    expect(Object.keys(args)).toEqual(['escrow', 'payment_id', 'score', 'tag1', 'tag2', 'feedback_uri', 'feedback_hash']);
    expect(params(r.buildGiveFeedback({ ...feedback, tag1: null, tag2: null, feedback_uri: null, feedback_hash: null })).args).toEqual({ ...payment, score: 90 });
  });
  for (const build of [r.buildGiveFeedback, r.buildRevokeFeedback]) {
    it.each(['', 'p'.repeat(65), ' x', 'x ', 'x y', 'x\n', 'x\x7f', 'pagó', null, 1])(`${build.name} rejects payment %j E11`, (payment_id) => {
      expect(() => build({ ...feedback, payment_id } as any)).toThrow('ARRAS_REG_E11');
    });
    it(`${build.name} accepts printable extremes and 64 bytes`, () => {
      for (const payment_id of ['!', '~', 'p'.repeat(64)]) expect(params(build({ ...feedback, payment_id })).args.payment_id).toBe(payment_id);
    });
    it.each(['v2.arras-escrow.near', 'arras-v1b-1101.testnet', 'V1.arras-escrow.near', 'v1.arras-escrow.near ', '', null])(`${build.name} refuses unregistered escrow %j`, (escrow) => {
      expect(() => build({ ...feedback, escrow } as any)).toThrow('ARRAS_REG_E10');
    });
  }
  it.each([-1, 101, 0.5, NaN, Infinity, '90', null, undefined])('refuses non-score %j', (score) => {
    expect(() => r.buildGiveFeedback({ ...feedback, score } as any)).toThrow('ARRAS_REG_E12');
  });
  it('accepts both score endpoints', () => {
    for (const score of [0, 100]) expect(params(r.buildGiveFeedback({ ...feedback, score })).args.score).toBe(score);
  });
  for (const build of [r.buildRegistryRegister, r.buildRegistryUpdate, r.buildGiveFeedback, r.buildRevokeFeedback]) {
    it(`${build.name} validates target, network and signer`, () => {
      for (const network of ['near:testnet', 'near', '__proto__']) expect(() => build({ ...identity, ...feedback, network } as any)).toThrow();
      for (const registryContract of ['other.near', 'registry.arras-escrow.near ', 'REGISTRY.arras-escrow.near', 'intents.near']) {
        expect(() => build({ ...identity, ...feedback, registryContract })).toThrow('receiverId');
      }
      for (const signerId of ['x', 'X.near', 'x..near', 'x'.repeat(65)]) expect(() => build({ ...identity, ...feedback, signerId })).toThrow('signerId');
    });
  }
  it('enforces deposit defaults and exact u128s', () => {
    for (const build of [r.buildRegistryRegister, r.buildRegistryUpdate]) {
      expect(params(build(identity)).deposit).toBe(r.REGISTER_DEPOSIT);
      expect(params(build({ ...identity, deposit: r.REGISTER_DEPOSIT })).deposit).toBe(r.REGISTER_DEPOSIT);
      expect(params(build({ ...identity, deposit: (1n << 128n) - 1n })).deposit).toBe(((1n << 128n) - 1n).toString());
    }
    expect(() => r.buildRegistryRegister({ ...identity, deposit: BigInt(r.REGISTER_DEPOSIT) - 1n })).toThrow('ARRAS_REG_E05');
    expect(() => r.buildRegistryUpdate({ ...identity, deposit: 0 })).toThrow('ARRAS_REG_E06');
    for (const deposit of [BigInt(r.FEEDBACK_DEPOSIT) - 1n, -1, '01', '1\n', 1.5, Number.MAX_SAFE_INTEGER + 1, 1n << 128n, true]) {
      expect(() => r.buildGiveFeedback({ ...feedback, deposit } as any)).toThrow('ARRAS_REG_E16');
    }
    expect(params(r.buildGiveFeedback({ ...feedback, deposit: BigInt(r.FEEDBACK_DEPOSIT) + 1n })).deposit).toBe('18640000000000000000001');
    for (const deposit of [0, 2]) expect(() => r.buildRevokeFeedback({ ...common, ...payment, deposit })).toThrow('exactly 1 yocto');
  });
  it('reserves E17 for the feedback gas minimum', () => {
    for (const gas of ['59999999999999', 0]) expect(() => r.buildGiveFeedback({ ...feedback, gas })).toThrow('ARRAS_REG_E17');
    for (const gas of ['60000000000000', '300000000000000']) expect(params(r.buildGiveFeedback({ ...feedback, gas })).gas).toBe(gas);
    for (const build of [r.buildRegistryRegister, r.buildRegistryUpdate, r.buildRevokeFeedback, r.buildGiveFeedback]) {
      for (const gas of [-1, '01', 1n << 64n, '300000000000001', null]) {
        const call = () => build({ ...identity, ...feedback, gas } as any);
        expect(call).toThrow('gas');
        expect(call).not.toThrow(r.RegistryValidationError);
      }
    }
    for (const build of [r.buildRegistryRegister, r.buildRegistryUpdate, r.buildRevokeFeedback]) {
      const call = () => build({ ...identity, ...feedback, gas: 0 });
      expect(call).toThrow('gas must be positive');
      expect(call).not.toThrow(r.RegistryValidationError);
      for (const gas of ['1', '300000000000000']) expect(params(build({ ...identity, ...feedback, gas })).gas).toBe(gas);
    }
  });
});

describe('registry signing and frozen cross-language vectors', () => {
  it('matches every canonical args byte and both normal Borsh signatures', async () => {
    expect(vectors.seed_hex).toBe('01'.repeat(32)); expect(vectors.block_hash).toBe(blockHash);
    expect(vectors.public_key).toBe(`ed25519:${encodeBase58(signer.publicKey)}`);
    for (const [name, build] of Object.entries({ register: r.buildRegistryRegister, give_feedback: r.buildGiveFeedback, revoke_feedback: r.buildRevokeFeedback })) {
      const v = vectors.calls[name as keyof typeof vectors.calls];
      const tx = build({ ...common, ...v.args } as any);
      expect(tx.receiverId).toBe(vectors.receiver_id);
      expect(JSON.stringify(params(tx).args)).toBe(v.args_json);
      expect(Buffer.from(JSON.stringify(params(tx).args)).toString('hex')).toBe(v.args_hex);
      expect(params(tx).gas).toBe(v.gas); expect(params(tx).deposit).toBe(v.deposit);
      if ('signed_transaction_base64' in v) {
        const signed = await r.signRegistryTransaction(tx, signer, 1, blockHash);
        expect(signed).toBe(v.signed_transaction_base64);
        const bytes = Buffer.from(signed, 'base64');
        const pk = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(signer.publicKey)]), format: 'der', type: 'spki' });
        expect(bytes[bytes.length - 65]).toBe(0);
        expect(verify(null, sha256(bytes.subarray(0, -65)), pk, bytes.subarray(-64))).toBe(true);
        // Independent structural decoding of Transaction V0, including the FunctionCall action.
        let at = 0;
        const n = (size: number) => { const value = bytes.subarray(at, at += size); return value; };
        const s = () => n(n(4).readUInt32LE()).toString('utf8');
        expect(s()).toBe('payer.near'); expect(n(1)[0]).toBe(0); expect(n(32)).toEqual(Buffer.from(signer.publicKey));
        expect(n(8).readBigUInt64LE()).toBe(1n); expect(s()).toBe('registry.arras-escrow.near');
        expect(n(32)).toEqual(Buffer.alloc(32, 2)); expect(n(4).readUInt32LE()).toBe(1); expect(n(1)[0]).toBe(2);
        expect(s()).toBe(name); expect(s()).toBe(v.args_json); expect(n(8).readBigUInt64LE()).toBe(BigInt(v.gas));
        const dep = n(16); expect(dep.readBigUInt64LE() + (dep.readBigUInt64LE(8) << 64n)).toBe(BigInt(v.deposit));
        expect(at).toBe(bytes.length - 65);
      }
    }
  });
  it('revalidates every argument, deposit and gas before calling the signer', async () => {
    const mutations: Array<(tx: any) => void> = [
      (t) => t.receiverId = 'other.near', (t) => t.signerId = 'BAD', (t) => t.actions = [],
      (t) => t.actions.push(t.actions[0]), (t) => t.actions[0].type = 'Transfer',
      (t) => params(t).methodName = 'delete_account' as any, (t) => params(t).args = null as any,
      (t) => params(t).args.extra = 'x', (t) => params(t).args.escrow = 'other.near',
      (t) => params(t).args.payment_id = '', (t) => params(t).args.score = 101,
      (t) => params(t).args.tag1 = '', (t) => params(t).args.tag2 = '',
      (t) => params(t).args.feedback_uri = '', (t) => params(t).args.feedback_hash = '',
      (t) => params(t).deposit = '1', (t) => params(t).gas = '59999999999999',
    ];
    for (const change of mutations) {
      const tx = r.buildGiveFeedback(feedback); change(tx);
      const spy = { publicKey: signer.publicKey, sign: vi.fn(signer.sign) };
      await expect(r.signRegistryTransaction(tx, spy, 1, blockHash)).rejects.toThrow(); expect(spy.sign).not.toHaveBeenCalled();
    }
    for (const build of [r.buildRegistryRegister, r.buildRegistryUpdate]) {
      for (const field of ['agent_uri', 'metadata']) {
        const tx = build(identity); params(tx).args[field] = '';
        await expect(r.signRegistryTransaction(tx, signer, 1, blockHash)).rejects.toThrow(field === 'agent_uri' ? 'E01' : 'E02');
      }
    }
    const tx = r.buildRevokeFeedback({ ...common, ...payment }); params(tx).deposit = '2';
    await expect(r.signRegistryTransaction(tx, signer, 1, blockHash)).rejects.toThrow('exactly 1');
  });
  it('checks nonce, block hash, public key and signature', async () => {
    const tx = r.buildRegistryRegister(identity);
    for (const nonce of [0, -1, 1n << 64n, '01', Number.MAX_SAFE_INTEGER + 1]) await expect(r.signRegistryTransaction(tx, signer, nonce, blockHash)).rejects.toThrow();
    for (const hash of ['', '0', '1'.repeat(31), '1'.repeat(33)]) await expect(r.signRegistryTransaction(tx, signer, 1, hash)).rejects.toThrow();
    await expect(r.signRegistryTransaction(tx, { ...signer, publicKey: new Uint8Array(31) }, 1, blockHash)).rejects.toThrow('public key');
    for (const signature of [new Uint8Array(63), new Uint8Array(64), 'x']) {
      await expect(r.signRegistryTransaction(tx, { ...signer, sign: () => signature as any }, 1, blockHash)).rejects.toThrow('signature');
    }
  });
  it('snapshots before an async signer can mutate descriptor/key/digest', async () => {
    const tx = r.buildRegistryRegister(identity);
    const signed = await r.signRegistryTransaction(tx, { publicKey: signer.publicKey, sign: async (digest) => {
      const sig = signer.sign(digest); tx.receiverId = 'other.near'; params(tx).deposit = '0'; digest.fill(0); return sig;
    } }, 1, blockHash);
    expect(signed).toBe(vectors.calls.register.signed_transaction_base64);
  });
});

describe('registry views with injectable RPC and complete shapes', () => {
  const cases: Array<[string, unknown, (o: r.RegistryViewOptions) => Promise<unknown>, Record<string, unknown>]> = [
    ['get_config', config, r.getConfig, {}], ['get_agent', agent, (o) => r.getAgent(o, 'agente.near'), { account_id: 'agente.near' }],
    ['list_agents', [agent], (o) => r.listAgents(o, { from_index: 2, limit: 50 }), { from_index: 2, limit: 50 }],
    ['get_feedback', row, (o) => r.getFeedback(o, 0), { feedback_id: 0 }],
    ['get_feedback_for_payment', row, (o) => r.getFeedbackForPayment(o, { ...payment, rater: 'payer.near' }), { ...payment, rater: 'payer.near' }],
    ['list_feedback', [row], (o) => r.listFeedback(o, 'worker.near', { from_index: 0, limit: 51 }), { account_id: 'worker.near', from_index: 0, limit: 51 }],
    ['get_summary', summary, (o) => r.getSummary(o, 'worker.near'), { account_id: 'worker.near' }],
    ['get_summary_by_operator', { ...summary, operator_id: 'em' }, (o) => r.getSummaryByOperator(o, 'worker.near', 'em'), { account_id: 'worker.near', operator_id: 'em' }],
    ['is_feedback_pending', true, (o) => r.isFeedbackPending(o, { ...payment, rater: 'payer.near' }), { ...payment, rater: 'payer.near' }],
  ];
  it.each(cases)('%s emits exact call_function args and decodes', async (name, value, call, args) => {
    const o = withRpc(value); expect(await call(o)).toEqual(value);
    expect(o.rpc).toHaveBeenCalledWith('query', { request_type: 'call_function', finality: 'final', account_id: vectors.receiver_id,
      method_name: name, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  });
  it.each(cases)('%s refuses malformed response shapes and missing fields', async (_name, value, call) => {
    for (const bad of [undefined, 'x', 42, {}, { result: '[]' }, { result: [-1] }, { result: [256] }, { result: [0.5] }, { result: [255] }, { result: [] }]) {
      await expect(call({ ...common, rpc: async () => bad })).rejects.toThrow();
    }
    if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
      for (const key of Object.keys(value)) {
        const bad = { ...value }; delete bad[key as keyof typeof bad];
        await expect(call(withRpc(bad))).rejects.toThrow();
      }
    }
    if (Array.isArray(value)) await expect(call(withRpc([{}]))).rejects.toThrow();
  });
  it('nullable lookups, empty pages and false pending are valid', async () => {
    expect(await r.getAgent(withRpc(null), 'aa')).toBeNull(); expect(await r.getFeedback(withRpc(null), 0)).toBeNull();
    expect(await r.getFeedbackForPayment(withRpc(null), { ...payment, rater: 'aa' })).toBeNull();
    expect(await r.listAgents(withRpc([]))).toEqual([]); expect(await r.listFeedback(withRpc([]), 'aa')).toEqual([]);
    expect(await r.isFeedbackPending(withRpc(false), { ...payment, rater: 'aa' })).toBe(false);
  });
  it('strict decimal U64/U128 strings and exact u32/enum/bool fields', async () => {
    for (const [key, bad] of [['released', 1], ['released', (1n << 128n).toString()], ['created_at', (1n << 64n).toString()],
      ['created_at', '01'], ['created_at', '-1'], ['created_at', '1\n'], ['feedback_id', 0x100000000], ['feedback_id', -1],
      ['feedback_id', 0.5], ['score', 101], ['ratee_role', 'Receiver'], ['revoked', 'false'], ['revoked_at', 7], ['rater', 'A.near']]) {
      await expect(r.getFeedback(withRpc({ ...row, [key as string]: bad }), 0)).rejects.toThrow('shape');
    }
    expect(await r.getFeedback(withRpc({ ...row, released: ((1n << 128n) - 1n).toString(), created_at: ((1n << 64n) - 1n).toString() }), 0)).toBeTruthy();
    await expect(r.getSummary(withRpc({ ...summary, as_payer: { ...stats, score_sum: 0 } }), 'aa')).rejects.toThrow('shape');
    await expect(r.getSummary(withRpc({ ...summary, average_x100: 10001 }), 'aa')).rejects.toThrow('shape');
    await expect(r.getSummary(withRpc({ ...summary, operator_id: 'em' }), 'aa')).rejects.toThrow('shape');
    await expect(r.getSummaryByOperator(withRpc(summary), 'aa', 'em')).rejects.toThrow('shape');
  });
  it('validates view inputs before RPC', async () => {
    const o = withRpc(null);
    for (const bad of [-1, 0x100000000, 0.5, '1', null]) {
      await expect(r.getFeedback(o, bad as any)).rejects.toThrow();
      await expect(r.listAgents(o, { limit: bad as any })).rejects.toThrow();
      await expect(r.listFeedback(o, 'aa', { from_index: bad as any })).rejects.toThrow();
    }
    await expect(r.getConfig({ ...o, registryContract: 'other.near' })).rejects.toThrow();
    await expect(r.getAgent(o, 'BAD')).rejects.toThrow();
    await expect(r.getSummaryByOperator(o, 'aa', null as any)).rejects.toThrow();
    await expect(r.isFeedbackPending(o, { ...payment, rater: 'BAD' })).rejects.toThrow();
    expect(o.rpc).not.toHaveBeenCalled();
  });
  it('uses the default fetch transport and fails on HTTP/RPC errors (all mocked)', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ result: response(config) }) }));
    vi.stubGlobal('fetch', fetch);
    expect(await r.getConfig({ network: common.network })).toEqual(config);
    expect(fetch.mock.calls[0][0]).toBe('https://rpc.mainnet.near.org');
    for (const value of [{ ok: false, status: 503 }, { ok: true, json: async () => ({ error: {} }) }, { ok: true, json: async () => ({}) }]) {
      fetch.mockResolvedValueOnce(value as any); await expect(r.getConfig(common)).rejects.toThrow();
    }
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden'); }));
  });
});

describe('registry events, outcomes and display reputation', () => {
  it('parses the four exact Rust strings and preserves their data', () => {
    expect(r.parseRegistryEvents(vectors.events.map((e) => e.log))).toEqual(vectors.events.map((e) => e.parsed));
    expect(vectors.events.map((e) => e.parsed.event)).toEqual(['agent_registered', 'agent_updated', 'feedback_given', 'feedback_revoked']);
  });
  it('skips unknown/malformed envelopes and data as parseArrasEvents does', () => {
    expect(r.parseRegistryEvents(null as any)).toEqual([]);
    for (const e of vectors.events) {
      const parsed = JSON.parse(e.log.slice(11));
      const candidates = [null, 1, 'x', 'EVENT_JSON:{', 'EVENT_JSON:null', ...[
        { ...parsed, standard: 'arras' }, { ...parsed, version: '2.0.0' }, { ...parsed, event: 'toString' },
        { ...parsed, event: 1 }, { ...parsed, data: {} }, { ...parsed, data: [null] },
        ...Object.keys(parsed.data[0]).map((key) => { const data = { ...parsed.data[0] }; delete data[key]; return { ...parsed, data: [data] }; }),
      ].map((v) => 'EVENT_JSON:' + JSON.stringify(v))];
      expect(r.parseRegistryEvents(candidates)).toEqual([]);
      expect(r.parseRegistryEvents(['EVENT_JSON:' + JSON.stringify({ ...parsed, data: [parsed.data[0], parsed.data[0]] })])[0].data).toHaveLength(2);
    }
  });
  it('decodes accepted IDs including zero and u32 maximum', () => {
    for (const id of [0, 1, 0xffffffff]) {
      expect(r.parseGiveFeedbackOutcome(id)).toEqual({ status: 'accepted', feedbackId: id });
      expect(r.parseGiveFeedbackOutcome({ status: { SuccessValue: Buffer.from(String(id)).toString('base64') } })).toEqual({ status: 'accepted', feedbackId: id });
    }
  });
  it('decodes every callback rejection and every panic code', () => {
    for (const code of [r.RegistryErrorCode.E18, r.RegistryErrorCode.E20, r.RegistryErrorCode.E21, r.RegistryErrorCode.E22, r.RegistryErrorCode.E23, r.RegistryErrorCode.E24, r.RegistryErrorCode.E25, r.RegistryErrorCode.E26]) {
      const logs = ['irrelevant', `arras-registry:rechazo:${code}`];
      expect(r.parseGiveFeedbackOutcome({ value: null, logs })).toEqual({ status: 'rejected', code });
      expect(r.parseGiveFeedbackOutcome({ status: { SuccessValue: 'bnVsbA==' }, receipts_outcome: [{ outcome: { logs } }] })).toEqual({ status: 'rejected', code });
    }
    for (const code of Object.values(r.RegistryErrorCode)) {
      const message = `ARRAS_REG_${code.slice(0, 3)}: contract error`;
      expect(r.parseGiveFeedbackOutcome(message)).toEqual({ status: 'error', code, message });
      expect(r.parseGiveFeedbackOutcome({ status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: message } } } } } })).toMatchObject({ status: 'error', code });
    }
  });
  it.each([null, -1, 0x100000000, 0.5, '1', 'ARRAS_REG_E99: unknown', {}, { status: 'Started' },
    { value: null }, { value: null, logs: ['arras-registry:rechazo:E23'] }, { value: null, logs: ['arras-registry:rechazo:E01_AGENT_URI_INVALIDA'] },
    { value: null, logs: ['arras-registry:rechazo:E22_PAGO_INEXISTENTE', 'arras-registry:rechazo:E23_PAGO_SIN_LIBERAR'] },
    { status: { Failure: 'unknown' } }, { status: { SuccessValue: '%%%%' } }, { status: { SuccessValue: '' } }])('rejects incomplete/invalid outcome %j', (v) => {
    expect(() => r.parseGiveFeedbackOutcome(v)).toThrow();
  });
  it('filters escrow/operator, counts active distinct raters and floors exact weighted sums', () => {
    const rows = [row, { ...row, score: 10, released: '1' }, { ...row, rater: 'other.near', score: 1, released: '2' },
      { ...row, revoked: true, revoked_at: '9' }, { ...row, escrow: 'other.near' }, { ...row, operator_id: 'other' }];
    expect(r.summarizeFeedback(rows, payment.escrow, 'em')).toEqual({ count: 3, distinct_raters: 2, revoked: 1,
      released_total: '1000003', average_x100: 3366, weighted_average_x100: 8999 });
    expect(r.summarizeFeedback([...rows].reverse(), payment.escrow, 'em')).toEqual(r.summarizeFeedback(rows, payment.escrow, 'em'));
    expect(r.summarizeFeedback([{ ...row, released: ((1n << 128n) - 1n).toString(), score: 100 }, { ...row, released: ((1n << 128n) - 1n).toString(), score: 0 }], payment.escrow, 'em')).toMatchObject({ weighted_average_x100: 5000, released_total: (((1n << 128n) - 1n) * 2n).toString() });
    expect(r.summarizeFeedback([{ ...row, revoked: true }], payment.escrow, 'em')).toEqual({ count: 0, distinct_raters: 0, revoked: 1, released_total: '0', average_x100: null, weighted_average_x100: null });
    expect(r.summarizeFeedback([{ ...row, released: '0' }], payment.escrow, 'em').weighted_average_x100).toBeNull();
    expect(() => r.summarizeFeedback([{ ...row, released: 1 } as any], payment.escrow, 'em')).toThrow();
  });
  it('allows only safe display schemes and removes controls/bidi/zero-width without changing contract inputs', () => {
    for (const uri of ['https://x', 'HTTPS://X', 'ipfs://bafy', 'ar://abc']) expect(r.safeLink(uri)).toBe(uri);
    for (const uri of ['javascript:alert(1)', 'data:x', 'http://x', '//x', ' https://x', 'https://x\n', 'https:', 'https://x\u202e']) expect(r.safeLink(uri)).toBeNull();
    expect(r.displayText('A\x00\t\n\x7f\u0085\u202e\u2066\u200b\u200c\u200d\ufeff\u034f\ufe0fBñ😀')).toBe('ABñ😀');
    expect(r.displayText('<b>hello</b>')).toBe('<b>hello</b>');
  });
});

describe('additional boundary and descriptor shape checks', () => {
  it('refuses monetary nulls and missing descriptor fields', async () => {
    expect(() => r.buildRegistryRegister({ ...identity, deposit: null } as any)).toThrow('E05');
    expect(() => r.buildGiveFeedback({ ...feedback, gas: null } as any)).toThrow('gas');
    for (const field of ['gas', 'deposit']) {
      const tx = r.buildRegistryRegister(identity); delete (params(tx) as any)[field];
      await expect(r.signRegistryTransaction(tx, signer, 1, blockHash)).rejects.toThrow('gas and deposit strings');
    }
    const tx = r.buildRegistryRegister(identity); params(tx).args = null as any;
    await expect(r.signRegistryTransaction(tx, signer, 1, blockHash)).rejects.toThrow('Expected registry args object');
  });
  it('checks operator UTF-8 64/65 byte boundary in views/events', async () => {
    for (const operator_id of ['x'.repeat(64), 'ñ'.repeat(32), '']) expect(await r.getFeedback(withRpc({ ...row, operator_id }), 0)).toBeTruthy();
    for (const operator_id of ['x'.repeat(65), 'ñ'.repeat(32) + 'x', 1, '\ud800']) {
      await expect(r.getFeedback(withRpc({ ...row, operator_id }), 0)).rejects.toThrow('shape');
      const event = { ...vectors.events[2].parsed, data: [{ ...vectors.events[2].parsed.data[0], operator_id }] };
      expect(r.parseRegistryEvents(['EVENT_JSON:' + JSON.stringify(event)])).toEqual([]);
    }
  });
  it('removes other default ignorable zero-width characters', () => {
    expect(r.displayText('a\u115f\u1160\u17b4\u17b5\u3164\uffa0b')).toBe('ab');
  });
});

describe('mutation regressions: specific guards and complete decoded rows', () => {
  it('reports network and method validation errors, not a later incidental failure', async () => {
    expect(() => r.buildRegistryRegister({ ...identity, network: 'near' } as any)).toThrow('Unsupported NEAR network');
    const tx = r.buildRevokeFeedback({ ...common, ...payment }); params(tx).methodName = 'delete_account' as any;
    await expect(r.signRegistryTransaction(tx, signer, 1, blockHash)).rejects.toThrow('Unknown registry method');
  });
  it('rejects unsuccessful HTTP responses even if the body has a valid view', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ result: response(config) }) })));
    await expect(r.getConfig(common)).rejects.toThrow('NEAR RPC HTTP 503');
    for (const body of [{ error: { code: -1 }, result: response(config) }, {}, null]) {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })));
      await expect(r.getConfig(common)).rejects.toThrow('Invalid NEAR RPC response');
    }
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden'); }));
  });
  it('requires null rather than undefined in nullable fields of in-memory rows', () => {
    for (const field of ['tag1', 'tag2', 'feedback_uri', 'feedback_hash', 'revoked_at']) {
      expect(() => r.summarizeFeedback([{ ...row, [field]: undefined }], payment.escrow, 'em')).toThrow('Invalid FeedbackView');
    }
  });
  it('validates the optional operator field type and requires it on operator summaries', async () => {
    await expect(r.getSummaryByOperator(withRpc({ ...summary, operator_id: 1 }), 'aa', 'em')).rejects.toThrow('shape');
    await expect(r.getSummaryByOperator(withRpc({ ...summary, operator_id: null }), 'aa', 'em')).rejects.toThrow('shape');
  });
  it('refuses malformed call_function bytes explicitly', async () => {
    for (const response of [null, {}, { result: {} }, { result: [-1] }, { result: [256] }, { result: [0.5] }, { result: ['123'] }]) {
      await expect(r.getConfig({ ...common, rpc: async () => response })).rejects.toThrow('Invalid call_function response');
    }
  });
  it('rejects the entire page/event batch when any row is malformed', async () => {
    await expect(r.listAgents(withRpc([agent, {}]))).rejects.toThrow('shape');
    await expect(r.listFeedback(withRpc([row, {}]), 'aa')).rejects.toThrow('shape');
    const parsed = vectors.events[0].parsed;
    expect(r.parseRegistryEvents(['EVENT_JSON:' + JSON.stringify({ ...parsed, data: [parsed.data[0], {}] })])).toEqual([]);
    expect(r.parseRegistryEvents(['WRONG_JSON:' + JSON.stringify(parsed)])).toEqual([]);
  });
  it('checks the alphabet before decoding base64', () => {
    expect(() => r.parseGiveFeedbackOutcome({ status: { SuccessValue: 'b nVsbA==' } })).toThrow('Invalid base64');
  });
});

it('decodes config max_score as u8 rather than u32', async () => {
  expect(await r.getConfig(withRpc({ ...config, limits: { ...config.limits, max_score: 255 } }))).toBeTruthy();
  await expect(r.getConfig(withRpc({ ...config, limits: { ...config.limits, max_score: 256 } }))).rejects.toThrow('shape');
});


describe('round 1: contract parity and emitter trust', () => {
  it('accepts update deposits from one yocto and checks E06 before E01/E02', async () => {
    for (const deposit of ['1', (BigInt(r.REGISTER_DEPOSIT) - 1n).toString()]) {
      const tx = r.buildRegistryUpdate({ ...identity, deposit });
      expect(params(tx).deposit).toBe(deposit);
      await expect(r.signRegistryTransaction(tx, signer, 1, blockHash)).resolves.toEqual(expect.any(String));
    }
    for (const args of [{ agent_uri: '', metadata: '' }, { agent_uri: identity.agent_uri, metadata: '' }]) {
      expect(() => r.buildRegistryUpdate({ ...identity, ...args, deposit: '0' })).toThrow('ARRAS_REG_E06');
      const tx = r.buildRegistryUpdate(identity);
      params(tx).deposit = '0'; params(tx).args = args;
      await expect(r.signRegistryTransaction(tx, signer, 1, blockHash)).rejects.toThrow('ARRAS_REG_E06');
    }
    expect(() => r.buildRegistryUpdate({ ...identity, agent_uri: '', metadata: '', deposit: '1' })).toThrow('ARRAS_REG_E01');
    expect(() => r.buildRegistryUpdate({ ...identity, metadata: '', deposit: '1' })).toThrow('ARRAS_REG_E02');
    for (const deposit of [-1, null, '01', 1n << 128n]) {
      expect(() => r.buildRegistryUpdate({ ...identity, deposit } as any)).toThrow('ARRAS_REG_E06');
    }
  });
  it('binds registry and escrow allowlists to the selected network', async () => {
    const o = { ...withRpc(config), network: 'near:testnet' as const, registryContract: vectors.receiver_id };
    expect(() => r.buildRegistryRegister({ ...identity, ...o })).toThrow('receiverId');
    await expect(r.getConfig(o)).rejects.toThrow('receiverId');
    await expect(r.isFeedbackPending({ ...o, registryContract: undefined }, { ...payment, rater: 'payer.near' })).rejects.toThrow('ARRAS_REG_E10');
    expect(o.rpc).not.toHaveBeenCalled();
  });
  it('requires the exact registry config version', async () => {
    await expect(r.getConfig(withRpc({ ...config, version: 'arras-registry-v2' }))).rejects.toThrow('shape');
  });
  const invalidViews: Array<[string, (o: r.RegistryViewOptions) => Promise<unknown>, string]> = [
    ['getConfig', (o) => r.getConfig({ ...o, registryContract: 'other.near' }), 'receiverId'],
    ['getAgent', (o) => r.getAgent(o, 'BAD'), 'account_id'],
    ['listAgents', (o) => r.listAgents(o, { limit: -1 }), 'limit'],
    ['getFeedback', (o) => r.getFeedback(o, -1), 'feedback_id'],
    ['getFeedbackForPayment', (o) => r.getFeedbackForPayment(o, { ...payment, rater: 'BAD' }), 'rater'],
    ['listFeedback', (o) => r.listFeedback(o, 'BAD'), 'account_id'],
    ['getSummary', (o) => r.getSummary(o, 'BAD'), 'account_id'],
    ['getSummaryByOperator', (o) => r.getSummaryByOperator(o, 'aa', null as any), 'operator_id'],
    ['isFeedbackPending', (o) => r.isFeedbackPending(o, { ...payment, rater: 'BAD' }), 'rater'],
  ];
  it.each(invalidViews)('%s returns a catchable rejection for invalid inputs', (_name, call, message) => {
    const o = withRpc(null);
    return call(o).catch((error) => {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(message);
      expect(o.rpc).not.toHaveBeenCalled();
      return 'caught';
    }).then((value) => expect(value).toBe('caught'));
  });
  it.each(Object.values(r.RegistryErrorCode).filter((code) => ![
    r.RegistryErrorCode.E18, r.RegistryErrorCode.E20, r.RegistryErrorCode.E21, r.RegistryErrorCode.E22,
    r.RegistryErrorCode.E23, r.RegistryErrorCode.E24, r.RegistryErrorCode.E25, r.RegistryErrorCode.E26,
  ].includes(code)))('refuses panic-only code %s as a callback rejection', (code) => {
    expect(() => r.parseGiveFeedbackOutcome({ value: null, logs: ['arras-registry:rechazo:' + code] })).toThrow('Malformed');
  });
  it.each(['arweave://x', 'ar+x://y', 'ipfs2://x', 'httpsx://x', 'https+evil://x'])('rejects display scheme prefix %s', (uri) => {
    expect(r.safeLink(uri)).toBeNull();
  });
  it('authenticates receipt executor_id for the network before parsing event logs', () => {
    const logs = vectors.events.map((e) => e.log);
    const receipt = (executor_id: unknown) => ({ outcome: { executor_id, logs, status: { SuccessValue: '' } } });
    const foreign = ['other.near', payment.escrow, vectors.receiver_id.toUpperCase(), vectors.receiver_id + ' ',
      ' ' + vectors.receiver_id, vectors.receiver_id + '.evil', '', null, 1];
    for (const id of foreign) expect(r.parseRegistryReceiptEvents([receipt(id)], common.network)).toEqual([]);
    const trusted = receipt(vectors.receiver_id);
    expect(r.parseRegistryReceiptEvents([receipt('other.near'), trusted, receipt(payment.escrow), trusted], common.network))
      .toEqual([...vectors.events, ...vectors.events].map((e) => e.parsed));
    expect(r.parseRegistryReceiptEvents([trusted], 'near:testnet')).toEqual([]);
    expect(() => r.parseRegistryReceiptEvents([trusted], 'near' as any)).toThrow('Unsupported NEAR network');
  });
  it('skips malformed receipts and retains strict log parsing for trusted emitters', () => {
    for (const receipts of [null, {}, 1, 'x']) expect(r.parseRegistryReceiptEvents(receipts, common.network)).toEqual([]);
    const malformed = [null, 1, [], {}, { outcome: null }, { outcome: [] }, { outcome: {} }];
    const trusted = (logs: unknown) => ({ outcome: { executor_id: vectors.receiver_id, logs, status: { SuccessValue: '' } } });
    for (const logs of [null, undefined, 'EVENT_JSON:{}', [], ['EVENT_JSON:{', 'foreign']]) {
      expect(r.parseRegistryReceiptEvents([...malformed, trusted(logs)], common.network)).toEqual([]);
    }
    expect(r.parseRegistryReceiptEvents([...malformed, trusted(['EVENT_JSON:{', vectors.events[0].log])], common.network))
      .toEqual([vectors.events[0].parsed]);
  });
});


describe('round 2: only successful registry receipts produce events', () => {
  const registered = vectors.events[0];
  const receipt = (status: unknown, logs: unknown[] = [registered.log]) => ({
    outcome: { executor_id: 'registry.arras-escrow.near', logs, ...(status === undefined ? {} : { status }) },
  });
  const lackBalance = { Failure: { ActionError: { index: 0, kind: { LackBalanceForState: {
    account_id: 'registry.arras-escrow.near', amount: '1',
  } } } } };
  const outOfGas = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: {
    ExecutionError: 'Exceeded the prepaid gas.',
  } } } } };

  it.each([
    ['SuccessValue', { SuccessValue: '' }],
    ['SuccessValue with return data', { SuccessValue: 'bnVsbA==' }],
    ['SuccessReceiptId', { SuccessReceiptId: '11111111111111111111111111111111' }],
    ['SuccessReceiptId empty string', { SuccessReceiptId: '' }],
  ])('accepts %s from the registered executor', (_name, status) => {
    expect(registered.parsed.event).toBe('agent_registered');
    expect(r.parseRegistryReceiptEvents([receipt(status)], common.network)).toEqual([registered.parsed]);
    expect(r.parseRegistryReceiptEvents([receipt(status)], 'near:testnet')).toEqual([]);
    expect(r.parseRegistryReceiptEvents([{
      outcome: { ...receipt(status).outcome, executor_id: 'other.near' },
    }], common.network)).toEqual([]);
  });

  const rejected: Array<[string, unknown]> = [
    ['Failure LackBalanceForState', lackBalance],
    ['Failure ExecutionError after emit', outOfGas],
    ['Unknown', 'Unknown'],
    ['missing status', undefined],
    ['null status', null],
    ['numeric SuccessValue', { SuccessValue: 1 }],
    ['null SuccessValue', { SuccessValue: null }],
    ['numeric SuccessReceiptId', { SuccessReceiptId: 1 }],
    ['null SuccessReceiptId', { SuccessReceiptId: null }],
    ['empty object', {}],
    ['numeric status', 1],
    ['boolean status', true],
    ['success string', 'SuccessValue'],
    ['array status', Object.assign([], { SuccessValue: '' })],
    ['lowercase success key', { successValue: '' }],
    ['whitespace in success key', { 'SuccessValue ': '' }],
    ['unknown object variant', { Unknown: '' }],
    ['Failure with SuccessValue', { ...lackBalance, SuccessValue: '' }],
    ['Failure with SuccessReceiptId', { ...outOfGas, SuccessReceiptId: 'receipt' }],
  ];
  it.each(rejected)('ignores the entire receipt for %s', (_name, status) => {
    expect(registered.parsed.event).toBe('agent_registered');
    expect(r.parseRegistryReceiptEvents([receipt(status)], common.network)).toEqual([]);
  });

  it('keeps successful receipt and log order while discarding failed receipts entirely', () => {
    const updated = vectors.events[1];
    const successful = receipt({ SuccessValue: '' }, [updated.log, registered.log]);
    expect(r.parseRegistryReceiptEvents([receipt(lackBalance), successful], common.network))
      .toEqual([updated.parsed, registered.parsed]);
    expect(r.parseRegistryReceiptEvents([
      receipt(lackBalance, vectors.events.map((event) => event.log)), successful,
      receipt(outOfGas, vectors.events.map((event) => event.log)),
      receipt({ SuccessReceiptId: 'receipt' }), receipt('Unknown'), receipt(undefined),
    ], common.network)).toEqual([updated.parsed, registered.parsed, registered.parsed]);
  });
});
