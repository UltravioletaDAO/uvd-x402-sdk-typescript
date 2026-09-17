/** Portable payment receipts. They attest settlement, not merchant delivery. */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import type { X402FetchOptions } from './types';

export const RECEIPT_ISSUER = 'https://facilitator.ultravioletadao.xyz';
export type PaymentState = 'verified' | 'pending' | 'confirmed' | 'rejected' | 'unknown' | 'not_required';
export interface FacilitatorReceipt {
  schemaVersion: number; receiptId: string; revision: number; issuer: string; issuedAt: number;
  operation: string; purchaseId: string | null; network: string; scheme: string; x402Version: number;
  asset: string; amount: string; decimals: number | null; payTo: string; payer: string | null;
  requestHash: string; requestHashVersion: string; request: Record<string, unknown>;
  paymentRequestHash: string; authorizationId: string; status: string;
  settlement: { id: string; idType: string; paymentId?: string | null; [key: string]: unknown } | null;
  refusalReason: string | null; diagnosticCode: string | null;
  retry: { action: string; afterSeconds?: number; [key: string]: unknown };
  proof: { type: string; jws?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
}
export interface PurchaseContext {
  purchaseId: string;
  /** Secret lookup capability. Store privately alongside paymentHeaders. */
  accessToken: string;
  method?: string; url?: string; bodySha256?: string;
  paymentHeaders?: Record<string, string>;
  receipt?: FacilitatorReceipt;
}
export interface ReceiptKeys { keys: Array<{ kid?: string; kty?: string; crv?: string; x?: string }> }
export interface FetchReceiptResult {
  response: Response | null; receipt: FacilitatorReceipt | null; paymentState: PaymentState;
  context: PurchaseContext; proofVerified: boolean; error?: unknown;
}
export interface ReceiptFetchOptions extends X402FetchOptions {
  context: PurchaseContext;
  /** Must complete before the authorized request is sent. */
  persist: (context: PurchaseContext) => void | Promise<void>;
  trustedKeys?: ReceiptKeys;
  issuer?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const digest = (value: Uint8Array): string => bytesToHex(sha256(value));

export function canonicalReceiptJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalReceiptJson).join(',')}]`;
  if (typeof value === 'object' && value) {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    if (keys.some(key => !/^[\x00-\x7f]*$/.test(key))) throw new Error('non-ASCII canonical key');
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalReceiptJson(object[key])}`).join(',')}}`;
  }
  throw new Error('unsupported canonical value');
}
export function receiptCommitment(domain: string, value: unknown): string {
  return digest(encoder.encode(`${domain}\n${canonicalReceiptJson(value)}`));
}

function encode64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
}
function decode64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('invalid base64');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
function decodeUrl64(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return decode64(padded + '='.repeat((4 - padded.length % 4) % 4));
}

export function parseFacilitatorReceipt(value: unknown): FacilitatorReceipt | null {
  if (value === null || value === undefined) return null;
  const r = value as FacilitatorReceipt;
  if (r.schemaVersion !== 1 || !['verified', 'pending', 'confirmed', 'rejected', 'unknown'].includes(r.status)) throw new Error('unsupported receipt version or state');
  for (const key of ['receiptId', 'issuer', 'operation', 'network', 'scheme', 'asset', 'amount', 'payTo', 'paymentRequestHash', 'authorizationId']) {
    if (typeof r[key] !== 'string' || !r[key]) throw new Error(`invalid receipt ${key}`);
  }
  if (!Number.isSafeInteger(r.revision) || r.revision < 1 || !r.request || !r.retry) throw new Error('incomplete receipt');
  if (r.requestHashVersion !== 'uvd-x402-request-v1' || r.requestHash !== receiptCommitment(r.requestHashVersion, r.request)) throw new Error('receipt request hash mismatch');
  for (const key of ['network', 'scheme', 'asset', 'amount', 'payTo', 'purchaseId']) {
    if (r[key] !== r.request[key]) throw new Error('receipt terms mismatch');
  }
  if (!/^[0-9]+$/.test(r.amount)) throw new Error('receipt amount must be an atomic integer string');
  if (r.status === 'confirmed' && (r.operation !== 'settle' || !r.settlement?.id)) throw new Error('confirmation has no settlement');
  return r;
}

/** Keys must be trusted independently of the receipt; no auto-fetch of issuer URLs. */
export function verifyFacilitatorReceipt(receipt: FacilitatorReceipt, jwks: ReceiptKeys, issuer = RECEIPT_ISSUER): boolean {
  try {
    parseFacilitatorReceipt(receipt);
    if (receipt.issuer !== issuer || receipt.proof?.type !== 'jws' || !receipt.proof.jws) return false;
    const parts = receipt.proof.jws.split('.');
    if (parts.length !== 3) return false;
    const [protectedHeader, payload, signature] = parts;
    const header = JSON.parse(decoder.decode(decodeUrl64(protectedHeader)));
    if (header.alg !== 'EdDSA' || header.typ !== 'uvd-facilitator-receipt+jws') return false;
    const keys = jwks.keys.filter(k => k.kid === header.kid && k.kty === 'OKP' && k.crv === 'Ed25519');
    if (keys.length !== 1 || !keys[0].x) return false;
    if (decoder.decode(decodeUrl64(payload)) !== canonicalReceiptJson({ ...receipt, proof: null })) return false;
    return ed25519.verify(decodeUrl64(signature), encoder.encode(`${protectedHeader}.${payload}`), decodeUrl64(keys[0].x));
  } catch { return false; }
}

export function createPurchaseContext(): PurchaseContext {
  return { purchaseId: bytesToHex(randomBytes(16)), accessToken: bytesToHex(randomBytes(32)) };
}
export function purchaseContextHeader(context: PurchaseContext): string {
  return encode64(encoder.encode(canonicalReceiptJson({ purchaseId: context.purchaseId, accessToken: context.accessToken,
    method: context.method, url: context.url, bodySha256: context.bodySha256 })));
}
/** Merchant-side binding to the actual request, before asking the facilitator. */
export function validatePurchaseContext(header: string | undefined, method: string, url: string, body: Uint8Array): string | undefined {
  if (!header) return undefined;
  if (header.length > 8192) throw new Error('invalid purchase context');
  const context = JSON.parse(decoder.decode(decode64(header)));
  if (typeof context.purchaseId !== 'string' || !context.purchaseId || context.purchaseId.length > 128
      || typeof context.accessToken !== 'string' || !/^[0-9a-f]{64}$/.test(context.accessToken)
      || context.method !== method.toUpperCase() || context.url !== new URL(url).toString()
      || context.bodySha256 !== digest(body)) throw new Error('purchase context does not match the HTTP request');
  return header;
}
export function paymentResponseHeaders(result: Record<string, unknown>): Record<string, string> {
  const encoded = encode64(encoder.encode(JSON.stringify(result)));
  if (encoded.length > 32768) throw new Error('payment response too large');
  return { 'PAYMENT-RESPONSE': encoded, 'X-PAYMENT-RESPONSE': encoded,
    'Access-Control-Expose-Headers': 'PAYMENT-RESPONSE, X-PAYMENT-RESPONSE', 'Cache-Control': 'no-store' };
}
export function receiptFromResponse(response: Response): FacilitatorReceipt | null {
  const values = [response.headers.get('PAYMENT-RESPONSE'), response.headers.get('X-PAYMENT-RESPONSE')].filter((v): v is string => v !== null);
  if (!values.length) return null;
  if (new Set(values).size !== 1 || values[0].includes(',') || values[0].length > 32768) throw new Error('ambiguous or oversized payment response header');
  return parseFacilitatorReceipt(JSON.parse(decoder.decode(decode64(values[0]))).receipt);
}
/** HTTP error bodies can be plain text. Preserve their original diagnosis. */
export function receiptFromErrorBody(body: string): FacilitatorReceipt | null {
  try { return parseFacilitatorReceipt(JSON.parse(body).receipt); } catch { return null; }
}

export async function fetchWithReceipt(
  fetchClient: (url: string, options: X402FetchOptions) => Promise<Response>, url: string, options: ReceiptFetchOptions,
): Promise<FetchReceiptResult> {
  const { context, persist, trustedKeys, issuer = RECEIPT_ISSUER } = options;
  const transport = options.fetchImpl || globalThis.fetch;
  const method = (options.method || 'GET').toUpperCase();
  const request = new Request(url, { ...options.init, method });
  const bytes = new Uint8Array(await request.arrayBuffer());
  const bodyHash = digest(bytes);
  if (context.method && (context.method !== method || context.url !== request.url || context.bodySha256 !== bodyHash)) throw new Error('purchase context cannot be reused for another HTTP request');
  context.method = method; context.url = request.url; context.bodySha256 = bodyHash;
  const init = { ...options.init, method, headers: new Headers(request.headers), body: ['GET', 'HEAD'].includes(method) ? undefined : bytes };
  let receipt = parseFacilitatorReceipt(context.receipt);
  let transportError: unknown;
  const persistCopy = async () => { await persist(JSON.parse(JSON.stringify(context))); };
  const send: typeof fetch = async (input, sendOptions) => {
    const headers = new Headers(sendOptions?.headers);
    const paid = headers.get('X-PAYMENT') || headers.get('PAYMENT-SIGNATURE');
    if (paid) {
      const paymentHeaders: Record<string, string> = {};
      for (const name of ['X-PAYMENT', 'PAYMENT-SIGNATURE']) {
        const value = headers.get(name); if (value) paymentHeaders[name] = value;
      }
      if (context.paymentHeaders && JSON.stringify(context.paymentHeaders) !== JSON.stringify(paymentHeaders)) throw new Error('refusing a new authorization for an existing purchase');
      context.paymentHeaders = paymentHeaders;
      headers.set('X-UVD-Purchase', purchaseContextHeader(context));
      await persistCopy();
    }
    try { return await transport(input, { ...sendOptions, headers }); }
    catch (error) { transportError = error; throw error; }
  };
  try {
    let response: Response;
    if (context.paymentHeaders) {
      const headers = new Headers(init.headers);
      for (const [name, value] of Object.entries(context.paymentHeaders)) headers.set(name, value);
      response = await send(request.url, { ...init, headers });
    } else {
      response = await fetchClient(request.url, { ...options, method, init, fetchImpl: send });
    }
    const incoming = receiptFromResponse(response);
    if (incoming) {
      if (incoming.issuer !== issuer || Object.entries({ purchaseId: context.purchaseId, method, url: context.url, bodySha256: bodyHash }).some(([key, value]) => incoming.request[key] !== value)) throw new Error('receipt does not bind this purchase');
      if (receipt?.operation === 'settle' && (incoming.receiptId !== receipt.receiptId || incoming.revision < receipt.revision)) throw new Error('receipt revision conflict');
      if (trustedKeys && !verifyFacilitatorReceipt(incoming, trustedKeys, issuer)) throw new Error('receipt signature verification failed');
      receipt = incoming; context.receipt = incoming; await persistCopy();
    }
    const proofVerified = !!(receipt && trustedKeys && verifyFacilitatorReceipt(receipt, trustedKeys, issuer));
    if (receipt && trustedKeys && !proofVerified) throw new Error('receipt signature verification failed');
    return { response, receipt, paymentState: receipt ? receipt.status as PaymentState : context.paymentHeaders ? 'unknown' : 'not_required', context, proofVerified };
  } catch (error) {
    if (!transportError) throw error;
    return { response: null, receipt, paymentState: 'unknown', context, proofVerified: false, error };
  }
}

export async function getFacilitatorReceipt(receiptId: string, context: PurchaseContext, options: { issuer?: string; fetchImpl?: typeof fetch } = {}): Promise<FacilitatorReceipt> {
  if (!/^[0-9a-f-]{36}$/.test(receiptId)) throw new Error('invalid receipt ID');
  const issuer = options.issuer || RECEIPT_ISSUER;
  const response = await (options.fetchImpl || globalThis.fetch)(`${issuer}/receipts/${receiptId}`, { headers: { Authorization: `Bearer ${context.accessToken}` } });
  if (!response.ok) throw new Error(`receipt lookup failed: ${response.status}`);
  const receipt = parseFacilitatorReceipt((await response.json()).receipt);
  if (!receipt || receipt.issuer !== issuer || receipt.purchaseId !== context.purchaseId) throw new Error('receipt lookup mismatch');
  return receipt;
}
