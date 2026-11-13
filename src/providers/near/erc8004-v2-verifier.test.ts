import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as r from './erc8004';
import { createNearLocalSigner } from './escrow';
import fixture from './vectors/near-erc8004.json';

/*
 * Arras v2 rates through payment-proof.arras-escrow.near: the real row of NEAR_ERC8004_ESCROW_VERIFIERS, no mock.
 * MEASURED_V2_CONFIG is the get_config c0der read from that account on mainnet on 2026-11-13, once it was keyless
 * (code sha256 ea430d5fbb3bbe3b59adf5c2cd7010e00f295e6be5a37eee935c560c5431e5a0, the reproducible wasm of arras
 * 40eba87). V2_PAYMENT and V2_PROOF are the released v2 payment of its smoke test and what verify_feedback_proof
 * answered for it (transaction ixnTdSzCYR7DCT7RwzPTaHQ7J6uVcQsCa9RbcNykbCt). None of them is in
 * vectors/near-erc8004.json: that fixture is recorded by scripts/record-near-erc8004-vectors.mjs and is the same bytes
 * as the Python SDK's.
 */
const net = 'near:mainnet' as const;
const t = r.NEAR_ERC8004_CONTRACTS[net];
const V1 = 'erc8004-verifier.arras-escrow.near', V2 = 'payment-proof.arras-escrow.near';
const E1 = 'v1.arras-escrow.near', E2 = 'v2.arras-escrow.near';
const CROSSED = "Verifier is not the one of the payment's escrow";
const UNREGISTERED_ESCROW = 'escrow is not a registered Arras contract for this network';
const MEASURED_V2_CONFIG = Object.freeze({
  contract: 'erc8004-arras-verifier', escrow: E2, min_gas_verify: '25000000000000',
  gas_get_payment: '10000000000000', gas_on_payment: '10000000000000',
});
const V2_PAYMENT = '9nySy6vTK95bgPUm5MkdsZtzC9XaGrSCV1EjNnRR6uyC';
const V2_PROOF = { counterparty: 'worker-v2.arras-escrow.near', role: 'receiver', context: 'em', weight: '50000' };
const nowNs = '1793829600000000000';
const blockHash = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const mainnet = fixture.networks.find(n => n.network === net)!;
const recorded = (contract: string): any =>
  structuredClone(mainnet.calls.find(c => c.contract === contract && c.method === 'get_config')!.result);
const config = (verifier: unknown = recorded(V1)): r.NearErc8004Config => ({
  network: net, identity: recorded(t.identity), reputation: recorded(t.reputation), verifier: structuredClone(verifier) as r.NearErc8004VerifierConfig,
});
const options = (c = config()) => ({ network: net, signerId: 'payer.near', config: c, nowNs });
const feedback = { agent_id: '0', value: '90', value_decimals: 0 };
const bytes = (value: unknown) => ({ result: [...Buffer.from(JSON.stringify(value))] });
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const answers = (): Record<string, unknown> => ({
  [t.identity]: recorded(t.identity), [t.reputation]: recorded(t.reputation), [V1]: recorded(V1), [V2]: { ...MEASURED_V2_CONFIG },
});
/** RPC double: the get_config of each account it knows; any other account does not exist. */
function rpcFor(byAccount: Record<string, unknown>) {
  return vi.fn(async (_m: string, p: any) => {
    if (!Object.hasOwn(byAccount, p.account_id)) throw new Error(`account ${p.account_id} does not exist while viewing`);
    return bytes(byAccount[p.account_id]);
  });
}
/** A local key whose sign() is a spy: what must not be reached, is not. */
function spySigner() {
  const local = createNearLocalSigner(new Uint8Array(32).fill(1));
  return { publicKey: local.publicKey, sign: vi.fn((digest: Uint8Array) => local.sign(digest)) };
}
/**
 * The recorded mainnet rating (v1) as v2 writes it: the verifier and payment of the call, the receipts of the v2
 * verifier and escrow, and the proof of its new_feedback event (naming `eventVerifier`).
 */
