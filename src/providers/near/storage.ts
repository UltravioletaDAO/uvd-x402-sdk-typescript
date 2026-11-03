/** Payer-funded NEP-145 calls. These are unsigned normal transactions, never facilitator delegates. */
import { NEAR_ESCROW_TOKENS, type NearEscrowNetwork, type NearUnsigned } from './escrow';
import { account, uint } from './encoding';

export interface NearStorageTransaction {
  signerId: string;
  receiverId: string;
  actions: [{ type: 'FunctionCall'; params: {
    methodName: 'storage_deposit'; args: { account_id: string; registration_only: boolean };
    gas: string; deposit: string;
  } }];
}
export interface NearStorageOptions {
  network: NearEscrowNetwork;
  /** Account that signs the normal transaction and pays its deposit and gas. */
  payerId: string;
  /** Account to register or fund; defaults to payerId. */
  accountId?: string;
  /** YoctoNEAR, not NEAR. Query storage_balance_bounds for the live contract minimum. */
  deposit?: NearUnsigned;
}
/** Explicit trusted deployment configuration; this unsigned builder does not select an account parent. */
export interface ArrasStorageOptions extends NearStorageOptions { escrowContract: string }
export const NEAR_ARRAS_STORAGE_DEPOSIT = '50000000000000000000000'; // 0.05 NEAR; about five payments
export const NEAR_USDC_STORAGE_DEPOSIT = '1250000000000000000000'; // 0.00125 NEAR

function storage(o: NearStorageOptions, receiverId: string, registrationOnly: boolean, defaultDeposit: string): NearStorageTransaction {
  if (o.network !== 'near:mainnet' && o.network !== 'near:testnet') throw new Error('Unsupported NEAR network');
  account(receiverId, 'receiverId');
  if (receiverId === 'intents.near') throw new Error('intents.near is not an allowed storage target');
  account(o.payerId, 'payerId');
  const accountId = o.accountId ?? o.payerId;
  account(accountId, 'accountId');
  const deposit = uint(o.deposit ?? defaultDeposit, 128, 'deposit');
  if (deposit === 0n) throw new Error('storage deposit must be positive');
  return { signerId: o.payerId, receiverId, actions: [{ type: 'FunctionCall', params: {
    methodName: 'storage_deposit', args: { account_id: accountId, registration_only: registrationOnly },
    gas: '30000000000000', deposit: deposit.toString(),
  } }] };
}
/** Keep surplus available for payment storage; registration_only must be false for Arras. */
export function buildArrasStorageDeposit(options: ArrasStorageOptions): NearStorageTransaction {
  const o = { ...options };
  if (o.network !== 'near:mainnet' && o.network !== 'near:testnet') throw new Error('Unsupported NEAR network');
  return storage(o, o.escrowContract, false, NEAR_ARRAS_STORAGE_DEPOSIT);
}
/** Register in native USDC; refund any surplus rather than topping up an FT registration. */
export function buildUsdcStorageDeposit(options: NearStorageOptions): NearStorageTransaction {
  const o = { ...options };
  return storage(o, NEAR_ESCROW_TOKENS[o.network], true, NEAR_USDC_STORAGE_DEPOSIT);
}
