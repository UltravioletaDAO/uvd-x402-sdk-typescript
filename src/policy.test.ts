import { describe, expect, it, vi } from 'vitest';

import {
  PurchasePolicy,
  PolicyRefusedError,
  decideOnChallenge,
  offerValidUntil,
  canonicalRecipient,
  assetKey,
  OFFER_VALIDITY_EXTENSION,
} from './policy';
import type { PolicyAsset, ReadChallenge } from './policy';
import { X402Client } from './client/X402Client';
import { X402Error } from './types';
import type { X402PaymentOffer } from './types';

/**
 * The buyer's policy: what this SDK is allowed to sign, decided against the
 * offer in hand before anything is signed.
 *
 * Same contract the Rust facilitator's `x402-reqwest` crate shipped in 2.25.0,
 * so a buyer in either language refuses the same payments for the same stated
 * reasons. These tests pin the parts of that contract that are easy to break
 * and expensive when broken:
 *
 *   - the SIX refusal codes and their FIXED order, because the first failing
 *     check is the one reported and a caller branches on it;
 *   - evaluating does not spend, and `recordSpend` is a separate call;
 *   - a copy of a policy spends from the SAME purse;
 *   - hex addresses fold case, base58 ones are compared exactly;
 *   - one unreadable `accepts` entry keeps the readable ones;
 *   - `validUntil === now` still stands, and an unreadable one is ABSENT, never
 *     zero;
 *   - and two that enter through the real path -- `client.fetch()` against a
 *     mocked 402 -- because a decision the real path does not call is worse than
 *     one that does not exist: the unit tests still pass and the capability is
 *     simply absent.
 *
 * Anvil/Hardhat account #0. Es una llave PUBLICA y conocida, a proposito: todo
 * escaner la reconoce como fixture y nadie le manda fondos jamas. NUNCA poner
 * aca una llave generada.
 */
const PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/** USDC on Base, checksummed exactly as the chain registry writes it. */
const USDC_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** EURC on Base -- a second asset, so "budgeted" can differ per token. */
const EURC_BASE_ADDRESS = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42';
const PAY_TO = '0xe4dc963c56979E0260fc146b87eE24F18220e545';
const OTHER_PAYEE = '0x000000000000000000000000000000000000dEaD';
/** A real base58 address: both cases matter, and folding it destroys it. */
const SOLANA_PAYEE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const USDC_BASE: PolicyAsset = { network: 'base', address: USDC_BASE_ADDRESS };
const EURC_BASE: PolicyAsset = { network: 'base', address: EURC_BASE_ADDRESS };

/** One offer as the client reads it off a 402. */
function offer(over: Partial<X402PaymentOffer> = {}): X402PaymentOffer {
  return {
    network: 'base',
    chainName: 'base',
    asset: USDC_BASE_ADDRESS,
    amount: '10000', // 0.01 USDC, atomic
    decimals: 6,
    payTo: PAY_TO,
    raw: {},
    ...over,
  };
}

/** A challenge carrying one readable offer and nothing else. */
function challengeOf(
  offers: X402PaymentOffer[],
  extensions?: Record<string, unknown>
): ReadChallenge {
  return { offers, unreadable: [], unreadableCount: 0, extensions };
}

/** The `extensions` map a seller publishes to say how long its offer stands. */
function validity(validUntil: unknown): Record<string, unknown> {
  return { [OFFER_VALIDITY_EXTENSION]: { schema: 'offer-receipt/1', info: { validUntil } } };
}

const NOW = 1_760_000_000;

// ============================================================================
// The six codes, and their fixed order
// ============================================================================

