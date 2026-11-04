/** Arras registry v1. Offline builders/signing; only view helpers perform RPC. */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { account, concat, fullMatch, le, str, uint, unbase58 } from './encoding';
import type { NearEscrowNetwork, NearLocalSigner, NearUnsigned } from './escrow';

export const NEAR_REGISTRY_CONTRACTS: Readonly<Record<NearEscrowNetwork, readonly string[]>> = Object.freeze({
  'near:mainnet': Object.freeze(['registry.arras-escrow.near']), 'near:testnet': Object.freeze([]),
});
export const NEAR_REGISTRY_ESCROWS: Readonly<Record<NearEscrowNetwork, readonly string[]>> = Object.freeze({
  'near:mainnet': Object.freeze(['v1.arras-escrow.near']), 'near:testnet': Object.freeze([]),
});
export const REGISTER_DEPOSIT = '17510000000000000000000';
export const FEEDBACK_DEPOSIT = '18640000000000000000000';
export const REGISTRY_GAS = '30000000000000';
export const GIVE_FEEDBACK_GAS = '100000000000000';
export const MIN_GIVE_FEEDBACK_GAS = '60000000000000';

export enum RegistryErrorCode {
  E01 = 'E01_AGENT_URI_INVALIDA', E02 = 'E02_METADATA_INVALIDA', E03 = 'E03_YA_REGISTRADO',
  E04 = 'E04_NO_REGISTRADO', E05 = 'E05_DEPOSITO_INSUFICIENTE', E06 = 'E06_REQUIERE_DEPOSITO',
  E10 = 'E10_ESCROW_NO_PERMITIDO', E11 = 'E11_PAYMENT_ID_INVALIDO', E12 = 'E12_SCORE_INVALIDO',
  E13 = 'E13_TAG_INVALIDO', E14 = 'E14_FEEDBACK_URI_INVALIDA', E15 = 'E15_FEEDBACK_HASH_INVALIDO',
  E16 = 'E16_DEPOSITO_FEEDBACK', E17 = 'E17_GAS_INSUFICIENTE', E18 = 'E18_YA_CALIFICADO',
  E19 = 'E19_EN_VUELO', E20 = 'E20_GET_PAYMENT_FALLO', E21 = 'E21_RESPUESTA_INVALIDA',
  E22 = 'E22_PAGO_INEXISTENTE', E23 = 'E23_PAGO_SIN_LIBERAR', E24 = 'E24_NO_ES_PARTE',
  E25 = 'E25_AUTO_CALIFICACION', E26 = 'E26_REEMPLAZADO', E30 = 'E30_FEEDBACK_INEXISTENTE',
  E31 = 'E31_YA_REVOCADO', E40 = 'E40_ESCROWS_INVALIDOS',
}
export class RegistryValidationError extends Error {
  constructor(readonly code: RegistryErrorCode) { super(`ARRAS_REG_${code.slice(0, 3)}: ${code}`); }
}
function requireRule(ok: boolean, code: RegistryErrorCode): void {
  if (!ok) throw new RegistryValidationError(code);
}
function validUri(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 &&
    fullMatch(/^[A-Za-z][A-Za-z0-9+.-]*:[\x21-\x7e]+$/, value);
}
function validMetadata(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= 1024 &&
    !/[\x00-\x1f\x7f]/u.test(value) && !/[\ud800-\udfff]/u.test(value);
}
function validTag(value: unknown): value is string {
  return typeof value === 'string' && fullMatch(/^[A-Za-z0-9._:/-]{1,64}$/, value);
}
function validPaymentId(value: unknown): value is string {
  return typeof value === 'string' && fullMatch(/^[\x21-\x7e]{1,64}$/, value);
}
function validHash(value: unknown): value is string {
  return typeof value === 'string' && fullMatch(/^[0-9a-f]{64}$/, value);
}
function validScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}
function network(value: NearEscrowNetwork): void {
  if (value !== 'near:mainnet' && value !== 'near:testnet') throw new Error('Unsupported NEAR network');
}
function receiver(o: RegistryTarget): string {
  network(o.network);
  const id = o.registryContract ?? NEAR_REGISTRY_CONTRACTS[o.network][0];
  if (!NEAR_REGISTRY_CONTRACTS[o.network].includes(id)) throw new Error('receiverId: unregistered registry for network');
  return id;
}
function escrow(value: string, net: NearEscrowNetwork): void {
  requireRule(NEAR_REGISTRY_ESCROWS[net].includes(value), RegistryErrorCode.E10);
}
function codedUint(value: NearUnsigned, bits: number, code: RegistryErrorCode): bigint {
  try { return uint(value, bits, code); } catch { throw new RegistryValidationError(code); }
}

