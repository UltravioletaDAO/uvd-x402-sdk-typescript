# Native Hedera: mainnet and testnet

Native Hedera uses **x402 v2, scheme exact**, numeric `0.0.…` accounts and
protobuf `TransactionList` buyer signatures. These are not EVM chains 295/296.

| Ledger | Fee payer | USDC token (6 decimals) | HBAR (8 decimals) |
| --- | --- | --- | --- |
| `hedera:mainnet` | `0.0.10868300` | `0.0.456858` | `0.0.0` |
| `hedera:testnet` | `0.0.10576385` | `0.0.429274` | `0.0.0` |

`hedera` and `hedera-testnet` are SDK input aliases. Wire offers use the canonical
ledger IDs above. Bind the buyer signer to the intended ledger and trusted
fee payer. USDC buyer and merchant accounts must be associated with that
ledger's native token. The facilitator pays consensus fees; the buyer signs
only the payment principal. Signed transactions cap sponsor fees at 1 HBAR.

Amounts in the native builders are integer strings in atomic units:
`1000` = 0.001 USDC; `10000` = 0.0001 HBAR. HBAR is not USD pegged, so do not
pass an HBAR amount through USD pricing APIs. Native signing supports DER
Ed25519 or ECDSA keys and numeric account IDs. No v1, EVM authorization,
escrow, upto, hooks or extensions are advertised for this native path.

The default facilitator is `https://facilitator.ultravioletadao.xyz`.
Check `GET /supported` before offering a ledger. Live capability and admission
budget are deployment settings, separate from SDK network discovery.

## Merchant protocol

Return HTTP 402 with `{ "x402Version": 2, "accepts": [requirements] }`.
Decode the buyer's `PAYMENT-SIGNATURE` base64 JSON. Build `/verify` and `/settle`
requests using your server's own stored requirements: never accept a price
or recipient supplied by the buyer. Require `isValid: true`, then require
`success: true` from settlement before serving the resource. The settlement
`transaction` is the native `0.0.feePayer@seconds.nanoseconds` ID.

Persist the signed request before settlement. After a timeout or ambiguous
result, recover/retry the **same request and transaction ID**; never sign a
new payment to resolve an unknown outcome. The facilitator rejects replay
at verification and returns the original successful result on settlement retry.

## Production evidence

The facilitator's [mainnet acceptance receipts](https://github.com/UltravioletaDAO/x402-rs/blob/main/docs/reports/2026-09-16-hedera-mainnet-public-canaries.json)
and [transaction ledger](https://github.com/UltravioletaDAO/x402-rs/blob/main/docs/reports/2026-09-16-hedera-transaction-ledger.md)
include HBAR and USDC settlements, exact principal movements, sponsor fees and
independent Mirror confirmation against persisted signed-transaction hashes.
The initial deployed admission budget is 10 HBAR of signed maximum fees per
ledger per UTC day (10 default 1-HBAR requests, not 10 HBAR actually spent).
Capacity must be raised deliberately before higher-volume production traffic.

## TypeScript buyer (2.93.0+)

```sh
npm install uvd-x402-sdk@^2.93.0 @hiero-ledger/sdk@^2.85.0
```

```typescript
import { X402Client } from 'uvd-x402-sdk';
import { HederaProvider } from 'uvd-x402-sdk/hedera';

const provider = new HederaProvider({
  network: 'hedera:mainnet', accountId: process.env.HEDERA_BUYER_ID!,
  privateKey: process.env.HEDERA_PRIVATE_KEY_DER!,
});
const client = new X402Client();
await client.connectWithAdapter(provider, 'hedera:mainnet');
const response = await client.fetch('https://your-merchant.example/paid', {
  tokenType: 'usdc', maxAmount: '0.001',
});
```

For HBAR use `tokenType: 'hbar'` and a ceiling expressed in HBAR.
This is a server/CLI DER-key adapter. HashPack browser connection is not
implemented by this provider; keep private keys in server-side secret storage.
The optional Hiero peer is loaded only when signing/connecting.

```typescript
import { buildHederaRequirements, buildHederaRequest } from 'uvd-x402-sdk/hedera';

const requirements = buildHederaRequirements({
  network: 'hedera:mainnet', payTo: merchantAccountId,
  amountAtomic: '1000', asset: 'usdc',
});
// After decoding the PAYMENT-SIGNATURE header:
const body = buildHederaRequest(decodedPayment, requirements);
// POST this same body to /verify and, if valid, /settle.
```

For offline signing use `provider.createPaymentPayload(requirements)`.
This signs three current node variants sharing one immutable transaction ID;
it does not broadcast or query consensus nodes.