describe('PurchasePolicy - the order of evaluation is part of the contract', () => {
  /**
   * Every refusal in this table is present at once, and the policy must report
   * the FIRST one in contract order. Walking the table top to bottom and
   * removing the cause each time proves the order, not just the codes: a policy
   * that reported `per-payment-limit` for an expired offer to a payee nobody
   * allowed would be telling the caller to raise a ceiling when the real fix is
   * to ask the seller for new terms.
   */
  it('reports the first failing check, never a later one', () => {
    // Budgeted asset, tiny ceiling, allowlist that excludes the payee, and an
    // offer that expired -- all four wrong at once.
    const policy = PurchasePolicy.create()
      .perPayment(USDC_BASE, 1n)
      .cumulative(USDC_BASE, 1n)
      .onlyPay([PAY_TO]);

    const badPayee = offer({ payTo: OTHER_PAYEE });

    // 1. no-readable-offer beats everything: there is no offer to judge.
    const step1 = decideOnChallenge(
      policy,
      { offers: [], unreadable: ['batch-settlement'], unreadableCount: 1, extensions: validity(NOW - 1) },
      null,
      { now: NOW }
    );
    expect(step1.ok).toBe(false);
    expect(step1.ok === false && step1.refusal.code).toBe('no-readable-offer');

    // 2. offer-expired beats the recipient check.
    const step2 = decideOnChallenge(policy, challengeOf([badPayee], validity(NOW - 1)), badPayee, {
      now: NOW,
    });
    expect(step2.ok === false && step2.refusal.code).toBe('offer-expired');

    // 3. recipient-not-permitted beats the asset check.
    const unbudgetedAndBadPayee = offer({ payTo: OTHER_PAYEE, asset: EURC_BASE_ADDRESS });
    const step3 = decideOnChallenge(
      policy,
      challengeOf([unbudgetedAndBadPayee]),
      unbudgetedAndBadPayee,
      { now: NOW }
    );
    expect(step3.ok === false && step3.refusal.code).toBe('recipient-not-permitted');

    // 4. asset-not-budgeted beats the ceilings. The caller has to be told to
    //    budget the asset, not to raise a ceiling that does not exist.
    const unbudgeted = offer({ asset: EURC_BASE_ADDRESS });
    const step4 = decideOnChallenge(policy, challengeOf([unbudgeted]), unbudgeted, { now: NOW });
    expect(step4.ok === false && step4.refusal.code).toBe('asset-not-budgeted');

    // 5. per-payment-limit beats the cumulative one.
    const step5 = decideOnChallenge(policy, challengeOf([offer()]), offer(), { now: NOW });
    expect(step5.ok === false && step5.refusal.code).toBe('per-payment-limit');

    // 6. cumulative-limit, once the per-payment ceiling is wide enough.
    const roomy = PurchasePolicy.create()
      .perPayment(USDC_BASE, 1_000_000n)
      .cumulative(USDC_BASE, 5_000n)
      .onlyPay([PAY_TO]);
    const step6 = roomy.evaluate(offer(), { now: NOW });
    expect(step6.ok === false && step6.refusal.code).toBe('cumulative-limit');
  });

  it('carries the numbers that caused each refusal', () => {
    const policy = PurchasePolicy.create().perPayment(USDC_BASE, 5_000n);
    const decision = policy.evaluate(offer({ amount: '10000' }), { now: NOW });

    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    if (decision.refusal.code !== 'per-payment-limit') throw new Error('wrong code');
    // bigint throughout: atomic units of an 18-decimal token pass
    // Number.MAX_SAFE_INTEGER at 0.01 of a token.
    expect(decision.refusal.requested).toBe(10_000n);
    expect(decision.refusal.allowed).toBe(5_000n);
    expect(decision.refusal.asset).toEqual(USDC_BASE);

    const cumulative = PurchasePolicy.create().cumulative(USDC_BASE, 12_000n);
    cumulative.recordSpend(USDC_BASE, 8_000n);
    const second = cumulative.evaluate(offer({ amount: '10000' }), { now: NOW });
    if (second.ok) throw new Error('unreachable');
    if (second.refusal.code !== 'cumulative-limit') throw new Error('wrong code');
    expect(second.refusal.spent).toBe(8_000n);
    expect(second.refusal.wouldTotal).toBe(18_000n);
    expect(second.refusal.allowed).toBe(12_000n);
  });

  it('refuses an asset with no ceiling, and permits it only when asked by name', () => {
    // The map has no opinion about a key it does not hold, which is exactly how
    // an unlisted token sails past a budget that looks complete -- and the EVM
    // signer would sign it, because it takes its EIP-712 domain from the
    // seller's own `extra`.
    const budgeted = PurchasePolicy.create().perPayment(USDC_BASE, 1_000_000n);
    const eurc = offer({ asset: EURC_BASE_ADDRESS });
    expect(budgeted.evaluate(eurc, { now: NOW }).ok).toBe(false);

    // Permissive is named, never a default.
    expect(PurchasePolicy.permissive().evaluate(eurc, { now: NOW }).ok).toBe(true);
    expect(budgeted.allowUnlistedAssets().evaluate(eurc, { now: NOW }).ok).toBe(true);
    // And it can be said back out loud at a call site that wants it explicit.
    expect(
      PurchasePolicy.permissive().denyUnlistedAssets().evaluate(eurc, { now: NOW }).ok
    ).toBe(false);
  });

  it('treats the same address on another network as another asset', () => {
    // Rule 4: a different asset is not the same price. The same USDC contract
    // address on two networks is two assets, and a budget for one is not one for
    // the other.
    const policy = PurchasePolicy.create().perPayment(USDC_BASE, 1_000_000n);
    const elsewhere = offer({ network: 'polygon', chainName: 'polygon' });
    const decision = policy.evaluate(elsewhere, { now: NOW });
    expect(decision.ok === false && decision.refusal.code).toBe('asset-not-budgeted');
    expect(assetKey(USDC_BASE)).not.toBe(assetKey({ network: 'polygon', address: USDC_BASE_ADDRESS }));
  });

  it('never widens itself: no method loosens the policy it was called on', () => {
    // Rule 2. Every builder returns a NEW policy and leaves the receiver exactly
    // as strict as it was, so nothing an evaluation can reach gives an offer more
    // room. A mutating setter here would be that reach.
    const strict = PurchasePolicy.create().perPayment(USDC_BASE, 1n).onlyPay([PAY_TO]);
    const refusesEverything = () => expect(strict.evaluate(offer(), { now: NOW }).ok).toBe(false);

    refusesEverything();
    const wider = strict.perPayment(USDC_BASE, 1_000_000n);
    refusesEverything();
    expect(wider.evaluate(offer(), { now: NOW }).ok).toBe(true);

    const unlisted = strict.allowUnlistedAssets();
    refusesEverything();
    expect(unlisted.permitsUnlistedAssets).toBe(true);
    expect(strict.permitsUnlistedAssets).toBe(false);

    const wideOpen = strict.cumulative(USDC_BASE, 10n ** 30n).onlyPay([PAY_TO, OTHER_PAYEE]);
    refusesEverything();
    expect(wideOpen.evaluate(offer(), { now: NOW }).ok).toBe(false); // perPayment still 1n

    // And `permitsUnlistedAssets` is a getter with no setter behind it.
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(strict),
      'permitsUnlistedAssets'
    );
    expect(descriptor?.get).toBeTypeOf('function');
    expect(descriptor?.set).toBeUndefined();
  });
});

