import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha256';
import { readFileSync } from 'node:fs';
import * as r from './erc8004';
import * as schema from './erc8004-schema';
import fixture from './vectors/near-erc8004.json';

const vectors: any[] = fixture.networks.flatMap(n => [
  ...n.calls.map(call => ({ network: n.network, receiver_id: call.contract, calls: { [call.method]: call }, events: [] })),
  ...n.transactions.map(tx => {
    const result = tx.result as any, call = result.transaction.actions[0].FunctionCall;
    const args_json = Buffer.from(call.args, 'base64').toString();
    return { network: n.network, receiver_id: result.transaction.receiver_id, transaction_hash: tx.transaction_hash,
      calls: { [tx.method]: { args: JSON.parse(args_json), args_json, args_hex: Buffer.from(args_json).toString('hex'), result } },
      events: result.receipts_outcome.flatMap((r: any) => r.outcome.logs.filter((l: string) => l.startsWith('EVENT_JSON:')).map((log: string) => ({ log, parsed: JSON.parse(log.slice(11)) }))) };
  }),
]);
const networks = ['near:mainnet', 'near:testnet'] as const;
const net = networks[0], targets = r.NEAR_ERC8004_CONTRACTS[net];
function recorded(network: r.NearErc8004Network, contract: string, method: string) {
  return vectors.find(v => v.network === network && v.receiver_id === contract && v.calls[method] && !v.transaction_hash).calls[method].result;
}
function config(network: r.NearErc8004Network = net): r.NearErc8004Config {
  const t = r.NEAR_ERC8004_CONTRACTS[network];
  return structuredClone({ network, identity: recorded(network, t.identity, 'get_config'), reputation: recorded(network, t.reputation, 'get_config'), verifier: recorded(network, t.verifier, 'get_config') });
}
const nowNs = '1793829600000000000';
const common = () => ({ network: net, signerId: 'payer.near', config: config(), nowNs });
const feedback = { agent_id: '0', value: '-32', value_decimals: 1 };
const reference = { agent_id: '0', client_address: 'payer.near', feedback_index: '1' };
const proofKey = { verifier: targets.verifier, proof: 'payment-1', client_address: 'payer.near' };
const bytes = (value: unknown) => ({ result: [...Buffer.from(JSON.stringify(value))] });
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const params = (tx: r.NearErc8004Transaction) => tx.actions[0].params;
const txFixture = (method: string, network: r.NearErc8004Network = net): any => structuredClone(vectors.find(v => v.network === network && v.transaction_hash && v.calls[method]).calls[method].result);
const receipt = (event: unknown, executor_id = targets.identity, status: unknown = { SuccessValue: '' }) => ({ outcome: { executor_id, status, logs: ['EVENT_JSON:' + JSON.stringify(event)] } });
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden'); })));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const calls: Array<[r.NearErc8004Method, any, any, string]> = [
  ['register', { agent_uri: 'ipfs://card', metadata: [{ metadata_key: 'name', metadata_value: 'YWJj' }] }, { agent_uri: 'ipfs://card', metadata: [{ metadata_key: 'name', metadata_value: 'YWJj' }] }, 'identity'],
  ['set_agent_uri', { agent_id: '0', new_uri: 'ipfs://card' }, { agent_id: '0', new_uri: 'ipfs://card' }, 'identity'],
  ['set_metadata', { agent_id: '0', metadata_key: 'name', metadata_value: '8J+YgA==' }, { agent_id: '0', metadata_key: 'name', metadata_value: '8J+YgA==' }, 'identity'],
  ['set_agent_wallet', { agent_id: '0', new_wallet: 'wallet.near', deadline: nowNs }, { agent_id: '0', new_wallet: 'wallet.near', deadline: nowNs }, 'identity'],
  ['accept_agent_wallet', { agent_id: '0' }, { agent_id: '0' }, 'identity'],
  ['unset_agent_wallet', { agent_id: '0' }, { agent_id: '0' }, 'identity'],
  ['nft_transfer', { receiver_id: 'worker.near', token_id: '0', approval_id: 0, memo: 'venta' }, { receiver_id: 'worker.near', token_id: '0', approval_id: 0, memo: 'venta' }, 'identity'],
  ['nft_transfer_call', { receiver_id: 'worker.near', token_id: '0', msg: '{}', approval_id: 1, memo: 'venta' }, { receiver_id: 'worker.near', token_id: '0', msg: '{}', approval_id: 1, memo: 'venta' }, 'identity'],
  ['nft_approve', { token_id: '0', account_id: 'em.near', msg: '{}' }, { token_id: '0', account_id: 'em.near', msg: '{}' }, 'identity'],
  ['nft_revoke', { token_id: '0', account_id: 'em.near' }, { token_id: '0', account_id: 'em.near' }, 'identity'],
  ['nft_revoke_all', { token_id: '0' }, { token_id: '0' }, 'identity'],
  ['give_feedback', { ...feedback, tag1: 'calidad ✓', tag2: '', endpoint: 'https://worker.example/mcp', feedback_uri: 'ipfs://feedback', feedback_hash: 'ab'.repeat(32) }, { ...feedback, tag1: 'calidad ✓', tag2: '', endpoint: 'https://worker.example/mcp', feedback_uri: 'ipfs://feedback', feedback_hash: 'ab'.repeat(32) }, 'reputation'],
  ['give_feedback_with_proof', { ...feedback, verifier: targets.verifier, proof: 'payment-1', tag1: 'starred' }, { ...feedback, verifier: targets.verifier, proof: 'payment-1', tag1: 'starred' }, 'reputation'],
  ['revoke_feedback', { agent_id: '0', feedback_index: '1' }, { agent_id: '0', feedback_index: '1' }, 'reputation'],
  ['append_response', { ...reference, response_uri: 'data:text/plain,ok', response_hash: '01'.repeat(32) }, { ...reference, response_uri: 'data:text/plain,ok', response_hash: '01'.repeat(32) }, 'reputation'],
  ['verify_feedback_proof', { client: 'payer.near', proof: 'payment-1' }, { client: 'payer.near', proof: 'payment-1' }, 'verifier'],
];
const wrapperNames = ['Register','SetAgentUri','SetMetadata','SetAgentWallet','AcceptAgentWallet','UnsetAgentWallet','NftTransfer','NftTransferCall','NftApprove','NftRevoke','NftRevokeAll','GiveFeedback','GiveFeedbackWithProof','RevokeFeedback','AppendResponse','VerifyFeedbackProof'];
describe('wallet descriptors and dynamic storage budgets', () => {
  describe.each(networks)('%s defaults', network => {
    it.each(calls)('%s exact args, receiver, gas and deposit', (method, input, expected, target) => {
      const t = r.NEAR_ERC8004_CONTRACTS[network], c = config(network);
      const o = { ...common(), network, config: c };
      const args = method === 'give_feedback_with_proof' ? { ...input, verifier: t.verifier } : input;
      const expectedArgs = method === 'give_feedback_with_proof' ? { ...expected, verifier: t.verifier } : expected;
      const byte = BigInt(c.identity.storage_byte_cost);
      // These independent budgets fix every default, including decoded (not base64) metadata bytes.
      const budgets: Record<r.NearErc8004Method, [bigint, bigint]> = {
        register: [30n, BigInt(c.identity.register_deposit)],
        set_agent_uri: [30n, 1n + byte * 11n], // UTF-8 bytes of ipfs://card
        set_metadata: [30n, 1n + byte * (128n + 4n + 4n)], // name + decoded emoji
        set_agent_wallet: [30n, 1n], accept_agent_wallet: [30n, 1n], unset_agent_wallet: [30n, 1n],
        nft_transfer: [30n, 1n], nft_transfer_call: [50n, 1n], nft_approve: [30n, 1n + byte * 256n],
        nft_revoke: [30n, 1n], nft_revoke_all: [30n, 1n],
        give_feedback: [60n, BigInt(c.reputation.feedback_deposit)],
        give_feedback_with_proof: [150n, BigInt(c.reputation.feedback_proof_deposit)],
        revoke_feedback: [30n, 1n], append_response: [30n, 1n + byte * 512n],
        verify_feedback_proof: [30n, 0n],
      };
      const tx = r.buildNearErc8004Transaction(method, o, args);
      expect(tx.signerId).toBe('payer.near'); expect(tx.receiverId).toBe((t as any)[target]);
      expect(params(tx)).toEqual({ methodName: method, args: expectedArgs,
        gas: (budgets[method][0] * 1000000000000n).toString(), deposit: budgets[method][1].toString() });
      expect(JSON.stringify(params(tx).args)).toBe(JSON.stringify(expectedArgs));
      const index = calls.findIndex(c => c[0] === method);
      expect((r as any)['buildNearErc8004' + wrapperNames[index]]({ ...o, ...args })).toEqual(tx);
    });
  });
  it.each(networks)('%s budgets empty URI and metadata values', network => {
    const c = config(network), o = { ...common(), network, config: c };
    expect(params(r.buildNearErc8004SetAgentUri({ ...o, agent_id: '0', new_uri: '' })))
      .toMatchObject({ gas: '30000000000000', deposit: '1', args: { agent_id: '0', new_uri: '' } });
    expect(params(r.buildNearErc8004SetMetadata({ ...o, agent_id: '0', metadata_key: 'name', metadata_value: '' })))
      .toMatchObject({ gas: '30000000000000', deposit: (1n + BigInt(c.identity.storage_byte_cost) * 132n).toString(),
        args: { agent_id: '0', metadata_key: 'name', metadata_value: '' } });
  });
  it('uses each network and freezes every target table', () => {
    for (const network of networks) {
      expect(r.buildNearErc8004Register({ ...common(), network, config: config(network) }).receiverId).toBe(r.NEAR_ERC8004_CONTRACTS[network].identity);
      expect(Object.isFrozen(r.NEAR_ERC8004_CONTRACTS[network])).toBe(true);
      expect(r.NEAR_ERC8004_CONTRACTS[network].agentRegistry).toBe(network + ':' + r.NEAR_ERC8004_CONTRACTS[network].identity);
      expect(Object.keys(r.NEAR_ERC8004_CONTRACTS[network])).not.toContain('validation');
    }
    expect(Object.isFrozen(r.NEAR_ERC8004_CONTRACTS)).toBe(true); expect(Object.isFrozen(r.NEAR_ERC8004_DEPOSIT_CAPS)).toBe(true);
  });
  it('does not replace changed on-chain deposit quotes with constants', () => {
    const o = common(); o.config.identity.register_deposit = '132800000000000000000000';
    o.config.reputation.feedback_deposit = '5920000000000000000000'; o.config.reputation.feedback_proof_deposit = '14730000000000000000000';
    expect(params(r.buildNearErc8004Register(o)).deposit).toBe(o.config.identity.register_deposit);
    expect(params(r.buildNearErc8004GiveFeedback({ ...o, ...feedback })).deposit).toBe(o.config.reputation.feedback_deposit);
    expect(params(r.buildNearErc8004GiveFeedbackWithProof({ ...o, ...feedback, verifier: targets.verifier, proof: 'p' })).deposit).toBe(o.config.reputation.feedback_proof_deposit);
    o.config.identity.storage_byte_cost = '10100000000000000000';
    expect(params(r.buildNearErc8004SetAgentUri({ ...o, agent_id: '0', new_uri: 'x:y' })).deposit).toBe((3n * BigInt(o.config.identity.storage_byte_cost) + 1n).toString());
  });
  it.each([
    ['identity', 'register_deposit', 'register'], ['identity', 'storage_byte_cost', 'storageByte'],
    ['reputation', 'feedback_deposit', 'feedback'], ['reputation', 'feedback_proof_deposit', 'feedbackProof'],
  ])('caps config %s.%s', (kind, field, cap) => {
    for (const value of ['0', (BigInt((r.NEAR_ERC8004_DEPOSIT_CAPS as any)[cap]) + 1n).toString(), '01', 1, null]) {
      const o = common(); (o.config as any)[kind][field] = value;
      expect(() => r.buildNearErc8004Register(o)).toThrow();
    }
  });
  it.each(calls)('%s enforces its deposit ceiling and floor', (method, args) => {
    const tx = r.buildNearErc8004Transaction(method, common(), args), d = params(tx).deposit;
    expect(() => r.buildNearErc8004Transaction(method, { ...common(), deposit: '9999999999999999999999999999' }, args)).toThrow('deposit');
    if (method === 'verify_feedback_proof') {
      expect(d).toBe('0'); expect(() => r.buildNearErc8004Transaction(method, { ...common(), deposit: '1' }, args)).toThrow('deposit');
    } else expect(() => r.buildNearErc8004Transaction(method, { ...common(), deposit: '0' }, args)).toThrow('deposit');
    if (['register','give_feedback','give_feedback_with_proof'].includes(method)) {
      expect(() => r.buildNearErc8004Transaction(method, { ...common(), deposit: (BigInt(d) - 1n).toString() }, args)).toThrow('deposit');
    } else if (!['set_agent_uri','set_metadata','nft_approve','append_response','verify_feedback_proof'].includes(method)) {
      expect(d).toBe('1'); expect(() => r.buildNearErc8004Transaction(method, { ...common(), deposit: '2' }, args)).toThrow('deposit');
    }
    if (['set_agent_uri','set_metadata','nft_approve','append_response'].includes(method)) expect(params(r.buildNearErc8004Transaction(method, { ...common(), deposit: '1' }, args)).deposit).toBe('1');
  });
  it.each(calls)('%s enforces gas bounds and descriptor strings', (method, args) => {
    const min = method === 'give_feedback' ? 40000000000000n : method === 'give_feedback_with_proof' ? 120000000000000n : method === 'nft_transfer_call' ? 50000000000000n : method === 'verify_feedback_proof' ? 25000000000000n : 1n;
    for (const gas of [(min - 1n).toString(), '300000000000001', '01', 1, null, '-1']) expect(() => r.buildNearErc8004Transaction(method, { ...common(), gas } as any, args)).toThrow();
    expect(params(r.buildNearErc8004Transaction(method, { ...common(), gas: min.toString() }, args)).gas).toBe(min.toString());
    expect(params(r.buildNearErc8004Transaction(method, { ...common(), gas: '300000000000000' }, args)).gas).toBe('300000000000000');
  });
  it.each([
    ['identity','min_gas_nft_transfer_call','nft_transfer_call',50000000000000n],
    ['reputation','min_gas_give_feedback','give_feedback',40000000000000n],
    ['reputation','min_gas_give_feedback_with_proof','give_feedback_with_proof',120000000000000n],
    ['verifier','min_gas_verify','verify_feedback_proof',25000000000000n],
    ['verifier','gas_get_payment','register',1n], ['verifier','gas_on_payment','register',1n],
  ])('validates and consumes %s.%s', (contract, field, method, min) => {
    for (const amount of [(BigInt(min) - 1n).toString(),'300000000000001','01',1]) {
      const o = common(); (o.config as any)[contract][field] = amount;
      expect(() => r.buildNearErc8004Register(o)).toThrow();
    }
    if (method !== 'register') {
      const o = common(); (o.config as any)[contract][field] = '200000000000000';
      expect(params(r.buildNearErc8004Transaction(method as any, o, calls.find(c => c[0] === method)![1])).gas).toBe('200000000000000');
    }
  });
  it('rejects unknown networks, mismatched configs, invalid accounts and methods', () => {
    for (const network of ['near', '', 'NEAR:mainnet', 'near:mainnet ', null]) expect(() => r.buildNearErc8004Register({ ...common(), network } as any)).toThrow();
    expect(() => r.buildNearErc8004Register({ ...common(), config: config('near:testnet') })).toThrow('network');
    for (const signerId of ['A.near','a..near','a','x'.repeat(65),'payer.near\n',' payer.near',null]) expect(() => r.buildNearErc8004Register({ ...common(), signerId } as any)).toThrow();
    const o = common(); o.config.reputation.identity_registry = r.NEAR_ERC8004_CONTRACTS['near:testnet'].identity;
    expect(() => r.buildNearErc8004Register(o)).toThrow('binding');
    o.config = config(); o.config.verifier.escrow = 'wrong.near'; expect(() => r.buildNearErc8004Register(o)).toThrow('binding');
    expect(() => r.buildNearErc8004Transaction('validation_request' as any, common(), {})).toThrow();
    expect(() => r.buildNearErc8004Transaction('toString' as any, common(), {})).toThrow();
    expect(() => r.buildNearErc8004Register({ ...common(), unexpected: true } as any)).toThrow('argument');
  });
  it('requires exact config shapes and protocol limits', () => {
    for (const contract of ['identity','reputation','verifier']) {
      for (const field of Object.keys((config() as any)[contract])) {
        const o = common(); delete (o.config as any)[contract][field]; expect(() => r.buildNearErc8004Register(o)).toThrow();
        const bad = common(); (bad.config as any)[contract][field] = 'wrong'; expect(() => r.buildNearErc8004Register(bad)).toThrow();
      }
      const o = common(); (o.config as any)[contract].extra = 1; expect(() => r.buildNearErc8004Register(o)).toThrow();
    }
    for (const field of Object.keys(config().identity.limits)) {
      const o = common(); (o.config.identity.limits as any)[field] = 0; expect(() => r.buildNearErc8004Register(o)).toThrow();
    }
  });
});

