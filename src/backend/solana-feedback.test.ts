/**
 * The rater-authored feedback rail on Solana: who the chain records as author.
 *
 * The program's `give_feedback` instruction declares account 0 as
 * `[signer, writable] client (feedback author / fee payer)`, and plain
 * `POST /feedback` puts the FACILITATOR's keypair there — so the chain records
 * the facilitator as the author of the rating, and the facilitator is the one
 * who could revoke it. `/feedback/solana/prepare` + `/submit` hand the rater
 * that seat: they sign as `client`, the facilitator only co-signs as fee payer.
 * Measured live on the deployed facilitator v2.16.0 (2026-09-07).
 *
 * What is pinned here:
 *
 * 1. Solana has its OWN network list, disjoint from the EIP-7702 one. Merging
 *    them would route a Solana rating to `/feedback/evm/*`, which answers 400,
 *    and would claim a `FeedbackDelegate` that does not exist and is not
 *    missing — Solana needs none.
 * 2. The two calls hit the Solana routes, not the EVM ones.
 * 3. `rater` and `score` reach the wire. Without `rater` the facilitator has no
 *    author to put in account 0; without `score` the rating lands on-chain and
 *    counts for nothing.
 * 4. The fee payer that comes back is NOT the rater. That split is the whole
 *    design: the rater authors, the facilitator pays.
 * 5. `submit` echoes the prepared parameters back byte for byte. The
 *    facilitator re-derives the message from them and refuses to co-sign
 *    anything else.
 * 6. An HTTP refusal comes back as `success: false`, not as a throw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  Erc8004Client,
  RELAYED_FEEDBACK_NETWORKS,
  SOLANA_FEEDBACK_NETWORKS,
  supportsRelayedFeedback,
  supportsSolanaFeedback,
} from './index.js';

/** Both are served by the deployed facilitator, read off `GET /supported`. */
const SOLANA_NETWORKS = ['solana', 'solana-devnet'];

/** An agent asset pubkey and a rater pubkey, both base58 as the chain wants. */
const AGENT_ASSET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv';
const RATER = '9oSLm8Rk1kQ9y8dFcqbAcTNqYqcrTUR6cQ4mL8mYNXpB';
const FEE_PAYER = 'F1owJRHzyoyKGpAcSXTsY1t9Rhb6HzWQBqRRhpVYYNMd';

let lastRequest: { url: string; body: any } | undefined;

function respondWith(status: number, body: unknown) {
  const payload = JSON.stringify(body);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      lastRequest = { url, body: JSON.parse(init.body as string) };
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => payload,
        json: async () => JSON.parse(payload),
      };
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  lastRequest = undefined;
});

describe('the networks that serve the Solana rail', () => {
  it('is exactly the two Solana networks the facilitator serves', () => {
    expect([...SOLANA_FEEDBACK_NETWORKS].sort()).toEqual([...SOLANA_NETWORKS].sort());
  });

  /**
   * The regression this whole pair exists to prevent.
   *
   * `RELAYED_FEEDBACK_NETWORKS` names the chains where Execution Market
   * deployed a `FeedbackDelegate` and the facilitator verified it on-chain, and
   * `prepareRelayedFeedback` builds `/feedback/evm/prepare` from it. Putting
   * `solana` in there sends a Solana rating to the EVM route — a 400 — while
   * asserting a delegate that was never deployed. Solana needs no delegate:
   * account 0 is already `[signer] client`.
   */
  it('shares nothing with the EIP-7702 delegate list', () => {
    const overlap = SOLANA_FEEDBACK_NETWORKS.filter((n) =>
      (RELAYED_FEEDBACK_NETWORKS as readonly string[]).includes(n)
    );
    expect(overlap).toEqual([]);
    expect(supportsRelayedFeedback('solana')).toBe(false);
    expect(supportsRelayedFeedback('solana-devnet')).toBe(false);
  });

  it('does not answer for EVM networks either', () => {
    expect(supportsSolanaFeedback('base')).toBe(false);
    expect(supportsSolanaFeedback('base-mainnet')).toBe(false);
    expect(supportsSolanaFeedback('ethereum')).toBe(false);
  });

  it('answers for both Solana networks', () => {
    expect(supportsSolanaFeedback('solana')).toBe(true);
    expect(supportsSolanaFeedback('solana-devnet')).toBe(true);
  });
});

