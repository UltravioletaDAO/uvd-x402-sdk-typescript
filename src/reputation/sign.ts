/**
 * The two signatures of a rater-authored rating, and the checks every
 * signature passes before it leaves the module.
 *
 * 1. `signRelayedFeedback`: the v4 `RelayedGiveFeedback`. The digest is the
 *    one `validatePreparation` rebuilt from this module's constants and
 *    compared to the prepare's, recomputed again here from the frozen
 *    message. A signer with `signHash` signs exactly that digest; one with
 *    only `signTypedData` gets the rebuilt typed data, never the prepare's.
 * 2. `buildRelayAuthorization`: the EIP-7702 authorization of a rater's first
 *    rating on a chain, `keccak256(0x05 || rlp([chainId, delegate, nonce]))`,
 *    built HERE from the module's delegate for that chain id. A prepare never
 *    supplies a hash to sign: a facilitator that could would ask for
 *    `rlp([0, attacker, 0])`, a delegation of the account on every chain.
 *
 * Every signature is then checked: 65 bytes, `s` in the lower half of the
 * curve order (a high-`s` signature is aborted, not flipped, because flipping
 * it needs `v` recomputed and a signer that emits one has changed), and it
 * must recover to the rater. A remote or delegated signer that answers with
 * someone else's signature is caught here, not on-chain.
 *
 * Low-s and the own digest come from KarmaKadabra
 * (`agents_sdk/rating_rail.py::firmar_rating`, `armar_authorization`); the
 * rebuilt typed data from Execution Market (`shared/relayed-rating.ts`).
 */

import { ethers } from 'ethers';
import { SECP256K1_N, reputationChainById } from './constants';
import { ReputationError } from './errors';
import { redactText } from './redact';
import {
  isValidatedPreparation,
  relayedFeedbackDigest,
  type RelayTypedData,
  type ValidatedPreparation,
} from './validate';
import { bytes32Of, isAddress, sameAddress } from './values';

/**
 * What the module signs with. The key never enters the module: a signer is
 * an address plus one or both signing functions, backed by anything (a local
 * key, a KMS, a remote wallet).
 */
export interface ReputationSigner {
  /** The rater's EVM address. */
  readonly address: string;
  /**
   * Sign a 32-byte prehash as it is, with no envelope (`0x`-prefixed hex in,
   * 65-byte `r || s || v` hex out). Needed for the EIP-7702 authorization
   * and for paying.
   */
  signHash?(digest: string): Promise<string>;
  /** Sign an `eth_signTypedData_v4` payload (types include `EIP712Domain`). */
  signTypedData?(typedData: RelayTypedData): Promise<string>;
}

/** A signer over an ethers `SigningKey` or wallet. The key stays inside ethers; nothing here exposes it. */
export function signerFromEthers(source: ethers.SigningKey | ethers.BaseWallet): ReputationSigner {
  const key = source instanceof ethers.SigningKey ? source : source.signingKey;
  const address = ethers.computeAddress(key.publicKey);
  return Object.freeze({
    address,
    async signHash(digest: string): Promise<string> {
      return key.sign(digest).serialized;
    },
  });
}

/** An EIP-7702 authorization, in the shape `/feedback/evm/submit` takes. */
export interface RelayAuthorization {
  chainId: number;
  address: string;
  nonce: number;
  yParity: number;
  r: string;
  s: string;
}

export interface CheckedSignature {
  /** `r || s || v` with `v` = 27 or 28, lowercase hex. */
  serialized: string;
  r: string;
  s: string;
  yParity: 0 | 1;
}

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * Parse a 65-byte signature, refuse a malleable or degenerate one, and check
 * that it recovers to `signer` over `digest`.
 */
export function checkSignature(signature: unknown, digest: string, signer: string): CheckedSignature {
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) {
    throw new ReputationError('bad_signature', 'the signer did not return a 65-byte hex signature');
  }
  const hex = signature.slice(2).toLowerCase();
  const r = BigInt('0x' + hex.slice(0, 64));
  const s = BigInt('0x' + hex.slice(64, 128));
  const v = parseInt(hex.slice(128, 130), 16);
  let yParity: 0 | 1;
  if (v === 0 || v === 27) yParity = 0;
  else if (v === 1 || v === 28) yParity = 1;
  else throw new ReputationError('bad_signature', `the signature has v = ${v}`);
  if (r === 0n || r >= SECP256K1_N || s === 0n || s >= SECP256K1_N) {
    throw new ReputationError('bad_signature', 'the signature r or s is out of range');
  }
  if (s > SECP256K1_N / 2n) {
    throw new ReputationError('high_s', 'the signer returned a high-s signature; aborted, not flipped');
  }
  const rHex = '0x' + hex.slice(0, 64);
  const sHex = '0x' + hex.slice(64, 128);
  const recovered = ethers.recoverAddress(digest, { r: rHex, s: sHex, yParity });
  if (!sameAddress(recovered, signer)) {
    throw new ReputationError(
      'signature_mismatch',
      redactText(`the signature recovers ${recovered}, not the rater ${signer}`)
    );
  }
  return {
    serialized: `${rHex}${sHex.slice(2)}${(27 + yParity).toString(16)}`,
    r: rHex,
    s: sHex,
    yParity,
  };
}