const badUnsigned = ['01','-0','+1','-1','1.0','1e3',' 1','1 ','1\n','','18446744073709551616', 0, 1n, null];
describe('canonical contract arguments', () => {
  it.each(badUnsigned)('rejects noncanonical agent id %s', agent_id => {
    expect(() => r.buildNearErc8004GiveFeedback({ ...common(), ...feedback, agent_id } as any)).toThrow();
  });
  it.each(['-0','+1','01','-01','1.0','1e38',' 1','1\n','','100000000000000000000000000000000000001','-100000000000000000000000000000000000001',1,null])('rejects value %s', value => {
    expect(() => r.buildNearErc8004GiveFeedback({ ...common(), ...feedback, value } as any)).toThrow();
  });
  it.each([-1,19,1.5,'1',null,NaN])('rejects decimals %s', value_decimals => expect(() => r.buildNearErc8004GiveFeedback({ ...common(), ...feedback, value_decimals } as any)).toThrow());
  it('accepts signed value and decimal boundaries without float conversion', () => {
    for (const value of ['0',(10n ** 38n).toString(),(-(10n ** 38n)).toString()]) for (const value_decimals of [0,18]) {
      expect(params(r.buildNearErc8004GiveFeedback({ ...common(), ...feedback, value, value_decimals })).args.value).toBe(value);
    }
  });
  it.each(['ipfs','GetPrice','bafycard','1https://x','a_b:x','https:',' https://x','https://x ','https://x\n','https://x\\a','https://x"','https://x<>','https://x{y}','https://café','https://x|y','https://x`y'])('rejects non-RFC URI %s', uri => {
    expect(() => r.buildNearErc8004Register({ ...common(), agent_uri: uri })).toThrow();
    expect(() => r.buildNearErc8004GiveFeedback({ ...common(), ...feedback, endpoint: uri })).toThrow();
    expect(() => r.buildNearErc8004GiveFeedback({ ...common(), ...feedback, feedback_uri: uri })).toThrow();
    expect(() => r.buildNearErc8004AppendResponse({ ...common(), ...reference, response_uri: uri })).toThrow();
  });
  it('handles URI limits, scheme case, RFC delimiters and explicit normalization', () => {
    for (const uri of ['HTTPS://example/a%20b','ipfs://bafy','data:text/plain,hello','did:example:123',"x:-._~:/?#[]@!$&'()*+,;=%"]) expect(params(r.buildNearErc8004Register({ ...common(), agent_uri: uri })).args.agent_uri).toBe(uri);
    expect(r.normalizeNearErc8004Uri('https://example/café%20a b')).toBe('https://example/caf%C3%A9%20a%20b');
    expect(() => r.normalizeNearErc8004Uri('no-scheme')).toThrow(); expect(() => r.normalizeNearErc8004Uri('x:\ud800')).toThrow();
    for (const [field, max] of [['agent_uri',8192],['endpoint',1024],['feedback_uri',4096],['response_uri',4096]] as const) {
      const build = (uri: string) => field === 'agent_uri' ? r.buildNearErc8004Register({ ...common(), agent_uri: uri }) : field === 'response_uri' ? r.buildNearErc8004AppendResponse({ ...common(), ...reference, response_uri: uri }) : r.buildNearErc8004GiveFeedback({ ...common(), ...feedback, [field]: uri });
      expect(() => build('x:' + 'a'.repeat(max - 2))).not.toThrow(); expect(() => build('x:' + 'a'.repeat(max - 1))).toThrow();
    }
    expect(() => r.buildNearErc8004AppendResponse({ ...common(), ...reference, response_uri: '' })).toThrow();
    expect(params(r.buildNearErc8004Register({ ...common(), agent_uri: null, metadata: null })).args).toEqual({});
  });
  it.each(['a'.repeat(65),'é'.repeat(33),'a\u0000','a\u007f','a\u0085','\ud800'])('rejects invalid UTF-8 tag %s', tag => {
    for (const field of ['tag1','tag2']) expect(() => r.buildNearErc8004GiveFeedback({ ...common(), ...feedback, [field]: tag })).toThrow();
  });
  it('accepts Unicode and empty tags, including exactly 64 UTF-8 bytes', () => {
    for (const tag1 of ['', 'é'.repeat(32), 'with spaces', 'quality ✓', '\u200b']) expect(params(r.buildNearErc8004GiveFeedback({ ...common(), ...feedback, tag1 })).args.tag1).toBe(tag1);
  });
  it.each(['0x'+'ab'.repeat(32),'0X'+'ab'.repeat(32),'AB'.repeat(32),'ab'.repeat(31),'ab'.repeat(33),'g'.repeat(64),'a'.repeat(64)+'\n',''])('rejects hash %s', hash => {
    expect(() => r.buildNearErc8004GiveFeedback({ ...common(), ...feedback, feedback_hash: hash })).toThrow();
    expect(() => r.buildNearErc8004AppendResponse({ ...common(), ...reference, response_uri: 'x:y', response_hash: hash })).toThrow();
  });
  it.each(['agentWallet','','a b','a'.repeat(65),'é','name\n'])('rejects metadata key %s', metadata_key => {
    expect(() => r.buildNearErc8004SetMetadata({ ...common(), agent_id: '0', metadata_key, metadata_value: '' })).toThrow();
    expect(() => r.buildNearErc8004Register({ ...common(), metadata: [{ metadata_key, metadata_value: '' }] })).toThrow();
  });
  it.each(['?','YQ','YR==','YWJ=','YQ==\n','YW Jj',Buffer.alloc(1025).toString('base64')])('rejects invalid metadata base64 %s', metadata_value => {
    expect(() => r.buildNearErc8004SetMetadata({ ...common(), agent_id: '0', metadata_key: 'name', metadata_value })).toThrow();
  });
  it('accepts max metadata, four entries, and rejects a fifth or extra field', () => {
    const entry = { metadata_key: 'a'.repeat(64), metadata_value: Buffer.alloc(1024).toString('base64') };
    expect(() => r.buildNearErc8004Register({ ...common(), metadata: Array(4).fill(entry) })).not.toThrow();
    expect(() => r.buildNearErc8004Register({ ...common(), metadata: Array(5).fill(entry) })).toThrow();
    expect(() => r.buildNearErc8004Register({ ...common(), metadata: [{ ...entry, extra: 1 }] } as any)).toThrow();
  });
  it('checks inclusive wallet deadline endpoints using nanoseconds', () => {
    for (const delta of [0n,300000000000n]) expect(() => r.buildNearErc8004SetAgentWallet({ ...common(), agent_id: '0', new_wallet: 'wallet.near', deadline: (BigInt(nowNs) + delta).toString() })).not.toThrow();
    for (const delta of [-1n,300000000001n]) expect(() => r.buildNearErc8004SetAgentWallet({ ...common(), agent_id: '0', new_wallet: 'wallet.near', deadline: (BigInt(nowNs) + delta).toString() })).toThrow('deadline');
    for (const deadline of badUnsigned) expect(() => r.buildNearErc8004SetAgentWallet({ ...common(), agent_id: '0', new_wallet: 'wallet.near', deadline } as any)).toThrow();
    vi.spyOn(Date, 'now').mockReturnValue(Number(BigInt(nowNs) / 1000000n));
    expect(() => r.buildNearErc8004SetAgentWallet({ ...common(), nowNs: undefined, agent_id: '0', new_wallet: 'wallet.near', deadline: nowNs })).not.toThrow();
  });
  it('validates transfer memo, approval id, account, token and callback message', () => {
    const transfer = { ...common(), receiver_id: 'worker.near', token_id: '0' };
    for (const approval_id of [-1,1.5,'1',Number.MAX_SAFE_INTEGER+1]) expect(() => r.buildNearErc8004NftTransfer({ ...transfer, approval_id } as any)).toThrow();
    expect(() => r.buildNearErc8004NftTransfer({ ...transfer, memo: 'é'.repeat(128) })).not.toThrow();
    expect(() => r.buildNearErc8004NftTransfer({ ...transfer, memo: 'é'.repeat(129) })).toThrow();
    expect(() => r.buildNearErc8004NftTransfer({ ...transfer, receiver_id: 'BAD' })).toThrow();
    expect(() => r.buildNearErc8004NftTransfer({ ...transfer, token_id: '01' })).toThrow();
    expect(() => r.buildNearErc8004NftTransferCall({ ...transfer, msg: 'a'.repeat(16385) })).toThrow();
    expect(() => r.buildNearErc8004NftApprove({ ...common(), token_id: '0', account_id: 'em.near', msg: '\ud800' })).toThrow();
  });
  it.each(['','a b','a\n','é','x'.repeat(129),null])('rejects proof %s', proof => expect(() => r.buildNearErc8004GiveFeedbackWithProof({ ...common(), ...feedback, verifier: targets.verifier, proof } as any)).toThrow());
  it('rejects foreign verifiers and zero feedback write indexes', () => {
    for (const verifier of ['other.near',targets.reputation,r.NEAR_ERC8004_CONTRACTS['near:testnet'].verifier]) expect(() => r.buildNearErc8004GiveFeedbackWithProof({ ...common(), ...feedback, verifier, proof: 'p' })).toThrow();
    for (const feedback_index of ['0',...badUnsigned]) expect(() => r.buildNearErc8004RevokeFeedback({ ...common(), agent_id: '0', feedback_index } as any)).toThrow();
  });
});