describe('prepareSolanaFeedback', () => {
  const PREPARED = {
    success: true,
    transaction: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    rater: RATER,
    feePayer: FEE_PAYER,
    blockhash: '9zXk1EJ8VJvQwGH8pGCkFTa4tEqPmYnLZuRUhoQdRvPB',
    lastValidBlockHeight: 297_384_112,
    network: 'solana',
  };

  it('goes to the Solana route, not the EVM one', async () => {
    respondWith(200, PREPARED);

    await new Erc8004Client().prepareSolanaFeedback({
      x402Version: 1,
      network: 'solana',
      feedback: { agentId: AGENT_ASSET, rater: RATER, value: 87, score: 95 },
    });

    expect(lastRequest!.url).toContain('/feedback/solana/prepare');
    expect(lastRequest!.url).not.toContain('/feedback/evm/');
  });

  it('puts the rater on the wire', async () => {
    respondWith(200, PREPARED);

    const result = await new Erc8004Client().prepareSolanaFeedback({
      x402Version: 1,
      network: 'solana',
      feedback: { agentId: AGENT_ASSET, rater: RATER, value: 87, score: 95, tag1: 'quality' },
    });

    // Without it the facilitator has no author for account 0 and answers 400 —
    // the rail degrading silently into the thing it replaces is the failure
    // this asserts against.
    expect(lastRequest!.body.feedback.rater).toBe(RATER);
    expect(lastRequest!.body.feedback.agentId).toBe(AGENT_ASSET);
    expect(result.success).toBe(true);
  });

  /**
   * `score` is optional on the wire and effectively required in practice: the
   * ATOM Engine ignores an unscored feedback, so the transaction succeeds, the
   * record lands on the agent, and reputation stays at zero (`had_impact=false`)
   * — and it is not retroactive. It has to survive serialisation.
   */
  it('carries the score, which is what makes the rating count', async () => {
    respondWith(200, PREPARED);

    await new Erc8004Client().prepareSolanaFeedback({
      x402Version: 1,
      network: 'solana',
      feedback: { agentId: AGENT_ASSET, rater: RATER, value: 87, score: 95 },
    });

    expect(lastRequest!.body.feedback.score).toBe(95);
  });

  /**
   * The fee payer is the facilitator and the author is the rater. If they came
   * back equal, the answer would be the old behaviour wearing the new route's
   * name, and every rating on it would still be attributed to the facilitator.
   */
  it('hands back a fee payer that is not the rater', async () => {
    respondWith(200, PREPARED);

    const result = await new Erc8004Client().prepareSolanaFeedback({
      x402Version: 1,
      network: 'solana',
      feedback: { agentId: AGENT_ASSET, rater: RATER, value: 87, score: 95 },
    });

    expect(result.rater).toBe(RATER);
    expect(result.feePayer).toBe(FEE_PAYER);
    expect(result.feePayer).not.toBe(result.rater);
    // The blockhash window: past it the network drops the transaction and a
    // fresh `prepare` is required, so a caller has to be able to see it.
    expect(result.blockhash).toBe(PREPARED.blockhash);
    expect(result.lastValidBlockHeight).toBe(297_384_112);
    expect(result.transaction).toBe(PREPARED.transaction);
  });

  it('works on devnet under the same name', async () => {
    respondWith(200, { ...PREPARED, network: 'solana-devnet' });

    const result = await new Erc8004Client().prepareSolanaFeedback({
      x402Version: 1,
      network: 'solana-devnet',
      feedback: { agentId: AGENT_ASSET, rater: RATER, value: 87, score: 95 },
    });

    expect(lastRequest!.body.network).toBe('solana-devnet');
    expect(result.success).toBe(true);
  });

  it('returns a refusal as data, not as a throw', async () => {
    respondWith(400, {
      success: false,
      error: 'rater must be a base58 Solana pubkey on this network',
    });

    const result = await new Erc8004Client().prepareSolanaFeedback({
      x402Version: 1,
      network: 'solana',
      // An EVM address on the Solana rail: refused, and readably so.
      feedback: { agentId: AGENT_ASSET, rater: `0x${'11'.repeat(20)}`, value: 87 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('400');
    expect(result.error).toContain('base58');
    expect(result.network).toBe('solana');
  });
});

describe('submitSolanaFeedback', () => {
  const SIGNED_TX = 'AVRhZXItc2lnbmVkLXRyYW5zYWN0aW9uLWJ5dGVzLWhlcmU=';
  const FEEDBACK = {
    agentId: AGENT_ASSET,
    rater: RATER,
    value: 87,
    valueDecimals: 0,
    score: 95,
    tag1: 'quality',
    tag2: 'api',
  };

  it('goes to the Solana route and echoes the prepared parameters', async () => {
    respondWith(200, {
      success: true,
      transaction: '5x7kQjR2mVdN8pTzYbW3cHfLgAeUq1sJnKoP4iXvBtMr9DwZaCuEyGh6FsNvQpRk',
      network: 'solana',
    });

    const result = await new Erc8004Client().submitSolanaFeedback({
      x402Version: 1,
      network: 'solana',
      feedback: FEEDBACK,
      transaction: SIGNED_TX,
    });

    expect(lastRequest!.url).toContain('/feedback/solana/submit');
    // Not redundant with prepare: the facilitator re-derives the message from
    // these plus the blockhash inside the transaction, and refuses to co-sign
    // anything that is not byte-for-byte what it built. Signing arbitrary blobs
    // would turn the fee-payer keypair into a public signing oracle.
    expect(lastRequest!.body.feedback).toEqual(FEEDBACK);
    expect(lastRequest!.body.transaction).toBe(SIGNED_TX);
    expect(result.success).toBe(true);
    expect(result.transaction).toBe(
      '5x7kQjR2mVdN8pTzYbW3cHfLgAeUq1sJnKoP4iXvBtMr9DwZaCuEyGh6FsNvQpRk'
    );
  });

  it('surfaces a byte-mismatch refusal as data', async () => {
    respondWith(400, {
      success: false,
      error: 'submitted transaction does not match the one this facilitator built',
      network: 'solana',
    });

    const result = await new Erc8004Client().submitSolanaFeedback({
      x402Version: 1,
      network: 'solana',
      feedback: FEEDBACK,
      transaction: SIGNED_TX,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('400');
    expect(result.error).toContain('does not match');
  });

  /**
   * A network failure leaves the write undecided: the co-signed transaction may
   * already be on the chain. Retryable, never automatically replayable — and on
   * this rail a resend needs a fresh `prepare`, because the blockhash the rater
   * signed over expires.
   */
  it('reports an unreachable facilitator as retryable but not replayable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );

    const result = await new Erc8004Client().submitSolanaFeedback({
      x402Version: 1,
      network: 'solana',
      feedback: FEEDBACK,
      transaction: SIGNED_TX,
    });

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.safeToReplay).toBe(false);
  });
});
