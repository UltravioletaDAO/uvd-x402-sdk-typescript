import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FacilitatorClient,
  buildSettleRequest,
  buildSettleRequestForVersion,
  buildSettleRequestV2,
  buildVerifyRequest,
  buildVerifyRequestForVersion,
  buildVerifyRequestV2,
  resolveEnvelopeVersion,
  toPaymentRequirementsV2,
  toResourceInfoV2,
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

/**
 * The half the SDK was missing until 2026-09-03.
 *
 * `buildVerifyRequestV2` above has existed since 2026-07-29 and its shape is
 * still exactly what production accepts. What did NOT exist was any way to
 * reach it: `FacilitatorClient.verify`/`settle` called the v1 builder
 * unconditionally, and they are what `createPaymentMiddleware`,
 * `createHonoMiddleware`, `verifyAndSettle` and every seller integration go
 * through. So a seller whose 402 advertised CAIP-2 -- which
 * `createHonoMiddleware` does on its own as soon as the accepts carry CAIP-2
 * ids -- shipped a paywall that no buyer following that 402 could pay, and each
 * consumer had to hand-port the v2 body. MeshRelay was porting it from its own
 * Turnstile service when this was written.
 *
 * Every expectation below is pinned to a status measured against
 * https://facilitator.ultravioletadao.xyz/verify on 2026-09-03 (facilitator
 * 2.10.0). The envelope enum there is UNTAGGED: it matches on shape and ignores
 * the `x402Version` marker, which is why the auto rule keys off CAIP-2 and not
 * off the marker.
 */
describe('FacilitatorClient picks the envelope', () => {
  const CAIP2_REQS = {
    scheme: 'exact' as const,
    network: 'eip155:8453',
    maxAmountRequired: '100000',
    resource: RESOURCE.url,
    description: RESOURCE.description,
    mimeType: RESOURCE.mimeType,
    payTo: ACCEPTED.payTo,
    maxTimeoutSeconds: 300,
    asset: ACCEPTED.asset,
  };
  const PLAIN_REQS = { ...CAIP2_REQS, network: 'base' };

  const V1_HEADER = {
    x402Version: 1 as const,
    scheme: 'exact' as const,
    network: 'base',
    payload: PAYLOAD,
  };
  const CAIP2_HEADER = { ...V1_HEADER, network: 'eip155:8453' };

  function mockFacilitator(body: unknown = { isValid: true }) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const sentBody = (fetchMock: ReturnType<typeof mockFacilitator>) =>
    JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as Record<string, unknown>;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the v2 envelope to /verify when the requirements are CAIP-2', async () => {
    // RED before this change: the client emitted
    // {x402Version, paymentPayload, paymentRequirements} with network
    // "eip155:8453" inside, which production answers
    // 400 `unknown variant \`eip155:8453\``.
    const fetchMock = mockFacilitator();
    await new FacilitatorClient().verify(V1_HEADER, CAIP2_REQS);

    const body = sentBody(fetchMock);
    expect(body.x402Version).toBe(2);
    expect(body).not.toHaveProperty('paymentRequirements');
    expect(body.accepted).toEqual(ACCEPTED);
    expect(body.resource).toEqual(RESOURCE);
  });

  it('sends the v2 envelope to /settle on the same trigger', async () => {
    const fetchMock = mockFacilitator({ success: true, transaction: '0xabc' });
    await new FacilitatorClient().settle(V1_HEADER, CAIP2_REQS);

    const body = sentBody(fetchMock);
    expect(body.x402Version).toBe(2);
    expect(body).not.toHaveProperty('paymentRequirements');
    expect(body.accepted).toEqual(ACCEPTED);
  });

  it('upgrades on a CAIP-2 network in the PAYMENT HEADER too', async () => {
    // Measured 400 today: CAIP-2 in the payload with plain-name requirements.
    // The seller may have built requirements from a v1 config while the buyer
    // echoed the CAIP-2 id from the 402.
    const fetchMock = mockFacilitator();
    await new FacilitatorClient().verify(CAIP2_HEADER, PLAIN_REQS);

    const body = sentBody(fetchMock);
    expect(body.x402Version).toBe(2);
    // `base` had to become `eip155:8453`; a plain name inside a v2 body is a 400.
    expect((body.accepted as { network: string }).network).toBe('eip155:8453');
  });

  it('leaves the v1 path byte-for-byte unchanged', async () => {
    const fetchMock = mockFacilitator();
    await new FacilitatorClient().verify(V1_HEADER, PLAIN_REQS);

    expect(sentBody(fetchMock)).toEqual(buildVerifyRequest(V1_HEADER, PLAIN_REQS));
  });

  it('does NOT upgrade a header that only declares version 2 with plain names', async () => {
    // The regression guard that decided the auto rule. Measured 200: the v1
    // envelope carrying {x402Version: 2, network: "base"} is served correctly
    // today, because the facilitator matches on shape. Upgrading it on the
    // strength of the marker would change a call that already works.
    const fetchMock = mockFacilitator();
    await new FacilitatorClient().verify(
      { x402Version: 2, scheme: 'exact', network: 'base', payload: PAYLOAD },
      PLAIN_REQS
    );

    const body = sentBody(fetchMock);
    expect(body).toHaveProperty('paymentRequirements');
    expect(body).not.toHaveProperty('accepted');
  });

  it('honours an explicit pin over what the wire says', async () => {
    const forcedV2 = mockFacilitator();
    await new FacilitatorClient({ x402Version: 2 }).verify(V1_HEADER, PLAIN_REQS);
    expect(sentBody(forcedV2)).toHaveProperty('accepted');

    vi.unstubAllGlobals();

    const forcedV1 = mockFacilitator();
    await new FacilitatorClient({ x402Version: 1 }).verify(V1_HEADER, CAIP2_REQS);
    expect(sentBody(forcedV1)).toHaveProperty('paymentRequirements');
  });
});

