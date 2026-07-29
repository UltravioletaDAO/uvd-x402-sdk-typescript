import { describe, expect, it } from 'vitest';

import {
  buildSettleRequestV2,
  buildVerifyRequest,
  buildVerifyRequestV2,
  type PaymentRequirementsV2,
  type ResourceInfoV2,
} from './index';

/**
 * The v2 envelope, pinned to a shape VERIFIED against the live facilitator on
 * 2026-07-29: posting it to /verify returns `contract_call_failed`, meaning it
 * deserialised and reached on-chain verification (the signature below is fake,
 * which is why the chain call is what fails).
 *
 * This exists because the SDK previously could not express v2 AT ALL —
 * buildVerifyRequest hardcodes the v1 envelope
 * `{x402Version, paymentPayload, paymentRequirements}`. Two teams spent a day on
 * that: the SDK advertised v2 (CAIP-2 chain ids in accepts[]) while being
 * structurally unable to CALL the facilitator in v2, and the resulting rejection
 * was "data did not match any variant of untagged enum", which names no field.
 */
const RESOURCE: ResourceInfoV2 = {
  url: 'https://irc.meshrelay.xyz/channel/alpha-test',
  description: 'Alpha test channel',
  mimeType: 'application/json',
};

const ACCEPTED: PaymentRequirementsV2 = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '100000',
  payTo: '0xe4dc963c56979E0260fc146b87eE24F18220e545',
  maxTimeoutSeconds: 300,
};

const PAYLOAD = {
  signature: '0xdeadbeef',
  authorization: {
    from: '0x7052cA449702e5ffafbE3dc63b74C7b7d8aF402B',
    to: '0xe4dc963c56979E0260fc146b87eE24F18220e545',
    value: '100000',
    validAfter: '1761329327',
    validBefore: '1961829987',
    nonce: '0xa0c6b1edb9fed5b5cd99626dadf0e60b56013f94839d4fdcfa0117cce1f74485',
  },
};

describe('buildVerifyRequestV2', () => {
  const body = buildVerifyRequestV2(PAYLOAD, RESOURCE, ACCEPTED);

  it('carries resource and accepted at the TOP level', () => {
    expect(body.resource).toEqual(RESOURCE);
    expect(body.accepted).toEqual(ACCEPTED);
  });

  it('has NO paymentRequirements key — that is the v1 envelope', () => {
    // Emitting it is what made every v2 attempt match the v1 variant and fail.
    expect(body).not.toHaveProperty('paymentRequirements');
  });

  it('nests the payload under paymentPayload with its own version marker', () => {
    expect(body.paymentPayload.x402Version).toBe(2);
    expect(body.paymentPayload.payload).toEqual(PAYLOAD);
  });

  it('repeats resource and accepted inside paymentPayload', () => {
    // Redundant on the wire, but the facilitator's PaymentPayloadV2 declares
    // both, so omitting them fails deserialization.
    expect(body.paymentPayload.resource).toEqual(RESOURCE);
    expect(body.paymentPayload.accepted).toEqual(ACCEPTED);
  });

  it('declares version 2 at every level', () => {
    expect(body.x402Version).toBe(2);
    expect(body.paymentPayload.x402Version).toBe(2);
  });

  it('keeps the network in CAIP-2, never a plain name', () => {
    // A plain name inside a v2 request fails deserialization, exactly as a
    // CAIP-2 id inside a v1 request does. Each version wants its own format.
    expect(body.accepted.network).toContain(':');
  });
});

describe('buildSettleRequestV2', () => {
  it('produces the same envelope as verify', () => {
    expect(buildSettleRequestV2(PAYLOAD, RESOURCE, ACCEPTED)).toEqual(
      buildVerifyRequestV2(PAYLOAD, RESOURCE, ACCEPTED)
    );
  });
});

describe('v1 vs v2 envelopes stay distinct', () => {
  it('v1 still emits paymentRequirements and no top-level accepted', () => {
    const v1 = buildVerifyRequest(
      { x402Version: 1, scheme: 'exact', network: 'base', payload: PAYLOAD },
      {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: '100000',
        resource: RESOURCE.url,
        description: RESOURCE.description,
        mimeType: RESOURCE.mimeType,
        payTo: ACCEPTED.payTo,
        maxTimeoutSeconds: 300,
        asset: ACCEPTED.asset,
      }
    );
    expect(v1).toHaveProperty('paymentRequirements');
    expect(v1).not.toHaveProperty('accepted');
  });
});
