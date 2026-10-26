/**
 * validatePreparation: one case per refusal, each with the one field changed.
 *
 * The prepares are built the way x402-rs builds them
 * (`test/reputation/doubles.ts::prepareAnswer`), and the digest formula is
 * pinned to the v4 delegate DEPLOYED on Base: x402-rs read the domain
 * separator and a full digest with `eth_call` on 2026-08-25
 * (`relay_v4.rs::the_vector_matches_the_deployed_v4_contract`).
 */
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  ReputationError,
  isValidatedPreparation,
  relayedFeedbackDigest,
  validatePreparation,
  type RelayedFeedbackParams,
} from './index';
import { DELEGATE, prepareAnswer, seededAddress } from '../../test/reputation/doubles';

const NOW = 1_793_000_000;
const RATER = seededAddress('uvd-x402 reputation validate rater');
const NONCE = ethers.keccak256(ethers.toUtf8Bytes('validate nonce'));
const PARAMS: RelayedFeedbackParams = {
  network: 'base',
  agentId: 18896,
  value: 90,
  valueDecimals: 0,
  tag1: 'moment:idea',
  tag2: 'credits-roll',
  endpoint: 'https://www.twitch.tv/example',
  feedbackUri: 'https://evidence.test/a.json',
  feedbackHash: ethers.keccak256(ethers.toUtf8Bytes('evidence')),
};

function prep(overrides: { delegated?: boolean; deadline?: number; params?: RelayedFeedbackParams } = {}) {
  const p = overrides.params ?? PARAMS;
  return prepareAnswer({
    rater: RATER,
    feedback: { ...p, agentId: p.agentId, value: p.value },
    deadline: overrides.deadline ?? NOW + 900,
    nonce: NONCE,
    delegated: overrides.delegated ?? false,
    accountNonce: 3,
  });
}

function refused(answer: unknown, code: string, params: RelayedFeedbackParams = PARAMS, rater = RATER) {
  let caught: unknown;
  try {
    validatePreparation(answer, params, rater, { now: NOW });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReputationError);
  expect((caught as ReputationError).code).toBe(code);
}

describe('validatePreparation accepts the rating it asked for', () => {
  it('a first rating: rebuilt typed data, the digest, the account nonce', () => {
    const answer = prep();
    const v = validatePreparation(answer, PARAMS, RATER, { now: NOW });
    expect(isValidatedPreparation(v)).toBe(true);
    expect(v.digest).toBe(answer.digest.toLowerCase());
    expect(v.delegated).toBe(false);
    expect(v.accountNonce).toBe(3);
    expect(v.delegate).toBe(DELEGATE);
    expect(v.typedData.domain.verifyingContract).toBe(RATER);
    expect(v.typedData.message).toEqual(answer.typedData.message);
    expect(Object.isFrozen(v) && Object.isFrozen(v.typedData.message)).toBe(true);
    expect(() => {
      (v.typedData.message as any).value = '100';
    }).toThrow(TypeError);
  });

  it('a delegated rater needs no account nonce', () => {
    const v = validatePreparation(prep({ delegated: true }), PARAMS, RATER, { now: NOW });
    expect(v.delegated).toBe(true);
    expect(v.accountNonce).toBeNull();
  });

  it('compares by value: hex case, a missing 0x, numbers as JSON numbers, the base-mainnet alias', () => {
    const answer = prep();
    answer.nonce = answer.nonce.toUpperCase().replace('0X', '0x');
    answer.typedData.message.nonce = answer.nonce.slice(2);
    answer.typedData.message.feedbackHash = answer.typedData.message.feedbackHash.toUpperCase().replace('0X', '0x');
    answer.typedData.message.agentId = 18896;
    answer.typedData.message.deadline = NOW + 900;
    answer.typedData.domain.verifyingContract = RATER.toLowerCase();
    const params = { ...PARAMS, network: 'base-mainnet', feedbackHash: (PARAMS.feedbackHash as string).slice(2) };
    const v = validatePreparation(answer, params, RATER.toUpperCase().replace('0X', '0x'), { now: NOW });
    expect(v.digest).toBe(prep().digest.toLowerCase());
    expect(v.network).toBe('base');
  });

  it('an absent feedbackHash is the zero hash the facilitator puts in', () => {
    const params = { ...PARAMS, feedbackHash: undefined };
    const answer = prep({ params });
    expect(answer.typedData.message.feedbackHash).toBe('0x' + '00'.repeat(32));
    expect(validatePreparation(answer, params, RATER, { now: NOW }).digest).toBe(answer.digest.toLowerCase());
  });
});

