/**
 * A 503 from the owner lookup must never be readable as "owns nothing".
 *
 * The facilitator answers 404 for "this address owns no agent" and 503 for "I
 * could not find out" — usually an RPC failure behind it. Collapsing the two is
 * how a transient failure becomes a permanent wrong answer: the caller persists
 * "not registered", stops asking, and on a registration path mints a second
 * agent for an owner who already has one, burning gas and leaving an orphan.
 *
 * This used to throw a bare `Error` with the status interpolated into the
 * message, so telling them apart meant parsing that string.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Erc8004Client, Erc8004LookupError } from './index';

const OWNER = '6xNPewUdKRbEZDReQdpyfNUdgNg8QRc8Mt263T5GZSRv';
const AGENT = '247Y4QLwz9ZbcuHR2nX2EQLZHCsMs1GTqvgd6fpdn85Q';

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getIdentityByOwner verdicts', () => {
  it('marks 503 retryable and not notFound', async () => {
    mockFetch(503, { error: 'Could not determine agent ID', retryable: true });

    const client = new Erc8004Client();
    await expect(client.getIdentityByOwner('solana', OWNER)).rejects.toThrow(
      Erc8004LookupError,
    );

    try {
      await client.getIdentityByOwner('solana', OWNER);
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as Erc8004LookupError;
      expect(err.status).toBe(503);
      expect(err.retryable).toBe(true);
      expect(err.notFound).toBe(false);
    }
  });

  it('marks 404 notFound and not retryable', async () => {
    mockFetch(404, { error: 'does not own any agent' });

    try {
      await new Erc8004Client().getIdentityByOwner('solana', OWNER);
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as Erc8004LookupError;
      expect(err.status).toBe(404);
      expect(err.notFound).toBe(true);
      expect(err.retryable).toBe(false);
    }
  });

  it('parses the Solana success shape', async () => {
    // Captured from mainnet on facilitator v1.72.0.
    mockFetch(200, {
      agentId: AGENT,
      owner: OWNER,
      agentUri: 'https://example.com/agent.json',
      network: 'solana',
      balance: '1',
    });

    const result = await new Erc8004Client().getIdentityByOwner('solana', OWNER);

    expect(result.agentId).toBe(AGENT);
    expect(result.balance).toBe('1');
  });
});
