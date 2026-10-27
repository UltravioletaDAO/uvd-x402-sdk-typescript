/**
 * The signatures: what is signed, and every check a signature passes before
 * it leaves the module (65 bytes, low-s, recovers to the rater).
 *
 * The EIP-7702 digest is checked against two other implementations: ethers'
 * `hashAuthorization`, and the hand-written RLP of KarmaKadabra's
 * `agents_sdk/rating_rail.py::digest_autorizacion_7702`, ported below.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import { SECP256K1_N as SECP256K1_N_FOR_TESTS } from './constants';
import {
  ReputationError,
  authorizationDigest,
  buildRelayAuthorization,
  checkSignature,
  signRelayedFeedback,
  signerFromEthers,
  validatePreparation,
  type ReputationSigner,
  type ValidatedPreparation,
} from './index';
import { DELEGATE, prepareAnswer, seedKey } from '../../test/reputation/doubles';

const NOW = 1_793_000_000;
const KEY = new ethers.SigningKey(seedKey('uvd-x402 reputation sign rater'));
const RATER = ethers.computeAddress(KEY.publicKey);
const SIGNER = signerFromEthers(KEY);
const OTHER = new ethers.SigningKey(seedKey('uvd-x402 reputation someone else'));
const PARAMS = { network: 'base', agentId: 7, value: 85, tag1: 'moment:assist' };

function validated(delegated = false): ValidatedPreparation {
  const answer = prepareAnswer({
    rater: RATER,
    feedback: PARAMS,
    deadline: NOW + 900,
    nonce: ethers.keccak256(ethers.toUtf8Bytes('sign nonce')),
    delegated,
    accountNonce: 5,
  });
  return validatePreparation(answer, PARAMS, RATER, { now: NOW });
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(ReputationError);
    return (error as ReputationError).code;
  }
  throw new Error('expected a ReputationError');
}

/** Recover without the low-s rule ethers applies, to show a flipped signature is still valid ECDSA. */
function recoverAllowingHighS(digest: string, serialized: string): string {
  const bytes = ethers.getBytes(serialized);
  const sig = new secp256k1.Signature(
    BigInt(ethers.hexlify(bytes.slice(0, 32))),
    BigInt(ethers.hexlify(bytes.slice(32, 64)))
  ).addRecoveryBit(bytes[64] - 27);
  const point = sig.recoverPublicKey(ethers.getBytes(digest).slice());
  return ethers.computeAddress('0x' + point.toHex(false));
}

/** The same signature with `s` flipped to the upper half: valid ECDSA, malleable. */
function highS(serialized: string): string {
  const sig = ethers.Signature.from(serialized);
  const s = SECP256K1_N_FOR_TESTS - BigInt(sig.s);
  const v = sig.v === 27 ? 28 : 27;
  return ethers.concat([sig.r, ethers.toBeHex(s, 32), ethers.toBeHex(v, 1)]);
}

describe('signRelayedFeedback', () => {
  it('signs the rebuilt digest, recoverable to the rater, deterministic', async () => {
    const v = validated();
    const signature = await signRelayedFeedback(v, SIGNER);
    expect(signature).toBe(KEY.sign(v.digest).serialized.toLowerCase());
    expect(ethers.recoverAddress(v.digest, signature)).toBe(RATER);
  });

  it('a signer with only signTypedData gets the rebuilt typed data and signs the same bytes', async () => {
    const wallet = new ethers.Wallet(KEY);
    let seen: any;
    const typedOnly: ReputationSigner = {
      address: RATER,
      async signTypedData(td) {
        seen = td;
        const { EIP712Domain: _domain, ...types } = td.types;
        return wallet.signTypedData(td.domain, types, td.message);
      },
    };
    const v = validated();
    expect(await signRelayedFeedback(v, typedOnly)).toBe(await signRelayedFeedback(v, SIGNER));
    expect(seen.primaryType).toBe('RelayedGiveFeedback');
    expect(seen.types.EIP712Domain).toHaveLength(4);
    // A copy: the signer cannot reach the validated object.
    seen.message.value = '100';
    expect(v.typedData.message.value).toBe('85');
  });

  it('accepts v as 0/1 and returns it as 27/28', async () => {
    const v = validated();
    const good = KEY.sign(v.digest);
    const raw = ethers.concat([good.r, good.s, ethers.toBeHex(good.yParity, 1)]);
    const out = await signRelayedFeedback(v, { address: RATER, signHash: async () => raw });
    expect(out.slice(-2)).toBe(good.v.toString(16));
  });

  it('aborts a high-s signature instead of flipping it', async () => {
    const v = validated();
    const flipped = highS(KEY.sign(v.digest).serialized);
    expect(recoverAllowingHighS(v.digest, flipped)).toBe(RATER); // valid ECDSA, still refused
    expect(await code(signRelayedFeedback(v, { address: RATER, signHash: async () => flipped }))).toBe('high_s');
  });

  it('refuses a signature that recovers someone else', async () => {
    const v = validated();
    const foreign = OTHER.sign(v.digest).serialized;
    expect(await code(signRelayedFeedback(v, { address: RATER, signHash: async () => foreign }))).toBe('signature_mismatch');
  });

  it.each<[string, string]>([
    ['64 bytes', '0x' + '11'.repeat(64)],
    ['v = 29', '0x' + '11'.repeat(32) + '22'.repeat(32) + '1d'],
    ['r = 0', '0x' + '00'.repeat(32) + '22'.repeat(32) + '1b'],
    ['s = 0', '0x' + '11'.repeat(32) + '00'.repeat(32) + '1b'],
    ['not hex', '0x' + 'zz'.repeat(65)],
  ])('refuses a malformed signature: %s', async (_name, raw) => {
    expect(await code(signRelayedFeedback(validated(), { address: RATER, signHash: async () => raw }))).toBe('bad_signature');
  });

  it('refuses anything that did not come out of validatePreparation', async () => {
    const copy = { ...validated() } as ValidatedPreparation;
    expect(await code(signRelayedFeedback(copy, SIGNER))).toBe('not_validated');
  });

  it('refuses a signer that is not the rater, and one that cannot sign', async () => {
    expect(await code(signRelayedFeedback(validated(), signerFromEthers(OTHER)))).toBe('rater_mismatch');
    expect(await code(signRelayedFeedback(validated(), { address: RATER }))).toBe('signer_unavailable');
    expect(await code(signRelayedFeedback(validated(), { address: 'nope' } as ReputationSigner))).toBe('signer_unavailable');
  });

  it('lets a signer failure through unchanged', async () => {
    const boom = new Error('kms down');
    await expect(signRelayedFeedback(validated(), { address: RATER, signHash: async () => Promise.reject(boom) })).rejects.toBe(boom);
  });
});