describe('resolveEnvelopeVersion', () => {
  const header = (network: string, x402Version: 1 | 2 = 1) =>
    ({ x402Version, scheme: 'exact' as const, network, payload: PAYLOAD });
  const reqs = (network: string) => ({
    scheme: 'exact' as const,
    network,
    maxAmountRequired: '100000',
    resource: RESOURCE.url,
    description: RESOURCE.description,
    mimeType: RESOURCE.mimeType,
    payTo: ACCEPTED.payTo,
    maxTimeoutSeconds: 300,
    asset: ACCEPTED.asset,
  });

  // One row per combination measured against production on 2026-09-03. The
  // expected version is "which envelope does this pair have to travel in",
  // and every pair mapped to 2 here is a hard 400 in the v1 envelope today.
  it.each([
    ['plain / plain -> v1 (200 today, must not move)', 'base', 'base', 1],
    ['CAIP-2 / plain -> v2 (400 today)', 'eip155:8453', 'base', 2],
    ['plain / CAIP-2 -> v2 (400 today)', 'base', 'eip155:8453', 2],
    ['CAIP-2 / CAIP-2 -> v2 (400 today)', 'eip155:8453', 'eip155:8453', 2],
  ] as const)('%s', (_label, headerNetwork, reqsNetwork, expected) => {
    expect(resolveEnvelopeVersion(header(headerNetwork), reqs(reqsNetwork))).toBe(expected);
  });

  it('ignores the x402Version marker on the header', () => {
    // Measured 200: a v1-shaped body whose marker says 2 is served fine.
    expect(resolveEnvelopeVersion(header('base', 2), reqs('base'))).toBe(1);
  });

  it('keeps XRPL on v1 — its v1 network string IS its identifier', () => {
    expect(resolveEnvelopeVersion(header('xrpl-mainnet'), reqs('xrpl-mainnet'))).toBe(1);
  });

  it('lets an explicit request win over the wire', () => {
    expect(resolveEnvelopeVersion(header('base'), reqs('base'), 2)).toBe(2);
    expect(resolveEnvelopeVersion(header('eip155:8453'), reqs('eip155:8453'), 1)).toBe(1);
  });
});