export interface RegistryTarget { network: NearEscrowNetwork; registryContract?: string }
export interface RegistryBuildOptions extends RegistryTarget {
  signerId: string;
  /** YoctoNEAR: register/feedback use getConfig floors; update accepts >= 1; revoke requires 1. */
  deposit?: NearUnsigned;
  /** Gas units, not TGas. give_feedback needs at least 60 TGas. */
  gas?: NearUnsigned;
}
export interface RegistryIdentityArgs { agent_uri: string; metadata?: string | null }
export interface RegistryPaymentArgs { escrow: string; payment_id: string }
export interface GiveFeedbackArgs extends RegistryPaymentArgs {
  score: number; tag1?: string | null; tag2?: string | null;
  feedback_uri?: string | null; feedback_hash?: string | null;
}
export type RegistryMethod = 'register' | 'update' | 'give_feedback' | 'revoke_feedback';
export interface RegistryTransaction {
  signerId: string; receiverId: string;
  actions: [{ type: 'FunctionCall'; params: {
    methodName: RegistryMethod; args: Record<string, string | number>; gas: string; deposit: string;
  } }];
}
function canonicalArgs(method: RegistryMethod, input: Record<string, unknown>, net: NearEscrowNetwork): Record<string, string | number> {
  const allowed = method === 'register' || method === 'update' ? ['agent_uri', 'metadata'] :
    method === 'give_feedback' ? ['escrow', 'payment_id', 'score', 'tag1', 'tag2', 'feedback_uri', 'feedback_hash'] :
      ['escrow', 'payment_id'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('Unexpected registry argument');
  const args: Record<string, string | number> = {};
  if (method === 'register' || method === 'update') {
    requireRule(validUri(input.agent_uri), RegistryErrorCode.E01);
    args.agent_uri = input.agent_uri as string;
    if (input.metadata != null) {
      requireRule(validMetadata(input.metadata), RegistryErrorCode.E02);
      args.metadata = input.metadata as string;
    }
  } else {
    escrow(input.escrow as string, net);
    requireRule(validPaymentId(input.payment_id), RegistryErrorCode.E11);
    args.escrow = input.escrow as string; args.payment_id = input.payment_id as string;
    if (method === 'give_feedback') {
      requireRule(validScore(input.score), RegistryErrorCode.E12);
      args.score = input.score as number;
      for (const field of ['tag1', 'tag2'] as const) {
        if (input[field] != null) {
          requireRule(validTag(input[field]), RegistryErrorCode.E13); args[field] = input[field] as string;
        }
      }
      if (input.feedback_uri != null) {
        requireRule(validUri(input.feedback_uri), RegistryErrorCode.E14); args.feedback_uri = input.feedback_uri as string;
      }
      if (input.feedback_hash != null) {
        requireRule(validHash(input.feedback_hash), RegistryErrorCode.E15); args.feedback_hash = input.feedback_hash as string;
      }
    }
  }
  return args;
}
function build(method: RegistryMethod, options: RegistryBuildOptions, input: Record<string, unknown>): RegistryTransaction {
  const o = { ...options };
  const receiverId = receiver(o);
  account(o.signerId, 'signerId');
  // update checks the attached deposit before URI/metadata (E06 -> E01 -> E02).
  const updateDeposit = method === 'update'
    ? codedUint(o.deposit === undefined ? REGISTER_DEPOSIT : o.deposit, 128, RegistryErrorCode.E06) : undefined;
  if (updateDeposit !== undefined) requireRule(updateDeposit > 0n, RegistryErrorCode.E06);
  const args = canonicalArgs(method, { ...input }, o.network);
  const depositCode = method === 'give_feedback' ? RegistryErrorCode.E16 : RegistryErrorCode.E05;
  const minimum = method === 'give_feedback' ? FEEDBACK_DEPOSIT : REGISTER_DEPOSIT;
  const deposit = updateDeposit ?? (method === 'revoke_feedback'
    ? uint(o.deposit === undefined ? '1' : o.deposit, 128, 'deposit')
    : codedUint(o.deposit === undefined ? minimum : o.deposit, 128, depositCode));
  if (method === 'revoke_feedback') {
    if (deposit !== 1n) throw new Error('revoke_feedback deposit must be exactly 1 yocto');
  } else if (method !== 'update') {
    requireRule(deposit >= BigInt(minimum), depositCode);
  }
  const gas = uint(o.gas === undefined ? (method === 'give_feedback' ? GIVE_FEEDBACK_GAS : REGISTRY_GAS) : o.gas, 64, 'gas');
  if (method === 'give_feedback') requireRule(gas >= BigInt(MIN_GIVE_FEEDBACK_GAS), RegistryErrorCode.E17);
  else if (gas < 1n) throw new Error('gas must be positive');
  // NEAR protocol maximum for a normal transaction; not a registry contract error.
  if (gas > 300_000_000_000_000n) throw new Error('gas exceeds 300 TGas');
  return { signerId: o.signerId, receiverId, actions: [{ type: 'FunctionCall', params: {
    methodName: method, args, gas: gas.toString(), deposit: deposit.toString(),
  } }] };
}
export const buildRegistryRegister = (options: RegistryBuildOptions & RegistryIdentityArgs): RegistryTransaction => {
  const { agent_uri, metadata, ...o } = options; return build('register', o, { agent_uri, metadata });
};
/** Replaces URI and metadata. Omitted/null metadata clears the previous value. */
export const buildRegistryUpdate = (options: RegistryBuildOptions & RegistryIdentityArgs): RegistryTransaction => {
  const { agent_uri, metadata, ...o } = options; return build('update', o, { agent_uri, metadata });
};
export const buildGiveFeedback = (options: RegistryBuildOptions & GiveFeedbackArgs): RegistryTransaction => {
  const { escrow, payment_id, score, tag1, tag2, feedback_uri, feedback_hash, ...o } = options;
  return build('give_feedback', o, { escrow, payment_id, score, tag1, tag2, feedback_uri, feedback_hash });
};
export const buildRevokeFeedback = (options: RegistryBuildOptions & RegistryPaymentArgs): RegistryTransaction => {
  const { escrow, payment_id, ...o } = options; return build('revoke_feedback', o, { escrow, payment_id });
};
function base64(bytes: Uint8Array): string { return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')); }
function fromBase64(value: string): Uint8Array {
  if (!fullMatch(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, value)) throw new Error('Invalid base64');
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
/**
 * Normal SignedTransaction Borsh, base64 for send_tx. No NEP-366 prefix, RPC or submission.
 * The access key MUST be FullAccess: FunctionCall keys cannot attach a deposit. The caller
 * verifies access-key permission and supplies the next nonce and a recent base58 block hash.
 * Revalidates the descriptor before asking the signer to sign, and verifies the returned signature.
 */
export async function signRegistryTransaction(descriptor: RegistryTransaction, signer: NearLocalSigner,
  nonce: NearUnsigned, blockHash: string): Promise<string> {
  const { signerId, receiverId, actions } = descriptor;
  const net = (Object.keys(NEAR_REGISTRY_CONTRACTS) as NearEscrowNetwork[])
    .find((n) => NEAR_REGISTRY_CONTRACTS[n].includes(receiverId));
  if (!net) throw new Error('receiverId: unregistered registry');
  if (!Array.isArray(actions) || actions.length !== 1) throw new Error('Expected exactly one registry action');
  const action = { ...actions[0] };
  if (action.type !== 'FunctionCall') throw new Error('Expected FunctionCall');
  const p = { ...action.params };
  if (!['register', 'update', 'give_feedback', 'revoke_feedback'].includes(p.methodName)) throw new Error('Unknown registry method');
  if (typeof p.gas !== 'string' || typeof p.deposit !== 'string') throw new Error('Expected gas and deposit strings');
  if (!object(p.args)) throw new Error('Expected registry args object');
  const d = build(p.methodName, { network: net, registryContract: receiverId, signerId, deposit: p.deposit, gas: p.gas }, { ...p.args });
  const a = d.actions[0].params;
  const n = uint(nonce, 64, 'nonce');
  if (n === 0n) throw new Error('nonce must be positive');
  const hash = unbase58(blockHash);
  if (hash.length !== 32) throw new Error('Expected 32-byte block hash');
  const pk = new Uint8Array(signer.publicKey);
  if (pk.length !== 32) throw new Error('Expected 32-byte Ed25519 public key');
  const bytes = concat(str(d.signerId), Uint8Array.of(0), pk, le(n, 8), str(d.receiverId), hash,
    le(1n, 4), Uint8Array.of(2), str(a.methodName), str(JSON.stringify(a.args)),
    le(BigInt(a.gas), 8), le(BigInt(a.deposit), 16));
  const digest = sha256(bytes);
  const signature = await signer.sign(digest.slice());
  if (!(signature instanceof Uint8Array) || signature.length !== 64 || !ed25519.verify(signature, digest, pk)) {
    throw new Error('Invalid Ed25519 transaction signature');
  }
  return base64(concat(bytes, Uint8Array.of(0), signature));
}

export interface AgentView {
  account_id: string; agent_uri: string; metadata: string | null; registered_at: string; updated_at: string;
}
export interface FeedbackView {
  feedback_id: number; rater: string; ratee: string; ratee_role: 'payer' | 'receiver'; escrow: string;
  payment_id: string; operator_id: string; released: string; score: number; tag1: string | null;
  tag2: string | null; feedback_uri: string | null; feedback_hash: string | null; created_at: string;
  revoked: boolean; revoked_at: string | null;
}
export interface RoleSummaryView { count: number; revoked: number; score_sum: string; average_x100: number | null }
export interface SummaryView extends RoleSummaryView {
  account_id: string; operator_id?: string; as_payer: RoleSummaryView; as_receiver: RoleSummaryView;
  last_feedback_id: number | null; last_at: string | null;
}
export interface RegistryConfigView {
  version: 'arras-registry-v1'; escrows: string[]; agents: number; feedbacks: number;
  register_deposit: string; feedback_deposit: string; min_gas_give_feedback: string;
  limits: { max_agent_uri_len: number; max_metadata_len: number; max_feedback_uri_len: number;
    max_tag_len: number; max_payment_id_len: number; max_score: number; max_list_limit: number; pending_ttl_blocks: string };
}
type Check = (value: unknown) => boolean;
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const string: Check = (v) => typeof v === 'string';
const boolean: Check = (v) => typeof v === 'boolean';
const nullable = (check: Check): Check => (v) => v === null || check(v);
const array = (check: Check): Check => (v) => Array.isArray(v) && v.every(check);
function record(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return (v) => object(v) && Object.entries(required).every(([k, check]) => Object.hasOwn(v, k) && check(v[k])) &&
    Object.entries(optional).every(([k, check]) => !Object.hasOwn(v, k) || check(v[k]));
}
const integer = (bits: number): Check => (v) => {
  if (typeof v !== 'string') return false;
  try { uint(v, bits, 'view integer'); return true; } catch { return false; }
};
const u32: Check = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const u64 = integer(64), u128 = integer(128);
const accountCheck: Check = (v) => { try { account(v as string, 'account'); return true; } catch { return false; } };
const operator: Check = (v) => typeof v === 'string' && new TextEncoder().encode(v).length <= 64 && !/[\ud800-\udfff]/u.test(v);
const role: Check = (v) => v === 'payer' || v === 'receiver';
const agentFields = { account_id: accountCheck, agent_uri: validUri, metadata: nullable(validMetadata) };
const feedbackFields = { feedback_id: u32, rater: accountCheck, ratee: accountCheck, ratee_role: role,
  escrow: accountCheck, payment_id: validPaymentId, operator_id: operator, released: u128, score: validScore,
  tag1: nullable(validTag), tag2: nullable(validTag), feedback_uri: nullable(validUri), feedback_hash: nullable(validHash), created_at: u64 };
const agentCheck = record({ ...agentFields, registered_at: u64, updated_at: u64 });
const feedbackCheck = record({ ...feedbackFields, revoked: boolean, revoked_at: nullable(u64) });
const average: Check = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10000;
const summaryFields = { count: u32, revoked: u32, score_sum: u64, average_x100: nullable(average) };
const summaryCheck = record({ ...summaryFields, account_id: accountCheck, as_payer: record(summaryFields),
  as_receiver: record(summaryFields), last_feedback_id: nullable(u32), last_at: nullable(u64) }, { operator_id: string });
const configCheck = record({ version: (v) => v === 'arras-registry-v1', escrows: array(accountCheck), agents: u32,
  feedbacks: u32, register_deposit: u128, feedback_deposit: u128, min_gas_give_feedback: u64,
  limits: record({ max_agent_uri_len: u32, max_metadata_len: u32, max_feedback_uri_len: u32, max_tag_len: u32,
    max_payment_id_len: u32, max_score: (v) => u32(v) && (v as number) <= 255, max_list_limit: u32, pending_ttl_blocks: u64 }) });

/** Return the JSON-RPC result (call_function response with result: number[]), not its outer envelope. */
export type RegistryRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export interface RegistryViewOptions extends RegistryTarget { rpc?: RegistryRpc }
export interface RegistryPage { from_index?: number; limit?: number }
const rpcUrls: Record<NearEscrowNetwork, string> = {
  'near:mainnet': 'https://rpc.mainnet.near.org', 'near:testnet': 'https://rpc.testnet.near.org',
};
async function view<T>(options: RegistryViewOptions, method: string, args: Record<string, unknown>, check: Check): Promise<T> {
  const o = { ...options };
  const id = receiver(o);
  const rpc: RegistryRpc = o.rpc ?? (async (method, params) => {
    const response = await fetch(rpcUrls[o.network], { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'registry', method, params }) });
    if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
    const data: unknown = await response.json();
    if (!object(data) || data.error || !Object.hasOwn(data, 'result')) throw new Error('Invalid NEAR RPC response');
    return data.result;
  });
  const response = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: id,
    method_name: method, args_base64: base64(new TextEncoder().encode(JSON.stringify(args))) });
  if (!object(response) || !Array.isArray(response.result) ||
      !response.result.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) throw new Error('Invalid call_function response');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(response.result)));
  if (!check(value)) throw new Error(`Invalid ${method} response shape`);
  return value as T;
}
function accountArgs(accountId: string): { account_id: string } {
  account(accountId, 'account_id'); return { account_id: accountId };
}
function page(p: RegistryPage): Record<string, number> {
  const result: Record<string, number> = {};
  for (const k of ['from_index', 'limit'] as const) {
    const v = p[k];
    if (v !== undefined) { if (!u32(v)) throw new Error(`Invalid ${k}`); result[k] = v; }
  }
  return result; // The contract caps limit to 50, including for larger u32 inputs.
}
function paymentArgs(o: RegistryViewOptions, input: RegistryPaymentArgs & { rater: string }): Record<string, string> {
  network(o.network); escrow(input.escrow, o.network);
  requireRule(validPaymentId(input.payment_id), RegistryErrorCode.E11); account(input.rater, 'rater');
  return { escrow: input.escrow, payment_id: input.payment_id, rater: input.rater };
}
export const getConfig = async (o: RegistryViewOptions): Promise<RegistryConfigView> => view(o, 'get_config', {}, configCheck);
export const getAgent = async (o: RegistryViewOptions, accountId: string): Promise<AgentView | null> =>
  view(o, 'get_agent', accountArgs(accountId), nullable(agentCheck));