describe('the digest is the deployed contract\'s', () => {
  // x402-rs src/erc8004/relay_v4.rs, `the_vector_matches_the_deployed_v4_contract`.
  it('reproduces the vector read from the v4 delegate on Base', () => {
    const account = '0x260D3D0258680aA458D0EBB8BcAE8A2f68bf6163';
    expect(
      ethers.TypedDataEncoder.hashDomain({ name: 'FeedbackDelegate', version: '1', chainId: 8453, verifyingContract: account })
    ).toBe('0xae792427891b13b5663e321e5c8802c304437aad75338e22a4b8e1a47243d09d');
    const digest = relayedFeedbackDigest(8453, account, {
      registry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
      agentId: '2106',
      value: '95',
      valueDecimals: 0,
      tag1: 'quality',
      tag2: 'api',
      endpoint: 'https://agent.example',
      feedbackURI: 'https://execution.market/feedback/abc',
      feedbackHash: '0x' + '00'.repeat(32),
      deadline: '1787662172',
      nonce: '0x' + '42'.repeat(32),
    });
    expect(digest).toBe('0xa7a2a62dd18c44c79f7c252d628f32b3c46234b20d237866154dbe118ebaf6e1');
  });
});

describe('validatePreparation refuses', () => {
  const at = (f: (a: any) => void) => {
    const a = prep();
    f(a);
    return a;
  };

  it.each<[string, unknown, string]>([
    ['a failed prepare', at((a) => (a.success = false)), 'prepare_failed'],
    ['no answer at all', null, 'prepare_failed'],
    ['an array', [prep()], 'prepare_failed'],
    ['another chain id', at((a) => (a.chainId = 1)), 'chain_mismatch'],
    ['a chain id as text', at((a) => (a.chainId = 'base')), 'chain_mismatch'],
    ['another delegate', at((a) => (a.delegate = '0x000000000000000000000000000000000000dEaD')), 'delegate_mismatch'],
    ['arc\'s delegate on base', at((a) => (a.delegate = '0x955Cc9fB9aB95FC0821ae74197D273dde5dA84f1')), 'delegate_mismatch'],
    ['no delegate', at((a) => delete a.delegate), 'delegate_mismatch'],
    ['no typed data (v3)', at((a) => delete a.typedData), 'typed_data_missing'],
    ['typed data under the snake-case key', at((a) => ((a.typed_data = a.typedData), delete a.typedData)), 'typed_data_missing'],
    ['an extra typed-data key', at((a) => (a.typedData.extra = 1)), 'typed_data_shape'],
    ['a revoke', at((a) => (a.typedData.primaryType = 'RelayedRevokeFeedback')), 'primary_type'],
    ['a Permit', at((a) => (a.typedData.primaryType = 'Permit')), 'primary_type'],
    ['two fields swapped', at((a) => a.typedData.types.RelayedGiveFeedback.reverse()), 'types_mismatch'],
    ['a field retyped', at((a) => (a.typedData.types.RelayedGiveFeedback[2].type = 'uint256')), 'types_mismatch'],
    ['an extra type', at((a) => (a.typedData.types.Other = [])), 'types_mismatch'],
    ['no EIP712Domain type', at((a) => delete a.typedData.types.EIP712Domain), 'types_mismatch'],
    ['an extra key on a field', at((a) => (a.typedData.types.RelayedGiveFeedback[0].x = 1)), 'types_mismatch'],
    ['another domain name', at((a) => (a.typedData.domain.name = 'USD Coin')), 'domain_mismatch'],
    ['another domain version', at((a) => (a.typedData.domain.version = '2')), 'domain_mismatch'],
    ['a domain salt', at((a) => (a.typedData.domain.salt = '0x' + '00'.repeat(32))), 'domain_mismatch'],
    ['a domain on another chain', at((a) => (a.typedData.domain.chainId = 84532)), 'domain_chain_id'],
    ['the delegate as verifyingContract', at((a) => (a.typedData.domain.verifyingContract = DELEGATE)), 'domain_verifying_contract'],
    ['an extra message field', at((a) => (a.typedData.message.extra = '1')), 'message_shape'],
    ['a missing message field', at((a) => delete a.typedData.message.tag2), 'message_shape'],
    ['the testnet registry', at((a) => (a.typedData.message.registry = '0x8004B663056A597Dffe9eCcC1965A193B7388713')), 'registry'],
    ['no nonce on the prepare', at((a) => delete a.nonce), 'message_shape'],
    ['no deadline on the prepare', at((a) => delete a.deadline), 'message_shape'],
    ['another agent', at((a) => (a.typedData.message.agentId = '18897')), 'field_mismatch'],
    ['another score', at((a) => (a.typedData.message.value = '100')), 'field_mismatch'],
    ['other decimals', at((a) => (a.typedData.message.valueDecimals = 2)), 'field_mismatch'],
    ['another tag1', at((a) => (a.typedData.message.tag1 = 'starred')), 'field_mismatch'],
    ['another tag2', at((a) => (a.typedData.message.tag2 = '')), 'field_mismatch'],
    ['another endpoint', at((a) => (a.typedData.message.endpoint = 'https://evil.test')), 'field_mismatch'],
    ['another feedbackURI', at((a) => (a.typedData.message.feedbackURI = 'https://evil.test/doc')), 'field_mismatch'],
    ['another feedbackHash', at((a) => (a.typedData.message.feedbackHash = '0x' + '11'.repeat(32))), 'field_mismatch'],
    ['a message deadline that is not the prepare\'s', at((a) => (a.typedData.message.deadline = String(NOW + 901))), 'field_mismatch'],
    ['a message nonce that is not the prepare\'s', at((a) => (a.typedData.message.nonce = '0x' + '22'.repeat(32))), 'field_mismatch'],
    ['a score of 9.5', at((a) => (a.typedData.message.value = '9.5')), 'field_mismatch'],
    ['no account nonce on a first rating', at((a) => delete a.accountNonce), 'account_nonce'],
    ['an account nonce past uint64', at((a) => (a.accountNonce = '18446744073709551616')), 'account_nonce'],
    ['no delegated flag', at((a) => delete a.delegated), 'message_shape'],
    ['another digest', at((a) => (a.digest = '0x' + '5a'.repeat(32))), 'digest_mismatch'],
    ['no digest', at((a) => delete a.digest), 'digest_mismatch'],
  ])('%s', (_name, answer, code) => refused(answer, code));

  it('a deadline too close, too far, or past', () => {
    refused(prep({ deadline: NOW + 15 }), 'deadline');
    refused(prep({ deadline: NOW + 3601 }), 'deadline');
    refused(prep({ deadline: NOW - 1 }), 'deadline');
    expect(() => validatePreparation(prep({ deadline: NOW + 3600 }), PARAMS, RATER, { now: NOW })).not.toThrow();
    expect(() => validatePreparation(prep({ deadline: NOW + 16 }), PARAMS, RATER, { now: NOW })).not.toThrow();
  });

  it('never accepts a deadline more than a day out, whatever the option says', () => {
    const far = prep({ deadline: NOW + 86_401 });
    expect(() => validatePreparation(far, PARAMS, RATER, { now: NOW, maxDeadlineAheadSecs: 10 ** 9 })).toThrow(ReputationError);
    const day = prep({ deadline: NOW + 86_400 });
    expect(() => validatePreparation(day, PARAMS, RATER, { now: NOW, maxDeadlineAheadSecs: 10 ** 9 })).not.toThrow();
  });

  it('a rating prepared for another rater', () => {
    refused(prep(), 'domain_verifying_contract', PARAMS, seededAddress('someone else'));
  });

  it('a network without a delegate', () => {
    refused(prep(), 'unknown_chain', { ...PARAMS, network: 'avalanche' });
    refused(prep(), 'unknown_chain', { ...PARAMS, network: 'arc-testnet' });
  });

  it.each<[string, Partial<RelayedFeedbackParams> | null, string]>([
    ['a negative agent', { agentId: -1 }, 'invalid_input'],
    ['a fractional score', { value: 1.5 }, 'invalid_input'],
    ['19 decimals', { valueDecimals: 19 }, 'invalid_input'],
    ['a tag with a newline', { tag1: 'a\nb' }, 'invalid_input'],
    ['a 31-byte hash', { feedbackHash: '0x' + '11'.repeat(31) }, 'invalid_input'],
  ])('params with %s', (_name, patch, code) => {
    refused(prep(), code, { ...PARAMS, ...patch });
  });

  it('a rater that is not an address', () => {
    refused(prep(), 'invalid_input', PARAMS, 'not-an-address');
  });
});
