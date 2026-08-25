/**
 * The rater-authored feedback rail: who the chain records as the author.
 *
 * The ERC-8004 Reputation Registry stores `msg.sender`. When the facilitator
 * relays a rating the ordinary way — `POST /feedback` — that is the
 * FACILITATOR, which is how 87,2% of the reputation on Base came to be
 * attributed to one wallet that could also revoke it. The EIP-7702 rail sends
 * the transaction TO THE RATER'S ADDRESS instead, so the registry sees the
 * rater.
 *
 * What is pinned here:
 *
 * 1. The network list matches the delegates the facilitator actually serves
 *    (`delegate_address()` in `src/erc8004/relay.rs`). Avalanche must stay out:
 *    its C-Chain rejects the transaction type itself, so there is nothing to
 *    deploy against.
 * 2. `rater` reaches the wire. Without it the facilitator has no author to put
 *    on the transaction and the rail silently degrades to the thing it
 *    replaces.
 * 3. `deadline`, `nonce` and `signature` are echoed back byte for byte on
 *    submit. The facilitator rebuilds the calldata from the declared parameters
 *    and refuses to relay anything the signature does not cover.
 * 4. An HTTP failure comes back as `success: false`, not as a throw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  Erc8004Client,
  RELAYED_FEEDBACK_NETWORKS,
  supportsRelayedFeedback,
} from './index.js';

/**
 * The eight mainnets Execution Market deployed a FeedbackDelegate on, each read
 * off its own chain on two independent RPCs before it was written down
 * (2026-08-23), plus the testnet the rail was first proven against.
 */
const DELEGATE_NETWORKS = [
  'base',
  'ethereum',
  'polygon',
  'arbitrum',
  'optimism',
  'celo',
  'bsc',
  'monad',
  'base-sepolia',
];

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

describe('the networks that serve the rail', () => {
  it('is exactly the set with a verified delegate', () => {
    expect([...RELAYED_FEEDBACK_NETWORKS].sort()).toEqual([...DELEGATE_NETWORKS].sort());
  });

  it('leaves Avalanche out, and that is not a "not yet"', () => {
    // The C-Chain answers `-32000 transaction type not supported` — an explicit
    // refusal from the node, not an absence of traffic. Reputation for tasks
    // paid on Avalanche is anchored on another chain; the payment stays put.
    expect(supportsRelayedFeedback('avalanche')).toBe(false);
    expect(supportsRelayedFeedback('avalanche-fuji')).toBe(false);
  });

  it('leaves Scroll and SKALE out too', () => {
    // Both serve ERC-8004; neither has a delegate deployed, and SKALE's EVM
    // predates Shanghai so 7702 cannot land there at all.
    expect(supportsRelayedFeedback('scroll')).toBe(false);
    expect(supportsRelayedFeedback('skale-base')).toBe(false);
  });

  it('routes the deprecated base alias', () => {
    expect(supportsRelayedFeedback('base-mainnet')).toBe(true);
  });
});

describe('the EIP-191 envelope', () => {
  /**
   * `digest` and `signingPayload` differ by exactly the envelope, and both are
   * served.
   *
   * `digest` is what the signature must recover against and ALREADY carries the
   * envelope; `signingPayload` is the same hash before it. A raw key signs the
   * first as a prehash; a wallet's `personal_sign` signs the second, because
   * `personal_sign` applies the envelope itself.
   *
   * Signing `digest` through a wallet wraps it TWICE and recovers a stranger.
   * Not hypothetical: it is what every wallet surface did, and what THIS SDK's
   * own documentation prescribed until 2026-08-25 — which is why the rail ran
   * for days without one successful signed rating.
   */
  it('carries both values, and they differ by the envelope', async () => {
    const { keccak_256 } = await import('@noble/hashes/sha3');

    // The envelope, applied by hand exactly as `personal_sign` applies it.
    const envelope = (payloadHex: string) => {
      const prefix = new TextEncoder().encode('\x19Ethereum Signed Message:\n32');
      const body = Uint8Array.from(
        payloadHex.slice(2).match(/../g)!.map((b) => parseInt(b, 16))
      );
      const buf = new Uint8Array(prefix.length + body.length);
      buf.set(prefix);
      buf.set(body, prefix.length);
      return `0x${Buffer.from(keccak_256(buf)).toString('hex')}`;
    };

    const signingPayload = `0x16f16acc${'11'.repeat(30)}`;
    const digest = envelope(signingPayload);

    respondWith(200, {
      success: true,
      digest,
      signingPayload,
      delegated: true,
      chainId: 8453,
      network: 'base',
    });

    const prep = await new Erc8004Client().prepareRelayedFeedback({
      x402Version: 1,
      network: 'base',
      feedback: { agentId: 1, value: 1, rater: '0x0000000000000000000000000000000000000001' },
    });

    expect(prep.signingPayload).toBe(signingPayload);
    expect(prep.digest).toBe(digest);
    // The relationship a client can check instead of rebuilding the preimage.
    expect(envelope(prep.signingPayload!)).toBe(prep.digest);
    expect(prep.signingPayload).not.toBe(prep.digest);
  });

  /**
   * An older facilitator omits it. That must read as absent, never as `digest`:
   * a client that needs it should fail loudly rather than hand a wallet the one
   * value it cannot sign.
   */
  it('is undefined against a facilitator older than v1.95.0', async () => {
    respondWith(200, {
      success: true,
      digest: `0x${'ab'.repeat(32)}`,
      delegated: true,
      chainId: 8453,
      network: 'base',
    });

    const prep = await new Erc8004Client().prepareRelayedFeedback({
      x402Version: 1,
      network: 'base',
      feedback: { agentId: 1, value: 1, rater: '0x0000000000000000000000000000000000000001' },
    });

    expect(prep.signingPayload).toBeUndefined();
    expect(prep.digest).toBeDefined();
  });
});

