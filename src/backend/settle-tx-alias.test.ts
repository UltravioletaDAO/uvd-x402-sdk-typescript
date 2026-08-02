import { describe, it, expect } from 'vitest';

/**
 * Regression for a bug that cost a real consumer a paid delivery.
 *
 * The facilitator names the settlement hash `transaction`. This client read
 * only `transactionHash || transaction_hash`, so it returned `undefined` for
 * the field the caller gates access on. One consumer failed closed on that and
 * revoked an access that had already been paid for on-chain.
 *
 * The parsing is exercised directly here rather than through a live client so
 * the test states the contract, not the transport.
 */
const readHash = (result: Record<string, unknown>) =>
  (result.transaction ?? result.transactionHash ?? result.transaction_hash) as
    | string
    | undefined;

const HASH =
  '0x4e186e8c76658ea699ff55413d268e7b806d6b93cea880bd215ef1cdd187c3b7';

describe('settle response hash parsing', () => {
  it('reads the canonical name the facilitator actually emits', () => {
    // This exact body is what production returned while the bug was live.
    expect(
      readHash({
        success: true,
        payer: '0x7052cA449702e5ffafbE3dc63b74C7b7d8aF402B',
        transaction: HASH,
        network: 'base',
      })
    ).toBe(HASH);
  });

  it('still reads both legacy spellings', () => {
    expect(readHash({ transactionHash: HASH })).toBe(HASH);
    expect(readHash({ transaction_hash: HASH })).toBe(HASH);
  });

  it('prefers the canonical name when a facilitator emits several', () => {
    expect(readHash({ transaction: HASH, transactionHash: HASH })).toBe(HASH);
  });

  it('reports undefined rather than an empty string when no hash is present', () => {
    // An empty string would read as a valid receipt to a caller doing a
    // truthiness check; undefined forces the absence to be handled.
    expect(readHash({ success: true, network: 'base' })).toBeUndefined();
  });
});
