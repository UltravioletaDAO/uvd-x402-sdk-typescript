import { describe, expect, it } from 'vitest';

import { create402Response } from './index';

/**
 * Regression for a defect found in production on 2026-07-29 by MeshRelay and
 * confirmed against the live facilitator: create402Response() emitted accepts[]
 * entries WITHOUT `scheme`.
 *
 * Why that was fatal rather than cosmetic: the x402 v2 spec (5.2) makes the
 * client echo the chosen accept VERBATIM into `accepted`. The facilitator's
 * PaymentRequirementsV2 requires `scheme`, so the omission travelled from our
 * own 402, through a client doing exactly what the spec says, and died in
 * deserialization with an error that named no field. The payer could not fix
 * it and the server could not see it.
 *
 * Reproduced against prod the same day: an accept missing `scheme` returns
 * "data did not match any variant of untagged enum VerifyRequestEnvelope".
 */
describe('create402Response accepts[] contract', () => {
  const primary = {
    amount: '0.10',
    recipient: '0xe4dc963c56979E0260fc146b87eE24F18220e545',
    resource: 'https://irc.meshrelay.xyz/channel/alpha-test',
    chainName: 'base',
    description: 'Alpha test channel',
    mimeType: 'application/json',
  };

  const acceptEntry = {
    network: 'eip155:137',
    asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    amount: '100000',
    payTo: '0xe4dc963c56979E0260fc146b87eE24F18220e545',
  };

  const acceptsOf = (extra: Record<string, unknown> = {}) => {
    const { body } = create402Response(primary, { accepts: [{ ...acceptEntry, ...extra }] });
    return body.accepts as Array<Record<string, unknown>>;
  };

  it('emits scheme on EVERY accepts[] entry, primary included', () => {
    const accepts = acceptsOf();
    expect(accepts.length).toBeGreaterThan(1);
    for (const accept of accepts) {
      expect(accept.scheme, `entry without scheme: ${JSON.stringify(accept)}`).toBeDefined();
    }
  });

  it('carries every field the facilitator needs to deserialize a v2 accept', () => {
    // Exactly the set PaymentRequirementsV2 declares as required. Verified by
    // reproduction: dropping any one of scheme / maxTimeoutSeconds, or renaming
    // amount, produces the same unnamed "no variant matched" error.
    for (const accept of acceptsOf()) {
      for (const field of ['scheme', 'network', 'asset', 'amount', 'maxTimeoutSeconds']) {
        expect(accept[field], `missing required field: ${field}`).toBeDefined();
      }
    }
  });

  it('keeps the amount field name, which is what v2 expects', () => {
    // The rename from maxAmountRequired is CORRECT for v2 — only the missing
    // scheme was ever the bug. Re-adding maxAmountRequired is not the fix.
    for (const accept of acceptsOf()) {
      expect(accept.amount).toBeDefined();
    }
  });

  it('honours a caller-supplied scheme instead of forcing exact', () => {
    // Hardcoding 'exact' silently discarded escrow/commerce accepts. Index 1 is
    // the caller's entry; index 0 is the primary requirement.
    const accepts = acceptsOf({ scheme: 'escrow' });
    expect(accepts[1].scheme).toBe('escrow');
  });

  it('still defaults to exact when the caller omits scheme', () => {
    expect(acceptsOf()[1].scheme).toBe('exact');
  });
});