export const listAgents = async (o: RegistryViewOptions, p: RegistryPage = {}): Promise<AgentView[]> =>
  view(o, 'list_agents', page(p), array(agentCheck));
export const getFeedback = async (o: RegistryViewOptions, feedbackId: number): Promise<FeedbackView | null> => {
  if (!u32(feedbackId)) throw new Error('Invalid feedback_id');
  return view(o, 'get_feedback', { feedback_id: feedbackId }, nullable(feedbackCheck));
};
export const getFeedbackForPayment = async (o: RegistryViewOptions, p: RegistryPaymentArgs & { rater: string }): Promise<FeedbackView | null> =>
  view(o, 'get_feedback_for_payment', paymentArgs(o, p), nullable(feedbackCheck));
export const listFeedback = async (o: RegistryViewOptions, accountId: string, p: RegistryPage = {}): Promise<FeedbackView[]> =>
  view(o, 'list_feedback', { ...accountArgs(accountId), ...page(p) }, array(feedbackCheck));
export const getSummary = async (o: RegistryViewOptions, accountId: string): Promise<SummaryView> =>
  view(o, 'get_summary', accountArgs(accountId), (v) => summaryCheck(v) && object(v) && !Object.hasOwn(v, 'operator_id'));
export const getSummaryByOperator = async (o: RegistryViewOptions, accountId: string, operatorId: string): Promise<SummaryView> => {
  if (typeof operatorId !== 'string') throw new Error('Invalid operator_id');
  return view(o, 'get_summary_by_operator', { ...accountArgs(accountId), operator_id: operatorId },
    (v) => summaryCheck(v) && object(v) && Object.hasOwn(v, 'operator_id'));
};
export const isFeedbackPending = async (o: RegistryViewOptions, p: RegistryPaymentArgs & { rater: string }): Promise<boolean> =>
  view(o, 'is_feedback_pending', paymentArgs(o, p), boolean);

