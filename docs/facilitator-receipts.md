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
and `paymentResponseHeaders(result)`. Forward these headers through CORS/proxies.

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