describe('prepareRelayedFeedback', () => {
  it('puts the rater on the wire', async () => {
    respondWith(200, {
      success: true,
      delegate: '0x754206C4247317768bD86459E829a174d9C68BA4',
      data: '0xdeadbeef',
      digest: `0x${'11'.repeat(32)}`,
      deadline: 1_800_000_000,
      nonce: `0x${'22'.repeat(32)}`,
      delegated: false,
      accountNonce: 7,
      chainId: 8453,
      network: 'base',
    });

    const result = await new Erc8004Client().prepareRelayedFeedback({
      x402Version: 1,
      network: 'base',
      feedback: {
        agentId: 18896,
        value: 95,
        tag1: 'quality',
        rater: '0x0000000000000000000000000000000000000001',
      },
    });

    expect(lastRequest!.url).toContain('/feedback/evm/prepare');
    expect(lastRequest!.body.feedback.rater).toBe(
      '0x0000000000000000000000000000000000000001'
    );
    expect(result.success).toBe(true);
    // delegated=false is the signal that an EIP-7702 authorization is still
    // required; accountNonce is what goes in it.
    expect(result.delegated).toBe(false);
    expect(result.accountNonce).toBe(7);
  });

  it('normalises the base alias before it reaches the wire', async () => {
    respondWith(200, { success: true, delegated: true, chainId: 8453, network: 'base' });

    await new Erc8004Client().prepareRelayedFeedback({
      x402Version: 1,
      network: 'base-mainnet',
      feedback: {
        agentId: 1,
        value: 1,
        rater: '0x0000000000000000000000000000000000000001',
      },
    });

    // The facilitator answers 400 "Invalid network: base-mainnet".
    expect(lastRequest!.body.network).toBe('base');
  });

  it('returns a refusal as data, not as a throw', async () => {
    respondWith(400, { success: false, error: 'no FeedbackDelegate is deployed there yet' });

    const result = await new Erc8004Client().prepareRelayedFeedback({
      x402Version: 1,
      network: 'celo',
      feedback: {
        agentId: 1,
        value: 1,
        rater: '0x0000000000000000000000000000000000000001',
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('400');
  });
});

describe('submitRelayedFeedback', () => {
  const DEADLINE = 1_800_000_000;
  const NONCE = `0x${'22'.repeat(32)}`;
  const SIGNATURE = `0x${'cd'.repeat(65)}`;

  it('echoes back exactly what prepare returned', async () => {
    respondWith(200, {
      success: true,
      transaction: `0x${'ab'.repeat(32)}`,
      feedbackIndex: 3,
      network: 'base',
    });

    const result = await new Erc8004Client().submitRelayedFeedback({
      x402Version: 1,
      network: 'base',
      feedback: {
        agentId: 18896,
        value: 95,
        tag1: 'quality',
        rater: '0x0000000000000000000000000000000000000001',
      },
      deadline: DEADLINE,
      nonce: NONCE,
      signature: SIGNATURE,
      authorization: {
        chainId: 8453,
        address: '0x754206C4247317768bD86459E829a174d9C68BA4',
        nonce: 7,
        yParity: 1,
        r: `0x${'01'.repeat(32)}`,
        s: `0x${'02'.repeat(32)}`,
      },
    });

    expect(lastRequest!.url).toContain('/feedback/evm/submit');
    // Not redundant with prepare: the facilitator rebuilds the calldata from
    // these and refuses to relay what the signature does not cover.
    expect(lastRequest!.body.deadline).toBe(DEADLINE);
    expect(lastRequest!.body.nonce).toBe(NONCE);
    expect(lastRequest!.body.signature).toBe(SIGNATURE);
    // chainId 0 is EIP-7702's wildcard, valid on every chain. Pinning the chain
    // is the narrower grant, so it must survive serialisation as sent.
    expect(lastRequest!.body.authorization.chainId).toBe(8453);
    expect(result.success).toBe(true);
    expect(result.feedbackIndex).toBe(3);
  });

  it('sends no authorization for an already-delegated account', async () => {
    respondWith(200, { success: true, network: 'base' });

    await new Erc8004Client().submitRelayedFeedback({
      x402Version: 1,
      network: 'base',
      feedback: {
        agentId: 1,
        value: 1,
        rater: '0x0000000000000000000000000000000000000001',
      },
      deadline: DEADLINE,
      nonce: NONCE,
      signature: SIGNATURE,
    });

    expect(lastRequest!.body.authorization).toBeUndefined();
  });

  it('returns a refusal as data, not as a throw', async () => {
    respondWith(400, { success: false, error: 'relay_expired' });

    const result = await new Erc8004Client().submitRelayedFeedback({
      x402Version: 1,
      network: 'base',
      feedback: {
        agentId: 1,
        value: 1,
        rater: '0x0000000000000000000000000000000000000001',
      },
      deadline: DEADLINE,
      nonce: NONCE,
      signature: SIGNATURE,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('400');
  });
});
