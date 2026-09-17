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
EURC real-payment acceptance is pending; the shared signed vectors are offline.