const sampleToken = recorded(net, targets.identity, 'nft_token');
const sampleFeedback = recorded(net, targets.reputation, 'read_feedback');
const sampleProof = recorded(net, targets.reputation, 'read_feedback_proof');
const sampleSummary = { count: '2', summary_value: '333333333333333333333333333333333333334', summary_value_decimals: 1 };
const viewCases: Array<[keyof r.NearErc8004ViewArgs, any, any, r.NearErc8004Contract, string?]> = [
  ['identity_config',{},config().identity,'identity','get_config'], ['reputation_config',{},config().reputation,'reputation','get_config'], ['verifier_config',{},config().verifier,'verifier','get_config'],
  ['identity_version',{},'2.0.0','identity','get_version'], ['reputation_version',{},'2.0.0','reputation','get_version'],
  ['nft_token',{ token_id: '0' },sampleToken,'identity'], ['nft_tokens',{ from_index: '0', limit: 2 },[sampleToken],'identity'],
  ['nft_supply_for_owner',{ account_id: 'worker.near' },'1','identity'], ['nft_tokens_for_owner',{ account_id: 'worker.near', from_index: '0', limit: 2 },[sampleToken],'identity'],
  ['nft_total_supply',{},'1','identity'], ['nft_metadata',{}, { spec: 'nft-1.0.0', name: 'Agents', symbol: 'AGENT', icon: null, base_uri: null, reference: null, reference_hash: null },'identity'],
  ['nft_is_approved',{ token_id: '0', approved_account_id: 'em.near', approval_id: 1 },true,'identity'],
  ['token_uri',{ agent_id: '0' },'ipfs://card','identity'], ['get_metadata',{ agent_id: '0', metadata_key: 'agentWallet' },'YWJj','identity'],
  ['get_agent_wallet',{ agent_id: '0' },'wallet.near','identity'], ['get_pending_agent_wallet',{ agent_id: '0' }, { wallet: 'wallet.near', deadline: nowNs },'identity'],
  ['is_authorized_or_owner',{ spender: 'em.near', agent_id: '0' },false,'identity'], ['check_agent',{ agent_id: '0', account_id: 'em.near' },{ owner_id: 'worker.near', agent_wallet: null, authorized: false },'identity'],
  ['get_summary',{ agent_id: '0', client_addresses: ['payer.near'], tag1: 'starred', tag2: '' },sampleSummary,'reputation'],
  ['read_feedback',reference,sampleFeedback,'reputation'], ['read_feedback_proof',reference,sampleProof,'reputation'],
  ['read_all_feedback',{ agent_id: '0', client_addresses: ['payer.near'], tag1: '', tag2: '', include_revoked: true },{ clients: ['payer.near'], feedback_indexes: ['1'], values: ['-32'], value_decimals: [1], tag1s: [''], tag2s: [''], revoked_statuses: [false] },'reputation'],
  ['get_response_count',{ agent_id: '0', client_address: 'payer.near', feedback_index: '0', responders: ['worker.near'] },'1','reputation'],
  ['get_clients',{ agent_id: '0', from_index: 0, limit: 2 },['payer.near'],'reputation'], ['get_last_index',{ agent_id: '0', client_address: 'payer.near' },'1','reputation'],
  ['get_identity_registry',{},targets.identity,'reputation'], ['get_proof_feedback',proofKey,reference,'reputation'], ['is_proof_pending',proofKey,false,'reputation'],
  ['list_verified_feedback',{ agent_id: '0', verifier: targets.verifier, from_index: 0, limit: 2 },[reference],'reputation'],
  ['get_verified_summary',{ agent_id: '0', verifier: targets.verifier, context: 'em', client_addresses: ['payer.near'], tag1: '', tag2: '' },{ ...sampleSummary, weight_sum: (2n ** 200n).toString() },'reputation'],
];
describe('bounded injectable JSON-RPC views', () => {
  it.each(viewCases)('%s exact wire request and typed response', async (method, args, result, target, wireName) => {
    const rpc = vi.fn(async () => bytes(result)), client = new r.NearErc8004Client({ network: net, rpc });
    expect(await client.view(method, args)).toEqual(result);
    const [rpcMethod, request, signal] = rpc.mock.calls[0] as any;
    expect(rpcMethod).toBe('query'); expect(request).toEqual({ request_type: 'call_function', finality: 'final', account_id: targets[target], method_name: wireName ?? method, args_base64: expect.any(String) });
    expect(JSON.parse(Buffer.from(request.args_base64,'base64').toString())).toEqual(args); expect(signal).toBeInstanceOf(AbortSignal);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(viewCases)('%s rejects extra args and malformed responses', async (method, args, result) => {
    const rpc = vi.fn(async () => bytes(result)), client = new r.NearErc8004Client({ network: net, rpc });
    await expect(client.view(method, { ...args, surprise: true })).rejects.toThrow(); expect(rpc).not.toHaveBeenCalled();
    for (const invalid of [123, {}, ['BAD'], 'INVALID']) {
      rpc.mockResolvedValueOnce(bytes(invalid));
      await expect(client.view(method, args)).rejects.toThrow();
    }
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      for (const k of Object.keys(result)) {
        const invalid = structuredClone(result); delete invalid[k]; rpc.mockResolvedValueOnce(bytes(invalid));
        await expect(client.view(method,args)).rejects.toThrow();
      }
      rpc.mockResolvedValueOnce(bytes({ ...result, unexpected: 1 })); await expect(client.view(method,args)).rejects.toThrow();
    }
  });
  it('replays all twenty recorded public reads through the wire decoder', async () => {
    for (const v of vectors.filter(v => !v.transaction_hash)) {
      const [method, call] = Object.entries(v.calls)[0] as [string, any];
      const t = r.NEAR_ERC8004_CONTRACTS[v.network as r.NearErc8004Network];
      const target = v.receiver_id === t.identity ? 'identity' : v.receiver_id === t.reputation ? 'reputation' : 'verifier';
      const rpc = vi.fn(async () => bytes(call.result));
      expect(await new r.NearErc8004Client({ network: v.network, rpc }).view((method === 'get_config' ? target + '_config' : method) as any, call.args)).toEqual(call.result);
      expect(call.args_json).toBe(JSON.stringify(call.args)); expect(call.args_hex).toBe(Buffer.from(call.args_json).toString('hex'));
    }
  });
  it('loads all configs and rejects altered contract binding or deposit quotes', async () => {
    for (const network of networks) {
      const t = r.NEAR_ERC8004_CONTRACTS[network], c = config(network);
      const rpc = vi.fn(async (_m, p) => bytes(p.account_id === t.identity ? c.identity : p.account_id === t.reputation ? c.reputation : c.verifier));
      expect(await new r.NearErc8004Client({ network, rpc }).getConfig()).toEqual(c);
      c.identity.register_deposit = '999999999999999999999999';
      await expect(new r.NearErc8004Client({ network, rpc }).getConfig()).rejects.toThrow('ceiling');
    }
  });
  it('covers every convenience view with the same transport', async () => {
    const byWire: Record<string, unknown> = Object.fromEntries(viewCases.map(([m,,v]) => [m,v]));
    const rpc: r.NearErc8004Rpc = async (_m,p) => bytes(p.method_name === 'get_config' ? p.account_id === targets.identity ? config().identity : p.account_id === targets.reputation ? config().reputation : config().verifier : p.method_name === 'get_version' ? '2.0.0' : byWire[p.method_name as string]);
    const c = new r.NearErc8004Client({ network: net, rpc });
    await expect(c.getIdentityConfig()).resolves.toEqual(config().identity); await expect(c.getReputationConfig()).resolves.toEqual(config().reputation); await expect(c.getVerifierConfig()).resolves.toEqual(config().verifier);
    await expect(c.getVersion()).resolves.toBe('2.0.0'); await expect(c.getVersion('reputation')).resolves.toBe('2.0.0');
    await expect(c.getAgent('0')).resolves.toEqual(sampleToken); await expect(c.getAgentUri('0')).resolves.toBe('ipfs://card');
    await expect(c.getMetadata('0','agentWallet')).resolves.toBe('YWJj'); await expect(c.getAgentWallet('0')).resolves.toBe('wallet.near');
    await expect(c.getPendingAgentWallet('0')).resolves.toEqual({ wallet: 'wallet.near', deadline: nowNs });
    await expect(c.readFeedback(reference)).resolves.toEqual(sampleFeedback); await expect(c.readFeedbackProof(reference)).resolves.toEqual(sampleProof);
    await expect(c.getSummary({ agent_id:'0', client_addresses:['payer.near'] })).resolves.toEqual(sampleSummary);
    await expect(c.getVerifiedSummary({ agent_id:'0', verifier: targets.verifier })).resolves.toEqual(byWire.get_verified_summary);
    await expect(c.listVerifiedFeedback({ agent_id:'0', verifier: targets.verifier })).resolves.toEqual([reference]);
  });
  it('accepts missing records as null, preserving empty metadata and URI', async () => {
    for (const method of ['nft_token','token_uri','get_metadata','get_agent_wallet','get_pending_agent_wallet','check_agent','read_feedback','read_feedback_proof','get_proof_feedback'] as const) {
      const c = new r.NearErc8004Client({ network:net, rpc:async () => bytes(null) });
      await expect(c.view(method, viewCases.find(v => v[0] === method)![1])).resolves.toBeNull();
    }
    for (const method of ['token_uri','get_metadata'] as const) await expect(new r.NearErc8004Client({ network:net, rpc:async () => bytes('') }).view(method, viewCases.find(v => v[0] === method)![1])).resolves.toBe('');
  });
  it('bounds pages, arrays, UTF-8, bytes, uints, signed summaries and protocol schemas', async () => {
    const rpc = vi.fn(async () => bytes([])), c = new r.NearErc8004Client({ network:net, rpc });
    await c.view('get_clients',{agent_id:'0'}); expect(JSON.parse(Buffer.from((rpc.mock.calls[0] as any)[1].args_base64,'base64').toString()).limit).toBe(100);
    for (const limit of [101,-1,1.5,'1']) await expect(c.view('get_clients',{agent_id:'0',limit} as any)).rejects.toThrow();
    for (const from_index of ['1',-1,Number.MAX_SAFE_INTEGER+1]) await expect(c.view('get_clients',{agent_id:'0',from_index} as any)).rejects.toThrow();
    for (const from_index of ['01','340282366920938463463374607431768211456',1]) await expect(c.view('nft_tokens',{from_index} as any)).rejects.toThrow();
    await expect(c.getSummary({agent_id:'0',client_addresses:[]})).rejects.toThrow();
    await expect(c.getSummary({agent_id:'0',client_addresses:Array(101).fill('payer.near')})).rejects.toThrow();
    await expect(c.getVerifiedSummary({agent_id:'0',verifier:'other.near'})).rejects.toThrow();
    await expect(c.getVerifiedSummary({agent_id:'0',verifier:targets.verifier,context:'EM'})).rejects.toThrow();
    const malformed = [null,{}, { result:'[]' }, {result:[-1]}, {result:[256]}, {result:[1.5]}, {result:['1']}, {result:[0xff]}, {result:Array(1048577).fill(32)}];
    for (const response of malformed) { rpc.mockResolvedValueOnce(response as any); await expect(c.view('get_clients',{agent_id:'0'})).rejects.toThrow(); }
    rpc.mockResolvedValueOnce(bytes(Array(101).fill('payer.near'))); await expect(c.view('get_clients',{agent_id:'0'})).rejects.toThrow();
    rpc.mockResolvedValueOnce(bytes(['payer.near','BAD'])); await expect(c.view('get_clients',{agent_id:'0'})).rejects.toThrow();
    for (const summary_value of ['01','-0','+1','1'.repeat(57),1]) {
      rpc.mockResolvedValueOnce(bytes({...sampleSummary,summary_value})); await expect(c.getSummary({agent_id:'0',client_addresses:['payer.near']})).rejects.toThrow();
    }
    rpc.mockResolvedValueOnce(bytes({...sampleSummary,weight_sum:(2n**256n).toString()})); await expect(c.getVerifiedSummary({agent_id:'0',verifier:targets.verifier})).rejects.toThrow();
    rpc.mockResolvedValueOnce(bytes({...viewCases.find(v => v[0] === 'read_all_feedback')![2],values:[]})); await expect(c.view('read_all_feedback',{agent_id:'0'})).rejects.toThrow();
    rpc.mockResolvedValueOnce(bytes('other.near')); await expect(c.view('get_identity_registry',{})).rejects.toThrow('binding');
    for (const weight of [1,'01','340282366920938463463374607431768211456']) {
      rpc.mockResolvedValueOnce(bytes({...sampleProof,weight})); await expect(c.readFeedbackProof(reference)).rejects.toThrow();
    }
  });
  it('bounds default HTTP reads, validates envelopes and times out an injected transport', async () => {
    const c = new r.NearErc8004Client({ network:net });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({result:bytes('1')})));
    await expect(c.view('nft_total_supply',{})).resolves.toBe('1');
    expect(fetchMock.mock.calls[0][0]).toBe('https://rpc.mainnet.near.org');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({result:bytes('1')})));
    await expect(new r.NearErc8004Client({network:'near:testnet'}).view('nft_total_supply',{})).resolves.toBe('1');
    expect(fetchMock.mock.calls[1][0]).toBe('https://rpc.testnet.near.org');
    for (const response of [new Response('{}',{status:500}),new Response('{}'),new Response(JSON.stringify({error:{},result:bytes('1')})),new Response('x'.repeat(4*1048576+1))]) {
      fetchMock.mockResolvedValueOnce(response); await expect(c.view('nft_total_supply',{})).rejects.toThrow();
    }
    const rpc = vi.fn((_m,_p,signal: any) => new Promise<never>(() => { expect(signal).toBeInstanceOf(AbortSignal); }));
    await expect(new r.NearErc8004Client({ network:net, rpc, timeoutMs:10 }).getAgent('0')).rejects.toThrow('timeout');
    expect(rpc.mock.calls[0][2].aborted).toBe(true);
    for (const timeoutMs of [0,60001,1.5,NaN]) expect(() => new r.NearErc8004Client({ network:net,timeoutMs })).toThrow();
    expect(() => new r.NearErc8004Client({network:'near' as any})).toThrow();
    await expect(c.view('verify_feedback_proof' as any,{})).rejects.toThrow();
  });
});