function assertSigner(signer: ReputationSigner, rater: string): void {
  if (!signer || !isAddress(signer.address)) {
    throw new ReputationError('signer_unavailable', 'the signer has no EVM address');
  }
  if (!sameAddress(signer.address, rater)) {
    throw new ReputationError(
      'rater_mismatch',
      redactText(`the rating was prepared for ${rater}, the signer is ${signer.address}`)
    );
  }
}

/** Sign the validated rating. Returns the 65-byte signature for `/feedback/evm/submit`. */
export async function signRelayedFeedback(
  validated: ValidatedPreparation,
  signer: ReputationSigner
): Promise<string> {
  if (!isValidatedPreparation(validated)) {
    throw new ReputationError('not_validated', 'only a validatePreparation result is ever signed');
  }
  assertSigner(signer, validated.rater);
  const digest = relayedFeedbackDigest(validated.chainId, validated.rater, validated.typedData.message);
  if (digest !== validated.digest) {
    throw new ReputationError('digest_mismatch', 'the validated rating no longer hashes to its digest');
  }
  let raw: unknown;
  if (typeof signer.signHash === 'function') {
    raw = await signer.signHash(digest);
  } else if (typeof signer.signTypedData === 'function') {
    const td = validated.typedData;
    raw = await signer.signTypedData({
      domain: { ...td.domain },
      types: Object.fromEntries(Object.entries(td.types).map(([k, v]) => [k, v.map((f) => ({ ...f }))])),
      primaryType: td.primaryType,
      message: { ...td.message },
    });
  } else {
    throw new ReputationError('signer_unavailable', 'the signer can sign neither a hash nor typed data');
  }
  return checkSignature(raw, digest, validated.rater).serialized;
}

/** `keccak256(0x05 || rlp([chainId, address, nonce]))`, the EIP-7702 authorization digest. */
export function authorizationDigest(chainId: number, address: string, nonce: number | bigint): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    // chainId 0 is EIP-7702's wildcard: valid on every chain at once.
    throw new ReputationError('invalid_input', 'an authorization needs a positive chain id');
  }
  if (!isAddress(address)) throw new ReputationError('invalid_input', 'authorization address is not an address');
  const n = BigInt(nonce);
  if (n < 0n || n >= 1n << 64n) throw new ReputationError('invalid_input', 'authorization nonce is not a uint64');
  const rlp = ethers.encodeRlp([ethers.toBeArray(chainId), address.toLowerCase(), ethers.toBeArray(n)]);
  return ethers.keccak256(ethers.concat(['0x05', rlp])).toLowerCase();
}

/**
 * Sign the EIP-7702 authorization a rater's first rating on a chain needs.
 * Throws `authorization_not_needed` when the prepare says the rater is
 * already delegated: nothing is signed that the submit would not carry.
 */
export async function buildRelayAuthorization(
  validated: ValidatedPreparation,
  signer: ReputationSigner
): Promise<RelayAuthorization> {
  if (!isValidatedPreparation(validated)) {
    throw new ReputationError('not_validated', 'only a validatePreparation result is ever signed');
  }
  if (validated.delegated) {
    throw new ReputationError('authorization_not_needed', 'the rater is already delegated on this chain');
  }
  assertSigner(signer, validated.rater);
  const chain = reputationChainById(validated.chainId);
  if (!chain || !sameAddress(chain.delegate, validated.delegate)) {
    throw new ReputationError('delegate_mismatch', 'the delegate is not this chain\'s');
  }
  if (validated.accountNonce === null) {
    throw new ReputationError('account_nonce', 'a first rating needs the account nonce');
  }
  if (typeof signer.signHash !== 'function') {
    throw new ReputationError('signer_unavailable', 'an EIP-7702 authorization needs a signer with signHash');
  }
  const delegate = ethers.getAddress(chain.delegate);
  const digest = authorizationDigest(chain.chainId, delegate, validated.accountNonce);
  const sig = checkSignature(await signer.signHash(digest), digest, validated.rater);
  return {
    chainId: chain.chainId,
    address: delegate,
    nonce: validated.accountNonce,
    yParity: sig.yParity,
    r: sig.r,
    s: sig.s,
  };
}

/** Lowercase `0x` bytes32 or throw, for values this module is about to sign or hash. */
export function requireBytes32(value: unknown, name: string): string {
  const b = bytes32Of(value);
  if (b === null) throw new ReputationError('invalid_input', `${name} is not 32 bytes`);
  return b;
}