export interface RegistryEventData {
  agent_registered: { account_id: string; agent_uri: string; metadata: string | null; at: string };
  agent_updated: RegistryEventData['agent_registered'];
  feedback_given: Omit<FeedbackView, 'revoked' | 'revoked_at'>;
  feedback_revoked: Pick<FeedbackView, 'feedback_id' | 'rater' | 'ratee' | 'escrow' | 'payment_id'> & { revoked_at: string };
}
export type RegistryEvent = { [K in keyof RegistryEventData]: {
  standard: 'arras-registry'; version: '1.0.0'; event: K; data: RegistryEventData[K][];
} }[keyof RegistryEventData];
const eventChecks: Record<keyof RegistryEventData, Check> = {
  agent_registered: record({ ...agentFields, at: u64 }), agent_updated: record({ ...agentFields, at: u64 }),
  feedback_given: record(feedbackFields), feedback_revoked: record({ feedback_id: u32, rater: accountCheck,
    ratee: accountCheck, escrow: accountCheck, payment_id: validPaymentId, revoked_at: u64 }),
};
/**
 * Skip malformed/foreign/unknown logs; preserve valid batches. Raw logs are safe only
 * when the caller has already filtered receipts by executor_id for the selected network.
 * Prefer parseRegistryReceiptEvents for transaction receipts_outcome from the RPC.
 */
