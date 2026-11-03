/** NEP-413 message signatures for a caller-supplied FullAccess key. Offline only. */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { encodeBase58 } from 'ethers';
import type { NearLocalSigner } from './escrow';
import { account, concat, le, str } from './encoding';

export interface Nep413Message {
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string;
}
export interface SignNep413Options extends Nep413Message {
  signer: NearLocalSigner;
  accountId: string;
}
export interface Nep413SignedMessage {
  accountId: string;
  publicKey: string;
  signature: string;
}
/** Prefix 2^31+413 followed by message, fixed nonce, recipient and Option<String> callback. */
export function nep413Preimage(options: Nep413Message): Uint8Array {
  const { message, recipient, callbackUrl, nonce } = options;
  if (typeof message !== 'string') throw new Error('message must be a string');
  if (typeof recipient !== 'string' || recipient.length === 0 || recipient.trim() !== recipient) {
    throw new Error('recipient must be a nonempty string without surrounding whitespace');
  }
  // Domain names are case insensitive; refuse equivalent spellings as well as the literal.
  if (recipient.toLowerCase().replace(/\.$/u, '') === 'intents.near') throw new Error('intents.near is not an allowed recipient');
  if (!(nonce instanceof Uint8Array) || nonce.length !== 32) throw new Error('nonce must contain 32 bytes');
  if (callbackUrl !== undefined && typeof callbackUrl !== 'string') throw new Error('callbackUrl must be a string');
  return concat(le(2147484061n, 4), str(message), new Uint8Array(nonce), str(recipient),
    callbackUrl === undefined ? Uint8Array.of(0) : concat(Uint8Array.of(1), str(callbackUrl)));
}
export async function signNep413(options: SignNep413Options): Promise<Nep413SignedMessage> {
  const o = { ...options };
  account(o.accountId, 'accountId');
  const digest = sha256(nep413Preimage(o));
  const pk = new Uint8Array(o.signer.publicKey);
  if (pk.length !== 32) throw new Error('Expected 32-byte Ed25519 public key');
  const signature = await o.signer.sign(digest.slice());
  if (!(signature instanceof Uint8Array) || signature.length !== 64 || !ed25519.verify(signature, digest, pk)) {
    throw new Error('Invalid Ed25519 NEP-413 signature');
  }
  return { accountId: o.accountId, publicKey: `ed25519:${encodeBase58(pk)}`,
    signature: btoa(Array.from(signature, (b) => String.fromCharCode(b)).join('')) };
}
