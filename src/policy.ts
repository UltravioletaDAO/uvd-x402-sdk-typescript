/**
 * uvd-x402-sdk - What this buyer is allowed to sign, decided before it signs.
 *
 * # The rule this module exists to enforce
 *
 * A catalog listing is a claim somebody else made about their own price. The
 * `402` that comes back from the actual request is the offer. They can differ,
 * legitimately: a seller may have repriced, and the listing may be a copy of a
 * copy. So the buying decision cannot be made against the listing. It has to be
 * made against **the offer in hand**, every time, before anything is signed.
 *
 * Two things follow, and both are load-bearing:
 *
 * - **A divergence from the listing is not, by itself, a refusal.** If the offer
 *   costs more than the catalog said but still sits inside a policy the operator
 *   already authorised, the payment proceeds. Stopping to ask would turn every
 *   ordinary reprice into a halt, and an agent that halts on ordinary commerce
 *   is an agent nobody can leave running. There is no human-confirmation hook in
 *   this path.
 * - **A policy is never widened to fit an offer.** Not by a byte, not once, not
 *   "because the seller says so". There is deliberately no method on this type
 *   that raises a limit from inside an evaluation. If the offer exceeds what was
 *   authorised the answer is a refusal with a concrete cause, and the caller
 *   decides whether to authorise more.
 *
 * # Order of evaluation
 *
 * Fixed, and part of the contract, because the FIRST failing check is the one
 * reported and a caller branches on it:
 *
 * 1. Was any offer readable at all? -> `no-readable-offer`
 * 2. Has it expired? -> `offer-expired`
 * 3. Is the recipient one we are willing to pay? -> `recipient-not-permitted`
 * 4. Was its asset budgeted at all? -> `asset-not-budgeted`
 * 5. Does it exceed the per-payment limit for that asset? -> `per-payment-limit`
 * 6. Does it exceed what remains of the cumulative limit? -> `cumulative-limit`
 *
 * The comparison against the listing is made LAST and refuses nothing: it is
 * evidence for the caller, never a gate.
 *
 * This is the same contract the Rust facilitator's `x402-reqwest` crate
 * implements (`PurchasePolicy`, release 2.25.0), written down once so a buyer in
 * either language refuses the same payments for the same stated reasons.
 *
 * @module
 */

import { X402Error } from './types';
import type { X402PaymentOffer } from './types';

// ============================================================================
// The offer-validity extension
// ============================================================================

/**
 * Extension key under which a seller declares how long its offer stands.
 *
 * Defined once, here, and read by nobody else's constant: a seller and a buyer
 * naming different keys have nothing to say to each other. The version is IN
 * the key because the offer-and-receipt transport can still change, and a value
 * read from an unversioned key could never be compared with anything later. A
 * key we do not recognise is ignored, which means "no declared expiry" -- a
 * different thing from "expired".
 */
export const OFFER_VALIDITY_EXTENSION = 'offer-receipt/1';

/**
 * Read `validUntil` (Unix seconds) out of a 402 challenge's `extensions`.
 *
 * Shape: `extensions["offer-receipt/1"].info.validUntil`. The `{info, schema}`
 * envelope is the one every merged x402 extension uses; reading the number from
 * anywhere else would be reading a field nobody agreed to publish.
 *
 * Anything unreadable is `undefined`, **never zero**: "the seller said
 * something we could not read" must not become "this offer expired in 1970".
 * A string, a float, a negative, a number past `Number.MAX_SAFE_INTEGER` -- all
 * unreadable, all absent.
 */
