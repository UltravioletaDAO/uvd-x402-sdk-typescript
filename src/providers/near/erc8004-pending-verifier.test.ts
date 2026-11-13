import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as r from './erc8004';
import fixture from './vectors/near-erc8004.json';

/*
 * An escrow whose verifier is not registered yet (a null row): v2 up to 2.115.0, and any escrow added later until its
 * verifier is deployed. The same SDK code with the table of this file, so the fail-closed path stays tested now that
 * every real row has a verifier.
 */
vi.mock('./erc8004-verifiers', () => ({
  NEAR_ERC8004_ESCROW_VERIFIERS: Object.freeze({
    'near:mainnet': Object.freeze({ 'v1.arras-escrow.near': 'erc8004-verifier.arras-escrow.near', 'v2.arras-escrow.near': null }),
    'near:testnet': Object.freeze({ 'arras-v1b-1101.testnet': 'erc8004-verifier.arras-dev.testnet' }),
  }),
}));

const net = 'near:mainnet' as const;
const t = r.NEAR_ERC8004_CONTRACTS[net];
const V1 = 'erc8004-verifier.arras-escrow.near', V2 = 'payment-proof.arras-escrow.near';
const E1 = 'v1.arras-escrow.near', E2 = 'v2.arras-escrow.near';
const NO_VERIFIER = 'No ERC-8004 verifier is registered for this Arras escrow yet';
const mainnet = fixture.networks.find(n => n.network === net)!;
const recorded = (contract: string): any =>
  structuredClone(mainnet.calls.find(c => c.contract === contract && c.method === 'get_config')!.result);
const config = (verifier: unknown = recorded(V1)): r.NearErc8004Config => ({
  network: net, identity: recorded(t.identity), reputation: recorded(t.reputation), verifier: structuredClone(verifier) as r.NearErc8004VerifierConfig,
});
const options = (c = config()) => ({ network: net, signerId: 'payer.near', config: c, nowNs: '1793829600000000000' });
const feedback = { agent_id: '0', value: '90', value_decimals: 0 };
const bytes = (value: unknown) => ({ result: [...Buffer.from(JSON.stringify(value))] });
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden'); })));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('an escrow with no registered verifier fails closed', () => {
  it('hands out no verifier for its payments', () => {
    expect(() => r.nearErc8004Verifier(net, E2)).toThrow(NO_VERIFIER);
    expect(r.nearErc8004Verifier(net, E1)).toBe(V1);
  });

  it('refuses it as the escrow of a rating or of a precheck, whatever the verifier', () => {
    expect(() => r.buildNearErc8004GiveFeedbackWithProof({ ...options(), ...feedback, escrow: E2, verifier: V1, proof: 'p' })).toThrow(NO_VERIFIER);
    expect(() => r.buildNearErc8004VerifyFeedbackProof({ ...options(), escrow: E2, client: 'payer.near', proof: 'p' })).toThrow(NO_VERIFIER);
    expect(r.buildNearErc8004GiveFeedbackWithProof({ ...options(), ...feedback, escrow: E1, verifier: V1, proof: 'p' }).receiverId).toBe(t.reputation);
  });

  it('refuses its would-be verifier in wallet calls, views, configs and outcomes', async () => {
    expect(() => r.buildNearErc8004GiveFeedbackWithProof({ ...options(), ...feedback, verifier: V2, proof: 'p' })).toThrow('Verifier is not registered for network');
    const rpc = vi.fn(async () => bytes({ count: '1', summary_value: '90', summary_value_decimals: 0, weight_sum: '1' }));
    const c = new r.NearErc8004Client({ network: net, rpc });
    await expect(c.getVerifiedSummary({ agent_id: '0', verifier: V2 })).rejects.toThrow('Verifier is not registered for network');
    await expect(c.listVerifiedFeedback({ agent_id: '0', verifier: V2 })).rejects.toThrow('Verifier is not registered for network');
    await expect(c.getVerifierConfig(V2)).rejects.toThrow('Verifier is not registered for network');
    await expect(c.getConfig(V2)).rejects.toThrow('Verifier is not registered for network');
    expect(rpc).not.toHaveBeenCalled();
    const outcome: any = structuredClone(mainnet.transactions.find(tx => tx.method === 'give_feedback_with_proof')!.result);
    const call = outcome.transaction.actions[0].FunctionCall;
    call.args = b64({ ...JSON.parse(Buffer.from(call.args, 'base64').toString()), verifier: V2 });
    expect(() => r.parseNearErc8004GiveFeedbackOutcome(outcome, net)).toThrow('Verifier is not registered for network');
  });

  it('refuses a verifier config that reads it: no quote, no verify_feedback_proof', async () => {
    const o = options(config({ ...recorded(V1), escrow: E2 }));
    expect(() => r.buildNearErc8004VerifyFeedbackProof({ ...o, client: 'payer.near', proof: 'p' })).toThrow('Config contract binding mismatch');
    expect(() => r.buildNearErc8004Register(o)).toThrow('Config contract binding mismatch');
    const c = new r.NearErc8004Client({ network: net, rpc: async () => bytes({ ...recorded(V1), escrow: E2 }) });
    await expect(c.getVerifierConfig()).rejects.toThrow('Config contract binding mismatch');
  });
});