describe('v1 -> v2 requirements conversion', () => {
  const V1_REQS = {
    scheme: 'exact' as const,
    network: 'base',
    maxAmountRequired: '100000',
    resource: RESOURCE.url,
    description: RESOURCE.description,
    mimeType: RESOURCE.mimeType,
    payTo: ACCEPTED.payTo,
    maxTimeoutSeconds: 300,
    asset: ACCEPTED.asset,
  };

  it('renames maxAmountRequired to amount', () => {
    // The rename the facilitator does not report by name: an `accepted` still
    // carrying `maxAmountRequired` and no `amount` is a measured 400.
    const v2 = toPaymentRequirementsV2(V1_REQS);
    expect(v2.amount).toBe('100000');
    expect(v2).not.toHaveProperty('maxAmountRequired');
  });

  it('converts a plain network name to CAIP-2', () => {
    expect(toPaymentRequirementsV2(V1_REQS).network).toBe('eip155:8453');
  });

  it('leaves an already-CAIP-2 network alone', () => {
    expect(
      toPaymentRequirementsV2({ ...V1_REQS, network: 'eip155:137' }).network
    ).toBe('eip155:137');
  });

  it('carries extra through — EURC and the bridged USDCs need it', () => {
    // extra.name/extra.version is the EIP-712 domain for tokens the facilitator
    // does not know by address. Dropping it makes those tokens unpayable.
    const extra = { name: 'EURC', version: '2' };
    expect(toPaymentRequirementsV2({ ...V1_REQS, extra }).extra).toEqual(extra);
  });

  it('omits extra entirely when there is none', () => {
    expect(toPaymentRequirementsV2(V1_REQS)).not.toHaveProperty('extra');
  });

  it('splits resource/description/mimeType into the resource object', () => {
    expect(toResourceInfoV2(V1_REQS)).toEqual(RESOURCE);
  });

  it('fills description and mimeType rather than emitting a partial resource', () => {
    // Measured 400: a resource object with only `url`. The types say these are
    // required, but a JS caller can still omit them, and the facilitator answers
    // "no variant matched" without naming the missing field.
    const partial = { ...V1_REQS } as Record<string, unknown>;
    delete partial.description;
    delete partial.mimeType;

    const resource = toResourceInfoV2(partial as unknown as typeof V1_REQS);
    expect(resource.description).toBeTruthy();
    expect(resource.mimeType).toBeTruthy();
  });

  it('fills maxTimeoutSeconds rather than omitting it', () => {
    // Measured 400: `accepted` without maxTimeoutSeconds.
    const partial = { ...V1_REQS } as Record<string, unknown>;
    delete partial.maxTimeoutSeconds;

    expect(
      toPaymentRequirementsV2(partial as unknown as typeof V1_REQS).maxTimeoutSeconds
    ).toBeGreaterThan(0);
  });
});

/**
 * The envelope marker names the ENVELOPE, not the payer.
 *
 * Until 2026-09-04 `buildVerifyRequest` / `buildSettleRequest` copied
 * `paymentHeader.x402Version` into the top level of the **v1** envelope. A
 * buyer who declared `2` -- which is legal, and which the SDK's own 402 invites
 * as soon as it advertises CAIP-2 -- therefore got a body that says `2` while
 * carrying `paymentRequirements`, the v1 shape. Nothing broke, because the
 * facilitator's envelope enum is untagged and matches on shape.
 *
 * What makes it a defect anyway is that the facilitator ALREADY reads that
 * marker for one thing: choosing the hint in its 400.
 *
 *   "This body declares `x402Version: 2`. x402 v2 is a JSON object with
 *    `paymentPayload`, `resource` and `accepted`..."
 *
 * So the first time such a body fails for an unrelated reason, the error tells
 * the integrator to go fix the wrong shape. Being sent to the fields when the
 * wrapper is the problem is precisely the inversion that cost two teams a day,
 * and it is the same class of defect that made the ChatGPT/PayBox purchase of a
 * MeshRelay deliberation fail.
 *
 * Found by the Python SDK's cross-SDK comparison (0xultravioleta/py-sobre-v2,
 * §5.3): the ONLY body difference left between the two SDKs on the same wire.
 */
