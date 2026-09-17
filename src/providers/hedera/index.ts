/** Native Hedera x402 v2/exact. Signing is offline; only the facilitator submits. */
import { formatUnits, parseUnits } from 'ethers';
import type { ChainConfig, PaymentInfo, TokenType, WalletAdapter, X402Version } from '../../types';
import { encodeBase64Json } from '../../utils/base64';

export const HEDERA_NETWORKS = {
  'hedera:mainnet': { usdc: '0.0.456858', feePayer: '0.0.10868300', mirror: 'https://mainnet-public.mirrornode.hedera.com' },
  'hedera:testnet': { usdc: '0.0.429274', feePayer: '0.0.10576385', mirror: 'https://testnet.mirrornode.hedera.com' },
} as const;
export type HederaNetwork = keyof typeof HEDERA_NETWORKS;
/** Historical identifier; HBAR is for network fees, not supported payments. */
export const HBAR_ASSET = '0.0.0';
const MAX_AMOUNT = (1n << 63n) - 1n;

export interface HederaRequirements {
  scheme: 'exact'; network: HederaNetwork; asset: string; amount: string;
  payTo: string; maxTimeoutSeconds: number; extra: { feePayer: string };
}
export interface HederaPaymentPayload {
  x402Version: 2; accepted: HederaRequirements;
  resource?: { url: string; description?: string; mimeType?: string };
  payload: { transaction: string };
}
function account(value: unknown): string {
  if (typeof value !== 'string' || !/^0\.0\.[1-9][0-9]*$/.test(value) || BigInt(value.split('.')[2]) > MAX_AMOUNT) {
    throw new Error('Hedera accounts must be canonical numeric IDs: 0.0.123');
  }
  return value;
}
function networkInfo(network: string) {
  if (!Object.hasOwn(HEDERA_NETWORKS, network)) throw new Error('Expected hedera:mainnet or hedera:testnet');
  return HEDERA_NETWORKS[network as HederaNetwork];
}
/** Validate the entire offer before any signing or network call. */
export function validateHederaRequirements(input: unknown): HederaRequirements {
  if (!input || typeof input !== 'object') throw new Error('Hedera requirements must be an object');
  const r = input as HederaRequirements;
  const fields = ['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds', 'extra'];
  if (Object.keys(r).length !== fields.length || fields.some(k => !Object.hasOwn(r, k)) || r.scheme !== 'exact') {
    throw new Error('Hedera requires exact v2 requirements without extensions');
  }
  const info = networkInfo(r.network);
  if (r.asset !== info.usdc) throw new Error('Hedera payments support native USDC only; HBAR is for network fees');
  if (typeof r.amount !== 'string' || !/^[1-9][0-9]*$/.test(r.amount) || r.amount.length > 19 || BigInt(r.amount) > MAX_AMOUNT) {
    throw new Error('amount must be a positive canonical atomic integer string within int64');
  }
  if (!Number.isInteger(r.maxTimeoutSeconds) || r.maxTimeoutSeconds < 15 || r.maxTimeoutSeconds > 180) {
    throw new Error('Hedera maxTimeoutSeconds must be 15..180');
  }
  if (!r.extra || Object.keys(r.extra).length !== 1 || !Object.hasOwn(r.extra, 'feePayer')) {
    throw new Error('Hedera extra must contain only feePayer');
  }
  account(r.extra.feePayer); account(r.payTo);
  if (r.payTo === r.extra.feePayer) throw new Error('The fee payer must be distinct from the merchant');
  return { ...r, extra: { ...r.extra } };
}
/** Native USDC amounts have 6 decimals. HBAR is used only for network fees. */
export function buildHederaRequirements(options: {
  network: HederaNetwork; payTo: string; amountAtomic: string; asset?: 'usdc' | string;
  feePayer?: string; maxTimeoutSeconds?: number;
}): HederaRequirements {
  const info = networkInfo(options.network);
  return validateHederaRequirements({
    scheme: 'exact', network: options.network,
    asset: !options.asset || options.asset === 'usdc' ? info.usdc : options.asset,
    amount: options.amountAtomic, payTo: options.payTo, maxTimeoutSeconds: options.maxTimeoutSeconds ?? 180,
    extra: { feePayer: options.feePayer ?? info.feePayer },
  });
}
/** Merchant /verify or /settle body. Pass the merchant's OWN offer, never the buyer's price. */
export function buildHederaRequest(paymentPayload: HederaPaymentPayload, requirements: HederaRequirements) {
  const r = validateHederaRequirements(requirements);
  const p = paymentPayload;
  const accepted = validateHederaRequirements(p.accepted);
  if (p.x402Version !== 2 || Object.keys(p).some(k => !['x402Version', 'accepted', 'resource', 'payload'].includes(k)) ||
      Object.keys(r).some(k => k === 'extra' ? r.extra.feePayer !== accepted.extra.feePayer : r[k as keyof HederaRequirements] !== accepted[k as keyof HederaRequirements])) {
    throw new Error('Hedera requires v2 and an exact accepted echo without extensions');
  }
  if (!p.payload || Object.keys(p.payload).length !== 1 || typeof p.payload.transaction !== 'string') {
    throw new Error('Hedera payload must contain only transaction');
  }
  return { x402Version: 2 as const, paymentPayload: p, paymentRequirements: r };
}

