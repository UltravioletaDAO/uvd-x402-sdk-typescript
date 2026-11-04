/** NEAR ERC-8004 identity, reputation and Arras proof verifier. No transaction submission. */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { account, concat, le, str, uint, unbase58 } from './encoding';
import type { NearEscrowNetwork, NearLocalSigner, NearUnsigned } from './escrow';
import * as s from './erc8004-schema';

export type NearErc8004Network = NearEscrowNetwork;
export type NearErc8004Contract = 'identity' | 'reputation' | 'verifier';
export const NEAR_ERC8004_CONTRACTS = Object.freeze({
  'near:mainnet': Object.freeze({ identity: 'identity-registry.erc-8004.near', reputation: 'reputation-registry.erc-8004.near',
    verifier: 'erc8004-verifier.arras-escrow.near', escrow: 'v1.arras-escrow.near', agentRegistry: 'near:mainnet:identity-registry.erc-8004.near' }),
  'near:testnet': Object.freeze({ identity: 'identity-registry.erc-8004.testnet', reputation: 'reputation-registry.erc-8004.testnet',
    verifier: 'erc8004-verifier.arras-dev.testnet', escrow: 'arras-v1b-1101.testnet', agentRegistry: 'near:testnet:identity-registry.erc-8004.testnet' }),
});
const ceiling = (measured: bigint): string => ((measured * 105n + 99n) / 100n).toString();
/** Five percent above the recorded worst-case storage quotes; never a substitute for get_config. */
export const NEAR_ERC8004_DEPOSIT_CAPS = Object.freeze({
  register: ceiling(132790000000000000000000n), feedback: ceiling(5910000000000000000000n),
  feedbackProof: ceiling(14720000000000000000000n), storageByte: ceiling(10000000000000000000n),
  uri: ceiling(81920000000000000000000n), metadata: ceiling(12160000000000000000000n),
  approval: ceiling(2560000000000000000000n), response: ceiling(5120000000000000000000n),
});
const TGAS = 1000000000000n;
function targets(network: NearErc8004Network) {
  if (network !== 'near:mainnet' && network !== 'near:testnet') throw new Error('Unsupported NEAR ERC-8004 network');
  return NEAR_ERC8004_CONTRACTS[network];
}
export interface NearErc8004IdentityConfig {
  contract: 'erc8004-identity'; erc8004_version: '2.0.0'; events_standard: 'erc8004'; events_version: '1.0.0';
  total_agents: string; register_deposit: string; token_reserve_bytes: number; storage_byte_cost: string;
  min_gas_nft_transfer_call: string;
  limits: { max_agent_uri_len: number; max_metadata_key_len: number; max_metadata_value_len: number;
    max_register_metadata: number; max_approvals: number; max_memo_len: number; max_deadline_delay_ns: string; max_list_limit: number };
}
export interface NearErc8004ReputationConfig {
  contract: 'erc8004-reputation'; erc8004_version: '2.0.0'; events_standard: 'erc8004'; events_version: '1.0.0';
  identity_registry: string; feedback_deposit: string; min_gas_give_feedback: string; feedback_proof_deposit: string;
  min_gas_give_feedback_with_proof: string; max_endpoint_len: number; max_feedback_uri_len: number;
  max_response_uri_len: number; max_tag_len: number; max_list_limit: number;
}
export interface NearErc8004VerifierConfig {
  contract: 'erc8004-arras-verifier'; escrow: string; min_gas_verify: string; gas_get_payment: string; gas_on_payment: string;
}
export interface NearErc8004Config {
  network: NearErc8004Network; identity: NearErc8004IdentityConfig;
  reputation: NearErc8004ReputationConfig; verifier: NearErc8004VerifierConfig;
}
function boundedAmount(v: unknown, cap: string, name: string): void {
  s.check(v, s.u128, name);
  if (BigInt(v as string) < 1n || BigInt(v as string) > BigInt(cap)) throw new Error(`${name}: outside SDK safety ceiling`);
}
function configuredGas(v: unknown, min: bigint): void {
  s.check(v, s.u64, 'config gas');
  if (BigInt(v as string) < min || BigInt(v as string) > 300n * TGAS) throw new Error('Invalid config gas range');
}
function validateContractConfig(kind: NearErc8004Contract, value: unknown, net: NearErc8004Network): void {
  const t = targets(net);
  if (kind === 'identity') {
    s.check(value, s.identityConfigCheck, 'identity config'); const c = value as NearErc8004IdentityConfig;
    boundedAmount(c.register_deposit, NEAR_ERC8004_DEPOSIT_CAPS.register, 'register_deposit');
    boundedAmount(c.storage_byte_cost, NEAR_ERC8004_DEPOSIT_CAPS.storageByte, 'storage_byte_cost');
    configuredGas(c.min_gas_nft_transfer_call, 50n * TGAS);
  } else if (kind === 'reputation') {
    s.check(value, s.reputationConfigCheck, 'reputation config'); const c = value as NearErc8004ReputationConfig;
    if (c.identity_registry !== t.identity) throw new Error('Config contract binding mismatch');
    boundedAmount(c.feedback_deposit, NEAR_ERC8004_DEPOSIT_CAPS.feedback, 'feedback_deposit');
    boundedAmount(c.feedback_proof_deposit, NEAR_ERC8004_DEPOSIT_CAPS.feedbackProof, 'feedback_proof_deposit');
    configuredGas(c.min_gas_give_feedback, 40n * TGAS); configuredGas(c.min_gas_give_feedback_with_proof, 120n * TGAS);
  } else {
    s.check(value, s.verifierConfigCheck, 'verifier config'); const c = value as NearErc8004VerifierConfig;
    if (c.escrow !== t.escrow) throw new Error('Config contract binding mismatch');
    configuredGas(c.min_gas_verify, 25n * TGAS); configuredGas(c.gas_get_payment, 1n); configuredGas(c.gas_on_payment, 1n);
  }
}
function validateConfig(config: NearErc8004Config, net: NearErc8004Network): void {
  targets(net);
  if (!s.object(config) || config.network !== net) throw new Error('Config network mismatch');
  for (const kind of ['identity', 'reputation', 'verifier'] as const) validateContractConfig(kind, config[kind], net);
}
export interface NearErc8004Metadata { metadata_key: string; metadata_value: string }
export interface NearErc8004FeedbackArgs {
  agent_id: string; value: string; value_decimals: number; tag1?: string | null; tag2?: string | null;
  endpoint?: string | null; feedback_uri?: string | null; feedback_hash?: string | null;
}
export interface NearErc8004TransferArgs {
  receiver_id: string; token_id: string; approval_id?: number | null; memo?: string | null;
}
export interface NearErc8004MethodArgs {
  register: { agent_uri?: string | null; metadata?: NearErc8004Metadata[] | null };
  set_agent_uri: { agent_id: string; new_uri: string };
  set_metadata: { agent_id: string; metadata_key: string; metadata_value: string };
  set_agent_wallet: { agent_id: string; new_wallet: string; deadline: string };
  accept_agent_wallet: { agent_id: string };
  unset_agent_wallet: { agent_id: string };
  nft_transfer: NearErc8004TransferArgs;
  nft_transfer_call: NearErc8004TransferArgs & { msg: string };
  nft_approve: { token_id: string; account_id: string; msg?: string | null };
  nft_revoke: { token_id: string; account_id: string };
  nft_revoke_all: { token_id: string };
  give_feedback: NearErc8004FeedbackArgs;
  give_feedback_with_proof: NearErc8004FeedbackArgs & { verifier: string; proof: string };
  revoke_feedback: { agent_id: string; feedback_index: string };
  append_response: { agent_id: string; client_address: string; feedback_index: string; response_uri: string; response_hash?: string | null };
  verify_feedback_proof: { client: string; proof: string };
}
export type NearErc8004Method = keyof NearErc8004MethodArgs;
type Fields = Record<string, s.Check>;
const agent = { agent_id: s.u64 }, token = { token_id: s.u64 };
const feedbackRequired = { ...agent, value: s.valueCheck, value_decimals: s.decimals };
const feedbackOptional = { tag1: s.tag, tag2: s.tag, endpoint: s.uri(1024, true), feedback_uri: s.uri(4096, true), feedback_hash: s.hash };
const transfer = { receiver_id: s.accountCheck, ...token };
const transferOptional = { approval_id: s.num(Number.MAX_SAFE_INTEGER), memo: s.boundedText(256) };
const methods: Record<NearErc8004Method, { target: NearErc8004Contract; required: Fields; optional?: Fields }> = {
  register: { target: 'identity', required: {}, optional: { agent_uri: s.uri(8192, true), metadata: s.list(s.metadataEntry, 4) } },
  set_agent_uri: { target: 'identity', required: { ...agent, new_uri: s.uri(8192, true) } },
  set_metadata: { target: 'identity', required: { ...agent, metadata_key: v => s.key(v) && v !== 'agentWallet', metadata_value: s.base64Check(1024) } },
  set_agent_wallet: { target: 'identity', required: { ...agent, new_wallet: s.accountCheck, deadline: s.u64 } },
  accept_agent_wallet: { target: 'identity', required: agent }, unset_agent_wallet: { target: 'identity', required: agent },
  nft_transfer: { target: 'identity', required: transfer, optional: transferOptional },
  nft_transfer_call: { target: 'identity', required: { ...transfer, msg: s.boundedText(16384) }, optional: transferOptional },
  nft_approve: { target: 'identity', required: { ...token, account_id: s.accountCheck }, optional: { msg: s.boundedText(16384) } },
  nft_revoke: { target: 'identity', required: { ...token, account_id: s.accountCheck } },
  nft_revoke_all: { target: 'identity', required: token },
  give_feedback: { target: 'reputation', required: feedbackRequired, optional: feedbackOptional },
  give_feedback_with_proof: { target: 'reputation', required: { ...feedbackRequired, verifier: s.accountCheck, proof: s.proof }, optional: feedbackOptional },
  revoke_feedback: { target: 'reputation', required: { ...agent, feedback_index: s.positiveIndex } },
  append_response: { target: 'reputation', required: { ...s.refFields, response_uri: s.uri(4096) }, optional: { response_hash: s.hash } },
  verify_feedback_proof: { target: 'verifier', required: { client: s.accountCheck, proof: s.proof } },
};
function canonicalArgs(required: Fields, optional: Fields, input: unknown): Record<string, unknown> {
  if (!s.object(input) || Object.keys(input).some(k => !Object.hasOwn(required, k) && !Object.hasOwn(optional, k))) throw new Error('Unexpected ERC-8004 argument');
  const args: Record<string, unknown> = {};
  for (const [k, check] of Object.entries(required)) { s.check(input[k], check, k); args[k] = input[k]; }
  for (const [k, check] of Object.entries(optional)) if (input[k] != null) { s.check(input[k], check, k); args[k] = input[k]; }
  return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
}
export interface NearErc8004BuildOptions {
  network: NearErc8004Network; signerId: string; config: NearErc8004Config;
  deposit?: string; gas?: string;
  /** Clock in nanoseconds. Defaults to Date.now() * 1e6; rechecked when signing. */
  nowNs?: string;
}
export interface NearErc8004Transaction {
  signerId: string; receiverId: string;
  actions: [{ type: 'FunctionCall'; params: { methodName: NearErc8004Method; args: Record<string, unknown>; gas: string; deposit: string } }];
}
/** Explicit URI encoding helper; builders themselves preserve valid URI bytes and reject invalid input. */
export function normalizeNearErc8004Uri(uri: string): string {
  s.check(uri, s.text, 'URI');
  const encoded = encodeURI(uri).replace(/%25([0-9A-Fa-f]{2})/g, '%$1');
  s.check(encoded, s.uri(8192), 'URI'); return encoded;
}
export function buildNearErc8004Transaction<M extends NearErc8004Method>(method: M, options: NearErc8004BuildOptions,
  input: NearErc8004MethodArgs[M]): NearErc8004Transaction {
  const o = { ...options }, t = targets(o.network);
  validateConfig(o.config, o.network); account(o.signerId, 'signerId');
  if (!Object.hasOwn(methods, method)) throw new Error('Unknown ERC-8004 method');
  const spec = methods[method];
  const args = canonicalArgs(spec.required, spec.optional ?? {}, input);
  if (method === 'set_agent_wallet') {
    const now = o.nowNs === undefined ? (BigInt(Date.now()) * 1000000n).toString() : o.nowNs; s.check(now, s.u64, 'nowNs');
    const deadline = BigInt(args.deadline as string);
    if (deadline < BigInt(now) || deadline > BigInt(now) + BigInt(o.config.identity.limits.max_deadline_delay_ns)) throw new Error('deadline outside five-minute window');
  }
  if (method === 'give_feedback_with_proof') {
    // This release supports the measured Arras verifier for each network.
    if (args.verifier !== t.verifier) throw new Error('Verifier is not registered for network');
  }
  const c = o.config;
  let minimum = 1n, recommended = 1n, cap = 1n, minGas = 1n, gasDefault = 30n * TGAS;
  const byte = BigInt(c.identity.storage_byte_cost);
  if (method === 'register') {
    minimum = recommended = BigInt(c.identity.register_deposit); cap = BigInt(NEAR_ERC8004_DEPOSIT_CAPS.register);
  } else if (method === 'give_feedback' || method === 'give_feedback_with_proof') {
    const proof = method === 'give_feedback_with_proof';
    minimum = recommended = BigInt(proof ? c.reputation.feedback_proof_deposit : c.reputation.feedback_deposit);
    cap = BigInt(proof ? NEAR_ERC8004_DEPOSIT_CAPS.feedbackProof : NEAR_ERC8004_DEPOSIT_CAPS.feedback);
    minGas = BigInt(proof ? c.reputation.min_gas_give_feedback_with_proof : c.reputation.min_gas_give_feedback);
    gasDefault = (proof ? 150n : 60n) * TGAS;
  } else if (method === 'set_agent_uri') {
    recommended = 1n + byte * BigInt(s.byteLength(args.new_uri as string)); cap = BigInt(NEAR_ERC8004_DEPOSIT_CAPS.uri) + 1n;
  } else if (method === 'set_metadata') {
    recommended = 1n + byte * BigInt(128 + s.byteLength(args.metadata_key as string) + s.unbase64(args.metadata_value as string).length);
    cap = BigInt(NEAR_ERC8004_DEPOSIT_CAPS.metadata) + 1n;
  } else if (method === 'nft_approve') {
    recommended = 1n + byte * 256n; cap = BigInt(NEAR_ERC8004_DEPOSIT_CAPS.approval) + 1n;
  } else if (method === 'append_response') {
    recommended = 1n + byte * 512n; cap = BigInt(NEAR_ERC8004_DEPOSIT_CAPS.response) + 1n;
  } else if (method === 'verify_feedback_proof') {
    minimum = recommended = cap = 0n; minGas = BigInt(c.verifier.min_gas_verify);
  }
  if (method === 'nft_transfer_call') { minGas = BigInt(c.identity.min_gas_nft_transfer_call); gasDefault = 50n * TGAS; }
  if (gasDefault < minGas) gasDefault = minGas;
  const deposit = o.deposit === undefined ? recommended.toString() : o.deposit, gas = o.gas === undefined ? gasDefault.toString() : o.gas;
  s.check(deposit, s.u128, 'deposit'); s.check(gas, s.u64, 'gas');
  if (BigInt(deposit) < minimum || BigInt(deposit) > cap) throw new Error('deposit outside permitted range');
  if (BigInt(gas) < minGas || BigInt(gas) > 300n * TGAS) throw new Error('gas outside permitted range');
  return { signerId: o.signerId, receiverId: t[spec.target], actions: [{ type: 'FunctionCall', params: { methodName: method, args, gas, deposit } }] };
}
function builder<M extends NearErc8004Method>(method: M) {
  return (options: NearErc8004BuildOptions & NearErc8004MethodArgs[M]): NearErc8004Transaction => {
    const { network, signerId, config, deposit, gas, nowNs, ...args } = options;
    return buildNearErc8004Transaction(method, { network, signerId, config, deposit, gas, nowNs }, args as unknown as NearErc8004MethodArgs[M]);
  };
}
export const buildNearErc8004Register = builder('register');
export const buildNearErc8004SetAgentUri = builder('set_agent_uri');
export const buildNearErc8004SetMetadata = builder('set_metadata');
export const buildNearErc8004SetAgentWallet = builder('set_agent_wallet');
export const buildNearErc8004AcceptAgentWallet = builder('accept_agent_wallet');
export const buildNearErc8004UnsetAgentWallet = builder('unset_agent_wallet');
export const buildNearErc8004NftTransfer = builder('nft_transfer');
export const buildNearErc8004NftTransferCall = builder('nft_transfer_call');
export const buildNearErc8004NftApprove = builder('nft_approve');
export const buildNearErc8004NftRevoke = builder('nft_revoke');
export const buildNearErc8004NftRevokeAll = builder('nft_revoke_all');
export const buildNearErc8004GiveFeedback = builder('give_feedback');
export const buildNearErc8004GiveFeedbackWithProof = builder('give_feedback_with_proof');
export const buildNearErc8004RevokeFeedback = builder('revoke_feedback');
export const buildNearErc8004AppendResponse = builder('append_response');
/** Async cross-contract call: costs gas, attaches zero deposit; it is not a query view. */
export const buildNearErc8004VerifyFeedbackProof = builder('verify_feedback_proof');