describe('local signing without stored keys', () => {
  const keyPair = generateKeyPairSync('ed25519');
  const publicKey = new Uint8Array(keyPair.publicKey.export({format:'der',type:'spki'}).subarray(-32));
  const signer = { publicKey, sign: async (message:Uint8Array) => new Uint8Array(sign(null,message,keyPair.privateKey)) };
  const options = () => ({ network:net,config:config(),nonce:'1',blockHash:'1'.repeat(32),nowNs });
  it('independently decodes Borsh, compact JSON, gas and deposit and verifies using Node crypto', async () => {
    for (const [method,args] of calls) {
      const tx = r.buildNearErc8004Transaction(method,common(),args);
      const encoded = await r.signNearErc8004Transaction(tx,signer,options()), data=Buffer.from(encoded,'base64');
      const body=data.subarray(0,-65), signature=data.subarray(-64); expect(data[data.length-65]).toBe(0);
      expect(verify(null,sha256(body),keyPair.publicKey,signature)).toBe(true);
      let at=0; const u32=()=>{const n=body.readUInt32LE(at);at+=4;return n;}; const string=()=>{const n=u32(),v=body.subarray(at,at+n).toString();at+=n;return v;};
      expect(string()).toBe(tx.signerId); expect(body[at++]).toBe(0); expect(body.subarray(at,at+32)).toEqual(Buffer.from(publicKey)); at+=32;
      expect(body.readBigUInt64LE(at)).toBe(1n);at+=8; expect(string()).toBe(tx.receiverId);expect(body.subarray(at,at+32)).toEqual(Buffer.alloc(32));at+=32;
      expect(u32()).toBe(1);expect(body[at++]).toBe(2);expect(string()).toBe(method);expect(string()).toBe(JSON.stringify(params(tx).args));
      expect(body.readBigUInt64LE(at)).toBe(BigInt(params(tx).gas));at+=8;
      expect(body.readBigUInt64LE(at)+(body.readBigUInt64LE(at+8)<<64n)).toBe(BigInt(params(tx).deposit));at+=16;expect(at).toBe(body.length);
    }
  });
  it('rejects all descriptor changes before accessing the signer', async () => {
    const mutations: Array<(tx:any)=>void> = [tx=>{tx.receiverId='other.near';},tx=>{tx.receiverId=r.NEAR_ERC8004_CONTRACTS['near:testnet'].identity;},tx=>{tx.signerId='BAD';},
      tx=>{tx.actions=[];},tx=>{tx.actions.push(tx.actions[0]);},tx=>{tx.actions[0].type='Transfer';},tx=>{tx.actions[0].params=null;},
      tx=>{params(tx).methodName='on_feedback_checked' as any;},tx=>{params(tx).args=null as any;},tx=>{params(tx).args.extra=true;},
      tx=>{params(tx).deposit='99999999999999999999999999';},tx=>{params(tx).deposit=1 as any;},tx=>{params(tx).gas=1 as any;},tx=>{params(tx).gas='300000000000001';},tx=>{params(tx).args.agent_uri='x:bad space';}];
    const getKey=vi.fn(()=>publicKey), signFn=vi.fn(signer.sign); const spy={get publicKey(){return getKey();},sign:signFn};
    for (const change of mutations) {const tx=r.buildNearErc8004Register(common());change(tx);await expect(r.signNearErc8004Transaction(tx,spy,options())).rejects.toThrow();}
    for (const patch of [{network:'near:testnet'},{config:config('near:testnet')},{nonce:'0'},{nonce:'01'},{nonce:Number.MAX_SAFE_INTEGER+1},{blockHash:'1'},{blockHash:'0'.repeat(32)}]) await expect(r.signNearErc8004Transaction(r.buildNearErc8004Register(common()),spy,{...options(),...patch} as any)).rejects.toThrow();
    const wallet=r.buildNearErc8004SetAgentWallet({...common(),agent_id:'0',new_wallet:'wallet.near',deadline:nowNs});
    await expect(r.signNearErc8004Transaction(wallet,spy,{...options(),nowNs:(BigInt(nowNs)+1n).toString()})).rejects.toThrow('deadline');
    expect(getKey).not.toHaveBeenCalled();expect(signFn).not.toHaveBeenCalled();
  });
  it('rejects invalid public keys and signatures, and signs a detached snapshot', async () => {
    const tx=r.buildNearErc8004Register({...common(),agent_uri:'ipfs://card'});
    await expect(r.signNearErc8004Transaction(tx,{...signer,publicKey:new Uint8Array(31)},options())).rejects.toThrow('public key');
    for(const signature of [new Uint8Array(63),new Uint8Array(64),'not bytes']) await expect(r.signNearErc8004Transaction(tx,{...signer,sign:async()=>signature as any},options())).rejects.toThrow('signature');
    const encoded=await r.signNearErc8004Transaction(tx,{...signer,sign:async digest=>{params(tx).args.agent_uri='ipfs://changed';return signer.sign(digest);}},options());
    const body=Buffer.from(encoded,'base64').subarray(0,-65);expect(body.includes(Buffer.from('ipfs://card'))).toBe(true);expect(body.includes(Buffer.from('ipfs://changed'))).toBe(false);
  });
});