export function parseRegistryEvents(logs: readonly unknown[]): RegistryEvent[] {
  const result: RegistryEvent[] = [];
  if (!Array.isArray(logs)) return result;
  for (const log of logs) {
    if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) continue;
    let v: unknown;
    try { v = JSON.parse(log.slice(11)); } catch { continue; }
    if (!object(v) || v.standard !== 'arras-registry' || v.version !== '1.0.0' || typeof v.event !== 'string' ||
        !Object.hasOwn(eventChecks, v.event) || !Array.isArray(v.data)) continue;
    if (!v.data.every(eventChecks[v.event as keyof RegistryEventData])) continue;
    result.push({ standard: 'arras-registry', version: '1.0.0', event: v.event, data: v.data } as RegistryEvent);
  }
  return result;
}
/** Parse RPC receipts_outcome, accepting only the selected network's registry emitters. */
export function parseRegistryReceiptEvents(receiptsOutcome: unknown, net: NearEscrowNetwork): RegistryEvent[] {
  network(net);
  const result: RegistryEvent[] = [];
  if (!Array.isArray(receiptsOutcome)) return result;
  for (const receipt of receiptsOutcome) {
    if (!object(receipt) || !object(receipt.outcome)) continue;
    const outcome = receipt.outcome;
    if (!NEAR_REGISTRY_CONTRACTS[net].includes(outcome.executor_id as string)) continue;
    result.push(...parseRegistryEvents(outcome.logs as unknown[]));
  }
  return result;
}
export type GiveFeedbackOutcome = { status: 'accepted'; feedbackId: number } |
  { status: 'rejected'; code: RegistryErrorCode } | { status: 'error'; code: RegistryErrorCode; message: string };