function v2Rating(eventVerifier = V2): any {
  const outcome: any = structuredClone(mainnet.transactions.find(tx => tx.method === 'give_feedback_with_proof')!.result);
  const call = outcome.transaction.actions[0].FunctionCall;
  call.args = b64({ ...JSON.parse(Buffer.from(call.args, 'base64').toString()), verifier: V2, proof: V2_PAYMENT });
  for (const rec of outcome.receipts_outcome) {
    rec.outcome.executor_id = rec.outcome.executor_id === V1 ? V2 : rec.outcome.executor_id === E1 ? E2 : rec.outcome.executor_id;
    rec.outcome.logs = rec.outcome.logs.map((log: string) => {
      if (!log.startsWith('EVENT_JSON:')) return log;
      const event = JSON.parse(log.slice(11));
      if (event.event === 'new_feedback') event.data[0].proof = { verifier: eventVerifier, proof: V2_PAYMENT, ...V2_PROOF };
      return 'EVENT_JSON:' + JSON.stringify(event);
    });
  }
  return outcome;
}
const panicked = (message: string) => ({ Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${message}` } } } } });
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden'); })));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Arras v2 rates through payment-proof.arras-escrow.near (2.116.0)', () => {
  it('maps each mainnet escrow to its own verifier; testnet and NEAR_ERC8004_CONTRACTS are unchanged', () => {
    expect(r.NEAR_ERC8004_ESCROW_VERIFIERS).toEqual({
      'near:mainnet': { [E1]: V1, [E2]: V2 },
      'near:testnet': { 'arras-v1b-1101.testnet': 'erc8004-verifier.arras-dev.testnet' },
    });
    expect(r.nearErc8004Verifier(net, E1)).toBe(V1);
    expect(r.nearErc8004Verifier(net, E2)).toBe(V2);
    for (const notAnEscrow of [V1, V2, 'V2.ARRAS-ESCROW.NEAR', ' v2.arras-escrow.near', 'v2.arras-escrow.near ', 'v2.arras-escrow.testnet']) {
      expect(() => r.nearErc8004Verifier(net, notAnEscrow)).toThrow(UNREGISTERED_ESCROW);
    }
    expect(() => r.nearErc8004Verifier('near:testnet', E2)).toThrow(UNREGISTERED_ESCROW);
    // Whoever reads the single verifier of the network keeps reading v1's.
    expect([t.verifier, t.escrow]).toEqual([V1, E1]);
  });

  it('accepts the measured get_config of payment-proof, bound to v2, and refuses it with any other escrow', async () => {
    const rpc = rpcFor(answers());
    const c = new r.NearErc8004Client({ network: net, rpc });
    expect(await c.getVerifierConfig(V2)).toEqual(MEASURED_V2_CONFIG);
    expect(rpc.mock.calls.at(-1)![1].account_id).toBe(V2);
    const quoted = await c.getConfig(r.nearErc8004Verifier(net, E2));
    expect(quoted.verifier).toEqual(MEASURED_V2_CONFIG);
    expect(rpc.mock.calls.slice(-3).map(([, p]) => p.account_id)).toEqual([t.identity, t.reputation, V2]);
    for (const escrow of [E1, 'v3.arras-escrow.near', 'arras-v1b-1101.testnet', 'evil-sink.near', 'constructor']) {
      const lying = new r.NearErc8004Client({ network: net, rpc: rpcFor({ ...answers(), [V2]: { ...MEASURED_V2_CONFIG, escrow } }) });
      await expect(lying.getVerifierConfig(V2)).rejects.toThrow('Config contract binding mismatch');
      await expect(lying.getConfig(V2)).rejects.toThrow('Config contract binding mismatch');
    }
    for (const patch of [{ escrow: 'V2.ARRAS-ESCROW.NEAR' }, { contract: 'erc8004-payment-proof' }, { min_gas_verify: '24999999999999' }]) {
      const lying = new r.NearErc8004Client({ network: net, rpc: rpcFor({ ...answers(), [V2]: { ...MEASURED_V2_CONFIG, ...patch } }) });
      await expect(lying.getVerifierConfig(V2)).rejects.toThrow();
    }
  });

  it('trusts a verifier by its account, never by its get_config', async () => {
    // v1's account answering v2's config, and a lookalike account answering it word for word.
    const swapped = new r.NearErc8004Client({ network: net, rpc: rpcFor({ [V1]: { ...MEASURED_V2_CONFIG } }) });
    await expect(swapped.getVerifierConfig()).rejects.toThrow('Config contract binding mismatch');
    await expect(swapped.getVerifierConfig(V1)).rejects.toThrow('Config contract binding mismatch');
    const rpc = rpcFor({ 'payment-proof2.arras-escrow.near': { ...MEASURED_V2_CONFIG } });
    const lookalike = new r.NearErc8004Client({ network: net, rpc });
    await expect(lookalike.getVerifierConfig('payment-proof2.arras-escrow.near')).rejects.toThrow('Verifier is not registered for network');
    await expect(lookalike.getConfig('payment-proof2.arras-escrow.near')).rejects.toThrow('Verifier is not registered for network');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('give_feedback_with_proof: each escrow through its own verifier; the crossed pair is refused before signing', () => {
    for (const c of [config(), config(MEASURED_V2_CONFIG)]) {
      for (const [escrow, verifier] of [[E1, V1], [E2, V2]]) {
        const tx = r.buildNearErc8004GiveFeedbackWithProof({ ...options(c), ...feedback, escrow, verifier, proof: V2_PAYMENT });
        expect(tx.receiverId).toBe(t.reputation);
        expect(tx.actions[0].params.args).toEqual({ ...feedback, verifier, proof: V2_PAYMENT });
        // escrow is not an argument of the call: the descriptor is the one built without it.
        expect(tx).toEqual(r.buildNearErc8004GiveFeedbackWithProof({ ...options(c), ...feedback, verifier, proof: V2_PAYMENT }));
      }
      for (const [escrow, verifier] of [[E1, V2], [E2, V1]]) {
        expect(() => r.buildNearErc8004GiveFeedbackWithProof({ ...options(c), ...feedback, escrow, verifier, proof: V2_PAYMENT })).toThrow(CROSSED);
        expect(() => r.buildNearErc8004Transaction('give_feedback_with_proof', { ...options(c), escrow }, { ...feedback, verifier, proof: V2_PAYMENT }))
          .toThrow(CROSSED);
      }
    }
  });

  it("verify_feedback_proof: the quoted config must read the payment's escrow", () => {
    const v2 = config(MEASURED_V2_CONFIG);
    const toV2 = r.buildNearErc8004VerifyFeedbackProof({ ...options(v2), escrow: E2, client: 'payer.near', proof: V2_PAYMENT });
    expect(toV2.receiverId).toBe(V2);
    expect(toV2.actions[0].params).toEqual({ methodName: 'verify_feedback_proof', args: { client: 'payer.near', proof: V2_PAYMENT }, gas: '30000000000000', deposit: '0' });
    expect(toV2).toEqual(r.buildNearErc8004VerifyFeedbackProof({ ...options(v2), client: 'payer.near', proof: V2_PAYMENT }));
    expect(r.buildNearErc8004VerifyFeedbackProof({ ...options(), escrow: E1, client: 'payer.near', proof: 'p' }).receiverId).toBe(V1);
    expect(() => r.buildNearErc8004VerifyFeedbackProof({ ...options(v2), escrow: E1, client: 'payer.near', proof: 'p' })).toThrow(CROSSED);
    expect(() => r.buildNearErc8004VerifyFeedbackProof({ ...options(), escrow: E2, client: 'payer.near', proof: V2_PAYMENT })).toThrow(CROSSED);
  });

  it('signing checks the escrow again, before the signer is reached', async () => {
    const signer = spySigner();
    const sign = (c: r.NearErc8004Config, escrow?: string) => ({ network: net, config: c, nonce: '1', blockHash, nowNs, escrow });
    const rating = r.buildNearErc8004GiveFeedbackWithProof({ ...options(), ...feedback, verifier: V2, proof: V2_PAYMENT });
    expect(typeof await r.signNearErc8004Transaction(rating, signer, sign(config(), E2))).toBe('string');
    expect(typeof await r.signNearErc8004Transaction(rating, signer, sign(config()))).toBe('string');
    expect(signer.sign).toHaveBeenCalledTimes(2);
    signer.sign.mockClear();
    await expect(r.signNearErc8004Transaction(rating, signer, sign(config(), E1))).rejects.toThrow(CROSSED);
    const crossed = r.buildNearErc8004GiveFeedbackWithProof({ ...options(), ...feedback, verifier: V1, proof: V2_PAYMENT });
    await expect(r.signNearErc8004Transaction(crossed, signer, sign(config(), E2))).rejects.toThrow(CROSSED);
    const v2 = config(MEASURED_V2_CONFIG);
    const precheck = r.buildNearErc8004VerifyFeedbackProof({ ...options(v2), client: 'payer.near', proof: V2_PAYMENT });
    await expect(r.signNearErc8004Transaction(precheck, signer, sign(v2, E1))).rejects.toThrow(CROSSED);
    expect(signer.sign).not.toHaveBeenCalled();
    expect(typeof await r.signNearErc8004Transaction(precheck, signer, sign(v2, E2))).toBe('string');
  });

  it('refuses escrow on any other call, and an escrow that has no verifier on this network', () => {
    expect(() => r.buildNearErc8004GiveFeedback({ ...options(), ...feedback, escrow: E2 })).toThrow('escrow applies only to payment-proof calls');
    expect(() => r.buildNearErc8004Register({ ...options(), escrow: E1 })).toThrow('escrow applies only to payment-proof calls');
    expect(() => r.buildNearErc8004Transaction('revoke_feedback', { ...options(), escrow: E1 }, { agent_id: '0', feedback_index: '1' }))
      .toThrow('escrow applies only to payment-proof calls');
    for (const escrow of ['arras-v1b-1101.testnet', 'v3.arras-escrow.near', V2, '', 'V2.ARRAS-ESCROW.NEAR', ' v2.arras-escrow.near', 'constructor', '__proto__', null, 2]) {
      expect(() => r.buildNearErc8004GiveFeedbackWithProof({ ...options(), ...feedback, escrow, verifier: V2, proof: V2_PAYMENT } as any))
        .toThrow(UNREGISTERED_ESCROW);
      expect(() => r.buildNearErc8004VerifyFeedbackProof({ ...options(config(MEASURED_V2_CONFIG)), escrow, client: 'payer.near', proof: V2_PAYMENT } as any))
        .toThrow(UNREGISTERED_ESCROW);
    }
    // undefined is the option left out.
    expect(r.buildNearErc8004GiveFeedbackWithProof({ ...options(), ...feedback, escrow: undefined, verifier: V2, proof: V2_PAYMENT })
      .actions[0].params.args.verifier).toBe(V2);
  });

  it('the generic builder reads escrow from a prototype or an accessor, as the wrappers and the signer do', () => {
    class Options {
      network = net; signerId = 'payer.near'; config = config(); nowNs = nowNs;
      get escrow() { return E1; }
    }
    const inherited = Object.assign(Object.create({ escrow: E1 }), options());
    for (const o of [new Options(), inherited]) {
      expect(() => r.buildNearErc8004Transaction('give_feedback_with_proof', o, { ...feedback, verifier: V2, proof: V2_PAYMENT })).toThrow(CROSSED);
      expect(r.buildNearErc8004Transaction('give_feedback_with_proof', o, { ...feedback, verifier: V1, proof: V2_PAYMENT }).receiverId).toBe(t.reputation);
    }
  });

  it('E16 (expired dispute paid to the receiver): a rejected proof, never an unknown failure', () => {
    const panic = 'ERC8004_ARV_E16: el receiver cobro por una disputa vencida, sin capturer ni arbitro: no es prueba';
    // Through give_feedback_with_proof the registry logs its E45 rejection and returns the deposit; the verifier's
    // receipt keeps the E16 panic. The SDK reads it as every failed proof (VerifierFailed): it does not tell the
    // verifier's codes apart there, so this pins the classification, not E16 against another code.
    const rejected = v2Rating();
    rejected.status = { SuccessValue: b64(null) };
    rejected.receipts_outcome = [
      { outcome: { executor_id: V2, status: panicked(panic), logs: [] } },
      { outcome: { executor_id: t.reputation, status: { SuccessValue: b64(null) }, logs: ['erc8004:rechazo:E45_VERIFICADOR_FALLO'] } },
    ];
    expect(r.parseNearErc8004GiveFeedbackOutcome(rejected, net)).toEqual({ status: 'rejected', code: r.NearErc8004RejectionCode.VerifierFailed });
    // A transaction failure that carries a verifier code is read with that code (null would be an unknown failure).
    // The registry catches the verifier's failure, so a real rating does not fail this way; the shape pins the regex.
    const failed = v2Rating();
    failed.status = panicked(panic);
    expect(r.parseNearErc8004GiveFeedbackOutcome(failed, net)).toEqual({ status: 'failed', code: 'ERC8004_ARV_E16', message: JSON.stringify(failed.status.Failure) });
    for (const code of ['E01', 'E02', 'E03', 'E10', 'E11', 'E12', 'E13', 'E14', 'E15', 'E16']) {
      failed.status = panicked(`ERC8004_ARV_${code}: x`);
      expect(r.parseNearErc8004GiveFeedbackOutcome(failed, net)).toMatchObject({ status: 'failed', code: `ERC8004_ARV_${code}` });
    }
  });

  it('reads a v2 rating: the accepted outcome and its new_feedback, with payment-proof as the verifier', () => {
    const outcome = v2Rating();
    expect(r.parseNearErc8004GiveFeedbackOutcome(outcome, net)).toEqual({ status: 'accepted', feedbackIndex: '1' });
    const event: any = r.parseNearErc8004Events(outcome, net).find(e => e.event === 'new_feedback');
    expect(event.data[0].proof).toEqual({ verifier: V2, proof: V2_PAYMENT, ...V2_PROOF });
    // An event whose proof names the other verifier is not this call's rating.
    expect(() => r.parseNearErc8004GiveFeedbackOutcome(v2Rating(V1), net)).toThrow('Feedback result/event mismatch');
  });

  it('reads verified summaries, lists and proof keys with either verifier, from the reputation registry', async () => {
    const summary = { count: '1', summary_value: '90', summary_value_decimals: 0, weight_sum: '50000' };
    const rpc = vi.fn(async (_m: string, p: any) => bytes(p.method_name === 'get_verified_summary' ? summary
      : p.method_name === 'list_verified_feedback' ? [] : p.method_name === 'is_proof_pending' ? false : null));
    const c = new r.NearErc8004Client({ network: net, rpc });
    for (const verifier of [V1, V2]) {
      expect(await c.getVerifiedSummary({ agent_id: '0', verifier, context: 'em' })).toEqual(summary);
      expect(await c.listVerifiedFeedback({ agent_id: '0', verifier })).toEqual([]);
      expect(await c.view('get_proof_feedback', { verifier, proof: V2_PAYMENT, client_address: 'payer.near' })).toBeNull();
      expect(await c.view('is_proof_pending', { verifier, proof: V2_PAYMENT, client_address: 'payer.near' })).toBe(false);
    }
    expect(rpc.mock.calls.every(([, p]) => p.account_id === t.reputation)).toBe(true);
    expect(JSON.parse(Buffer.from(rpc.mock.calls[4][1].args_base64, 'base64').toString()).verifier).toBe(V2);
  });
});