// ============================================================================
// Evaluating does not spend
// ============================================================================

describe('PurchasePolicy - evaluating does not spend', () => {
  it('leaves the running total untouched no matter how often it is asked', () => {
    // Signing can fail and a settlement can be refused; a cumulative limit that
    // counted attempts would lock a caller out of money it never spent.
    const policy = PurchasePolicy.create()
      .perPayment(USDC_BASE, 1_000_000n)
      .cumulative(USDC_BASE, 20_000n);

    for (let i = 0; i < 5; i += 1) {
      expect(policy.evaluate(offer({ amount: '10000' }), { now: NOW }).ok).toBe(true);
    }
    // Five approvals of 0.01 against a 0.02 ceiling: still nothing spent.
    expect(policy.spent(USDC_BASE)).toBe(0n);
  });

  it('moves the total only through recordSpend, and then refuses what no longer fits', () => {
    const policy = PurchasePolicy.create()
      .perPayment(USDC_BASE, 1_000_000n)
      .cumulative(USDC_BASE, 25_000n);

    policy.recordSpend(USDC_BASE, 10_000n);
    expect(policy.spent(USDC_BASE)).toBe(10_000n);
    policy.recordSpend(USDC_BASE, 10_000n);
    expect(policy.spent(USDC_BASE)).toBe(20_000n);

    const decision = policy.evaluate(offer({ amount: '10000' }), { now: NOW });
    if (decision.ok) throw new Error('a third payment should not fit');
    expect(decision.refusal.code).toBe('cumulative-limit');
  });

  it('ignores a negative recordSpend instead of handing budget back', () => {
    const policy = PurchasePolicy.create().cumulative(USDC_BASE, 25_000n);
    policy.recordSpend(USDC_BASE, 20_000n);
    policy.recordSpend(USDC_BASE, -15_000n);
    // Handing budget back is not something a settlement can do, and treating it
    // as one would widen the policy from outside.
    expect(policy.spent(USDC_BASE)).toBe(20_000n);
  });

  it('reports the ceiling, never zero, when the purse is corrupt', () => {
    // For money the safe direction is to refuse. Reporting zero spent would
    // silently restore the caller's whole budget.
    const policy = PurchasePolicy.create().cumulative(USDC_BASE, 25_000n);
    policy.recordSpend(USDC_BASE, 1_000n);
    // Whatever mangled it -- a bad deserialisation, a caller reaching in -- the
    // answer is the ceiling.
    (policy as unknown as { spentTotals: Map<string, unknown> }).spentTotals.set(
      assetKey(USDC_BASE),
      'not a bigint'
    );
    expect(policy.spent(USDC_BASE)).toBe(25_000n);
    expect(policy.evaluate(offer({ amount: '1' }), { now: NOW }).ok).toBe(false);
  });
});