/** FullAccess key, next nonce and recent block hash are caller responsibilities. Does not broadcast. */
export async function signNearErc8004Transaction(descriptor: NearErc8004Transaction, signer: NearLocalSigner,
  options: { network: NearErc8004Network; config: NearErc8004Config; nonce: NearUnsigned; blockHash: string; nowNs?: string }): Promise<string> {
  if (!s.object(descriptor) || !Array.isArray(descriptor.actions) || descriptor.actions.length !== 1) throw new Error('Expected one ERC-8004 action');
  const a = descriptor.actions[0];
  if (!s.object(a) || a.type !== 'FunctionCall' || !s.object(a.params)) throw new Error('Expected FunctionCall');
  const p = a.params;
  s.check(p.deposit, s.u128, 'descriptor deposit'); s.check(p.gas, s.u64, 'descriptor gas');
  const d = buildNearErc8004Transaction(p.methodName, { network: options.network, config: options.config,
    signerId: descriptor.signerId, deposit: p.deposit, gas: p.gas, nowNs: options.nowNs }, p.args as never);
  if (descriptor.receiverId !== d.receiverId) throw new Error('Descriptor receiver/network mismatch');
  const n = uint(options.nonce, 64, 'nonce'); if (n === 0n) throw new Error('nonce must be positive');
  const hash = unbase58(options.blockHash); if (hash.length !== 32) throw new Error('Expected 32-byte block hash');
  // All descriptor, network, config, clock, nonce and hash checks precede access to the signer.
  const pk = new Uint8Array(signer.publicKey); if (pk.length !== 32) throw new Error('Expected Ed25519 public key');
  const call = d.actions[0].params;
  const bytes = concat(str(d.signerId), Uint8Array.of(0), pk, le(n, 8), str(d.receiverId), hash, le(1n, 4),
    Uint8Array.of(2), str(call.methodName), str(JSON.stringify(call.args)), le(BigInt(call.gas), 8), le(BigInt(call.deposit), 16));
  const digest = sha256(bytes), signature = await signer.sign(digest.slice());
  if (!(signature instanceof Uint8Array) || signature.length !== 64 || !ed25519.verify(signature, digest, pk)) throw new Error('Invalid Ed25519 transaction signature');
  return s.base64(concat(bytes, Uint8Array.of(0), signature));
}

