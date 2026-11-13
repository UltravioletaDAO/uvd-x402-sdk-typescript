import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as r from './erc8004';
import fixture from './vectors/near-erc8004.json';

/*
 * The mechanism with a filled v2 row: the same SDK code, with the verifier table of this file. The account is
 * fictitious on purpose, so these tests do not depend on the real row (erc8004-v2-verifier.test.ts pins that one).
 */
vi.mock('./erc8004-verifiers', () => ({
  NEAR_ERC8004_ESCROW_VERIFIERS: Object.freeze({
    'near:mainnet': Object.freeze({ 'v1.arras-escrow.near': 'erc8004-verifier.arras-escrow.near', 'v2.arras-escrow.near': 'v2-verifier.example.near' }),
    'near:testnet': Object.freeze({ 'arras-v1b-1101.testnet': 'erc8004-verifier.arras-dev.testnet' }),
  }),
}));

const net = 'near:mainnet' as const;
const t = r.NEAR_ERC8004_CONTRACTS[net];
const V1 = 'erc8004-verifier.arras-escrow.near', V2 = 'v2-verifier.example.near';
const nowNs = '1793829600000000000';
function recorded(contract: string): any {
  const call = fixture.networks.find(n => n.network === net)!.calls.find(c => c.contract === contract && c.method === 'get_config')!;
  return structuredClone(call.result);
}
const verifierV1 = () => recorded(t.verifier);
const verifierV2 = () => ({ ...verifierV1(), escrow: 'v2.arras-escrow.near', min_gas_verify: '27000000000000' });
const config = (verifier = verifierV1()): r.NearErc8004Config => ({ network: net, identity: recorded(t.identity), reputation: recorded(t.reputation), verifier });
const bytes = (value: unknown) => ({ result: [...Buffer.from(JSON.stringify(value))] });
const feedback = { agent_id: '0', value: '90', value_decimals: 0 };
const options = (c = config()) => ({ network: net, signerId: 'payer.near', config: c, nowNs });
/** RPC double: get_config of each contract by account; the v2 verifier answers with its own escrow. */
function rpcFor(answers: Record<string, unknown>) {
  return vi.fn(async (_m: string, p: any) => {
    if (!Object.hasOwn(answers, p.account_id)) throw new Error(`account ${p.account_id} does not exist while viewing`);
    return bytes(answers[p.account_id]);
  });
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden'); })));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('with the v2 row filled: one verifier per escrow', () => {
  it('maps each escrow to its own verifier', () => {
    expect(r.NEAR_ERC8004_ESCROW_VERIFIERS[net]['v2.arras-escrow.near']).toBe(V2);
    expect(r.nearErc8004Verifier(net, 'v1.arras-escrow.near')).toBe(V1);
    expect(r.nearErc8004Verifier(net, 'v2.arras-escrow.near')).toBe(V2);
  });
  it('give_feedback_with_proof accepts both verifiers of the network, and only those', () => {
    for (const verifier of [V1, V2]) {
      expect(r.buildNearErc8004GiveFeedbackWithProof({ ...options(), ...feedback, verifier, proof: 'p' }).actions[0].params.args.verifier).toBe(verifier);
    }
    for (const verifier of ['other.near', 'erc8004-verifier.arras-dev.testnet', 'v2.arras-escrow.near']) {
      expect(() => r.buildNearErc8004GiveFeedbackWithProof({ ...options(), ...feedback, verifier, proof: 'p' })).toThrow('Verifier is not registered for network');
    }
  });
  it('reads the get_config of the verifier asked for, bound to that verifier\'s escrow', async () => {
    const rpc = rpcFor({ [t.identity]: recorded(t.identity), [t.reputation]: recorded(t.reputation), [V1]: verifierV1(), [V2]: verifierV2() });
    const c = new r.NearErc8004Client({ network: net, rpc });
    expect(await c.getVerifierConfig(V2)).toEqual(verifierV2());
    expect(rpc.mock.calls.at(-1)![1].account_id).toBe(V2);
    expect(await c.getVerifierConfig()).toEqual(verifierV1());
    expect(rpc.mock.calls.at(-1)![1].account_id).toBe(V1);
    expect((await c.getConfig(V2)).verifier.escrow).toBe('v2.arras-escrow.near');
    expect((await c.getConfig()).verifier.escrow).toBe('v1.arras-escrow.near');
  });
  it('refuses a verifier config that reads another escrow than the verifier it came from', async () => {
    const swapped = new r.NearErc8004Client({ network: net, rpc: rpcFor({ [V1]: verifierV2(), [V2]: verifierV1() }) });
    await expect(swapped.getVerifierConfig(V2)).rejects.toThrow('Config contract binding mismatch');
    await expect(swapped.getVerifierConfig()).rejects.toThrow('Config contract binding mismatch');
    await expect(swapped.getVerifierConfig(V1)).rejects.toThrow('Config contract binding mismatch');
  });
  it('quotes verify_feedback_proof against the verifier of the config: receiver and gas floor follow it', () => {
    const v2 = r.buildNearErc8004VerifyFeedbackProof({ ...options(config(verifierV2())), client: 'payer.near', proof: 'p' });
    expect(v2.receiverId).toBe(V2);
    expect(v2.actions[0].params.gas).toBe('30000000000000');
    expect(() => r.buildNearErc8004VerifyFeedbackProof({ ...options(config(verifierV2())), client: 'payer.near', proof: 'p', gas: '26000000000000' }))
      .toThrow('gas outside permitted range');
    expect(r.buildNearErc8004VerifyFeedbackProof({ ...options(), client: 'payer.near', proof: 'p' }).receiverId).toBe(V1);
    expect(r.buildNearErc8004VerifyFeedbackProof({ ...options(), client: 'payer.near', proof: 'p', gas: '26000000000000' }).receiverId).toBe(V1);
  });
  it('signs a v2 verify_feedback_proof only toward the v2 verifier', async () => {
    const { createNearLocalSigner } = await import('./escrow');
    const signer = createNearLocalSigner(new Uint8Array(32).fill(1));
    const c = config(verifierV2());
    const descriptor = r.buildNearErc8004VerifyFeedbackProof({ ...options(c), client: 'payer.near', proof: 'p' });
    const sign = { network: net, config: c, nonce: '1', blockHash: '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR', nowNs };
    expect(typeof await r.signNearErc8004Transaction(descriptor, signer, sign)).toBe('string');
    await expect(r.signNearErc8004Transaction({ ...descriptor, receiverId: V1 }, signer, sign)).rejects.toThrow('Descriptor receiver/network mismatch');
  });
  it('a config that reads an escrow with no verifier, or an unregistered escrow, is refused', () => {
    // 'constructor' is a valid NEAR account and a property every object inherits: only own rows count.
    for (const escrow of ['arras-v1b-1101.testnet', 'v3.arras-escrow.near', 'evil-sink.near', 'constructor']) {
      expect(() => r.buildNearErc8004Register(options(config({ ...verifierV1(), escrow })))).toThrow('Config contract binding mismatch');
    }
  });
  it('fails closed when the v2 verifier does not answer: no config, so no quote to sign', async () => {
    const down = new r.NearErc8004Client({ network: net, rpc: rpcFor({ [t.identity]: recorded(t.identity), [t.reputation]: recorded(t.reputation), [V1]: verifierV1() }) });
    await expect(down.getVerifierConfig(V2)).rejects.toThrow(`account ${V2} does not exist`);
    await expect(down.getConfig(V2)).rejects.toThrow(`account ${V2} does not exist`);
    expect((await down.getConfig()).verifier.escrow).toBe('v1.arras-escrow.near');
    const silent = new r.NearErc8004Client({ network: net, timeoutMs: 20, rpc: () => new Promise(() => {}) });
    await expect(silent.getVerifierConfig(V2)).rejects.toThrow('NEAR RPC timeout');
  });
  it('views and outcomes accept the v2 verifier', async () => {
    const summary = { count: '1', summary_value: '90', summary_value_decimals: 0, weight_sum: '1' };
    const rpc = vi.fn(async () => bytes(summary));
    const c = new r.NearErc8004Client({ network: net, rpc });
    expect(await c.getVerifiedSummary({ agent_id: '0', verifier: V2 })).toEqual(summary);
    expect((rpc.mock.calls[0] as any[])[1].account_id).toBe(t.reputation);
    await expect(c.getVerifiedSummary({ agent_id: '0', verifier: 'other.near' })).rejects.toThrow('Verifier is not registered for network');
  });
});
