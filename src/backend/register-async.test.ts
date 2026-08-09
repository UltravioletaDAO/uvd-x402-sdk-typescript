/**
 * Async registration: start, poll, and never confuse a timeout with a failure.
 *
 * A synchronous register waits on a mint receipt, which on a congested chain
 * outlives client and proxy timeouts. The timed-out call is genuinely ambiguous
 * — the mint may well have landed — and retrying it is how five duplicate agents
 * once got minted. The async flow exists so the caller holds a job id instead of
 * a guess.
 *
 * `waitForRegistration` therefore rejects on timeout rather than resolving with
 * the last non-terminal status: resolving `pending` invites a caller to read it
 * as "did not happen".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Erc8004Client, isRegisterJobTerminal, RegistrationPendingError } from './index';
import type { RegisterJobResponse } from './index';

function queueResponses(responses: Array<{ status: number; body: unknown }>): {
  headers: () => Record<string, string>;
} {
  let seenHeaders: Record<string, string> = {};

  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      const next = responses.length > 1 ? responses.shift()! : responses[0];
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: async () => next.body,
        text: async () => JSON.stringify(next.body),
      };
    }),
  );

  return { headers: () => seenHeaders };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('async registration', () => {
  it('sends Prefer: respond-async and returns a job without an agent id', async () => {
    const probe = queueResponses([
      { status: 202, body: { jobId: 'reg_42', status: 'pending' } },
    ]);

    const job = await new Erc8004Client().registerAgentAsync({
      x402Version: 1,
      network: 'solana',
      agentUri: 'https://example.com/agent.json',
    });

    expect(probe.headers()['Prefer']).toBe('respond-async');
    expect(job.jobId).toBe('reg_42');
    expect(isRegisterJobTerminal(job)).toBe(false);
    expect(job.agentId).toBeUndefined();
  });

  it('polls until the job is terminal', async () => {
    queueResponses([
      { status: 200, body: { jobId: 'reg_42', status: 'pending' } },
      {
        status: 200,
        body: {
          jobId: 'reg_42',
          status: 'done',
          network: 'solana',
          agentId: '247Y4QLwz9ZbcuHR2nX2EQLZHCsMs1GTqvgd6fpdn85Q',
        },
      },
    ]);

    const job = await new Erc8004Client().waitForRegistration('reg_42', {
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });

    expect(job.status).toBe('done');
    expect(job.agentId).toBe('247Y4QLwz9ZbcuHR2nX2EQLZHCsMs1GTqvgd6fpdn85Q');
  });

  it('rejects on timeout instead of resolving pending', async () => {
    queueResponses([{ status: 200, body: { jobId: 'reg_42', status: 'pending' } }]);

    await expect(
      new Erc8004Client().waitForRegistration('reg_42', {
        pollIntervalMs: 1,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/rather than registering again/);
  });

  it('treats mint_confirmed as carrying an agent but not terminal', () => {
    const job: RegisterJobResponse = {
      jobId: 'reg_7',
      status: 'mint_confirmed',
      agentId: 17,
    };

    expect(job.agentId).toBe(17);
    expect(isRegisterJobTerminal(job)).toBe(false);
  });
});

describe('asyncTransport flag', () => {
  it('returns the same shape as the synchronous call', async () => {
    // The migration must not force callers to rewrite anything downstream.
    queueResponses([
      { status: 202, body: { jobId: 'reg_42', status: 'pending' } },
      {
        status: 200,
        body: {
          jobId: 'reg_42',
          status: 'done',
          network: 'solana',
          agentId: '247Y4QLwz9ZbcuHR2nX2EQLZHCsMs1GTqvgd6fpdn85Q',
          transaction: '4jz6...',
          transferTransaction: '27Vv...',
          owner: '6xNPewUdKRbEZDReQdpyfNUdgNg8QRc8Mt263T5GZSRv',
        },
      },
    ]);

    const result = await new Erc8004Client().registerAgent(
      { x402Version: 1, network: 'solana', agentUri: 'https://example.com/agent.json' },
      { asyncTransport: true, pollIntervalMs: 1 },
    );

    expect(result.success).toBe(true);
    expect(result.agentId).toBe('247Y4QLwz9ZbcuHR2nX2EQLZHCsMs1GTqvgd6fpdn85Q');
    expect(result.transferTransaction).toBe('27Vv...');
    expect(result.network).toBe('solana');
  });

  it('maps a failed job to an unsuccessful response', async () => {
    queueResponses([
      { status: 202, body: { jobId: 'reg_9', status: 'pending' } },
      {
        status: 200,
        body: { jobId: 'reg_9', status: 'failed', network: 'base', error: 'insufficient gas' },
      },
    ]);

    const result = await new Erc8004Client().registerAgent(
      { x402Version: 1, network: 'base', agentUri: 'ipfs://Qm' },
      { asyncTransport: true, pollIntervalMs: 1 },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('insufficient gas');
    expect(result.agentId).toBeUndefined();
  });

  it('surfaces the job id on timeout instead of reporting a failure', async () => {
    // Resolving success=false here would tell the caller the registration did
    // not happen, when the mint may well be about to land.
    queueResponses([{ status: 200, body: { jobId: 'reg_7', status: 'pending' } }]);

    try {
      await new Erc8004Client().registerAgent(
        { x402Version: 1, network: 'solana', agentUri: 'https://example.com/agent.json' },
        { asyncTransport: true, pollIntervalMs: 1, timeoutMs: 20 },
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as RegistrationPendingError;
      expect(err).toBeInstanceOf(RegistrationPendingError);
      expect(err.jobId).toBe('reg_7');
      expect(err.retryable).toBe(true);
    }
  });
});