const rejectionCodes = [RegistryErrorCode.E18, RegistryErrorCode.E20, RegistryErrorCode.E21, RegistryErrorCode.E22,
  RegistryErrorCode.E23, RegistryErrorCode.E24, RegistryErrorCode.E25, RegistryErrorCode.E26];
function panic(value: unknown): GiveFeedbackOutcome | undefined {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const number = text?.match(/ARRAS_REG_(E[0-9]{2}):/)?.[1];
  const code = Object.values(RegistryErrorCode).find((c) => c.slice(0, 3) === number);
  if (code) return { status: 'error', code, message: text };
  return undefined;
}
/** Accept a decoded number, {value, logs}, or the final NEAR execution outcome (not a pending send_tx result). */
export function parseGiveFeedbackOutcome(outcome: unknown): GiveFeedbackOutcome {
  let value: unknown = outcome;
  let logs: unknown[] = [];
  if (typeof outcome === 'string') {
    const error = panic(outcome); if (error) return error;
  }
  if (object(outcome)) {
    if (object(outcome.status) && Object.hasOwn(outcome.status, 'Failure')) {
      const error = panic(outcome.status.Failure); if (error) return error;
      throw new Error('NEAR transaction failed without a registry code');
    }
    if (object(outcome.status) && typeof outcome.status.SuccessValue === 'string') {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64(outcome.status.SuccessValue)));
      if (Array.isArray(outcome.receipts_outcome)) {
        logs = outcome.receipts_outcome.flatMap((r) => object(r) && object(r.outcome) && Array.isArray(r.outcome.logs) ? r.outcome.logs : []);
      }
    } else if (Object.hasOwn(outcome, 'value')) {
      value = outcome.value; logs = Array.isArray(outcome.logs) ? outcome.logs : [];
    } else throw new Error('Expected final give_feedback outcome');
  }
  if (u32(value)) return { status: 'accepted', feedbackId: value as number };
  if (value === null) {
    const codes = new Set(logs.filter((l): l is string => typeof l === 'string')
      .filter((l) => l.startsWith('arras-registry:rechazo:')).map((l) => l.slice(23)));
    if (codes.size === 1) {
      const code = [...codes][0] as RegistryErrorCode;
      if (rejectionCodes.includes(code)) return { status: 'rejected', code };
    }
  }
  throw new Error('Malformed or incomplete give_feedback outcome');
}
export interface FeedbackSummary {
  count: number; distinct_raters: number; revoked: number; released_total: string;
  average_x100: number | null; weighted_average_x100: number | null;
}
/**
 * Summarize the supplied rows for one escrow/operator. Revoked rows only increment revoked.
 * Active rows count equally in average_x100; released weights weighted_average_x100. Both
 * use exact bigint sums and floor. No deduplication/pagination: supply each feedback once,
 * for the intended ratee. Zero total weight returns null, as does an empty active set.
 */
export function summarizeFeedback(feedbacks: readonly FeedbackView[], escrow: string, operatorId: string): FeedbackSummary {
  let count = 0, revoked = 0, score = 0n, released = 0n, weighted = 0n;
  const raters = new Set<string>();
  for (const f of feedbacks) {
    if (!feedbackCheck(f)) throw new Error('Invalid FeedbackView');
    if (f.escrow !== escrow || f.operator_id !== operatorId) continue;
    if (f.revoked) { revoked++; continue; }
    count++; raters.add(f.rater);
    const amount = BigInt(f.released); score += BigInt(f.score); released += amount; weighted += BigInt(f.score) * amount;
  }
  return { count, distinct_raters: raters.size, revoked, released_total: released.toString(),
    average_x100: count ? Number(score * 100n / BigInt(count)) : null,
    weighted_average_x100: released ? Number(weighted * 100n / released) : null };
}
/** Allow only display links with these schemes; never normalize contract bytes or accept whitespace. */
export function safeLink(uri: string): string | null {
  return validUri(uri) && /^(https|ipfs|ar):/i.test(uri) ? uri : null;
}
/** Plain text only; remove Unicode control/format characters (including bidi and zero width). Not HTML escaping. */
export function displayText(s: string): string { return s.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu, ''); }