describe('the v1 envelope marker is the envelope, not the payer', () => {
  const PLAIN_REQS = {
    scheme: 'exact' as const,
    network: 'base',
    maxAmountRequired: '100000',
    resource: RESOURCE.url,
    description: RESOURCE.description,
    mimeType: RESOURCE.mimeType,
    payTo: ACCEPTED.payTo,
    maxTimeoutSeconds: 300,
    asset: ACCEPTED.asset,
  };

  /** A payer that declares v2 while carrying plain network names. Legal, and a
   *  measured 200 in the v1 envelope -- so this must keep travelling as v1. */
  const DECLARES_V2 = {
    x402Version: 2 as const,
    scheme: 'exact' as const,
    network: 'base',
    payload: PAYLOAD,
  };
  const DECLARES_V1 = { ...DECLARES_V2, x402Version: 1 as const };

  it('emits 1 for a payer that declared 2', () => {
    // RED before the fix: `2`, inherited from the header.
    expect(buildVerifyRequest(DECLARES_V2, PLAIN_REQS).x402Version).toBe(1);
  });

  it('emits 1 on /settle too', () => {
    expect(buildSettleRequest(DECLARES_V2, PLAIN_REQS).x402Version).toBe(1);
  });

  it('leaves the payer’s own marker untouched inside paymentPayload', () => {
    // The fix must not rewrite the payer's header: that marker describes the
    // payment, and the facilitator reads it there. Only the envelope's own
    // marker is ours to set. A "fix" that clamped both would be a regression.
    const body = buildVerifyRequest(DECLARES_V2, PLAIN_REQS);
    expect(body.paymentPayload.x402Version).toBe(2);
    expect(body.paymentPayload).toEqual(DECLARES_V2);
  });

  it('does not move the ordinary v1 payer', () => {
    // The no-regression guard: green in BOTH states, on purpose.
    expect(buildVerifyRequest(DECLARES_V1, PLAIN_REQS).x402Version).toBe(1);
    expect(buildSettleRequest(DECLARES_V1, PLAIN_REQS).x402Version).toBe(1);
  });

  it('never contradicts itself: the marker and the shape agree, on every wire', () => {
    // The invariant, rather than a case. Whatever the payer declares and
    // whatever `resolveEnvelopeVersion` picks, a body marked 2 MUST carry
    // {resource, accepted} and a body marked 1 MUST carry paymentRequirements.
    // This is what the facilitator would enforce the day its enum stops being
    // untagged, and what its 400 hint already assumes today.
    for (const marker of [1, 2] as const) {
      for (const network of ['base', 'eip155:8453']) {
        const header = { x402Version: marker, scheme: 'exact' as const, network, payload: PAYLOAD };
        const reqs = { ...PLAIN_REQS, network };
        for (const pin of [undefined, 1, 2] as const) {
          const version = resolveEnvelopeVersion(header, reqs, pin ?? 'auto');
          const body = buildVerifyRequestForVersion(header, reqs, version) as Record<
            string,
            unknown
          >;
          const label = `marker=${marker} network=${network} pin=${pin ?? 'auto'}`;

          expect(body.x402Version, label).toBe(version);
          if (version === 2) {
            expect(body, label).toHaveProperty('accepted');
            expect(body, label).not.toHaveProperty('paymentRequirements');
          } else {
            expect(body, label).toHaveProperty('paymentRequirements');
            expect(body, label).not.toHaveProperty('accepted');
          }
        }
      }
    }
  });

  it('sends 1 through the client, on the wire that produced the report', async () => {
    // End-to-end through FacilitatorClient, which is what every seller
    // integration actually calls.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ isValid: true }),
      text: async () => '{"isValid":true}',
    });
    vi.stubGlobal('fetch', fetchMock);

    await new FacilitatorClient().verify(DECLARES_V2, PLAIN_REQS);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.x402Version).toBe(1);
    expect(body).toHaveProperty('paymentRequirements');
    expect(body.paymentPayload.x402Version).toBe(2);

    vi.unstubAllGlobals();
  });
});