// ============================================================================
// A copy spends from the same purse
// ============================================================================

describe('PurchasePolicy - a copy spends from the same purse', () => {
  it('shares the running total across clone() and across every builder', () => {
    // A client is copied per request; if each copy kept its own total a
    // cumulative limit would mean nothing.
    const policy = PurchasePolicy.create()
      .perPayment(USDC_BASE, 1_000_000n)
      .cumulative(USDC_BASE, 25_000n);

    const copy = policy.clone();
    copy.recordSpend(USDC_BASE, 20_000n);

    expect(policy.spent(USDC_BASE)).toBe(20_000n);
    expect(copy.spent(USDC_BASE)).toBe(20_000n);
    expect(policy.evaluate(offer({ amount: '10000' }), { now: NOW }).ok).toBe(false);

    // And a policy narrowed afterwards still spends from the same purse: the
    // builders are where the sharing decision lives, so all of them share it.
    const narrowed = policy.onlyPay([PAY_TO]);
    expect(narrowed.spent(USDC_BASE)).toBe(20_000n);
    narrowed.recordSpend(USDC_BASE, 1_000n);
    expect(policy.spent(USDC_BASE)).toBe(21_000n);
  });
});

// ============================================================================
// Addresses: hex folds, base58 does not
// ============================================================================

describe('canonicalRecipient - by family, not by lowercasing', () => {
  it('folds hex so an allowlist matches a checksummed payee', () => {
    const policy = PurchasePolicy.create()
      .allowUnlistedAssets()
      .onlyPay([PAY_TO.toLowerCase()]);
    // The seller writes it checksummed; the operator wrote it lowercase.
    expect(policy.evaluate(offer({ payTo: PAY_TO }), { now: NOW }).ok).toBe(true);
    expect(canonicalRecipient(PAY_TO)).toBe(PAY_TO.toLowerCase());
    // Trimmed too: a copy-pasted address carries whitespace.
    expect(canonicalRecipient(`  ${PAY_TO}  `)).toBe(PAY_TO.toLowerCase());
  });

  it('compares base58 exactly, because its case is a symbol and not a spelling', () => {
    // Folding a Solana or XRPL address does not produce the same address spelled
    // differently -- it produces a string that is not an address.
    expect(canonicalRecipient(SOLANA_PAYEE)).toBe(SOLANA_PAYEE);
    expect(canonicalRecipient(SOLANA_PAYEE)).not.toBe(SOLANA_PAYEE.toLowerCase());

    // An allowlist written in the seller's own spelling matches.
    const allowed = PurchasePolicy.create()
      .allowUnlistedAssets()
      .onlyPay([SOLANA_PAYEE]);
    expect(
      allowed.evaluate(offer({ payTo: SOLANA_PAYEE, network: 'solana', chainName: 'solana' }), {
        now: NOW,
      }).ok
    ).toBe(true);

    // And the dangerous direction: a folded allowlist entry must NOT admit the
    // real address, and the real entry must not admit a folded impostor.
    const folded = PurchasePolicy.create()
      .allowUnlistedAssets()
      .onlyPay([SOLANA_PAYEE.toLowerCase()]);
    const refused = folded.evaluate(
      offer({ payTo: SOLANA_PAYEE, network: 'solana', chainName: 'solana' }),
      { now: NOW }
    );
    expect(refused.ok === false && refused.refusal.code).toBe('recipient-not-permitted');
    const impostor = allowed.evaluate(
      offer({ payTo: SOLANA_PAYEE.toLowerCase(), network: 'solana', chainName: 'solana' }),
      { now: NOW }
    );
    expect(impostor.ok === false && impostor.refusal.code).toBe('recipient-not-permitted');
  });

  it('keys assets by family too, so a checksummed budget matches a lowercase offer', () => {
    const policy = PurchasePolicy.create().perPayment(
      { network: 'base', address: USDC_BASE_ADDRESS.toLowerCase() },
      1_000_000n
    );
    expect(policy.evaluate(offer({ asset: USDC_BASE_ADDRESS }), { now: NOW }).ok).toBe(true);
  });
});