export interface NearErc8004Feedback { value: string; value_decimals: number; tag1: string; tag2: string; is_revoked: boolean }
export interface NearErc8004Proof { verifier: string; proof: string; counterparty: string; role: string; context: string; weight: string }
export interface NearErc8004FeedbackRef { agent_id: string; client_address: string; feedback_index: string }
export interface NearErc8004Summary { count: string; summary_value: string; summary_value_decimals: number }
export interface NearErc8004VerifiedSummary extends NearErc8004Summary { weight_sum: string }
export interface NearErc8004TokenMetadata {
  title: string | null; description: string | null; media: string | null; media_hash: string | null; copies: number | null;
  issued_at: string | null; expires_at: string | null; starts_at: string | null; updated_at: string | null;
  extra: string | null; reference: string | null; reference_hash: string | null;
}
export interface NearErc8004Token { token_id: string; owner_id: string; metadata: NearErc8004TokenMetadata; approved_account_ids: Record<string, number> }
export interface NearErc8004NftMetadata { spec: string; name: string; symbol: string; icon: string | null; base_uri: string | null; reference: string | null; reference_hash: string | null }
export interface NearErc8004AllFeedback {
  clients: string[]; feedback_indexes: string[]; values: string[]; value_decimals: number[];
  tag1s: string[]; tag2s: string[]; revoked_statuses: boolean[];
}
export interface NearErc8004Page { from_index?: number; limit?: number }
export interface NearErc8004NftPage { from_index?: string; limit?: number }
export interface NearErc8004Filters { client_addresses?: string[]; tag1?: string; tag2?: string }
export interface NearErc8004ProofKey { verifier: string; proof: string; client_address: string }
export interface NearErc8004ViewArgs {
  identity_config: Record<string, never>; reputation_config: Record<string, never>; verifier_config: Record<string, never>;
  identity_version: Record<string, never>; reputation_version: Record<string, never>;
  nft_token: { token_id: string }; nft_tokens: NearErc8004NftPage;
  nft_supply_for_owner: { account_id: string }; nft_tokens_for_owner: { account_id: string } & NearErc8004NftPage;
  nft_total_supply: Record<string, never>; nft_metadata: Record<string, never>;
  nft_is_approved: { token_id: string; approved_account_id: string; approval_id?: number };
  token_uri: { agent_id: string }; get_metadata: { agent_id: string; metadata_key: string };
  get_agent_wallet: { agent_id: string }; get_pending_agent_wallet: { agent_id: string };
  is_authorized_or_owner: { spender: string; agent_id: string }; check_agent: { agent_id: string; account_id: string };
  get_summary: { agent_id: string; client_addresses: string[]; tag1?: string; tag2?: string };
  read_feedback: NearErc8004FeedbackRef; read_feedback_proof: NearErc8004FeedbackRef;
  read_all_feedback: { agent_id: string; include_revoked?: boolean } & NearErc8004Filters;
  get_response_count: { agent_id: string; client_address?: string; feedback_index?: string; responders?: string[] };
  get_clients: { agent_id: string } & NearErc8004Page;
  get_last_index: { agent_id: string; client_address: string }; get_identity_registry: Record<string, never>;
  get_proof_feedback: NearErc8004ProofKey; is_proof_pending: NearErc8004ProofKey;
  list_verified_feedback: { agent_id: string; verifier: string } & NearErc8004Page;
  get_verified_summary: { agent_id: string; verifier: string; context?: string } & NearErc8004Filters;
}
export interface NearErc8004ViewResults {
  identity_config: NearErc8004IdentityConfig; reputation_config: NearErc8004ReputationConfig; verifier_config: NearErc8004VerifierConfig;
  identity_version: '2.0.0'; reputation_version: '2.0.0'; nft_token: NearErc8004Token | null;
  nft_tokens: NearErc8004Token[]; nft_supply_for_owner: string; nft_tokens_for_owner: NearErc8004Token[];
  nft_total_supply: string; nft_metadata: NearErc8004NftMetadata; nft_is_approved: boolean;
  token_uri: string | null; get_metadata: string | null; get_agent_wallet: string | null;
  get_pending_agent_wallet: { wallet: string; deadline: string } | null;
  is_authorized_or_owner: boolean; check_agent: { owner_id: string; agent_wallet: string | null; authorized: boolean } | null;
  get_summary: NearErc8004Summary; read_feedback: NearErc8004Feedback | null; read_feedback_proof: NearErc8004Proof | null;
  read_all_feedback: NearErc8004AllFeedback; get_response_count: string; get_clients: string[]; get_last_index: string;
  get_identity_registry: string; get_proof_feedback: NearErc8004FeedbackRef | null; is_proof_pending: boolean;
  list_verified_feedback: NearErc8004FeedbackRef[]; get_verified_summary: NearErc8004VerifiedSummary;
}
type ViewMethod = keyof NearErc8004ViewArgs;
interface ViewSpec { target: NearErc8004Contract; method?: string; required: Fields; optional?: Fields; result: s.Check; page?: boolean }
const pageFields = { from_index: s.num(Number.MAX_SAFE_INTEGER), limit: s.num(100) };
const nftPageFields = { from_index: s.u128, limit: s.num(100) };
const filterFields = { client_addresses: s.list(s.accountCheck), tag1: s.tag, tag2: s.tag };
const proofKeyFields = { verifier: s.accountCheck, proof: s.proof, client_address: s.accountCheck };
const views: Record<ViewMethod, ViewSpec> = {
  identity_config: { target: 'identity', method: 'get_config', required: {}, result: s.identityConfigCheck },
  reputation_config: { target: 'reputation', method: 'get_config', required: {}, result: s.reputationConfigCheck },
  verifier_config: { target: 'verifier', method: 'get_config', required: {}, result: s.verifierConfigCheck },
  identity_version: { target: 'identity', method: 'get_version', required: {}, result: s.exact('2.0.0') },
  reputation_version: { target: 'reputation', method: 'get_version', required: {}, result: s.exact('2.0.0') },
  nft_token: { target: 'identity', required: token, result: s.nullable(s.tokenCheck) },
  nft_tokens: { target: 'identity', required: {}, optional: nftPageFields, result: s.list(s.tokenCheck), page: true },
  nft_supply_for_owner: { target: 'identity', required: { account_id: s.accountCheck }, result: s.u128 },
  nft_tokens_for_owner: { target: 'identity', required: { account_id: s.accountCheck }, optional: nftPageFields, result: s.list(s.tokenCheck), page: true },
  nft_total_supply: { target: 'identity', required: {}, result: s.u128 },
  nft_metadata: { target: 'identity', required: {}, result: s.nftMetadataCheck },
  nft_is_approved: { target: 'identity', required: { ...token, approved_account_id: s.accountCheck }, optional: { approval_id: s.num(Number.MAX_SAFE_INTEGER) }, result: s.bool },
  token_uri: { target: 'identity', required: agent, result: s.nullable(s.uri(8192, true)) },
  get_metadata: { target: 'identity', required: { ...agent, metadata_key: s.key }, result: s.nullable(s.base64Check(1024)) },
  get_agent_wallet: { target: 'identity', required: agent, result: s.nullable(s.accountCheck) },
  get_pending_agent_wallet: { target: 'identity', required: agent, result: s.nullable(s.pendingWalletCheck) },
  is_authorized_or_owner: { target: 'identity', required: { spender: s.accountCheck, ...agent }, result: s.bool },
  check_agent: { target: 'identity', required: { ...agent, account_id: s.accountCheck }, result: s.nullable(s.agentCheck) },
  get_summary: { target: 'reputation', required: { ...agent, client_addresses: v => s.list(s.accountCheck)(v) && (v as unknown[]).length > 0 }, optional: { tag1: s.tag, tag2: s.tag }, result: s.summaryCheck },
  read_feedback: { target: 'reputation', required: { ...s.refFields, feedback_index: s.u64 }, result: s.nullable(s.feedbackCheck) },
  read_feedback_proof: { target: 'reputation', required: { ...s.refFields, feedback_index: s.u64 }, result: s.nullable(s.proofCheck) },
  read_all_feedback: { target: 'reputation', required: agent, optional: { ...filterFields, include_revoked: s.bool }, result: s.allFeedbackCheck },
  get_response_count: { target: 'reputation', required: agent, optional: { client_address: s.accountCheck, feedback_index: s.u64, responders: s.list(s.accountCheck) }, result: s.u64 },
  get_clients: { target: 'reputation', required: agent, optional: pageFields, result: s.list(s.accountCheck), page: true },
  get_last_index: { target: 'reputation', required: { ...agent, client_address: s.accountCheck }, result: s.u64 },
  get_identity_registry: { target: 'reputation', required: {}, result: s.accountCheck },
  get_proof_feedback: { target: 'reputation', required: proofKeyFields, result: s.nullable(s.refCheck) },
  is_proof_pending: { target: 'reputation', required: proofKeyFields, result: s.bool },
  list_verified_feedback: { target: 'reputation', required: { ...agent, verifier: s.accountCheck }, optional: pageFields, result: s.list(s.refCheck), page: true },
  get_verified_summary: { target: 'reputation', required: { ...agent, verifier: s.accountCheck }, optional: { ...filterFields, context: s.label }, result: s.verifiedSummaryCheck },
};
/** Return the JSON-RPC result, not the outer envelope. Honor signal when possible. */
export type NearErc8004Rpc = (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
export interface NearErc8004ClientOptions { network: NearErc8004Network; rpc?: NearErc8004Rpc; timeoutMs?: number }
const MAX_VIEW_BYTES = 1048576;
async function defaultRpc(network: NearErc8004Network, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const url = network === 'near:mainnet' ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.near.org';
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'near-erc8004', method, params }), signal });
  if (!response.ok || !response.body) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > 4 * MAX_VIEW_BYTES) throw new Error('RPC response exceeds byte limit');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concat(...chunks)));
  if (!s.object(data) || Object.hasOwn(data, 'error') || !Object.hasOwn(data, 'result')) throw new Error('Invalid NEAR RPC envelope');
  return data.result;
}
export class NearErc8004Client {
  readonly network: NearErc8004Network;
  private readonly rpc: NearErc8004Rpc;
  private readonly timeoutMs: number;
  constructor(options: NearErc8004ClientOptions) {
    targets(options.network); this.network = options.network;
    this.timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000) throw new Error('Invalid RPC timeout');
    this.rpc = options.rpc ?? ((method, params, signal) => defaultRpc(this.network, method, params, signal));
  }
  async view<M extends ViewMethod>(method: M, input: NearErc8004ViewArgs[M]): Promise<NearErc8004ViewResults[M]> {
    const t = targets(this.network);
    if (!Object.hasOwn(views, method)) throw new Error('Unknown ERC-8004 view');
    const spec = views[method], args = canonicalArgs(spec.required, spec.optional ?? {}, input);
    if (spec.page && args.limit === undefined) args.limit = 100;
    if (args.verifier !== undefined && args.verifier !== t.verifier) throw new Error('Verifier is not registered for network');
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('NEAR RPC timeout')); }, this.timeoutMs); });
    let response: unknown;
    try {
      response = await Promise.race([this.rpc('query', { request_type: 'call_function', finality: 'final', account_id: t[spec.target],
        method_name: spec.method ?? method, args_base64: s.base64(new TextEncoder().encode(JSON.stringify(args))) }, controller.signal), timeout]);
    } finally { clearTimeout(timer); }
    if (!s.object(response) || !Array.isArray(response.result) || response.result.length > MAX_VIEW_BYTES ||
      !response.result.every(v => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255)) throw new Error('Invalid call_function response');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(response.result)));
    s.check(value, spec.result, `${method} response`);
    if (spec.method === 'get_config') validateContractConfig(spec.target, value, this.network);
    if (method === 'get_identity_registry' && value !== t.identity) throw new Error('Identity registry binding mismatch');
    return value as NearErc8004ViewResults[M];
  }
  async getConfig(): Promise<NearErc8004Config> {
    const config = { network: this.network, identity: await this.view('identity_config', {}),
      reputation: await this.view('reputation_config', {}), verifier: await this.view('verifier_config', {}) };
    validateConfig(config, this.network); return config;
  }
  getIdentityConfig() { return this.view('identity_config', {}); }
  getReputationConfig() { return this.view('reputation_config', {}); }
  getVerifierConfig() { return this.view('verifier_config', {}); }
  getVersion(contract: 'identity' | 'reputation' = 'identity') { return this.view(contract === 'identity' ? 'identity_version' : 'reputation_version', {}); }
  getAgent(agent_id: string) { return this.view('nft_token', { token_id: agent_id }); }
  getAgentUri(agent_id: string) { return this.view('token_uri', { agent_id }); }
  getMetadata(agent_id: string, metadata_key: string) { return this.view('get_metadata', { agent_id, metadata_key }); }
  getAgentWallet(agent_id: string) { return this.view('get_agent_wallet', { agent_id }); }
  getPendingAgentWallet(agent_id: string) { return this.view('get_pending_agent_wallet', { agent_id }); }
  readFeedback(args: NearErc8004FeedbackRef) { return this.view('read_feedback', args); }
  readFeedbackProof(args: NearErc8004FeedbackRef) { return this.view('read_feedback_proof', args); }
  getSummary(args: NearErc8004ViewArgs['get_summary']) { return this.view('get_summary', args); }
  getVerifiedSummary(args: NearErc8004ViewArgs['get_verified_summary']) { return this.view('get_verified_summary', args); }
  listVerifiedFeedback(args: NearErc8004ViewArgs['list_verified_feedback']) { return this.view('list_verified_feedback', args); }
}