/**
 * A network with no CAIP-2 form cannot travel in a v2 body, and saying so is
 * better than sending one.
 *
 * `chainToCAIP2` answers with the name unchanged when it does not know a chain,
 * and XRPL maps to ITSELF on purpose — `xrpl-mainnet` has no CAIP-2 form, its
 * v1 string IS its network id. So `toPaymentRequirementsV2` used to hand back
 * `network: 'xrpl-mainnet'` inside a v2 envelope: a plain name in a v2 body,
 * which is a measured 400 (`data did not match any variant of untagged enum`,
 * naming no field). The SDK knew the rule — the doc comment right above it says
 * "a plain name inside a v2 body is a 400" — and shipped the body anyway.
 *
 * Only reachable by PINNING 2 on such a network: `auto` leaves them on v1,
 * where they work. Found by phase 6 of the cross-language conformance run,
 * which is the whole reason that phase exists: the Python SDK refuses this wire
 * with the fix in the message, TypeScript quietly built the 400.
 */
describe('a network with no CAIP-2 form refuses v2 rather than emitting a 400', () => {
  const XRPL_REQS = {
    scheme: 'exact' as const,
    network: 'xrpl-mainnet',
    maxAmountRequired: '100000',
    resource: RESOURCE.url,
    description: RESOURCE.description,
    mimeType: RESOURCE.mimeType,
    payTo: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
    maxTimeoutSeconds: 300,
    asset: 'XRP',
  };
  const XRPL_HEADER = {
    x402Version: 1 as const,
    scheme: 'exact' as const,
    network: 'xrpl-mainnet',
    payload: PAYLOAD,
  };

  it('throws, naming the network and the escape', () => {
    // RED before the fix: returned { network: 'xrpl-mainnet' } inside a v2 body.
    expect(() => toPaymentRequirementsV2(XRPL_REQS)).toThrow(/no CAIP-2 form/);
    expect(() => toPaymentRequirementsV2(XRPL_REQS)).toThrow(/xrpl-mainnet/);
    expect(() => toPaymentRequirementsV2(XRPL_REQS)).toThrow(/x402Version: 1/);
  });

  it('throws through the builders, on both endpoints', () => {
    expect(() => buildVerifyRequestForVersion(XRPL_HEADER, XRPL_REQS, 2)).toThrow(
      /no CAIP-2 form/
    );
    expect(() => buildSettleRequestForVersion(XRPL_HEADER, XRPL_REQS, 2)).toThrow(
      /no CAIP-2 form/
    );
  });

  it('never fires on auto — XRPL stays on v1, where it works', () => {
    // The no-regression guard: green in BOTH states. `auto` must not have
    // become a way to break XRPL, which is the live path.
    const version = resolveEnvelopeVersion(XRPL_HEADER, XRPL_REQS);
    expect(version).toBe(1);
    expect(buildVerifyRequestForVersion(XRPL_HEADER, XRPL_REQS, version)).toHaveProperty(
      'paymentRequirements'
    );
  });

  it('leaves every network that HAS a CAIP-2 form alone', () => {
    // The other half of the guard: the throw must be about the missing form,
    // not about non-EVM chains. Solana and Stellar have CAIP-2 ids and pass.
    for (const [network, expected] of [
      ['base', 'eip155:8453'],
      ['avalanche', 'eip155:43114'],
      ['solana', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
      ['stellar', 'stellar:pubnet'],
    ] as const) {
      expect(toPaymentRequirementsV2({ ...XRPL_REQS, network }).network).toBe(expected);
    }
  });
});
