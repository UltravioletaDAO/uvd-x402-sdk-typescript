/**
 * `validatePreparation`: refuse to sign anything except the exact rating we
 * asked for.
 *
 * The facilitator's `/feedback/evm/prepare` answers with EIP-712 typed data
 * and a digest. A compromised facilitator, a hijacked DNS record or a wrong
 * base URL controls that answer, and the rater's key signs it. So nothing is
 * taken from it on trust:
 *
 * - the chain, the delegate and the registry must be this module's row for
 *   the network asked for (`constants.ts`), never whatever the prepare names;
 * - domain, types and `primaryType` must be the v4 `RelayedGiveFeedback`, key
 *   for key and field for field (the same delegate accepts
 *   `RelayedRevokeFeedback`, which destroys one of the rater's own ratings);
 * - `verifyingContract` must be the rater: under EIP-7702 the delegate runs as
 *   the rater's EOA, and that is what binds a signature to one account;
 * - every message field must equal what WE sent (`params`) or what the
 *   prepare itself issued for this one request (`deadline`, `nonce`);
 * - the digest is rebuilt from those values and must equal the prepare's.
 *
 * What comes back is rebuilt from this module's constants, frozen, and
 * registered: `signRelayedFeedback` and `buildRelayAuthorization` refuse any
 * object that did not come out of this function.
 *
 * Merged from Karma Hello (`services/reputation/live.py::validate_preparation`:
 * every field bound to the request), Execution Market
 * (`shared/relayed-rating.ts::verifyRelayedRatingPrepare`: exact keys, a code
 * per refusal, values compared by value) and KarmaKadabra
 * (`agents_sdk/rating_rail.py::firmar_rating`: the digest rebuilt here and
 * compared, never signed as received).
 */

import { ethers } from 'ethers';
import {
  EIP712_DOMAIN_FIELDS,
  FEEDBACK_DELEGATE_DOMAIN_NAME,
  FEEDBACK_DELEGATE_DOMAIN_VERSION,
  RELAYED_GIVE_FEEDBACK,
  RELAYED_GIVE_FEEDBACK_FIELDS,
  ZERO_BYTES32,
  reputationChain,
  type TypedField,
} from './constants';
import { ReputationError } from './errors';
import { redactText } from './redact';
import {
  MAX_UINT64,
  bytes32Of,
  hasExactKeys,
  int128Of,
  isAddress,
  isRecord,
  safeUint,
  sameAddress,
  uintOf,
  CONTROL,
} from './values';

/** The rating this program asked the facilitator to prepare. */
export interface RelayedFeedbackParams {
  /** Facilitator network name, e.g. `base`. */
  network: string;
  agentId: string | number | bigint;
  value: string | number | bigint;
  /** 0..18; default 0. */
  valueDecimals?: number;
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  feedbackUri?: string;
  /** 32 bytes; default zero (what the facilitator puts in when it is absent). */
  feedbackHash?: string | null;
}

/** EIP-712 typed data as a wallet takes it. */
export interface RelayTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, string | number>;
}

/** A prepare that passed every check. Frozen; only this module creates one. */
export interface ValidatedPreparation {
  readonly network: string;
  readonly chainId: number;
  /** This chain's delegate, from the module's table (checksummed). */
  readonly delegate: string;
  /** The rater (checksummed). */
  readonly rater: string;
  /** Rebuilt from the module's constants: the only thing ever handed to a signer. */
  readonly typedData: Readonly<RelayTypedData>;
  /** The EIP-712 digest of {@link typedData}, lowercase `0x` hex. */
  readonly digest: string;
  readonly deadline: number;
  /** The single-use nonce, lowercase `0x` hex. */
  readonly nonce: string;
  /** `false`: the first rating of this rater on this chain, which needs an EIP-7702 authorization. */
  readonly delegated: boolean;
  /** The rater's account nonce, present when an authorization is needed. */
  readonly accountNonce: number | null;
}

export interface ValidatePreparationOptions {
  /** Unix seconds; default the system clock. */
  now?: number;
  /**
   * Latest acceptable deadline, in seconds from `now`. Default 3600 (the
   * facilitator issues 900). Capped at 86400: past it a signature is a
   * standing permission, not an answer to this request.
   */
  maxDeadlineAheadSecs?: number;
}

const VALIDATED = new WeakSet<object>();

/** Whether `value` came out of {@link validatePreparation} unchanged. */
export function isValidatedPreparation(value: unknown): value is ValidatedPreparation {
  return typeof value === 'object' && value !== null && VALIDATED.has(value);
}

/** Below this many seconds of life left, a prepare is too close to expiring to sign. */
export const MIN_DEADLINE_LEAD_SECS = 15;
export const DEFAULT_MAX_DEADLINE_AHEAD_SECS = 3600;
const MAX_DEADLINE_AHEAD_CEILING_SECS = 86400;
const MAX_STRING_BYTES = 2048;

function reject(code: ConstructorParameters<typeof ReputationError>[0], message: string): never {
  throw new ReputationError(code, redactText(message));
}