/** KarmaKadabra's `digest_autorizacion_7702`, ported: RLP by hand for [int, address, int]. */
function kkAuthorizationDigest(chainId: number, delegate: string, nonce: bigint): string {
  const chunk = (b: Uint8Array): Uint8Array => (b.length === 1 && b[0] < 0x80 ? b : ethers.getBytes(ethers.concat([Uint8Array.of(0x80 + b.length), b])));
  const int = (n: bigint): Uint8Array => chunk(n === 0n ? new Uint8Array() : ethers.getBytes(ethers.toBeHex(n)));
  const body = ethers.getBytes(ethers.concat([int(BigInt(chainId)), chunk(ethers.getBytes(delegate)), int(nonce)]));
  return ethers.keccak256(ethers.concat([Uint8Array.of(0x05), Uint8Array.of(0xc0 + body.length), body]));
}

describe('authorizationDigest', () => {
  it.each([0n, 1n, 5n, 127n, 128n, 255n, 256n, 65535n, 2n ** 63n, 2n ** 64n - 1n])('matches ethers and KarmaKadabra for nonce %s', (nonce) => {
    for (const chainId of [8453, 1, 84532]) {
      const ours = authorizationDigest(chainId, DELEGATE, nonce);
      expect(ours).toBe(ethers.hashAuthorization({ chainId: BigInt(chainId), address: DELEGATE, nonce }).toLowerCase());
      expect(ours).toBe(kkAuthorizationDigest(chainId, DELEGATE, nonce).toLowerCase());
    }
  });

  it('refuses chain 0 (valid on every chain), a nonce past uint64 and a non-address', () => {
    expect(() => authorizationDigest(0, DELEGATE, 0)).toThrow(ReputationError);
    expect(() => authorizationDigest(8453, DELEGATE, 2n ** 64n)).toThrow(ReputationError);
    expect(() => authorizationDigest(8453, DELEGATE, -1n)).toThrow(ReputationError);
    expect(() => authorizationDigest(8453, '0x1234', 0)).toThrow(ReputationError);
  });
});

describe('buildRelayAuthorization', () => {
  it('signs the module\'s delegate for this chain, with the prepare\'s account nonce', async () => {
    const auth = await buildRelayAuthorization(validated(), SIGNER);
    expect(auth.chainId).toBe(8453);
    expect(auth.address).toBe(DELEGATE);
    expect(auth.nonce).toBe(5);
    const digest = ethers.hashAuthorization({ chainId: 8453n, address: DELEGATE, nonce: 5n });
    expect(ethers.recoverAddress(digest, { r: auth.r, s: auth.s, yParity: auth.yParity as 0 | 1 })).toBe(RATER);
    expect(BigInt(auth.s) <= SECP256K1_N_FOR_TESTS / 2n).toBe(true);
  });

  it('signs nothing for a rater already delegated', async () => {
    expect(await code(buildRelayAuthorization(validated(true), SIGNER))).toBe('authorization_not_needed');
  });

  it('needs signHash: an authorization has no typed-data form', async () => {
    const typedOnly: ReputationSigner = { address: RATER, signTypedData: async () => '0x' };
    expect(await code(buildRelayAuthorization(validated(), typedOnly))).toBe('signer_unavailable');
  });

  it('aborts a high-s authorization and one from another key', async () => {
    const v = validated();
    const digest = authorizationDigest(8453, DELEGATE, 5);
    const flipped = highS(KEY.sign(digest).serialized);
    expect(await code(buildRelayAuthorization(v, { address: RATER, signHash: async () => flipped }))).toBe('high_s');
    const foreign = OTHER.sign(digest).serialized;
    expect(await code(buildRelayAuthorization(v, { address: RATER, signHash: async () => foreign }))).toBe('signature_mismatch');
  });

  it('refuses a copy of a validated prepare', async () => {
    expect(await code(buildRelayAuthorization({ ...validated() } as ValidatedPreparation, SIGNER))).toBe('not_validated');
  });
});

describe('checkSignature', () => {
  it('returns r, s and the parity of a good signature', () => {
    const digest = ethers.keccak256(ethers.toUtf8Bytes('x'));
    const sig = KEY.sign(digest);
    const checked = checkSignature(sig.serialized, digest, RATER);
    expect(checked.r).toBe(sig.r);
    expect(checked.s).toBe(sig.s);
    expect(checked.yParity).toBe(sig.yParity);
  });
});

describe('signerFromEthers', () => {
  it('keeps the key out of JSON and out of its own keys', () => {
    const text = JSON.stringify(SIGNER);
    expect(text).not.toContain(seedKey('uvd-x402 reputation sign rater').slice(2));
    expect(Object.keys(SIGNER)).toEqual(['address', 'signHash']);
  });
});