export function offerValidUntil(
  extensions: Record<string, unknown> | undefined | null
): number | undefined {
  if (!extensions || typeof extensions !== 'object') return undefined;
  const entry = (extensions as Record<string, unknown>)[OFFER_VALIDITY_EXTENSION];
  if (!entry || typeof entry !== 'object') return undefined;
  const info = (entry as Record<string, unknown>).info;
  if (!info || typeof info !== 'object') return undefined;
  const value = (info as Record<string, unknown>).validUntil;
  if (typeof value !== 'number') return undefined;
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

// ============================================================================
// Addresses
// ============================================================================

/**
 * Canonical form of a recipient or token address, for comparison.
 *
 * # Why this is not `toLowerCase()`
 *
 * It was, in the Rust crate, and that is only correct for one family. EVM
 * addresses are hex and arrive both checksummed and lowercase, so folding case
 * is right and necessary. **Base58 is case-sensitive** -- Solana and XRPL
 * addresses use both cases as distinct symbols -- so lowercasing one does not
 * produce the same address spelled differently, it produces a string that is not
 * an address.
 *
 * An allowlist written in the seller's own spelling would then never match, and
 * every payment to a legitimate Solana payee would be refused with
 * `recipient-not-permitted`. Worse in the other direction: two distinct base58
 * addresses can fold to the same lowercase string, so an allowlist could admit
 * an address nobody put on it.
 *
 * So: hex is folded, everything else is compared exactly.
 */
export function canonicalRecipient(address: string): string {
  const trimmed = address.trim();
  const rest =
    trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : null;
  const isHex = rest !== null && rest.length > 0 && /^[0-9a-fA-F]+$/.test(rest);
  return isHex ? trimmed.toLowerCase() : trimmed;
}

// ============================================================================
// Assets
// ============================================================================

/**
 * A token on a network -- the unit a budget is denominated in.
 *
 * Both halves are required. The same USDC contract address on two networks is
 * two different assets, and a budget for one is not a budget for the other: the
 * EVM signer takes its EIP-712 domain from the seller's own `extra`, so it will
 * sign for whatever token and network the seller names.
 */
export interface PolicyAsset {
  /**
   * SDK chain name (`'base'`) when the 402's network resolved to one, otherwise
   * the network string exactly as the 402 wrote it.
   *
   * Resolving first is what lets one written policy cover both 402 dialects:
   * a v1 challenge says `base` and a v2 one says `eip155:8453`, and a budget
   * keyed on the raw string would silently miss half of a seller's offers.
   */
  network: string;
  /** Token contract address. Compared canonicalised, never raw. */
  address: string;
}

/**
 * Stable map key for an asset. Not part of the wire format; comparison only.
 *
 * The network is folded to lowercase because SDK chain names and CAIP-2 strings
 * are lowercase by convention, so `'Base'` and `'base'` are the same network
 * written two ways -- never two networks. Leaving the case in fails closed
 * (`asset-not-budgeted`, so no wrong payment), but it trips the operator over a
 * capital letter and the refusal would point at the budget instead of the typo.
 * The address keeps its by-family treatment: see {@link canonicalRecipient}.
 */
export function assetKey(asset: PolicyAsset): string {
  return `${asset.network.trim().toLowerCase()}|${canonicalRecipient(asset.address)}`;
}

/** Human form, for a refusal message. */
function assetLabel(asset: PolicyAsset): string {
  return asset.address ? `${asset.address} on ${asset.network}` : `(no asset declared) on ${asset.network}`;
}

/**
 * The asset an offer is priced in.
 *
 * An offer that declares no `asset` yields an empty address, which no budget can
 * ever hold -- {@link PurchasePolicy.perPayment} rejects an empty address -- so
 * such an offer is refused with `asset-not-budgeted` unless unlisted assets were
 * explicitly permitted. That is the safe direction: an unnamed token is a token
 * nobody budgeted for.
 */
export function offerAsset(offer: X402PaymentOffer): PolicyAsset {
  return {
    network: offer.chainName ?? offer.network,
    address: typeof offer.asset === 'string' ? offer.asset : '',
  };
}

// ============================================================================
// Refusals
// ============================================================================

/**
 * Closed vocabulary of reasons a payment was not signed, in kebab-case, so an
 * SDK in another language branches on it without parsing English.
 *
 * There is no `other`: a refusal a caller cannot interpret is a refusal it will
 * paper over.
 */
export type PolicyRefusalCode =
  | 'no-readable-offer'
  | 'offer-expired'
  | 'recipient-not-permitted'
  | 'asset-not-budgeted'
  | 'per-payment-limit'
  | 'cumulative-limit';

/**
 * Why a payment was not signed. Every variant carries the numbers that caused
 * it, so a caller can log the decision without re-deriving it.
 */
export type PolicyRefusal =
  | {
      code: 'no-readable-offer';
      /** Scheme names the seller offered, for the ones this build cannot read. */
      offered: string[];
      message: string;
    }
  | { code: 'offer-expired'; validUntil: number; now: number; message: string }
  | { code: 'recipient-not-permitted'; payTo: string; message: string }
  | { code: 'asset-not-budgeted'; asset: PolicyAsset; message: string }
  | {
      code: 'per-payment-limit';
      requested: bigint;
      allowed: bigint;
      asset: PolicyAsset;
      message: string;
    }
  | {
      code: 'cumulative-limit';
      requested: bigint;
      spent: bigint;
      wouldTotal: bigint;
      allowed: bigint;
      asset: PolicyAsset;
      message: string;
    };

/**
 * A 402 whose offers this build could not read, turned into a refusal that says
 * so.
 *
 * The point is the message. A caller that learns the seller offered
 * `batch-settlement` knows to look for a facilitator that implements it, where
 * "could not parse the response" would have sent it looking for a bug in its own
 * code. Discovering the service keeps working even though buying it
 * automatically does not.
 */
export function noReadableOffer(offered: string[]): PolicyRefusal {
  return {
    code: 'no-readable-offer',
    offered,
    message:
      'no offer in this challenge is one this build can pay; offered: ' +
      JSON.stringify(offered),
  };
}

/**
 * Error thrown on the real payment path when the policy refuses.
 *
 * Extends {@link X402Error}, so a consumer already catching `X402Error` keeps
 * catching this; the typed cause is on {@link PolicyRefusedError.refusal} and
 * its stable code on `refusal.code`.
 */
export class PolicyRefusedError extends X402Error {
  public readonly refusal: PolicyRefusal;

  constructor(refusal: PolicyRefusal) {
    super(`payment refused by policy: ${refusal.message}`, 'POLICY_REFUSED', refusal);
    this.name = 'PolicyRefusedError';
    this.refusal = refusal;
  }

  /** Stable kebab code of the refusal, for branching. */
  get policyCode(): PolicyRefusalCode {
    return this.refusal.code;
  }
}

// ============================================================================
// The listing, and how the offer compares to it
// ============================================================================

/**
 * What a catalog listing advertised, for comparison against the real offer.
 *
 * Optional throughout. A buyer that never read a listing simply evaluates the
 * offer against its policy, which is the same decision with one fewer input.
 */
export interface AdvertisedQuote {
  asset: PolicyAsset;
  /** Price in the token's own atomic units. */
  amount: bigint;
}

/** How the offer in hand compares to what the catalog advertised. */
export type QuoteComparison =
  | { code: 'not-compared' }
  | { code: 'matches' }
  | { code: 'amount-differs'; advertised: bigint; offered: bigint }
  /**
   * A different asset entirely. The same number in another currency is not the
   * same price, so there is nothing to compare -- and no number is compared.
   */
  | { code: 'different-asset'; advertised: PolicyAsset; offered: PolicyAsset };

/** A payment this policy permits, and what it noticed on the way. */
export interface PolicyApproval {
  asset: PolicyAsset;
  /** Price in the token's own atomic units. */
  amount: bigint;
  /**
   * How the offer compared to the listing, when there was one. Carried so a
   * caller can log or surface it; it never changed the decision.
   */
  versusQuote: QuoteComparison;
}

/** The outcome of an evaluation. Explicit, so no caller needs a `try`. */
export type PolicyDecision =
  | { ok: true; approval: PolicyApproval }
  | { ok: false; refusal: PolicyRefusal };

/** Inputs to {@link PurchasePolicy.evaluate} besides the offer itself. */
export interface EvaluateOptions {
  /**
   * Unix seconds. Passed rather than read so the decision is testable at an
   * exact instant: money decisions that depend on a hidden clock cannot be
   * pinned.
   */
  now: number;
  /** `validUntil` the seller declared, if any. See {@link offerValidUntil}. */
  validUntil?: number;
  /** What the catalog advertised, if the caller read a listing. */
  quote?: AdvertisedQuote;
}

// ============================================================================
// The policy
// ============================================================================

/**
 * The spending rules a caller authorised in advance.
 *
 * Every builder returns a new policy that **shares the running total**: two
 * copies of one policy spend from the same purse, which is what makes a
 * cumulative limit mean anything when a client is copied per request.
 *
 * @example
 * ```ts
 * const USDC_BASE = { network: 'base', address: '0x8335...2913' };
 * const policy = PurchasePolicy.create()
 *   .perPayment(USDC_BASE, 50_000n)      // 0.05 USDC, atomic units
 *   .cumulative(USDC_BASE, 1_000_000n)   // 1 USDC total, for this policy's life
 *   .onlyPay(['0xe4dc...e545']);
 *
 * const client = new X402Client({ defaultChain: 'base', policy });
 * ```
 */
export class PurchasePolicy {
  private readonly perPaymentLimits: Map<string, bigint>;
  private readonly cumulativeLimits: Map<string, bigint>;
  /** Shared by reference across every copy: one purse, many holders. */
  private readonly spentTotals: Map<string, bigint>;
  private readonly recipients: Set<string> | null;
  private readonly assetsByKey: Map<string, PolicyAsset>;
  private readonly unlistedAssetsAllowed: boolean;

  private constructor(
    perPaymentLimits: Map<string, bigint>,
    cumulativeLimits: Map<string, bigint>,
    spentTotals: Map<string, bigint>,
    recipients: Set<string> | null,
    assetsByKey: Map<string, PolicyAsset>,
    unlistedAssetsAllowed: boolean
  ) {
    this.perPaymentLimits = perPaymentLimits;
    this.cumulativeLimits = cumulativeLimits;
    this.spentTotals = spentTotals;
    this.recipients = recipients;
    this.assetsByKey = assetsByKey;
    this.unlistedAssetsAllowed = unlistedAssetsAllowed;
  }

  /**
   * A policy that pays nothing until it is told what it may pay.
   *
   * # Why the default is deny
   *
   * The limits are a map keyed by asset, and a map answers "no entry" for every
   * asset nobody thought of. Permitting on a missing entry means a budget in
   * USDC is **no budget at all** for any other token: a seller offering the same
   * resource priced in something unlisted walks straight past the ceiling, and
   * the wallet will sign it, because the EVM signer takes the EIP-712 domain
   * from the seller's own `extra` and will happily sign for a token and a
   * network it has never heard of.
   *
   * So an asset with no stated ceiling is refused. A caller that genuinely wants
   * to pay anything says so once, by name, with
   * {@link PurchasePolicy.allowUnlistedAssets}, and that sentence is then in
   * their code where a reader can find it.
   */
  static create(): PurchasePolicy {
    return new PurchasePolicy(new Map(), new Map(), new Map(), null, new Map(), false);
  }

  /**
   * A policy that permits an asset it was never told about.
   *
   * This is what {@link X402Client} holds when the caller supplied no policy,
   * and it exists for exactly one reason: this SDK had no budget before 2.89.0,
   * and turning one on silently would refuse payments that callers are making
   * today. Named rather than defaulted, so choosing it is visible. The asymmetry
   * is deliberate -- whoever sits down to WRITE a policy deserves the safe
   * default.
   */
  static permissive(): PurchasePolicy {
    return new PurchasePolicy(new Map(), new Map(), new Map(), null, new Map(), true);
  }

  /** Permit assets with no configured ceiling. */
  allowUnlistedAssets(): PurchasePolicy {
    return this.with({ unlistedAssetsAllowed: true });
  }

  /**
   * Refuse assets with no configured ceiling. The default; here so the intent
   * can be written down at a call site that wants it explicit.
   */
  denyUnlistedAssets(): PurchasePolicy {
    return this.with({ unlistedAssetsAllowed: false });
  }

  /** Most this policy will pay in ONE payment of `asset`, in atomic units. */
  perPayment(asset: PolicyAsset, amount: bigint): PurchasePolicy {
    const key = this.register(asset);
    const perPaymentLimits = new Map(this.perPaymentLimits);
    perPaymentLimits.set(key, requireCeiling(amount, 'perPayment'));
    return this.with({ perPaymentLimits });
  }

  /**
   * Most this policy will pay in `asset` in TOTAL, across every payment it
   * approves for as long as it lives.
   */
  cumulative(asset: PolicyAsset, amount: bigint): PurchasePolicy {
    const key = this.register(asset);
    const cumulativeLimits = new Map(this.cumulativeLimits);
    cumulativeLimits.set(key, requireCeiling(amount, 'cumulative'));
    return this.with({ cumulativeLimits });
  }

  /**
   * Restrict payment to a set of recipients.
   *
   * Addresses are canonicalised **by family**, not by lowercasing the string:
   * see {@link canonicalRecipient}.
   */
  onlyPay(recipients: Iterable<string>): PurchasePolicy {
    const set = new Set<string>();
    for (const r of recipients) set.add(canonicalRecipient(r));
    return this.with({ recipients: set });
  }

  /**
   * Total recorded so far for `asset`, in atomic units.
   *
   * A total that is not a sane bigint means something corrupted the purse.
   * Reporting zero would silently restore the caller's whole budget, so this
   * reports the CEILING instead: for money, the safe direction is to refuse,
   * never to permit.
   */
  spent(asset: PolicyAsset): bigint {
    const key = assetKey(asset);
    const value = this.spentTotals.get(key);
    if (value === undefined) return 0n;
    if (typeof value !== 'bigint' || value < 0n) {
      return this.cumulativeLimits.get(key) ?? 0n;
    }
    return value;
  }

  /**
   * Record that a payment actually happened.
   *
   * Separate from {@link PurchasePolicy.evaluate} on purpose. Signing can still
   * fail and a settlement can still be refused; a cumulative limit that counted
   * attempts rather than payments would lock a caller out of money it never
   * spent. Call this when a payment settled.
   *
   * A negative amount is ignored: handing budget back is not something a
   * settlement can do, and treating it as one would be a way to widen a policy
   * from outside.
   */
  recordSpend(asset: PolicyAsset, amount: bigint): void {
    if (typeof amount !== 'bigint' || amount <= 0n) return;
    const key = assetKey(asset);
    if (!this.assetsByKey.has(key)) this.assetsByKey.set(key, asset);
    const current = this.spent(asset);
    this.spentTotals.set(key, current + amount);
  }

  /**
   * Whether this policy pays an asset it holds no ceiling for. Read-only: there
   * is no setter that flips it from inside an evaluation.
   */
  get permitsUnlistedAssets(): boolean {
    return this.unlistedAssetsAllowed;
  }

  /**
   * Decide whether this offer may be signed. Steps 2 through 6 of the contract;
   * step 1 (`no-readable-offer`) is decided on the challenge, before an offer
   * exists to evaluate -- see {@link decideOnChallenge}.
   *
   * **Approving does not record the spend.** See
   * {@link PurchasePolicy.recordSpend}.
   */
  evaluate(offer: X402PaymentOffer, options: EvaluateOptions): PolicyDecision {
    const { now, validUntil, quote } = options;

    // 2. Expiry. Before anything about money: terms that have lapsed are not
    //    terms, whatever they say. `validUntil === now` still stands -- it is the
    //    last instant the offer is up.
    if (validUntil !== undefined && now > validUntil) {
      return {
        ok: false,
        refusal: {
          code: 'offer-expired',
          validUntil,
          now,
          message:
            `this offer expired at ${validUntil} (now ${now}); ` +
            'ask the seller for new terms',
        },
      };
    }

    // 3. Recipient.
    if (this.recipients !== null) {
      const payTo = canonicalRecipient(offer.payTo);
      if (!this.recipients.has(payTo)) {
        return {
          ok: false,
          refusal: {
            code: 'recipient-not-permitted',
            payTo: offer.payTo,
            message: `this policy does not pay ${offer.payTo}`,
          },
        };
      }
    }

    const asset = offerAsset(offer);
    const key = assetKey(asset);
    const requested = readAmount(offer.amount);

    // 4. An asset nobody budgeted for. Checked BEFORE the ceilings, because the
    //    ceilings are a map and a map has no opinion about a key it does not
    //    hold -- which is precisely how an unlisted token would sail past a
    //    budget that looks complete. And the caller has to be told "budget that
    //    asset", not "raise a ceiling that does not exist".
    if (
      !this.unlistedAssetsAllowed &&
      !this.perPaymentLimits.has(key) &&
      !this.cumulativeLimits.has(key)
    ) {
      return {
        ok: false,
        refusal: {
          code: 'asset-not-budgeted',
          asset,
          message:
            `this policy has no budget for ${assetLabel(asset)}; ` +
            'it pays only what it was told it may pay',
        },
      };
    }

    // 5. Per-payment ceiling.
    const perPaymentAllowed = this.perPaymentLimits.get(key);
    if (perPaymentAllowed !== undefined && requested > perPaymentAllowed) {
      return {
        ok: false,
        refusal: {
          code: 'per-payment-limit',
          requested,
          allowed: perPaymentAllowed,
          asset,
          message:
            `offer of ${requested} exceeds the per-payment limit of ` +
            `${perPaymentAllowed} for ${assetLabel(asset)}`,
        },
      };
    }

    // 6. Cumulative ceiling.
    const cumulativeAllowed = this.cumulativeLimits.get(key);
    if (cumulativeAllowed !== undefined) {
      const spent = this.spent(asset);
      const wouldTotal = spent + requested;
      if (wouldTotal > cumulativeAllowed) {
        return {
          ok: false,
          refusal: {
            code: 'cumulative-limit',
            requested,
            spent,
            wouldTotal,
            allowed: cumulativeAllowed,
            asset,
            message:
              `offer of ${requested} would take spend to ${wouldTotal}, past the ` +
              `cumulative limit of ${cumulativeAllowed} for ${assetLabel(asset)} ` +
              `(already spent ${spent})`,
          },
        };
      }
    }

    // The comparison against the listing is made LAST and refuses nothing. It is
    // evidence for the caller, not a gate: a seller repricing inside a policy the
    // operator already authorised is ordinary commerce.
    return {
      ok: true,
      approval: { asset, amount: requested, versusQuote: compareToQuote(asset, requested, quote) },
    };
  }

  /** Copy sharing the same purse. Cloning is what a per-request client does. */
  clone(): PurchasePolicy {
    return this.with({});
  }

  /**
   * Rebuild with some fields replaced, **always sharing `spentTotals`**. This is
   * the one place that decides copies share a purse, so it is the one place to
   * read when asking whether they do.
   */
  private with(changes: {
    perPaymentLimits?: Map<string, bigint>;
    cumulativeLimits?: Map<string, bigint>;
    recipients?: Set<string> | null;
    unlistedAssetsAllowed?: boolean;
  }): PurchasePolicy {
    return new PurchasePolicy(
      changes.perPaymentLimits ?? this.perPaymentLimits,
      changes.cumulativeLimits ?? this.cumulativeLimits,
      this.spentTotals,
      changes.recipients !== undefined ? changes.recipients : this.recipients,
      this.assetsByKey,
      changes.unlistedAssetsAllowed ?? this.unlistedAssetsAllowed
    );
  }

  /** Remember an asset's written form and reject one no budget could match. */
  private register(asset: PolicyAsset): string {
    if (!asset || typeof asset.address !== 'string' || asset.address.trim() === '') {
      throw new X402Error(
        'A budget needs a token address; an asset with none can never match an offer',
        'INVALID_CONFIG',
        { asset }
      );
    }
    if (typeof asset.network !== 'string' || asset.network.trim() === '') {
      throw new X402Error(
        'A budget needs a network; the same address on two networks is two assets',
        'INVALID_CONFIG',
        { asset }
      );
    }
    const key = assetKey(asset);
    this.assetsByKey.set(key, asset);
    return key;
  }
}

/** A ceiling has to be a non-negative bigint; anything else is a config bug. */
function requireCeiling(amount: bigint, field: string): bigint {
  if (typeof amount !== 'bigint' || amount < 0n) {
    throw new X402Error(
      `${field} must be a non-negative bigint in atomic units`,
      'INVALID_AMOUNT',
      { amount: String(amount) }
    );
  }
  return amount;
}

/**
 * An offer's price as a bigint.
 *
 * Arithmetic is bigint throughout, never `number`: atomic units of an 18-decimal
 * token pass `Number.MAX_SAFE_INTEGER` at 0.01 of a token, and a ceiling
 * compared as a float is a ceiling that rounds.
 *
 * An amount that is not a non-negative integer is read as the largest value we
 * can represent for the comparison, so it fails every ceiling rather than
 * passing as zero: a price we cannot read is not a price we may pay.
 */
function readAmount(amount: string): bigint {
  const text = String(amount).trim();
  if (!/^\d+$/.test(text)) return UNREADABLE_AMOUNT;
  return BigInt(text);
}

/**
 * Stand-in for a price we could not read. Absurdly large on purpose: it exceeds
 * every ceiling a caller would write, so an unreadable amount is refused by the
 * limit checks instead of sliding through as zero.
 */
const UNREADABLE_AMOUNT = (1n << 256n) - 1n;

function compareToQuote(
  asset: PolicyAsset,
  requested: bigint,
  quote: AdvertisedQuote | undefined
): QuoteComparison {
  if (!quote) return { code: 'not-compared' };
  if (assetKey(quote.asset) !== assetKey(asset)) {
    // Rule 4: a different asset is not the same price. No numbers are compared.
    return { code: 'different-asset', advertised: quote.asset, offered: asset };
  }
  if (quote.amount !== requested) {
    return { code: 'amount-differs', advertised: quote.amount, offered: requested };
  }
  return { code: 'matches' };
}

// ============================================================================
// The whole decision, in one place
// ============================================================================

/** A 402 challenge as the buyer read it, whole. */
export interface ReadChallenge {
  /** Offers this build could read. */
  offers: X402PaymentOffer[];
  /**
   * Scheme names of the entries it could not. Rule 7: an `accepts` with one
   * unreadable entry KEEPS the readable ones and counts the others by scheme
   * name, so a refusal can say what the seller offered.
   */
  unreadable: string[];
  /**
   * How many entries were unreadable, which is not the same as how many could be
   * NAMED: an entry too broken to even carry a `scheme` still proves the seller
   * sent offers. Without it, a challenge whose only entry was nameless garbage
   * would read as "the seller sent nothing" -- a different fact, and the wrong
   * one to report. Defaults to `unreadable.length`.
   */
  unreadableCount?: number;
  /** The challenge's top-level `extensions`, where `validUntil` lives. */
  extensions?: Record<string, unknown>;
}

/** Inputs to {@link decideOnChallenge} besides the challenge. */
export interface DecideOptions {
  /** Unix seconds. Passed, never read, so the decision can be pinned in a test. */
  now: number;
  /** What the catalog advertised, if the caller read a listing. */
  quote?: AdvertisedQuote;
}

/**
 * The whole buying decision: all six steps, in the fixed order, against the
 * offer in hand.
 *
 * Takes the challenge WHOLE, deliberately. Passing `offers` alone is what
 * dropped the seller's `validUntil` on the floor in the Rust crate for a full
 * commit with every unit test green, and a signature that takes the parts
 * invites doing it again.
 *
 * Callable without a network stack on purpose: a decision that can only be
 * exercised by driving a real HTTP client is a decision nobody tests.
 *
 * @param offer - The offer already selected out of `challenge.offers`. Selection
 *   is the caller's (cheapest, or its own `select`); this decides whether the
 *   selected one may be paid.
 */
export function decideOnChallenge(
  policy: PurchasePolicy,
  challenge: ReadChallenge,
  offer: X402PaymentOffer | null,
  options: DecideOptions
): PolicyDecision {
  // 1. Was any offer readable at all? A challenge that carried offers, none of
  //    which this build can read, is not "no matching payment method": it is a
  //    seller asking for a scheme we do not implement, and saying so names what
  //    they wanted.
  const unreadableCount = challenge.unreadableCount ?? challenge.unreadable.length;
  if (challenge.offers.length === 0 && unreadableCount > 0) {
    return { ok: false, refusal: noReadableOffer(challenge.unreadable) };
  }
  if (!offer) {
    // Nothing selected out of a challenge that had readable offers, or a seller
    // that sent no offers at all. Either way there is no offer in hand to judge,
    // and the refusal names what the seller offered -- an empty list when it
    // offered nothing.
    return { ok: false, refusal: noReadableOffer(challenge.unreadable) };
  }
  return policy.evaluate(offer, {
    now: options.now,
    validUntil: offerValidUntil(challenge.extensions),
    quote: options.quote,
  });
}