const eventCases: Array<[keyof r.NearErc8004EventData, any, string]> = [
  ['registered',{agent_id:'0',agent_uri:'',owner:'payer.near'},'identity'],
  ['metadata_set',{agent_id:'0',metadata_key:'agentWallet',metadata_value:'cGF5ZXIubmVhcg=='},'identity'],
  ['uri_updated',{agent_id:'0',new_uri:'ipfs://card',updated_by:'payer.near'},'identity'],
  ['agent_wallet_pending',{agent_id:'0',wallet:'wallet.near',deadline:nowNs},'identity'],
  ['nft_mint',{owner_id:'payer.near',token_ids:['0']},'identity'],
  ['nft_transfer',{old_owner_id:'payer.near',new_owner_id:'worker.near',token_ids:['0'],memo:'venta',authorized_id:'em.near'},'identity'],
  ['new_feedback',{...reference,...feedback,tag1:'starred',tag2:'',endpoint:'',feedback_uri:'',feedback_hash:null,proof:null},'reputation'],
  ['feedback_revoked',reference,'reputation'],
  ['response_appended',{...reference,responder:'worker.near',response_uri:'ipfs://response',response_hash:'ab'.repeat(32)},'reputation'],
];
function eventFor(name: string,data: unknown) {return {standard:name.startsWith('nft_')?'nep171':'erc8004',version:'1.0.0',event:name,data:[data]};}
describe('strict successful receipt events and transaction outcomes', () => {
  it.each(eventCases)('parses %s and rejects malformed data and provenance', (name,data,target) => {
    const event=eventFor(name,data), emitter=(targets as any)[target];
    expect(r.parseNearErc8004ReceiptEvents([receipt(event,emitter)],net)).toEqual([event]);
    for(const status of [{SuccessReceiptId:'receipt'},{SuccessValue:''}]) expect(r.parseNearErc8004ReceiptEvents([receipt(event,emitter,status)],net)).toEqual([event]);
    for(const bad of [null,{},[],{Failure:{}},'Unknown',{SuccessValue:null},{SuccessReceiptId:1},{SuccessValue:'',Failure:{}},{SuccessValue:'',SuccessReceiptId:'r'}]) expect(r.parseNearErc8004ReceiptEvents([receipt(event,emitter,bad)],net)).toEqual([]);
    for(const executor of ['foreign.near',emitter.toUpperCase(),emitter+' ',emitter+'\n',r.NEAR_ERC8004_CONTRACTS['near:testnet'][target as 'identity'|'reputation'],target==='identity'?targets.reputation:targets.identity]) expect(r.parseNearErc8004ReceiptEvents([receipt(event,executor)],net)).toEqual([]);
    expect(r.parseNearErc8004ReceiptEvents([receipt(event,emitter)],'near:testnet')).toEqual([]);
    for(const patch of [{standard:'foreign'},{version:'2.0.0'},{event:'validation_request'},{event:'toString'},{data:[]},{data:[data,data]},{data:[null]},{data:{}},{extra:true}]) expect(r.parseNearErc8004ReceiptEvents([receipt({...event,...patch},emitter)],net)).toEqual([]);
    for(const k of Object.keys(data)) {
      // memo and authorized_id are optional NEP-171 fields.
      if(['memo','authorized_id'].includes(k)) continue;
      const invalid={...data};delete invalid[k];expect(r.parseNearErc8004ReceiptEvents([receipt(eventFor(name,invalid),emitter)],net)).toEqual([]);
      expect(r.parseNearErc8004ReceiptEvents([receipt(eventFor(name,{...data,[k]:{}}),emitter)],net)).toEqual([]);
    }
    expect(r.parseNearErc8004ReceiptEvents([receipt(eventFor(name,{...data,extra:1}),emitter)],net)).toEqual([]);
  });
  it('replays six final outcomes and their exact ordered events', () => {
    const txs=vectors.filter(v=>v.transaction_hash);expect(txs).toHaveLength(6);
    for(const v of txs) {
      const [method,call]=Object.entries(v.calls)[0] as [string,any];
      expect(call.args_hex).toBe(Buffer.from(call.args_json).toString('hex'));expect(JSON.parse(call.args_json)).toEqual(call.args);
      expect(r.parseNearErc8004Events(call.result,v.network)).toEqual(v.events.map((e:any)=>e.parsed));
      if(method==='register') expect(r.parseNearErc8004RegisterOutcome(call.result,v.network)).toBe('0');
      if(method==='give_feedback_with_proof') expect(r.parseNearErc8004GiveFeedbackOutcome(call.result,v.network)).toEqual({status:'accepted',feedbackIndex:'1'});
    }
    expect(vectors.filter(v=>!v.transaction_hash)).toHaveLength(20);
    const file=readFileSync(new URL('./vectors/near-erc8004.json',import.meta.url),'utf8');
    expect(file).toBe(JSON.stringify(fixture,null,2)+'\n');
  });
  it('ignores malformed receipts, log prefixes and incomplete or failed transaction outcomes', () => {
    const event=eventFor('registered',eventCases[0][1]);
    for(const input of [null,{},1,'x']) expect(r.parseNearErc8004ReceiptEvents(input,net)).toEqual([]);
    expect(r.parseNearErc8004ReceiptEvents([null,{},[],{outcome:null},{outcome:[]},{outcome:{}}],net)).toEqual([]);
    for(const logs of [null,'x',[null,'',' EVENT_JSON:'+JSON.stringify(event),'EVENT_JSON:{','EVENT_JSON:'+ 'x'.repeat(65536)]]) {
      const rec=receipt(event);(rec.outcome as any).logs=logs;expect(r.parseNearErc8004ReceiptEvents([rec],net)).toEqual([]);
    }
    expect(()=>r.parseNearErc8004ReceiptEvents([],'near' as any)).toThrow();
    const final=txFixture('register');
    for(const status of [{Failure:{}},{SuccessReceiptId:'pending'},{SuccessValue:'',Failure:{}},null,'Unknown']) expect(r.parseNearErc8004Events({...final,status},net)).toEqual([]);
    expect(r.parseNearErc8004Events(null,net)).toEqual([]);
  });
  it('handles cleared wallets and proof events, rejects noncanonical event integers and hashes', () => {
    const pending=eventFor('agent_wallet_pending',{agent_id:'0',wallet:null,deadline:'0'});
    expect(r.parseNearErc8004ReceiptEvents([receipt(pending)],net)).toEqual([pending]);
    expect(r.parseNearErc8004ReceiptEvents([receipt(eventFor('agent_wallet_pending',{agent_id:'0',wallet:null,deadline:'1'}))],net)).toEqual([]);
    const data={...eventCases.find(c=>c[0]==='new_feedback')![1],proof:sampleProof};
    const event=eventFor('new_feedback',data);expect(r.parseNearErc8004ReceiptEvents([receipt(event,targets.reputation)],net)).toEqual([event]);
    for(const patch of [{agent_id:'01'},{feedback_index:'0'},{value:'-0'},{value_decimals:19},{feedback_hash:'0x'+'ab'.repeat(32)},{proof:{...sampleProof,context:'EM'}},{proof:{...sampleProof,role:'a'.repeat(33)}},{proof:{...sampleProof,weight:'01'}}]) expect(r.parseNearErc8004ReceiptEvents([receipt(eventFor('new_feedback',{...data,...patch}),targets.reputation)],net)).toEqual([]);
    expect(r.parseNearErc8004ReceiptEvents([receipt(eventFor('nft_mint',{owner_id:'payer.near',token_ids:[]}))],net)).toEqual([]);
  });
  it.each(Object.values(r.NearErc8004RejectionCode))('recognizes authenticated callback rejection %s', code => {
    const outcome=txFixture('give_feedback_with_proof');outcome.status={SuccessValue:b64(null)};
    outcome.receipts_outcome=[{outcome:{executor_id:targets.reputation,status:{SuccessValue:b64(null)},logs:['erc8004:rechazo:'+code]}}];
    expect(r.parseNearErc8004GiveFeedbackOutcome(outcome,net)).toEqual({status:'rejected',code});
    for(const executor_id of ['other.near',targets.identity,r.NEAR_ERC8004_CONTRACTS['near:testnet'].reputation]) {const bad=structuredClone(outcome);bad.receipts_outcome[0].outcome.executor_id=executor_id;expect(()=>r.parseNearErc8004GiveFeedbackOutcome(bad,net)).toThrow();}
    const failed=structuredClone(outcome);failed.receipts_outcome[0].outcome.status={Failure:{}};expect(()=>r.parseNearErc8004GiveFeedbackOutcome(failed,net)).toThrow();
  });
  it('rejects unknown, duplicate, ambiguous and untrusted callback logs', () => {
    for(const logs of [[],['erc8004:rechazo:E41'],['erc8004:rechazo:E23_NO_AUTORIZADO'],['erc8004:rechazo:E45_VERIFICADOR_FALLO '],Array(2).fill('erc8004:rechazo:E45_VERIFICADOR_FALLO'),['erc8004:rechazo:E45_VERIFICADOR_FALLO','erc8004:rechazo:E42_PRUEBA_YA_USADA']]) {
      const outcome=txFixture('give_feedback_with_proof');outcome.status={SuccessValue:b64(null)};
      outcome.receipts_outcome=[{outcome:{executor_id:targets.reputation,status:{SuccessValue:b64(null)},logs}}];
      expect(()=>r.parseNearErc8004GiveFeedbackOutcome(outcome,net)).toThrow();
    }
  });
  it('rejects return values that disagree with authenticated events or transaction inputs', () => {
    for(const method of ['register','give_feedback_with_proof']) {
      const parse=method==='register'?r.parseNearErc8004RegisterOutcome:r.parseNearErc8004GiveFeedbackOutcome;
      for(const value of ['01',1,'-0','2',{},'18446744073709551616',method==='register'?null:'0']) {
        const outcome=txFixture(method);outcome.status={SuccessValue:b64(value)};expect(()=>parse(outcome,net)).toThrow();
      }
      const original=txFixture(method);
      const badCases=[null,{}, {...original,transaction:null},{...original,status:{SuccessReceiptId:'r'}},{...original,status:{SuccessValue:'YR=='}},
        {...original,receipts_outcome:[]},{...original,transaction:{...original.transaction,receiver_id:'other.near'}},{...original,transaction:{...original.transaction,actions:[]}},
        {...original,transaction:{...original.transaction,signer_id:'other.near'}},{...original,status:{SuccessValue:'a'.repeat(1028)}}];
      for(const bad of badCases) expect(()=>parse(bad,net)).toThrow();
      expect(()=>parse(original,'near:testnet')).toThrow();
      const altered=structuredClone(original);const call=altered.transaction.actions[0].FunctionCall;const args=JSON.parse(Buffer.from(call.args,'base64').toString());
      call.args=b64({...args,[method==='register'?'agent_uri':'value']:method==='register'?'ipfs://different':'99'});expect(()=>parse(altered,net)).toThrow();
      call.method_name='nft_transfer';expect(()=>parse(altered,net)).toThrow();
    }
  });
  describe.each(networks)('%s outcome correlation', network => {
    const t = r.NEAR_ERC8004_CONTRACTS[network];
    function editFeedback(outcome: any, change: (data: any) => void) {
      for (const rec of outcome.receipts_outcome) rec.outcome.logs = rec.outcome.logs.map((log: string) => {
        if (!log.startsWith('EVENT_JSON:')) return log;
        const event = JSON.parse(log.slice(11));
        if (event.event === 'new_feedback') change(event.data[0]);
        return 'EVENT_JSON:' + JSON.stringify(event);
      });
    }
    it.each([
      ['agent_id', '2'], ['value_decimals', 2], ['tag1', 'different'], ['tag2', 'different'],
      ['endpoint', 'https://different.example'], ['feedback_uri', 'ipfs://different'], ['feedback_hash', 'ab'.repeat(32)],
      ['proof.verifier', 'foreign.near'], ['proof.proof', 'different-payment'],
    ])('rejects a schema-valid mismatch in %s', (field, value) => {
      const outcome = txFixture('give_feedback_with_proof', network);
      editFeedback(outcome, data => {
        if (field.startsWith('proof.')) data.proof[field.slice(6)] = value;
        else data[field] = value;
      });
      // Ensure this tests correlation, rather than the event schema discarding the changed row.
      expect(r.parseNearErc8004Events(outcome, network).filter(e => e.event === 'new_feedback')).toHaveLength(1);
      expect(() => r.parseNearErc8004GiveFeedbackOutcome(outcome, network)).toThrow('Feedback result/event mismatch');
    });
    it('rejects proof-bearing events for feedback submitted without a proof', () => {
      const outcome = txFixture('give_feedback_with_proof', network), call = outcome.transaction.actions[0].FunctionCall;
      const args = JSON.parse(Buffer.from(call.args, 'base64').toString());
      delete args.verifier; delete args.proof; call.args = b64(args); call.method_name = 'give_feedback';
      expect(r.parseNearErc8004Events(outcome, network).filter(e => e.event === 'new_feedback')).toHaveLength(1);
      expect(() => r.parseNearErc8004GiveFeedbackOutcome(outcome, network)).toThrow('Feedback result/event mismatch');
      editFeedback(outcome, data => { data.proof = null; });
      expect(r.parseNearErc8004GiveFeedbackOutcome(outcome, network)).toEqual({ status: 'accepted', feedbackIndex: '1' });
    });
    it('rejects a callback rejection accompanied by new_feedback', () => {
      const outcome = txFixture('give_feedback_with_proof', network);
      outcome.status = { SuccessValue: b64(null) };
      outcome.receipts_outcome.push({ outcome: { executor_id: t.reputation, status: { SuccessValue: b64(null) },
        logs: ['erc8004:rechazo:E45_VERIFICADOR_FALLO'] } });
      expect(r.parseNearErc8004Events(outcome, network).filter(e => e.event === 'new_feedback')).toHaveLength(1);
      expect(() => r.parseNearErc8004GiveFeedbackOutcome(outcome, network)).toThrow();
    });
    it('rejects two otherwise matching registered events', () => {
      const outcome = txFixture('register', network);
      const registered = r.parseNearErc8004Events(outcome, network).find(e => e.event === 'registered')!;
      outcome.receipts_outcome.push(receipt(registered, t.identity));
      expect(r.parseNearErc8004Events(outcome, network).filter(e => e.event === 'registered')).toHaveLength(2);
      expect(() => r.parseNearErc8004RegisterOutcome(outcome, network)).toThrow('Register result/event mismatch');
    });
    it.each(['foreign', 'other-network'])('rejects matching args/event from a %s verifier', kind => {
      const verifier = kind === 'foreign' ? 'foreign.near' : r.NEAR_ERC8004_CONTRACTS[networks.find(n => n !== network)!].verifier;
      const outcome = txFixture('give_feedback_with_proof', network), call = outcome.transaction.actions[0].FunctionCall;
      call.args = b64({ ...JSON.parse(Buffer.from(call.args, 'base64').toString()), verifier });
      editFeedback(outcome, data => { data.proof.verifier = verifier; });
      expect(r.parseNearErc8004Events(outcome, network).filter(e => e.event === 'new_feedback')).toHaveLength(1);
      expect(() => r.parseNearErc8004GiveFeedbackOutcome(outcome, network)).toThrow('Verifier is not registered for network');
      // The same rule applies before returning synchronous failures or callback rejections.
      outcome.status = { Failure: { error: 'out of gas' } };
      expect(() => r.parseNearErc8004GiveFeedbackOutcome(outcome, network)).toThrow('Verifier is not registered for network');
      outcome.status = { SuccessValue: b64(null) };
      outcome.receipts_outcome = [{ outcome: { executor_id: t.reputation, status: { SuccessValue: b64(null) },
        logs: ['erc8004:rechazo:E45_VERIFICADOR_FALLO'] } }];
      expect(() => r.parseNearErc8004GiveFeedbackOutcome(outcome, network)).toThrow('Verifier is not registered for network');
    });
    it.each(['EXECUTED_OPTIMISTIC', 'EXECUTED', 'INCLUDED', 'INCLUDED_FINAL', 'NONE', 'final', 'FINAL ', '', null, 1, {}, undefined])(
      'rejects an explicitly non-final execution status %j', status => {
        for (const method of ['register', 'give_feedback_with_proof']) {
          const outcome = txFixture(method, network); outcome.final_execution_status = status;
          const parse = method === 'register' ? r.parseNearErc8004RegisterOutcome : r.parseNearErc8004GiveFeedbackOutcome;
          expect(r.parseNearErc8004Events(outcome, network)).toEqual([]);
          expect(() => parse(outcome, network)).toThrow('final');
          if (method === 'give_feedback_with_proof') {
            outcome.status = { Failure: { error: 'out of gas' } };
            expect(() => parse(outcome, network)).toThrow('final');
          }
        }
      });
    it.each(['register', 'give_feedback_with_proof'])('accepts FINAL and an absent finality field for %s', method => {
      const outcome = txFixture(method, network);
      const parse = method === 'register' ? r.parseNearErc8004RegisterOutcome : r.parseNearErc8004GiveFeedbackOutcome;
      const expected = method === 'register' ? '0' : { status: 'accepted', feedbackIndex: '1' };
      expect(outcome.final_execution_status).toBe('FINAL');
      expect(parse(outcome, network)).toEqual(expected);
      delete outcome.final_execution_status;
      expect(parse(outcome, network)).toEqual(expected);
      expect(r.parseNearErc8004Events(outcome, network).length).toBeGreaterThan(0);
    });
  });
  it('returns synchronous contract failures distinctly and accepts unproved feedback with a null proof', () => {
    const outcome=txFixture('give_feedback_with_proof');outcome.status={Failure:{error:'ERC8004_REP_E09: storage'}};
    expect(r.parseNearErc8004GiveFeedbackOutcome(outcome,net)).toEqual({status:'failed',code:'ERC8004_REP_E09',message:JSON.stringify(outcome.status.Failure)});
    outcome.status={Failure:{error:'out of gas'}};expect(r.parseNearErc8004GiveFeedbackOutcome(outcome,net).status).toBe('failed');
    outcome.status={Failure:{},SuccessValue:b64('1')};expect(()=>r.parseNearErc8004GiveFeedbackOutcome(outcome,net)).toThrow();
    const plain=txFixture('give_feedback_with_proof'),call=plain.transaction.actions[0].FunctionCall;call.method_name='give_feedback';
    const args=JSON.parse(Buffer.from(call.args,'base64').toString());delete args.verifier;delete args.proof;call.args=b64(args);
    for(const rec of plain.receipts_outcome) rec.outcome.logs=rec.outcome.logs.map((log:string)=>{if(!log.startsWith('EVENT_JSON:'))return log;const e=JSON.parse(log.slice(11));if(e.event==='new_feedback')e.data[0].proof=null;return 'EVENT_JSON:'+JSON.stringify(e);});
    expect(r.parseNearErc8004GiveFeedbackOutcome(plain,net)).toEqual({status:'accepted',feedbackIndex:'1'});
  });
});