export enum NearErc8004RejectionCode {
  IdentityViewFailed = 'E20_VISTA_DE_IDENTIDAD_FALLO', InvalidIdentityResponse = 'E21_RESPUESTA_DE_IDENTIDAD_INVALIDA',
  AgentNotFound = 'E22_AGENTE_INEXISTENTE', SelfFeedback = 'E23_AUTO_CALIFICACION', ProofAlreadyUsed = 'E42_PRUEBA_YA_USADA',
  Replaced = 'E44_REEMPLAZADO', VerifierFailed = 'E45_VERIFICADOR_FALLO', InvalidVerifierResponse = 'E46_RESPUESTA_DEL_VERIFICADOR_INVALIDA',
  CounterpartyMismatch = 'E47_NO_ES_EL_AGENTE', AgentWalletFeedback = 'E48_AGENT_WALLET_CALIFICA',
}
export interface NearErc8004EventData {
  registered: { agent_id: string; agent_uri: string; owner: string };
  metadata_set: { agent_id: string; metadata_key: string; metadata_value: string };
  uri_updated: { agent_id: string; new_uri: string; updated_by: string };
  agent_wallet_pending: { agent_id: string; wallet: string | null; deadline: string };
  nft_mint: { owner_id: string; token_ids: string[]; memo?: string | null };
  nft_transfer: { old_owner_id: string; new_owner_id: string; token_ids: string[]; authorized_id?: string | null; memo?: string | null };
  new_feedback: NearErc8004FeedbackRef & Omit<NearErc8004Feedback, 'is_revoked'> & { endpoint: string; feedback_uri: string; feedback_hash: string | null; proof: NearErc8004Proof | null };
  feedback_revoked: NearErc8004FeedbackRef;
  response_appended: NearErc8004FeedbackRef & { responder: string; response_uri: string; response_hash: string | null };
}
export type NearErc8004Event = { [K in keyof NearErc8004EventData]: {
  standard: K extends 'nft_mint' | 'nft_transfer' ? 'nep171' : 'erc8004'; version: '1.0.0'; event: K; data: [NearErc8004EventData[K]];
} }[keyof NearErc8004EventData];
const eventSpecs: Record<keyof NearErc8004EventData, { target: 'identity' | 'reputation'; standard: string; check: s.Check }> = {
  registered: { target: 'identity', standard: 'erc8004', check: s.shape({ ...agent, agent_uri: s.uri(8192, true), owner: s.accountCheck }) },
  metadata_set: { target: 'identity', standard: 'erc8004', check: s.shape({ ...agent, metadata_key: s.key, metadata_value: s.base64Check(1024) }) },
  uri_updated: { target: 'identity', standard: 'erc8004', check: s.shape({ ...agent, new_uri: s.uri(8192, true), updated_by: s.accountCheck }) },
  agent_wallet_pending: { target: 'identity', standard: 'erc8004', check: v => s.shape({ ...agent, wallet: s.nullable(s.accountCheck), deadline: s.u64 })(v) &&
    s.object(v) && (v.wallet !== null || v.deadline === '0') },
  nft_mint: { target: 'identity', standard: 'nep171', check: s.shape({ owner_id: s.accountCheck, token_ids: v => s.list(s.u64, 1)(v) && (v as unknown[]).length === 1 }, { memo: s.nullable(s.boundedText(256)) }) },
  nft_transfer: { target: 'identity', standard: 'nep171', check: s.shape({ old_owner_id: s.accountCheck, new_owner_id: s.accountCheck,
    token_ids: v => s.list(s.u64, 1)(v) && (v as unknown[]).length === 1 }, { authorized_id: s.nullable(s.accountCheck), memo: s.nullable(s.boundedText(256)) }) },
  new_feedback: { target: 'reputation', standard: 'erc8004', check: s.shape({ ...s.refFields, ...s.feedbackFields, endpoint: s.uri(1024, true),
    feedback_uri: s.uri(4096, true), feedback_hash: s.nullable(s.hash), proof: s.nullable(s.proofCheck) }) },
  feedback_revoked: { target: 'reputation', standard: 'erc8004', check: s.refCheck },
  response_appended: { target: 'reputation', standard: 'erc8004', check: s.shape({ ...s.refFields, responder: s.accountCheck, response_uri: s.uri(4096), response_hash: s.nullable(s.hash) }) },
};
function successful(status: unknown): boolean {
  return s.object(status) && Object.keys(status).length === 1 &&
    (typeof status.SuccessValue === 'string' || typeof status.SuccessReceiptId === 'string');
}
function receiptOutcomes(receipts: unknown, network: NearErc8004Network, target?: NearErc8004Contract): Record<string, unknown>[] {
  const t = targets(network);
  if (!Array.isArray(receipts) || receipts.length > 10000) return [];
  return receipts.flatMap(r => {
    if (!s.object(r) || !s.object(r.outcome) || !successful(r.outcome.status)) return [];
    const o = r.outcome;
    if (target && o.executor_id !== t[target]) return [];
    return [o];
  });
}
/** Receipt-only indexer API. Supply receipts from a finalized successful transaction. */
export function parseNearErc8004ReceiptEvents(receipts: unknown, network: NearErc8004Network): NearErc8004Event[] {
  const t = targets(network), events: NearErc8004Event[] = [];
  for (const o of receiptOutcomes(receipts, network)) {
    if (!Array.isArray(o.logs)) continue;
    for (const log of o.logs) {
      if (typeof log !== 'string' || log.length > 65536 || !log.startsWith('EVENT_JSON:')) continue;
      let v: unknown; try { v = JSON.parse(log.slice(11)); } catch { continue; }
      if (!s.object(v) || Object.keys(v).length !== 4 || v.version !== '1.0.0' || typeof v.event !== 'string' || !Object.hasOwn(eventSpecs, v.event)) continue;
      const spec = eventSpecs[v.event as keyof NearErc8004EventData];
      if (o.executor_id !== t[spec.target] || v.standard !== spec.standard || !Array.isArray(v.data) || v.data.length !== 1 || !spec.check(v.data[0])) continue;
      events.push(v as unknown as NearErc8004Event);
    }
  }
  return events;
}
/** Preferred transaction API: also requires final SuccessValue, never a pending receipt id. */
export function parseNearErc8004Events(outcome: unknown, network: NearErc8004Network): NearErc8004Event[] {
  targets(network);
  if (!s.object(outcome) || !successful(outcome.status) || !s.object(outcome.status) || typeof outcome.status.SuccessValue !== 'string') return [];
  return parseNearErc8004ReceiptEvents(outcome.receipts_outcome, network);
}
function transaction(outcome: unknown, network: NearErc8004Network, allowed: NearErc8004Method[]) {
  const t = targets(network);
  if (!s.object(outcome) || !s.object(outcome.transaction)) throw new Error('Expected final ERC-8004 transaction outcome');
  const tx = outcome.transaction;
  s.check(tx.signer_id, s.accountCheck, 'transaction signer');
  if (!Array.isArray(tx.actions) || tx.actions.length !== 1 || !s.object(tx.actions[0]) || !s.object(tx.actions[0].FunctionCall)) throw new Error('Expected one FunctionCall outcome');
  const call = tx.actions[0].FunctionCall;
  if (!allowed.includes(call.method_name as NearErc8004Method)) throw new Error('Wrong transaction method');
  const method = call.method_name as NearErc8004Method;
  if (tx.receiver_id !== t[methods[method].target]) throw new Error('Outcome receiver/network mismatch');
  if (typeof call.args !== 'string' || call.args.length > 65536) throw new Error('Invalid transaction args');
  const args = canonicalArgs(methods[method].required, methods[method].optional ?? {},
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(s.unbase64(call.args))));
  if (!s.object(outcome.status)) throw new Error('Expected final transaction status');
  return { outcome, tx, args, status: outcome.status };
}
function returnValue(status: Record<string, unknown>): unknown {
  if (!successful(status) || typeof status.SuccessValue !== 'string' || status.SuccessValue.length > 1024) throw new Error('Expected final SuccessValue');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(s.unbase64(status.SuccessValue)));
}
export function parseNearErc8004RegisterOutcome(outcome: unknown, network: NearErc8004Network): string {
  const parsed = transaction(outcome, network, ['register']);
  const value = returnValue(parsed.status); s.check(value, s.u64, 'register agent_id');
  const registered = parseNearErc8004Events(outcome, network).filter(e => e.event === 'registered');
  if (registered.length !== 1 || registered[0].data[0].agent_id !== value || registered[0].data[0].owner !== parsed.tx.signer_id ||
    registered[0].data[0].agent_uri !== (parsed.args.agent_uri ?? '')) throw new Error('Register result/event mismatch');
  return value as string;
}
export type NearErc8004FeedbackOutcome = { status: 'accepted'; feedbackIndex: string } |
  { status: 'rejected'; code: NearErc8004RejectionCode } | { status: 'failed'; code: string | null; message: string };
