/**
 * A 409 from POST /register must survive as data, not as a string.
 *
 * The facilitator's in-flight lock answers a SYNCHRONOUS register with 409 and
 * a structured RegisterAgentResponse: it carries the agent id and tx of the run
 * already underway, plus a "poll GET /register/status/{jobId}" hint. Flattening
 * that into `Facilitator error: 409 - <text>` left the caller with a bare
 * failure, which is precisely the shape that invites a retry — and retrying a
 * mint is how duplicate agents get created.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Erc8004Client } from './index.js';

function respondWith(status: number, body: unknown, asText = false) {
  const payload = asText ? (body as string) : JSON.stringify(body);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => payload,
      json: async () => JSON.parse(payload),
    }))
  );
}

const REQUEST = {
  x402Version: 1 as const,
  network: 'base-mainnet' as const,
  agentUri: 'https://example.com/agent.json',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerAgent on a 409 in-flight conflict', () => {
  it('keeps the agent id of the run already in flight', async () => {
    respondWith(409, {
      success: false,
      agentId: 2106,
      transaction: `0x${'ab'.repeat(32)}`,
      owner: '0x1234567890123456789012345678901234567890',
      error:
        'A registration for this agent is already in progress; retry later or poll GET /register/status/{jobId}',
      network: 'base-mainnet',
    });

    const result = await new Erc8004Client().registerAgent(REQUEST);

    expect(result.success).toBe(false);
    expect(result.agentId).toBe(2106);
    expect(result.transaction).toBe(`0x${'ab'.repeat(32)}`);
    expect(result.error).toContain('already in progress');
  });

  it('never lets a 4xx body claim success', async () => {
    respondWith(409, { success: true, agentId: 1, network: 'base-mainnet' });

    const result = await new Erc8004Client().registerAgent(REQUEST);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('surfaces the facilitator message on a 400 instead of raw text', async () => {
    respondWith(400, {
      success: false,
      error: 'invalid agentUri',
      network: 'base-mainnet',
    });

    const result = await new Erc8004Client().registerAgent(REQUEST);

    expect(result.error).toBe('invalid agentUri');
  });

  it('degrades to the flattened string when the error is not JSON', async () => {
    respondWith(502, 'upstream down', true);

    const result = await new Erc8004Client().registerAgent(REQUEST);

    expect(result.success).toBe(false);
    expect(result.error).toContain('502');
    expect(result.error).toContain('upstream down');
  });
});
