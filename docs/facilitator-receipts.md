# Facilitator receipts and restart-safe purchases

Receipts initially cover Arc mainnet/testnet USDC/EURC and native Hedera USDC v2.
Hedera payments use USDC only; HBAR pays sponsor fees. Check
`/supported.facilitatorReceipts` before relying on facilitator support.

```typescript
import { createPurchaseContext } from 'uvd-x402-sdk';

// client is your connected X402Client. Load/save contexts in private durable storage.
const context = savedContext ?? createPurchaseContext();
const result = await client.fetchWithReceipt('https://merchant.example/data', {
  context,
  persist: saveContextToPrivateDatabase,
  trustedKeys: trustedFacilitatorKeys,
});
console.log(result.paymentState, result.proofVerified);
if (result.receipt) {
  const { network, asset, amount, payTo, requestHash, settlement, refusalReason } = result.receipt;
  console.log({ network, asset, amount, payTo, requestHash, settlement, refusalReason });
}
// result.response is the original unconsumed Response; result.error records transport loss.
```

The persistence callback must complete durably before returning. Context includes
a signed payment authorization and secret capability: never log or publish it.
Resume exactly that context after a lost response, restart, or HTTP 500. No new
payment signature is created on resume. A new context represents a new purchase.

Express and Hono integrations validate `X-UVD-Purchase`, forward it to the
facilitator, and propagate `PAYMENT-RESPONSE` / `X-PAYMENT-RESPONSE`. Express must
provide the exact `rawBody` bytes for non-GET/HEAD requests. Configure the public
merchant URL correctly behind proxies. Custom integrations can use
`validatePurchaseContext`, `FacilitatorClient.verify/settle(..., {receiptContext})`
and `paymentResponseHeaders(result)`, or `mergePaymentResponseHeaders(result, current)`
when the response may already carry `Access-Control-Expose-Headers` or
`Cache-Control` (it adds to them instead of replacing them). Forward these
headers through CORS/proxies.

`getFacilitatorReceipt(receiptId, context)` performs capability-protected lookup.
`verifyFacilitatorReceipt(receipt, trustedKeys)` validates issuer, request hash
and Ed25519 JWS, in Node or browsers. Obtain public keys from the configured
facilitator's `/.well-known/receipt-keys.json`; retain old keys before rotation.
The lookup helper does not implicitly verify a signature or trust keys from a
receipt. Without supplied trusted keys, `proofVerified` remains false.

Amounts are atomic strings. `verified` is not a completed payment; keep the
original authorization for `pending`/`unknown`. An older merchant returning no
receipt produces `receipt: null`, never a fabricated payment success. A confirmed
payment may accompany an HTTP 500; merchant fulfillment needs its own order store.

See the [full contract and operational limits](https://github.com/UltravioletaDAO/x402-rs/blob/main/docs/facilitator-receipts.md).
EURC real payments settled on Arc mainnet on 2026-09-22 (v1/v2), each with a signed
`confirmed` receipt; see [Arc](networks/arc.md#confirmed-eurc-payments-2026-09-22). The shared signed vectors are offline.

This API is published in [2.96.0](https://www.npmjs.com/package/uvd-x402-sdk/v/2.96.0).
The facilitator's [release snapshot](https://github.com/UltravioletaDAO/x402-rs/blob/main/docs/reports/2026-09-17-facilitator-receipts-release.md)
documents eight confirmed USDC payments: both published SDKs on Arc and Hedera,
mainnet and testnet. Each purchase resumed after a merchant HTTP 500 with the
same authorization, receipt and transaction. The artifact includes all eight
signed receipts, independent chain checks and an audited quota-blocked attempt.
Both SDKs verified all nine exported signatures. Real EURC settlements were not
part of that snapshot and should not be inferred from offline fixtures; they came
later (Arc mainnet, 2026-09-22).

Facilitator 2.36.1 also makes private receipt lookup return HTTP 200 for any
authorized stored receipt, including `unknown` after a failed settlement call.
HTTP 200 means lookup succeeded; inspect and verify the receipt status before
treating the payment as confirmed. This fix preserves the original signature
and settlement POST result, and requires no SDK upgrade beyond this release.

## Purchase binding and resends

The facilitator returns an admitted payment's original answer only to the
binding that admitted it: the same `Idempotency-Key` or the same
`X-UVD-Purchase`. Holding the signed payment is not a binding. From 2.97.0 every
`/verify` and `/settle` call carries an `Idempotency-Key`:

```typescript
import { FacilitatorClient, createIdempotencyKey } from 'uvd-x402-sdk/backend';

const client = new FacilitatorClient();
const idempotencyKey = createIdempotencyKey(); // one per payment; store it with the order
const verified = await client.verify(payment, requirements, { idempotencyKey });
const settled = await client.settle(payment, requirements, { idempotencyKey });
// After a lost response, resend with the SAME key: the original answer comes
// back with settled.replayed === true, and no new money moves.
```

`verifyAndSettle` and the Express/Hono middlewares create one key per payment
and send it on both calls and every retry. The key is random: a key derived from
the X-PAYMENT would be known to anyone holding the payment. It is
merchant-private and never propagated in `PAYMENT-RESPONSE`. On networks without
receipts the facilitator uses it for its own settle cache, keyed per payment, so
only a retry of the same settle can hit it; if that cache is unreadable it answers
`503 idempotency_store_unavailable` without settling, which the SDK reports as
`retryable` (no verdict).

A resend without the admitting binding is refused, and the SDK reports it as
data:

| `errorCode` | Meaning | Middleware answer |
| --- | --- | --- |
| `authorization_already_settled` | This X-PAYMENT was used; its payment is confirmed | `409`, handler not run |
| `authorization_in_flight` | Its payment is pending or unknown; `retryable: true` to learn the verdict | `503` + `Retry-After` |
| `receipt_request_conflict` | The authorization belongs to another request | `409` |

None is a rejected signature, so none is answered `402` (a new signature would
pay a second time), and none is a `500`. `/verify` reports the first two as
`isValid: false` with the same `errorCode`. For a payment made without purchase
context, the receipt travels in `PAYMENT-RESPONSE` so the buyer can see its
state. `buildPaymentConflictResponse(result)` gives any other framework the same
answer. A facilitator older than 2.39.0 replays the original success to any
resend; a settle made with a fresh key and no purchase context cannot have
admitted anything, so the SDK answers such a replay as
`authorization_already_settled` too. A replay bound by the buyer's
`X-UVD-Purchase` is a resumed purchase and is served.