export function parseNearErc8004GiveFeedbackOutcome(outcome: unknown, network: NearErc8004Network): NearErc8004FeedbackOutcome {
  const parsed = transaction(outcome, network, ['give_feedback', 'give_feedback_with_proof']);
  if (Object.hasOwn(parsed.status, 'Failure')) {
    if (Object.keys(parsed.status).length !== 1) throw new Error('Ambiguous transaction status');
    const message = JSON.stringify(parsed.status.Failure);
    return { status: 'failed', code: message.match(/\bERC8004_(?:ID|REP|ARV)_E[0-9]{2}\b/)?.[0] ?? null, message };
  }
  const value = returnValue(parsed.status);
  const logs = receiptOutcomes(parsed.outcome.receipts_outcome, network, 'reputation').flatMap(o => Array.isArray(o.logs) ? o.logs : []);
  const rejections = logs.filter((v): v is string => typeof v === 'string' && v.startsWith('erc8004:rechazo:')).map(v => v.slice('erc8004:rechazo:'.length));
  const events = parseNearErc8004Events(outcome, network).filter(e => e.event === 'new_feedback');
  if (value === null && rejections.length === 1 && events.length === 0 && Object.values(NearErc8004RejectionCode).includes(rejections[0] as NearErc8004RejectionCode)) {
    return { status: 'rejected', code: rejections[0] as NearErc8004RejectionCode };
  }
  s.check(value, s.positiveIndex, 'feedback_index');
  if (rejections.length !== 0 || events.length !== 1) throw new Error('Feedback result/event mismatch');
  const event = events[0].data[0];
  if (event.feedback_index !== value || event.agent_id !== parsed.args.agent_id || event.client_address !== parsed.tx.signer_id ||
    event.value !== parsed.args.value || event.value_decimals !== parsed.args.value_decimals ||
    event.tag1 !== (parsed.args.tag1 ?? '') || event.tag2 !== (parsed.args.tag2 ?? '') ||
    event.endpoint !== (parsed.args.endpoint ?? '') || event.feedback_uri !== (parsed.args.feedback_uri ?? '') || event.feedback_hash !== (parsed.args.feedback_hash ?? null) ||
    (parsed.args.verifier === undefined ? event.proof !== null : !event.proof || event.proof.verifier !== parsed.args.verifier || event.proof.proof !== parsed.args.proof)) throw new Error('Feedback result/event mismatch');
  return { status: 'accepted', feedbackIndex: value as string };
}