// ============================================================================
// validUntil
// ============================================================================

describe('offerValidUntil - read from the versioned key, or absent', () => {
  it('reads seconds from extensions["offer-receipt/1"].info.validUntil', () => {
    expect(offerValidUntil(validity(1_760_000_123))).toBe(1_760_000_123);
  });

  it('is absent, never zero, for anything it cannot read', () => {
    // "The seller said something we could not read" must not become "this offer
    // expired in 1970".
    for (const bad of ['1760000000', 1.5, -1, Number.MAX_SAFE_INTEGER + 2, null, {}, NaN]) {
      expect(offerValidUntil(validity(bad))).toBeUndefined();
    }
    expect(offerValidUntil({ [OFFER_VALIDITY_EXTENSION]: { info: {} } })).toBeUndefined();
    expect(offerValidUntil({ [OFFER_VALIDITY_EXTENSION]: 'nonsense' })).toBeUndefined();
    // An unversioned or unknown key is ignored: no declared expiry.
    expect(offerValidUntil({ 'offer-receipt': { info: { validUntil: 1 } } })).toBeUndefined();
    expect(offerValidUntil(undefined)).toBeUndefined();
    expect(offerValidUntil({})).toBeUndefined();
  });

  it('an unreadable validUntil does not expire the offer', () => {
    // The whole point of "absent, never zero": a policy that read zero would
    // refuse every offer from a seller whose extension has a typo.
    const policy = PurchasePolicy.permissive();
    const decision = decideOnChallenge(
      policy,
      challengeOf([offer()], validity('not a number')),
      offer(),
      { now: NOW }
    );
    expect(decision.ok).toBe(true);
  });
});

describe('PurchasePolicy - expiry', () => {
  it('validUntil === now still stands: it is the last instant the offer is up', () => {
    const policy = PurchasePolicy.permissive();
    expect(policy.evaluate(offer(), { now: NOW, validUntil: NOW }).ok).toBe(true);
    // One second past it, and the terms have lapsed.
    const lapsed = policy.evaluate(offer(), { now: NOW + 1, validUntil: NOW });
    expect(lapsed.ok === false && lapsed.refusal.code).toBe('offer-expired');
  });

  it('an absent validUntil means no declared expiry, not an expired offer', () => {
    expect(PurchasePolicy.permissive().evaluate(offer(), { now: NOW }).ok).toBe(true);
  });

  it('checks expiry before anything about money', () => {
    // Terms that have lapsed are not terms, whatever they say -- including an
    // amount that would have passed every ceiling.
    const policy = PurchasePolicy.create().perPayment(USDC_BASE, 1_000_000n);
    const decision = policy.evaluate(offer({ amount: '1' }), { now: NOW, validUntil: NOW - 1 });
    expect(decision.ok === false && decision.refusal.code).toBe('offer-expired');
  });
});

// ============================================================================
// The listing never decides
// ============================================================================

