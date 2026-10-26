/**
 * One error class for the module, with a stable snake_case `code`.
 *
 * Branch on `code`, never on the message: messages are prose and are written
 * with every long hex value shortened (see `redact.ts`), so a message can go
 * to a log as it is.
 */

export type ReputationErrorCode =
  // input given to the module
  | 'invalid_input'
  // the prepare, before anything is signed
  | 'prepare_failed'
  | 'unknown_network'
  | 'no_chain'
  | 'chain_mismatch'
  | 'delegate_mismatch'
  | 'rater_mismatch'
  | 'typed_data_missing'
  | 'typed_data_shape'
  | 'primary_type'
  | 'types_mismatch'
  | 'domain_mismatch'
  | 'domain_chain_id'
  | 'domain_verifying_contract'
  | 'message_shape'
  | 'registry'
  | 'value'
  | 'message_binding'
  | 'deadline'
  | 'account_nonce'
  | 'digest_mismatch'
  // signing
  | 'not_validated'
  | 'authorization_not_needed'
  | 'signer_unavailable'
  | 'bad_signature'
  | 'high_s'
  | 'signature_mismatch'
  // payment
  | 'unexpected_chain'
  | 'unsupported_token'
  | 'rpc_failed'
  | 'gas_too_expensive'
  | 'balance_low'
  | 'payment_estimate_failed'
  | 'payment_broadcast_failed'
  | 'payment_pending'
  | 'payment_awaiting_confirmations'
  | 'payment_reverted'
  | 'payment_transfer_missing'
  | 'payment_block_hash_mismatch'
  | 'payment_nonce_consumed'
  | 'payment_mismatch'
  | 'proof_expired'
  // evidence (the Python SDK's codes, pinned by evidence-document.json)
  | 'wallet_binding'
  | 'agent_id'
  | 'private'
  | 'salt'
  | 'commitment_label'
  | 'commitment_value'
  | 'address'
  | 'created_at'
  | 'proof'
  | 'private_field'
  | 'float_in_evidence'
  | 'evidence_type'
  | 'private_value_leaked'
  // outbox and submission
  | 'row_missing'
  | 'invalid_transition'
  | 'feedback_missing'
  | 'identity_owner_mismatch';

/** Codes that name a condition which may clear on its own: retry later, unchanged. */
const RETRYABLE: ReadonlySet<ReputationErrorCode> = new Set<ReputationErrorCode>([
  'rpc_failed',
  'gas_too_expensive',
  'balance_low',
  'payment_broadcast_failed',
  'payment_pending',
  'payment_awaiting_confirmations',
  'payment_block_hash_mismatch',
  'deadline',
]);

export class ReputationError extends Error {
  readonly code: ReputationErrorCode;

  constructor(code: ReputationErrorCode, message: string) {
    super(message);
    this.name = 'ReputationError';
    this.code = code;
  }

  /** The same operation may succeed later without changing anything. */
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

/** The error's code when it is a {@link ReputationError}, else the error's class name. Never its message. */
export function errorCode(error: unknown): string {
  if (error instanceof ReputationError) return error.code;
  if (error instanceof Error && /^[A-Za-z]+$/.test(error.name)) return error.name;
  return 'Error';
}
