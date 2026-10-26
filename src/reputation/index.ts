/**
 * uvd-x402-sdk/reputation - write ERC-8004 ratings signed by the RATER and
 * relayed by the facilitator, one implementation for every program.
 *
 * - {@link messageRef} - the deterministic key of the thing rated.
 * - {@link validatePreparation} - refuse to sign anything but the rating asked for.
 * - {@link signRelayedFeedback}, {@link buildRelayAuthorization} - the
 *   EIP-712 rating and the EIP-7702 authorization, low-s, self-checked.
 * - {@link payAndProve} - the anchor payment and its `ProofOfPayment`.
 * - {@link RatingOutbox} - the persistent queue: {@link MemoryRatingOutbox},
 *   {@link SqliteRatingOutbox}.
 * - {@link Governor} - caps (parameters) and the circuit breaker.
 * - {@link evidenceDocument} - the public evidence, without chat text or author.
 * - {@link submitWithReconcile}, {@link processRating} - send once, then read
 *   the chain; never prepare twice while a signed rating could land.
 *
 * The module never reads a key: it signs through a {@link ReputationSigner}.
 * Its logs shorten every long hex value and drop proofs and signatures.
 *
 * Same contract as the Python SDK's `uvd_x402_sdk.reputation`; the vectors in
 * `test/vectors/reputation/` are the parity check. See
 * `src/reputation/README.md` for a fifteen-line integration.
 */

export { messageRef, type MessageRefPart } from './message-ref';
export { canonicalJson, canonicalBytes } from './canonical';
export {
  REPUTATION_CHAINS,
  reputationChain,
  reputationChainById,
  MAINNET_IDENTITY_REGISTRY,
  MAINNET_REPUTATION_REGISTRY,
  TESTNET_IDENTITY_REGISTRY,
  TESTNET_REPUTATION_REGISTRY,
  FEEDBACK_DELEGATE_DOMAIN_NAME,
  FEEDBACK_DELEGATE_DOMAIN_VERSION,
  RELAYED_GIVE_FEEDBACK,
  RELAYED_GIVE_FEEDBACK_FIELDS,
  EIP712_DOMAIN_FIELDS,
  NEW_FEEDBACK_TOPIC,
  PROOF_MAX_AGE_SECS,
  type ReputationChain,
  type TypedField,
} from './constants';
export { ReputationError, errorCode, type ReputationErrorCode } from './errors';
export { redact, redactText, type ReputationLogger } from './redact';
export {
  validatePreparation,
  isValidatedPreparation,
  relayedFeedbackDigest,
  MIN_DEADLINE_LEAD_SECS,
  DEFAULT_MAX_DEADLINE_AHEAD_SECS,
  type RelayedFeedbackParams,
  type RelayTypedData,
  type ValidatedPreparation,
  type ValidatePreparationOptions,
} from './validate';
export {
  signRelayedFeedback,
  buildRelayAuthorization,
  authorizationDigest,
  checkSignature,
  signerFromEthers,
  type ReputationSigner,
  type RelayAuthorization,
  type CheckedSignature,
} from './sign';
export {
  payAndProve,
  signPayment,
  provePayment,
  computePaymentHash,
  jsonRpc,
  JsonRpcError,
  DEFAULT_MAX_FEE_PER_GAS_WEI,
  DEFAULT_MAX_GAS_LIMIT,
  type EvmRpc,
  type PaymentFacts,
  type PaymentRequest,
  type GasLimits,
  type SignedPayment,
  type ProveOptions,
  type PayAndProveOptions,
  type ProofOfPayment,
} from './payment';
export {
  evidenceDocument,
  commitment,
  EVIDENCE_SCHEMA,
  COMMITMENT_SCHEME,
  type EvidenceInput,
  type EvidenceDocument,
  type WalletBinding,
} from './evidence';
export {
  MemoryRatingOutbox,
  applyTransition,
  forgetRow,
  ACTIVE_STATUSES,
  type RatingOutbox,
  type RatingRow,
  type RatingStatus,
  type RatingPatch,
  type NewRating,
  type FeedbackInput,
  type Submission,
  type CountFilter,
  type ForgetReport,
} from './outbox';
export { SqliteRatingOutbox, type SqliteDatabase, type SqliteStatement } from './sqlite-outbox';
export {
  Governor,
  describeNetHealth,
  nextUtcMidnight,
  type ReputationCaps,
  type HealthSnapshot,
  type HealthSource,
  type BreakerFailure,
  type BreakerFailureKind,
  type BreakerState,
  type Admission,
  type GovernorOptions,
} from './governor';
export {
  submitWithReconcile,
  processRating,
  classifyFailure,
  matchFeedbackLog,
  retryDelay,
  RETRY_SCHEDULE_SECS,
  REORG_OVERLAP_BLOCKS,
  DEADLINE_GRACE_SECS,
  type RelayFeedbackClient,
  type FeedbackBuild,
  type SubmitDeps,
  type ProcessDeps,
} from './submit';
export { walletDirectory, type WalletDirectory, type WalletEntry } from './directory';
