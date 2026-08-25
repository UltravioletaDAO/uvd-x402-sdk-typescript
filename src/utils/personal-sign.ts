/**
 * uvd-x402-sdk - EIP-191 personal_sign helpers
 *
 * Generic recover/verify for an EIP-191 `personal_sign` over an arbitrary
 * string message — the shape a wallet produces for `eth_sign`/`personal_sign`
 * and `cast wallet sign <message>`.
 *
 * This is deliberately NOT the ERC-8128 machinery (`verifyRequest`), which
 * verifies an RFC 9421 SIGNED HTTP REQUEST (method;url;headers;content-digest).
 * A challenge/response flow — a service hands out a nonce string, the wallet
 * signs that string, the service recovers the signer — is a different, simpler
 * case that the ERC-8128 path does not cover. Consumers doing wallet-ownership
 * challenges (e.g. MeshRelay's IRC `VERIFY`/`VERIFY-SIG`) needed this and were
 * each reaching for `ethers.verifyMessage` directly; this centralizes it.
 */

import { ethers } from 'ethers';

/**
 * Recover the address that produced an EIP-191 `personal_sign` over `message`.
 *
 * @param message - the exact string that was signed
 * @param signature - the 0x-prefixed signature
 * @returns the checksummed recovered address
 * @throws if the signature is malformed (propagates ethers' error)
 */
export function recoverPersonalSignAddress(message: string, signature: string): string {
  return ethers.verifyMessage(message, signature);
}

/**
 * Whether `signature` over `message` was produced by `expected`.
 *
 * Compares case-insensitively (recovered addresses are checksummed, linked
 * wallets are often stored lower-cased) and never throws: a malformed
 * signature is a failed verification, not an exception to handle at every
 * call site.
 *
 * @returns true iff the recovered signer equals `expected`
 */
export function verifyPersonalSign(params: {
  message: string;
  signature: string;
  expected: string;
}): boolean {
  const { message, signature, expected } = params;
  if (!expected) return false;
  try {
    const recovered = recoverPersonalSignAddress(message, signature);
    return recovered.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}