describe('additional input and transport boundary regressions', () => {
  it.each(calls)('%s validates every supplied argument and snapshots nested values', (method, args) => {
    for (const field of Object.keys(args)) expect(() => r.buildNearErc8004Transaction(method,common(),{...args,[field]:{}})).toThrow();
    expect(() => r.buildNearErc8004Transaction(method,common(),null as any)).toThrow();
    const copied=structuredClone(args), tx=r.buildNearErc8004Transaction(method,common(),copied);
    for(const key of Object.keys(copied)) copied[key]='changed';expect(params(tx).args).toEqual(args);
  });
  it('rejects malformed monetary options instead of activating defaults', () => {
    for(const deposit of [null,1,'01','-1','+1','1\n','340282366920938463463374607431768211456']) expect(()=>r.buildNearErc8004Register({...common(),deposit} as any)).toThrow();
    for(const now of [null,'01','-1','18446744073709551616']) expect(()=>r.buildNearErc8004SetAgentWallet({...common(),nowNs:now,agent_id:'0',new_wallet:'wallet.near',deadline:nowNs} as any)).toThrow();
  });
  it('returns query null at canonical zero indexes without weakening write indexes', async () => {
    const c=new r.NearErc8004Client({network:net,rpc:async()=>bytes(null)});
    await expect(c.readFeedback({...reference,feedback_index:'0'})).resolves.toBeNull();
    await expect(c.readFeedbackProof({...reference,feedback_index:'0'})).resolves.toBeNull();
  });
  it('checks individual config reads before returning them', async () => {
    const c=config();c.identity.register_deposit='999999999999999999999999';
    await expect(new r.NearErc8004Client({network:net,rpc:async()=>bytes(c.identity)}).getIdentityConfig()).rejects.toThrow();
    c.reputation.identity_registry='other.near';await expect(new r.NearErc8004Client({network:net,rpc:async()=>bytes(c.reputation)}).getReputationConfig()).rejects.toThrow();
    c.verifier.escrow='other.near';await expect(new r.NearErc8004Client({network:net,rpc:async()=>bytes(c.verifier)}).getVerifierConfig()).rejects.toThrow();
  });
  it('checks Unicode scalars, canonical padding and integer widths', () => {
    expect(schema.base64Check(1)('YQ==')).toBe(true);expect(schema.base64Check(1)('YWI=')).toBe(false);
    expect(schema.unsigned(256)('1'.repeat(79))).toBe(false);expect(schema.u128((2n**128n-1n).toString())).toBe(true);
    expect(schema.text('\udfff')).toBe(false);expect(schema.text('😀')).toBe(true);
    for(const value of ['YQ==\n','YQ=','YR==','YWJ=']) expect(()=>schema.unbase64(value)).toThrow();
  });
});

