/** Typed Arras v1 NEP-297 envelopes, following escrow-core/src/events.rs. */
import { uint } from './encoding';

export interface ArrasAuthorizedData {
  payment_id: string; operator_id: string; token: string; payer: string; receiver: string;
  amount: string; fee_bps: number; fee_recipient: string; terms_hash: string;
}
export interface ArrasReleasedData { payment_id: string; amount: string; net: string; fee: string }
export interface ArrasPaymentAmountData { payment_id: string; amount: string }
export interface ArrasWithdrawnData { account: string; token: string; amount: string; ok: boolean }
export interface ArrasCompactedData { payment_id: string }
export interface ArrasOperatorData {
  operator_id: string; owner?: string; capturers?: string[]; fee_bps?: number; fee_recipient?: string;
  min_amount?: string; tope_tvl_operador?: string; tope_tvl_por_payer?: string; sponsor_max_por_payer?: string;
}
export interface ArrasCapsSetData { by: string; tope_por_pago: string; tope_tvl_global: string }
export interface ArrasPauseData { by: string; paused: boolean; at: string }
export interface ArrasEventData {
  authorized: ArrasAuthorizedData;
  released: ArrasReleasedData;
  refunded: ArrasPaymentAmountData;
  reclaimed: ArrasPaymentAmountData;
  withdrawn: ArrasWithdrawnData;
  compacted: ArrasCompactedData;
  operator_registered: ArrasOperatorData;
  operator_updated: ArrasOperatorData;
  caps_set: ArrasCapsSetData;
  paused: ArrasPauseData;
  unpaused: ArrasPauseData;
}
export type ArrasEvent = { [K in keyof ArrasEventData]: {
  standard: 'arras'; version: '1.0.0'; event: K; data: ArrasEventData[K][];
} }[keyof ArrasEventData];

type Check = (v: unknown) => boolean;
const string: Check = (v) => typeof v === 'string';
const boolean: Check = (v) => typeof v === 'boolean';
const integer = (bits: number): Check => (v) => {
  if (typeof v !== 'string') return false; // Rust U64 and U128 are JSON decimal strings
  try { uint(v, bits, 'event integer'); return true; } catch { return false; }
};
const u128 = integer(128), u64 = integer(64);
const fee: Check = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535;
const strings: Check = (v) => Array.isArray(v) && v.every(string);
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function record(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return (v) => object(v) && Object.entries(required).every(([k, check]) => Object.hasOwn(v, k) && check(v[k])) &&
    Object.entries(optional).every(([k, check]) => !Object.hasOwn(v, k) || check(v[k]));
}
const operator = record({ operator_id: string }, { owner: string, capturers: strings, fee_bps: fee,
  fee_recipient: string, min_amount: u128, tope_tvl_operador: u128, tope_tvl_por_payer: u128, sponsor_max_por_payer: u128 });
const paymentAmount = record({ payment_id: string, amount: u128 });
const pause = record({ by: string, paused: boolean, at: u64 });
const checks: Record<keyof ArrasEventData, Check> = {
  authorized: record({ payment_id: string, operator_id: string, token: string, payer: string, receiver: string,
    amount: u128, fee_bps: fee, fee_recipient: string, terms_hash: string }),
  released: record({ payment_id: string, amount: u128, net: u128, fee: u128 }),
  refunded: paymentAmount, reclaimed: paymentAmount,
  withdrawn: record({ account: string, token: string, amount: u128, ok: boolean }),
  compacted: record({ payment_id: string }),
  operator_registered: operator, operator_updated: operator,
  caps_set: record({ by: string, tope_por_pago: u128, tope_tvl_global: u128 }),
  paused: pause, unpaused: pause,
};
/**
 * Pass flattened receipt outcome logs. Foreign logs, malformed envelopes/data and unknown
 * standards, versions or events are skipped. Preserve each batch and decimal integer bytes.
 * Logs alone do not authenticate the emitter: the caller must check the receipt executor/status.
 */
export function parseArrasEvents(logs: readonly unknown[]): ArrasEvent[] {
  const result: ArrasEvent[] = [];
  if (!Array.isArray(logs)) return result;
  for (const log of logs) {
    if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) continue;
    let value: unknown;
    try { value = JSON.parse(log.slice(11)); } catch { continue; }
    if (!object(value) || value.standard !== 'arras' || value.version !== '1.0.0' ||
        typeof value.event !== 'string' || !Object.hasOwn(checks, value.event) || !Array.isArray(value.data)) continue;
    const check = checks[value.event as keyof ArrasEventData];
    if (!value.data.every(check)) continue;
    result.push({ standard: 'arras', version: '1.0.0', event: value.event, data: value.data } as ArrasEvent);
  }
  return result;
}
