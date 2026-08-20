import { describe, expect, it } from 'vitest';

import { detectX402Version, paymentChallengeFrom } from './index';

/**
 * A real `PAYMENT-REQUIRED` header value captured from production: base64 of an
 * x402 v2 challenge with `accepts[].payTo` on Base.
 */
const REAL_HEADER =
  'eyJ4NDAyVmVyc2lvbiI6IDIsICJlcnJvciI6ICJQYXltZW50IHJlcXVpcmVkIiwgImFjY2VwdHMiOiBbeyJzY2hlbWUiOiAiZXhhY3QiLCAibmV0d29yayI6ICJlaXAxNTU6ODQ1MyIsICJhbW91bnQiOiAiMTAwMDAwIiwgImFzc2V0IjogIjB4ODMzNTg5ZkNENmVEYjZFMDhmNGM3QzMyRDRmNzFiNTRiZEEwMjkxMyIsICJwYXlUbyI6ICIweGIwNTllQUM5MzMwREM1ZjIzRjUzNDZhODEzNDhBZjFFOTlmMzc5YmQiLCAibWF4VGltZW91dFNlY29uZHMiOiAzMDB9XX0=';

/**
 * What a real seller puts in the 402 BODY: a free preview of the paid content.
 * Valid JSON, zero payment terms — the case that makes a body-only reader
 * report success while seeing nothing.
 */
const PREVIEW_BODY = {
  id: '01a01a4c',
  slug: 'china-macro-weekly',
  title: 'China Macro Weekly',
  price: '100000',
};

describe('reading the 402 challenge from either transport', () => {
  it('decodes a header value instead of calling it v1', () => {
    // The bug: a header value is a base64 string, so the old code fell into
    // `typeof data !== 'object'` and answered 1 without ever decoding it —
    // silently, as a plausible value. v1 and v2 payloads are structurally
    // incompatible, so that misread builds the wrong request shape.
    expect(detectX402Version(REAL_HEADER)).toBe(2);
  });

  it('still answers v1 for something genuinely undecodable', () => {
    expect(detectX402Version('not base64 and not json')).toBe(1);
    expect(detectX402Version('')).toBe(1);
    expect(detectX402Version(undefined)).toBe(1);
  });

  it('finds the challenge in the header when the body is a preview', () => {
    // Measured 2026-08-20: 36 of 36 live resources answering 402 do exactly
    // this.
    const headers = new Headers({ 'payment-required': REAL_HEADER });
    const challenge = paymentChallengeFrom(headers, PREVIEW_BODY);
    expect(challenge).not.toBeNull();
    expect((challenge!.accepts as unknown[]).length).toBe(1);
  });

  it('still reads the body transport', () => {
    const body = { x402Version: 2, accepts: [{ payTo: '0xAAAA' }] };
    const challenge = paymentChallengeFrom(new Headers(), body);
    expect(challenge).not.toBeNull();
    expect((challenge!.accepts as unknown[]).length).toBe(1);
  });

  it('does not mistake a free preview for a challenge', () => {
    // THE failure this exists to prevent: valid JSON, no payment terms. Saying
    // "here is your challenge" for this is how a caller concludes it checked.
    expect(paymentChallengeFrom(new Headers(), PREVIEW_BODY)).toBeNull();
  });

  it('accepts a plain header record, not just a Headers object', () => {
    const challenge = paymentChallengeFrom({ 'payment-required': REAL_HEADER });
    expect(challenge).not.toBeNull();
  });

  it('falls back to the body when the header is unparseable', () => {
    const headers = new Headers({ 'payment-required': '!!!not base64!!!' });
    const body = { accepts: [{ payTo: '0xBBBB' }] };
    expect(paymentChallengeFrom(headers, body)).not.toBeNull();
  });
});

describe('the v1 spelling of accepts', () => {
  it('recognises paymentRequirements as a challenge', () => {
    // KarmaKadabra's buyer matched both keys in production; ours matched only
    // one, so a seller using the v1 spelling read as "no terms here" — the
    // exact false negative this reader exists to prevent.
    const v1 = { paymentRequirements: [{ payTo: '0xAAAA' }] };
    expect(paymentChallengeFrom(new Headers(), v1)).not.toBeNull();
  });

  it('still refuses a preview that has neither key', () => {
    expect(paymentChallengeFrom(new Headers(), { id: 'x', title: 'preview' })).toBeNull();
  });

  it('reads paymentRequirements out of the header too', () => {
    const raw = btoa(JSON.stringify({ paymentRequirements: [{ payTo: '0xBBBB' }] }));
    expect(paymentChallengeFrom({ 'payment-required': raw })).not.toBeNull();
  });
});