describe('isolated guard mutation regressions', () => {
  it('rejects HTTP failure even when the body is a fully valid RPC success', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({result:bytes('1')}),{status:500}));
    await expect(new r.NearErc8004Client({network:net}).view('nft_total_supply',{})).rejects.toThrow('HTTP');
  });
  it('rejects an otherwise valid RPC body above the wire-byte ceiling', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(' '.repeat(4*1048576)+JSON.stringify({result:bytes('1')})));
    await expect(new r.NearErc8004Client({network:net}).view('nft_total_supply',{})).rejects.toThrow('byte limit');
  });
  it('rejects an otherwise valid decoded response above the payload-byte ceiling', async () => {
    const rpc=async()=>({result:[...Buffer.from(' '.repeat(1048576)+'"1"')]});
    await expect(new r.NearErc8004Client({network:net,rpc}).view('nft_total_supply',{})).rejects.toThrow('call_function');
  });
  it.each([-165,347,91.25,'91'])('does not coerce malformed byte %s into a valid JSON bracket', async first => {
    const rpc=async()=>({result:[first,93]});
    await expect(new r.NearErc8004Client({network:net,rpc}).view('nft_tokens',{})).rejects.toThrow('call_function');
  });
  it('rejects foreign view verifiers before RPC, even if the response would pass its schema', async () => {
    const rpc=vi.fn(async()=>bytes({...sampleSummary,weight_sum:'1'}));
    await expect(new r.NearErc8004Client({network:net,rpc}).getVerifiedSummary({agent_id:'0',verifier:'other.near'})).rejects.toThrow('Verifier');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('validates optional NFT event memo and authorized_id fields', () => {
    const valid={old_owner_id:'payer.near',new_owner_id:'worker.near',token_ids:['0']};
    for(const patch of [{memo:1},{memo:'a'.repeat(257)},{authorized_id:'BAD'},{authorized_id:1}]) {
      expect(r.parseNearErc8004ReceiptEvents([receipt(eventFor('nft_transfer',{...valid,...patch}))],net)).toEqual([]);
    }
    expect(r.parseNearErc8004ReceiptEvents([receipt(eventFor('nft_mint',{owner_id:'payer.near',token_ids:['0'],memo:1}))],net)).toEqual([]);
  });
});

describe('snapshot before validation', () => {
  it('reads argument accessors once and validates the exact detached value', () => {
    let reads=0;
    const args={get agent_uri(){reads++;return reads===1?'ipfs://card':'invalid uri';}};
    const tx=r.buildNearErc8004Transaction('register',common(),args);
    expect(reads).toBe(1);expect(params(tx).args).toEqual({agent_uri:'ipfs://card'});
  });
  it('reads config accessors once and consumes the validated detached quote', () => {
    const o=common(),quote=o.config.identity.register_deposit;let reads=0;
    Object.defineProperty(o.config.identity,'register_deposit',{enumerable:true,get(){reads++;return reads===1?quote:'999999999999999999999999';}});
    const tx=r.buildNearErc8004Register(o);expect(reads).toBe(1);expect(params(tx).deposit).toBe(quote);
  });
});
