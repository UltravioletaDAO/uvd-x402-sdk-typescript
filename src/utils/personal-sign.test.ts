import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { recoverPersonalSignAddress, verifyPersonalSign } from './personal-sign';

describe('personal-sign (EIP-191)', () => {
  // A fixed test key — public, for tests only, never a real wallet.
  const wallet = new ethers.Wallet(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
  );
  const message = 'meshrelay:verify:alice:1730000000:deadbeef';

  it('recovers the address that signed an arbitrary string', async () => {
    const sig = await wallet.signMessage(message);
    expect(recoverPersonalSignAddress(message, sig).toLowerCase())
      .toBe(wallet.address.toLowerCase());
  });

  it('verifyPersonalSign is true for the real signer, case-insensitively', async () => {
    const sig = await wallet.signMessage(message);
    expect(verifyPersonalSign({ message, signature: sig, expected: wallet.address.toLowerCase() }))
      .toBe(true);
  });

  it('verifyPersonalSign is false for a different expected address', async () => {
    const sig = await wallet.signMessage(message);
    const other = ethers.Wallet.createRandom().address;
    expect(verifyPersonalSign({ message, signature: sig, expected: other })).toBe(false);
  });

  it('verifyPersonalSign is false (not throwing) for a garbage signature', () => {
    expect(verifyPersonalSign({ message, signature: '0xnotasig', expected: wallet.address }))
      .toBe(false);
  });

  it('a signature over a DIFFERENT message does not verify', async () => {
    const sig = await wallet.signMessage('some other challenge');
    expect(verifyPersonalSign({ message, signature: sig, expected: wallet.address })).toBe(false);
  });
});