describe('PurchasePolicy - the comparison against the listing decides nothing', () => {
  it('pays an offer that diverges from the listing but fits the policy', () => {
    // A seller repricing inside a policy the operator already authorised is
    // ordinary commerce. Halting here would turn every reprice into a stop, and
    // an agent that halts on ordinary commerce is one nobody can leave running.
    const policy = PurchasePolicy.create().perPayment(USDC_BASE, 1_000_000n);
    const decision = policy.evaluate(offer({ amount: '20000' }), {
      now: NOW,
      quote: { asset: USDC_BASE, amount: 10_000n },
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.approval.versusQuote).toEqual({
      code: 'amount-differs',
      advertised: 10_000n,
      offered: 20_000n,
    });
  });

  it('reports the four comparison codes and compares no numbers across assets', () => {
    const policy = PurchasePolicy.permissive();

    const notCompared = policy.evaluate(offer(), { now: NOW });
    expect(notCompared.ok && notCompared.approval.versusQuote.code).toBe('not-compared');

    const matches = policy.evaluate(offer({ amount: '10000' }), {
      now: NOW,
      quote: { asset: USDC_BASE, amount: 10_000n },
    });
    expect(matches.ok && matches.approval.versusQuote.code).toBe('matches');

    // Rule 4: the same number in another currency is not the same price, so no
    // number is compared at all.
    const other = policy.evaluate(offer({ amount: '10000' }), {
      now: NOW,
      quote: { asset: EURC_BASE, amount: 10_000n },
    });
    expect(other.ok).toBe(true);
    if (!other.ok) throw new Error('unreachable');
    expect(other.approval.versusQuote).toEqual({
      code: 'different-asset',
      advertised: EURC_BASE,
      offered: USDC_BASE,
    });
  });
});

// ============================================================================
// Rule 7: one unreadable entry keeps the readable ones
// ============================================================================

describe('X402Client.parse402 - one unreadable accepts entry keeps the readable ones', () => {
  /** Read a 402 body the way the client does, without a network stack. */
  function read(body: unknown) {
    const client = new X402Client({ defaultChain: 'base' });
    return (
      client as unknown as {
        parse402: (b: unknown, t: string) => ReadChallenge & { version: number };
      }
    ).parse402(body, 'usdc');
  }

  it('keeps a payable offer sitting next to a scheme this build cannot read', () => {
    // `accepts` is a LIST, and a closed scheme enum acting as an open collection
    // made a seller unpayable for offering `exact` next to something else. The
    // buyer never learned there was a perfectly payable offer right there.
    const challenge = read({
      x402Version: 1,
      accepts: [
        { scheme: 'batch-settlement', payTo: PAY_TO },
        {
          scheme: 'exact',
          network: 'base',
          maxAmountRequired: '10000',
          payTo: PAY_TO,
          asset: USDC_BASE_ADDRESS,
        },
      ],
    });

    expect(challenge.offers).toHaveLength(1);
    expect(challenge.offers[0].amount).toBe('10000');
    expect(challenge.unreadable).toEqual(['batch-settlement']);
  });

  it('names the schemes it could not read when none is payable', () => {
    const challenge = read({
      x402Version: 1,
      accepts: [{ scheme: 'batch-settlement' }, { scheme: 'agent-pay' }],
    });
    expect(challenge.offers).toHaveLength(0);
    expect(challenge.unreadable).toEqual(['batch-settlement', 'agent-pay']);

    const decision = decideOnChallenge(PurchasePolicy.permissive(), challenge, null, { now: NOW });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.refusal.code).toBe('no-readable-offer');
    // The message names what the seller wanted, so the caller looks for a
    // facilitator that implements it instead of a bug in its own code.
    expect(decision.refusal.message).toContain('batch-settlement');
    expect(decision.refusal.message).toContain('agent-pay');
  });

  it('counts a nameless broken entry as an offer the seller did send', () => {
    // An entry too broken to carry a `scheme` still proves the seller sent
    // offers. Reading that as "the seller sent nothing" would report a different
    // fact, and the wrong one.
    const challenge = read({ x402Version: 1, accepts: [{ nonsense: true }, 'garbage'] });
    expect(challenge.offers).toHaveLength(0);
    expect(challenge.unreadable).toEqual([]);
    expect(challenge.unreadableCount).toBe(2);

    const decision = decideOnChallenge(PurchasePolicy.permissive(), challenge, null, { now: NOW });
    expect(decision.ok === false && decision.refusal.code).toBe('no-readable-offer');
  });

  it('reads the challenge extensions, where validUntil lives', () => {
    const challenge = read({
      x402Version: 1,
      accepts: [
        { scheme: 'exact', network: 'base', maxAmountRequired: '1', payTo: PAY_TO },
      ],
      extensions: validity(NOW + 60),
    });
    expect(offerValidUntil(challenge.extensions)).toBe(NOW + 60);
  });
});