function sameFields(actual: unknown, expected: readonly TypedField[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every(
      (f, i) =>
        isRecord(f) &&
        hasExactKeys(f, ['name', 'type']) &&
        f.name === expected[i].name &&
        f.type === expected[i].type
    )
  );
}

function textParam(value: unknown, name: string): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || CONTROL.test(value)) {
    reject('invalid_input', `params.${name} must be a string without control characters`);
  }
  if (new TextEncoder().encode(value).length > MAX_STRING_BYTES) {
    reject('invalid_input', `params.${name} is longer than ${MAX_STRING_BYTES} bytes`);
  }
  return value;
}

/** The message the prepare must carry, from what this program asked for. */
function expectedMessage(params: RelayedFeedbackParams) {
  if (!isRecord(params)) reject('invalid_input', 'params must be an object');
  const agentId = uintOf(params.agentId);
  if (agentId === null) reject('invalid_input', 'params.agentId is not a uint256');
  const value = int128Of(params.value);
  if (value === null) reject('invalid_input', 'params.value is not an int128');
  const valueDecimals = params.valueDecimals ?? 0;
  if (!Number.isSafeInteger(valueDecimals) || valueDecimals < 0 || valueDecimals > 18) {
    reject('invalid_input', 'params.valueDecimals must be an integer from 0 to 18');
  }
  let feedbackHash = ZERO_BYTES32;
  if (params.feedbackHash !== undefined && params.feedbackHash !== null) {
    const hash = bytes32Of(params.feedbackHash);
    if (hash === null) reject('invalid_input', 'params.feedbackHash is not 32 bytes');
    feedbackHash = hash;
  }
  return {
    agentId,
    value,
    valueDecimals,
    tag1: textParam(params.tag1, 'tag1'),
    tag2: textParam(params.tag2, 'tag2'),
    endpoint: textParam(params.endpoint, 'endpoint'),
    feedbackURI: textParam(params.feedbackUri, 'feedbackUri'),
    feedbackHash,
  };
}

