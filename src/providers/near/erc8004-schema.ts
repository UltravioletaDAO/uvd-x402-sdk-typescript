/** Internal runtime schemas for the deployed NEAR ERC-8004 interface. */
import { account, fullMatch, uint } from './encoding';
export type Check = (value: unknown) => boolean;
export const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const text: Check = v => typeof v === 'string' && !/[\ud800-\udfff]/u.test(v);
export const bool: Check = v => typeof v === 'boolean';
export const nullable = (check: Check): Check => v => v === null || check(v);
export const list = (check: Check, max = 100): Check => v => Array.isArray(v) && v.length <= max && v.every(check);
export const num = (max: number): Check => v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
export const exact = (expected: unknown): Check => v => v === expected;
export function shape(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return v => object(v) && Object.keys(v).every(k => Object.hasOwn(required, k) || Object.hasOwn(optional, k)) &&
    Object.entries(required).every(([k, check]) => Object.hasOwn(v, k) && check(v[k])) &&
    Object.entries(optional).every(([k, check]) => !Object.hasOwn(v, k) || check(v[k]));
}
export const unsigned = (bits: number): Check => v => {
  if (typeof v !== 'string' || v.length > 78) return false;
  try { uint(v, bits, 'integer'); return true; } catch { return false; }
};
export const u64 = unsigned(64), u128 = unsigned(128), u256 = unsigned(256);
export const positiveIndex: Check = v => u64(v) && v !== '0';
export const signed = (digits: number): Check => v => typeof v === 'string' && v.length <= digits + 1 &&
  fullMatch(/^(0|-?[1-9][0-9]*)$/, v) && v.replace('-', '').length <= digits;
export const valueCheck: Check = v => signed(39)(v) && BigInt(v as string) >= -(10n ** 38n) && BigInt(v as string) <= 10n ** 38n;
export const decimals = num(18);
export const accountCheck: Check = v => { try { account(v as string, 'account'); return true; } catch { return false; } };
export const byteLength = (v: string): number => new TextEncoder().encode(v).length;
export const boundedText = (max: number): Check => v => text(v) && byteLength(v as string) <= max;
export const tag: Check = v => boundedText(64)(v) && !/\p{Cc}/u.test(v as string);
export const label: Check = v => typeof v === 'string' && fullMatch(/^[a-z0-9_-]{0,32}$/, v);
export const proof: Check = v => typeof v === 'string' && fullMatch(/^[\x21-\x7e]{1,128}$/, v);
export const hash: Check = v => typeof v === 'string' && fullMatch(/^[0-9a-f]{64}$/, v);
export const key: Check = v => typeof v === 'string' && fullMatch(/^[A-Za-z0-9._:/-]{1,64}$/, v);
export const uri = (max: number, empty = false): Check => v => typeof v === 'string' &&
  ((empty && v === '') || (v.length <= max && fullMatch(/^[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/, v)));
export function base64(bytes: Uint8Array): string { return btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')); }
export function unbase64(value: string): Uint8Array {
  if (typeof value !== 'string' || !fullMatch(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, value)) throw new Error('Invalid base64');
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (base64(bytes) !== value) throw new Error('Noncanonical base64');
  return bytes;
}
export const base64Check = (max: number): Check => v => {
  if (typeof v !== 'string' || v.length > Math.ceil(max / 3) * 4) return false;
  try { return unbase64(v).length <= max; } catch { return false; }
};
export function check(v: unknown, valid: Check, name: string): void { if (!valid(v)) throw new Error(`Invalid ${name}`); }
export const metadataEntry = shape({ metadata_key: v => key(v) && v !== 'agentWallet', metadata_value: base64Check(1024) });
const version = { erc8004_version: exact('2.0.0'), events_standard: exact('erc8004'), events_version: exact('1.0.0') };
export const identityConfigCheck = shape({ contract: exact('erc8004-identity'), ...version, total_agents: u64,
  register_deposit: u128, token_reserve_bytes: exact(77), storage_byte_cost: u128, min_gas_nft_transfer_call: u64,
  limits: shape({ max_agent_uri_len: exact(8192), max_metadata_key_len: exact(64), max_metadata_value_len: exact(1024),
    max_register_metadata: exact(4), max_approvals: exact(8), max_memo_len: exact(256), max_deadline_delay_ns: exact('300000000000'), max_list_limit: exact(100) }) });
export const reputationConfigCheck = shape({ contract: exact('erc8004-reputation'), ...version, identity_registry: accountCheck,
  feedback_deposit: u128, min_gas_give_feedback: u64, feedback_proof_deposit: u128, min_gas_give_feedback_with_proof: u64,
  max_endpoint_len: exact(1024), max_feedback_uri_len: exact(4096), max_response_uri_len: exact(4096), max_tag_len: exact(64), max_list_limit: exact(100) });
export const verifierConfigCheck = shape({ contract: exact('erc8004-arras-verifier'), escrow: accountCheck,
  min_gas_verify: u64, gas_get_payment: u64, gas_on_payment: u64 });
export const feedbackFields = { value: valueCheck, value_decimals: decimals, tag1: tag, tag2: tag };
export const feedbackCheck = shape({ ...feedbackFields, is_revoked: bool });
export const proofFields = { verifier: accountCheck, proof, counterparty: accountCheck, role: label, context: label, weight: u128 };
export const proofCheck = shape(proofFields);
export const refFields = { agent_id: u64, client_address: accountCheck, feedback_index: positiveIndex };
export const refCheck = shape(refFields);
export const summaryFields = { count: u64, summary_value: signed(56), summary_value_decimals: decimals };
export const summaryCheck = shape(summaryFields);
export const verifiedSummaryCheck = shape({ ...summaryFields, weight_sum: u256 });
export const tokenMetadataCheck = shape({ title: nullable(text), description: nullable(text), media: nullable(uri(8192)),
  media_hash: nullable(base64Check(32)), copies: nullable(num(Number.MAX_SAFE_INTEGER)), issued_at: nullable(text),
  expires_at: nullable(text), starts_at: nullable(text), updated_at: nullable(text), extra: nullable(text),
  reference: nullable(uri(8192)), reference_hash: nullable(base64Check(32)) });
export const tokenCheck = shape({ token_id: u64, owner_id: accountCheck, metadata: tokenMetadataCheck,
  approved_account_ids: v => object(v) && Object.keys(v).length <= 8 && Object.entries(v).every(([k,v]) => accountCheck(k) && num(Number.MAX_SAFE_INTEGER)(v)) });
export const nftMetadataCheck = shape({ spec: exact('nft-1.0.0'), name: text, symbol: text, icon: nullable(uri(8192)),
  base_uri: nullable(uri(8192)), reference: nullable(uri(8192)), reference_hash: nullable(base64Check(32)) });
export const pendingWalletCheck = shape({ wallet: accountCheck, deadline: u64 });
export const agentCheck = shape({ owner_id: accountCheck, agent_wallet: nullable(accountCheck), authorized: bool });
const allFields = { clients: list(accountCheck), feedback_indexes: list(positiveIndex), values: list(valueCheck),
  value_decimals: list(decimals), tag1s: list(tag), tag2s: list(tag), revoked_statuses: list(bool) };
export const allFeedbackCheck: Check = v => shape(allFields)(v) && object(v) &&
  Object.values(v).every(a => (a as unknown[]).length === (v.clients as unknown[]).length);