// ============================================================================
// The real path: client.fetch() against a mocked 402
// ============================================================================

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A fetch that answers the given responses in order, recording every call. */
function scriptedFetch(responses: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('scriptedFetch: unexpected extra call');
    return next;
  });
  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

/** A 402 body in v1 dialect, with optional seller-declared validity. */
function challenge402(over: Record<string, unknown> = {}, extensions?: Record<string, unknown>) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: '10000',
        payTo: PAY_TO,
        asset: USDC_BASE_ADDRESS,
        ...over,
      },
    ],
    ...(extensions ? { extensions } : {}),
  };
}

async function clientWith(policy?: PurchasePolicy) {
  const client = new X402Client({ defaultChain: 'base', policy });
  await client.connectWithPrivateKey(PRIVATE_KEY, 'base');
  return client;
}

describe('X402Client.fetch - the policy decides on the path that signs', () => {
  /**
   * These two are the ones that matter most, and the reason they enter through
   * `fetch()` and not through `evaluate()`: in Rust the wiring that carried a
   * challenge's `extensions` into the policy was missing for a full commit with
   * every unit test green, so the seller declared `validUntil`, the policy knew
   * how to check it, and between the two there was no cable.
   */
  it('refuses an expired offer before signing anything', async () => {
    const client = await clientWith(PurchasePolicy.permissive());
    const { impl, calls } = scriptedFetch([
      jsonResponse(402, challenge402({}, validity(NOW - 1))),
    ]);
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);

    try {
      await expect(
        client.fetch('https://api.example.com/data', { fetchImpl: impl })
      ).rejects.toMatchObject({
        name: 'PolicyRefusedError',
        code: 'POLICY_REFUSED',
        refusal: { code: 'offer-expired', validUntil: NOW - 1, now: NOW },
      });
      // The probe, and nothing else: no retry, no signature.
      expect(calls).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('refuses an asset the policy was never given a ceiling for', async () => {
    // A budget in USDC is no budget at all for another token, and the EVM signer
    // would have signed it: it takes its EIP-712 domain from the seller's own
    // `extra`, for a token and a network it has never seen.
    const policy = PurchasePolicy.create().perPayment(USDC_BASE, 1_000_000n);
    const client = await clientWith(policy);
    const { impl, calls } = scriptedFetch([
      jsonResponse(402, challenge402({ asset: EURC_BASE_ADDRESS })),
    ]);

    await expect(
      client.fetch('https://api.example.com/data', { fetchImpl: impl })
    ).rejects.toMatchObject({
      code: 'POLICY_REFUSED',
      refusal: { code: 'asset-not-budgeted' },
    });
    expect(calls).toHaveLength(1);
  });

  it('pays, and only then hands the caller the approval to record', async () => {
    const policy = PurchasePolicy.create()
      .perPayment(USDC_BASE, 1_000_000n)
      .cumulative(USDC_BASE, 50_000n)
      .onlyPay([PAY_TO]);
    const client = await clientWith(policy);
    const { impl, calls } = scriptedFetch([
      jsonResponse(402, challenge402({}, validity(NOW + 600))),
      jsonResponse(200, { data: 'paid' }),
    ]);
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);

    try {
      const recorded: Array<{ amount: bigint }> = [];
      const res = await client.fetch('https://api.example.com/data', {
        fetchImpl: impl,
        advertised: { asset: USDC_BASE, amount: 10_000n },
        onPaid: (approval) => {
          recorded.push({ amount: approval.amount });
          client.policy.recordSpend(approval.asset, approval.amount);
        },
      });

      expect(res.status).toBe(200);
      expect(calls).toHaveLength(2);
      const headers = calls[1].init?.headers as Record<string, string>;
      expect(headers['X-PAYMENT']).toBeTruthy();

      // Evaluating did not spend; recording did, and once.
      expect(recorded).toEqual([{ amount: 10_000n }]);
      expect(client.policy.spent(USDC_BASE)).toBe(10_000n);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('refuses a payee the policy does not pay, without signing', async () => {
    const policy = PurchasePolicy.create()
      .perPayment(USDC_BASE, 1_000_000n)
      .onlyPay([OTHER_PAYEE]);
    const client = await clientWith(policy);
    const { impl, calls } = scriptedFetch([jsonResponse(402, challenge402())]);

    await expect(
      client.fetch('https://api.example.com/data', { fetchImpl: impl })
    ).rejects.toMatchObject({
      code: 'POLICY_REFUSED',
      refusal: { code: 'recipient-not-permitted', payTo: PAY_TO },
    });
    expect(calls).toHaveLength(1);
  });

  it('names the schemes a seller offered when none of them is payable', async () => {
    const client = await clientWith();
    const { impl } = scriptedFetch([
      jsonResponse(402, {
        x402Version: 1,
        accepts: [{ scheme: 'batch-settlement' }, { scheme: 'agent-pay' }],
      }),
    ]);

    await expect(
      client.fetch('https://api.example.com/data', { fetchImpl: impl })
    ).rejects.toMatchObject({
      code: 'POLICY_REFUSED',
      refusal: { code: 'no-readable-offer', offered: ['batch-settlement', 'agent-pay'] },
    });
  });

  it('still says "no usable payment options" when the seller sent no offers', async () => {
    // Three facts that used to be one error, and this is the one that keeps its
    // old code: the seller sent nothing, which is not "we could not read it".
    const client = await clientWith();
    const { impl } = scriptedFetch([jsonResponse(402, { x402Version: 1, accepts: [] })]);

    const failure = await client
      .fetch('https://api.example.com/data', { fetchImpl: impl })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(X402Error);
    expect(failure).not.toBeInstanceOf(PolicyRefusedError);
    expect((failure as X402Error).code).toBe('NO_ACCEPTABLE_PAYMENT');
  });

  it('keeps paying for a caller that never wrote a policy', async () => {
    // The asymmetry, from the consumer's side: no policy means permissive, so an
    // unbudgeted asset that a written policy would refuse still goes through.
    // Turning a budget on silently would refuse payments consumers make today.
    const client = await clientWith();
    const { impl, calls } = scriptedFetch([
      jsonResponse(402, challenge402({ asset: EURC_BASE_ADDRESS })),
      jsonResponse(200, { data: 'paid' }),
    ]);

    const res = await client.fetch('https://api.example.com/data', { fetchImpl: impl });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('keeps maxAmount as the hard ceiling it already was', async () => {
    // The pre-existing check is untouched and still runs before the policy: a
    // caller that set one and no policy keeps exactly the behaviour it had.
    const client = await clientWith();
    const { impl } = scriptedFetch([jsonResponse(402, challenge402())]);

    await expect(
      client.fetch('https://api.example.com/data', { fetchImpl: impl, maxAmount: '0.001' })
    ).rejects.toMatchObject({ code: 'PAYMENT_EXCEEDS_MAX' });
  });

  it('does not ask anyone for confirmation when the policy already covers it', async () => {
    // Rule 3. There is no confirmation hook on this path, and a divergence from
    // the listing is not by itself a refusal: the retry goes out unprompted.
    const policy = PurchasePolicy.create().perPayment(USDC_BASE, 1_000_000n);
    const client = await clientWith(policy);
    const { impl, calls } = scriptedFetch([
      jsonResponse(402, challenge402({ maxAmountRequired: '40000' })),
      jsonResponse(200, { data: 'paid' }),
    ]);

    const res = await client.fetch('https://api.example.com/data', {
      fetchImpl: impl,
      // The catalog said a quarter of what the seller now asks.
      advertised: { asset: USDC_BASE, amount: 10_000n },
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('does not record a spend when the seller answers the retry with another 402', async () => {
    // A retry that comes back 402 is a payment the seller did not accept, and a
    // limit that counted it would take money the caller never spent.
    const policy = PurchasePolicy.create()
      .perPayment(USDC_BASE, 1_000_000n)
      .cumulative(USDC_BASE, 50_000n);
    const client = await clientWith(policy);
    const { impl } = scriptedFetch([
      jsonResponse(402, challenge402()),
      jsonResponse(402, challenge402()),
    ]);

    const onPaid = vi.fn();
    const res = await client.fetch('https://api.example.com/data', { fetchImpl: impl, onPaid });
    expect(res.status).toBe(402);
    expect(onPaid).not.toHaveBeenCalled();
    expect(client.policy.spent(USDC_BASE)).toBe(0n);
  });
});