/** The EIP-712 digest of a `RelayedGiveFeedback` for `rater` on `chainId`, from the module's own types. */
export function relayedFeedbackDigest(
  chainId: number,
  rater: string,
  message: Record<string, unknown>
): string {
  return ethers.TypedDataEncoder.hash(
    {
      name: FEEDBACK_DELEGATE_DOMAIN_NAME,
      version: FEEDBACK_DELEGATE_DOMAIN_VERSION,
      chainId,
      verifyingContract: rater,
    },
    { [RELAYED_GIVE_FEEDBACK]: RELAYED_GIVE_FEEDBACK_FIELDS.map((f) => ({ ...f })) },
    message
  ).toLowerCase();
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * Check a `/feedback/evm/prepare` answer against the rating in `params` for
 * `rater`, and return what may be signed. Throws {@link ReputationError} with
 * a code naming the first thing that differs; nothing is signed by this
 * function.
 */
export function validatePreparation(
  prep: unknown,
  params: RelayedFeedbackParams,
  rater: string,
  options: ValidatePreparationOptions = {}
): ValidatedPreparation {
  if (!isAddress(rater)) reject('invalid_input', 'rater is not an address');
  const expected = expectedMessage(params);
  const chain = reputationChain(String(params.network));
  if (!chain) reject('unknown_chain', `no FeedbackDelegate is known for network ${String(params.network)}`);

  if (!isRecord(prep) || prep.success !== true) {
    reject('prepare_failed', 'the prepare did not succeed');
  }
  if (safeUint(prep.chainId) !== chain.chainId) {
    reject('chain_mismatch', `the prepare is for chain ${String(prep.chainId)}, the rating for ${chain.chainId}`);
  }
  if (!sameAddress(prep.delegate, chain.delegate)) {
    reject('delegate_mismatch', `the prepare names delegate ${String(prep.delegate)}, not this chain's`);
  }

  const td = prep.typedData;
  if (!isRecord(td)) {
    reject('typed_data_missing', 'the prepare carries no EIP-712 typed data (v3 opaque hashes are never signed)');
  }
  if (!hasExactKeys(td, ['domain', 'types', 'primaryType', 'message'])) {
    reject('typed_data_shape', 'the typed data has unexpected keys');
  }
  if (td.primaryType !== RELAYED_GIVE_FEEDBACK) {
    reject('primary_type', `refusing to sign a ${String(td.primaryType).slice(0, 40)}`);
  }
  const types = td.types;
  if (
    !isRecord(types) ||
    !hasExactKeys(types, ['EIP712Domain', RELAYED_GIVE_FEEDBACK]) ||
    !sameFields(types.EIP712Domain, EIP712_DOMAIN_FIELDS) ||
    !sameFields(types[RELAYED_GIVE_FEEDBACK], RELAYED_GIVE_FEEDBACK_FIELDS)
  ) {
    reject('types_mismatch', 'the types are not the v4 RelayedGiveFeedback');
  }
  const domain = td.domain;
  if (
    !isRecord(domain) ||
    !hasExactKeys(domain, ['name', 'version', 'chainId', 'verifyingContract']) ||
    domain.name !== FEEDBACK_DELEGATE_DOMAIN_NAME ||
    domain.version !== FEEDBACK_DELEGATE_DOMAIN_VERSION
  ) {
    reject('domain_mismatch', 'the domain is not FeedbackDelegate v1');
  }
  if (uintOf(domain.chainId) !== BigInt(chain.chainId)) {
    reject('domain_chain_id', `the domain is for chain ${String(domain.chainId)}`);
  }
  if (!sameAddress(domain.verifyingContract, rater)) {
    reject('domain_verifying_contract', 'the domain verifyingContract is not the rater');
  }

  const message = td.message;
  if (!isRecord(message) || !hasExactKeys(message, RELAYED_GIVE_FEEDBACK_FIELDS.map((f) => f.name))) {
    reject('message_shape', 'the message does not carry exactly the RelayedGiveFeedback fields');
  }
  if (!sameAddress(message.registry, chain.reputationRegistry)) {
    reject('registry', 'the message registry is not the ReputationRegistry of this chain');
  }

  const deadline = safeUint(prep.deadline);
  const nonce = bytes32Of(prep.nonce);
  if (deadline === null || nonce === null) {
    reject('message_shape', 'the prepare carries no usable deadline or nonce');
  }
  const bound: Array<[string, boolean]> = [
    ['agentId', uintOf(message.agentId) === expected.agentId],
    ['value', int128Of(message.value) === expected.value],
    ['valueDecimals', uintOf(message.valueDecimals) === BigInt(expected.valueDecimals)],
    ['tag1', message.tag1 === expected.tag1],
    ['tag2', message.tag2 === expected.tag2],
    ['endpoint', message.endpoint === expected.endpoint],
    ['feedbackURI', message.feedbackURI === expected.feedbackURI],
    ['feedbackHash', bytes32Of(message.feedbackHash) === expected.feedbackHash],
    ['deadline', uintOf(message.deadline) === BigInt(deadline)],
    ['nonce', bytes32Of(message.nonce) === nonce],
  ];
  const unbound = bound.find(([, ok]) => !ok);
  if (unbound) {
    reject('field_mismatch', `the message ${unbound[0]} is not the one this rating asked for`);
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ahead = Math.min(
    options.maxDeadlineAheadSecs ?? DEFAULT_MAX_DEADLINE_AHEAD_SECS,
    MAX_DEADLINE_AHEAD_CEILING_SECS
  );
  if (!(deadline > now + MIN_DEADLINE_LEAD_SECS && deadline <= now + ahead)) {
    reject('deadline', `the deadline ${deadline} is outside (now + ${MIN_DEADLINE_LEAD_SECS}, now + ${ahead}]`);
  }

  const delegated = prep.delegated;
  if (typeof delegated !== 'boolean') reject('message_shape', 'the prepare does not say whether the rater is delegated');
  let accountNonce: number | null = null;
  if (!delegated) {
    const n = uintOf(prep.accountNonce, MAX_UINT64);
    if (n === null || n > BigInt(Number.MAX_SAFE_INTEGER)) {
      reject('account_nonce', 'a first rating needs the account nonce, and the prepare has none usable');
    }
    accountNonce = Number(n);
  }

  const raterChecksum = ethers.getAddress(rater.toLowerCase());
  const rebuilt: Record<string, string | number> = {
    registry: ethers.getAddress(chain.reputationRegistry),
    agentId: expected.agentId.toString(),
    value: expected.value.toString(),
    valueDecimals: expected.valueDecimals,
    tag1: expected.tag1,
    tag2: expected.tag2,
    endpoint: expected.endpoint,
    feedbackURI: expected.feedbackURI,
    feedbackHash: expected.feedbackHash,
    deadline: String(deadline),
    nonce,
  };
  const digest = relayedFeedbackDigest(chain.chainId, raterChecksum, rebuilt);
  if (bytes32Of(prep.digest) !== digest) {
    reject('digest_mismatch', `the prepare digest ${String(prep.digest)} is not the rating rebuilt here (${digest})`);
  }

  const validated: ValidatedPreparation = deepFreeze({
    network: chain.network,
    chainId: chain.chainId,
    delegate: ethers.getAddress(chain.delegate),
    rater: raterChecksum,
    typedData: {
      domain: {
        name: FEEDBACK_DELEGATE_DOMAIN_NAME,
        version: FEEDBACK_DELEGATE_DOMAIN_VERSION,
        chainId: chain.chainId,
        verifyingContract: raterChecksum,
      },
      types: {
        EIP712Domain: EIP712_DOMAIN_FIELDS.map((f) => ({ ...f })),
        [RELAYED_GIVE_FEEDBACK]: RELAYED_GIVE_FEEDBACK_FIELDS.map((f) => ({ ...f })),
      },
      primaryType: RELAYED_GIVE_FEEDBACK,
      message: rebuilt,
    },
    digest,
    deadline,
    nonce,
    delegated,
    accountNonce,
  });
  VALIDATED.add(validated);
  return validated;
}