/** Native buyer adapter. The optional @hiero-ledger/sdk peer is loaded only when used. */
export class HederaProvider implements WalletAdapter {
  readonly id = 'hedera-native';
  readonly name = 'Hedera Native';
  readonly networkType = 'hedera' as const;
  readonly network: HederaNetwork;
  readonly accountId: string;
  readonly feePayer: string;
  private privateKey: string;
  private connected = false;

  constructor(options: { accountId: string; privateKey: string; network: HederaNetwork; feePayer?: string }) {
    const info = networkInfo(options.network);
    this.network = options.network;
    this.accountId = account(options.accountId);
    this.feePayer = account(options.feePayer ?? info.feePayer);
    if (this.accountId === this.feePayer) throw new Error('Buyer and fee payer must be distinct');
    this.privateKey = options.privateKey;
    // Keep key material out of JSON.stringify(provider), including diagnostic logs.
    Object.defineProperty(this, 'privateKey', { enumerable: false });
  }
  isAvailable(): boolean { return true; }
  async connect(chainName = this.network): Promise<string> {
    if (chainName !== this.network) throw new Error('Provider is bound to another Hedera ledger');
    await this.key();
    this.connected = true;
    return this.accountId;
  }
  async disconnect(): Promise<void> { this.connected = false; }
  getAddress(): string | null { return this.connected ? this.accountId : null; }

  private async key() {
    let sdk: typeof import('@hiero-ledger/sdk');
    try { sdk = await import('@hiero-ledger/sdk'); }
    catch { throw new Error('Install @hiero-ledger/sdk to sign native Hedera payments'); }
    try { return { sdk, key: sdk.PrivateKey.fromStringDer(this.privateKey) }; }
    catch { throw new Error('Invalid Hedera DER private key (value redacted)'); }
  }
  async createPaymentPayload(accepted: HederaRequirements, resource?: HederaPaymentPayload['resource']): Promise<HederaPaymentPayload> {
    const r = validateHederaRequirements(accepted);
    if (r.network !== this.network || r.extra.feePayer !== this.feePayer) throw new Error("Offer does not match the signer's ledger and trusted fee payer");
    if (r.payTo === this.accountId) throw new Error('Buyer and merchant must be distinct');
    const { sdk, key } = await this.key();
    const tx = new sdk.TransferTransaction()
      .setTransactionId(sdk.TransactionId.generate(this.feePayer))
      .setNodeAccountIds(['0.0.3', '0.0.4', this.network === 'hedera:mainnet' ? '0.0.7' : '0.0.5'].map(n => sdk.AccountId.fromString(n)))
      .setTransactionValidDuration(r.maxTimeoutSeconds)
      .setMaxTransactionFee(sdk.Hbar.fromTinybars('100000000'))
      .setRegenerateTransactionId(false);
    tx.addTokenTransfer(r.asset, this.accountId, '-' + r.amount).addTokenTransfer(r.asset, r.payTo, r.amount);
    await tx.freeze().sign(key);
    // Browser-safe encoding; protobuf TransactionList, NOT a single Transaction.
    let binary = '';
    for (const byte of tx.toBytes()) binary += String.fromCharCode(byte);
    const p: HederaPaymentPayload = { x402Version: 2, accepted: r, payload: { transaction: btoa(binary) } };
    if (resource) p.resource = { ...resource };
    return p;
  }
  async signPayment(paymentInfo: PaymentInfo, chain: ChainConfig): Promise<string> {
    if (!this.connected) throw new Error('Hedera wallet is not connected');
    if (chain.name !== this.network || paymentInfo.x402Version === 1) throw new Error('Hedera requires this ledger and x402 v2');
    if (paymentInfo.extensions && Object.keys(paymentInfo.extensions).length) throw new Error('Hedera extensions are unsupported');
    if (!paymentInfo.accepted) throw new Error('Hedera signing requires the exact accepted offer from the 402');
    const r = validateHederaRequirements(paymentInfo.accepted);
    const tokenType = paymentInfo.tokenType ?? 'usdc';
    const asset = tokenType === 'usdc' ? networkInfo(this.network).usdc : '';
    if (r.asset !== asset || r.payTo !== paymentInfo.recipient || parseUnits(paymentInfo.amount, 6).toString() !== r.amount) {
      throw new Error('Offer does not match the approved recipient, asset and amount');
    }
    return JSON.stringify(await this.createPaymentPayload(r, paymentInfo.resource));
  }
  encodePaymentHeader(payload: string, chain: ChainConfig, version: X402Version = 2): string {
    if (version !== 2 || chain.name !== this.network) throw new Error('Hedera supports only x402 v2 on the bound ledger');
    const p = JSON.parse(payload) as HederaPaymentPayload;
    buildHederaRequest(p, p.accepted);
    return encodeBase64Json(p);
  }
  async getBalance(chain: ChainConfig, tokenType: TokenType = 'usdc'): Promise<string> {
    if (chain.name !== this.network) throw new Error('Provider is bound to another Hedera ledger');
    const info = networkInfo(this.network);
    if (!['usdc', 'hbar'].includes(tokenType)) throw new Error('Unsupported Hedera token');
    const path = tokenType === 'hbar' ? '' : `/tokens?token.id=${info.usdc}`;
    const response = await fetch(`${info.mirror}/api/v1/accounts/${this.accountId}${path}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Hedera balance HTTP ${response.status}`);
    const data = await response.json();
    const amount = tokenType === 'hbar' ? data.balance?.balance : data.tokens?.[0]?.balance ?? 0;
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Mirror returned an unsafe balance');
    return formatUnits(BigInt(amount), tokenType === 'hbar' ? 8 : 6);
  }
}
export default HederaProvider;
