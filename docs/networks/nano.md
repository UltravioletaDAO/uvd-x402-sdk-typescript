# Nano (XNO) on nano:mainnet

Nano is a feeless ledger in which every account has its own chain of blocks.
A payment is a **send block** from the buyer's account to the merchant's; it is
final once the network has confirmed it, usually in well under a second.

The Ultravioleta facilitator does **not** settle Nano, and nothing here changes
that. A Nano payment is verified by the merchant's own server against a Nano
node, beside the facilitator networks, which keep going to the facilitator.

| Setting | Value |
|---|---|
| SDK name | `nano:mainnet` |
| Asset | native XNO, written `XNO` in an accept |
| Units | raw: **1 XNO = 10^30 raw** |
| Addresses | `nano_...` (or the older `xrb_...`), 5-byte Blake2b checksum |
| Explorer | `https://nanolooker.com` |
| Import | `uvd-x402-sdk/nano` |

The registry entry has `x402.enabled: false`, so the client and the network
counts treat it as a network the facilitator does not offer.

## Prices are in raw, set by the operator

XNO is not a dollar and the SDK has no exchange rate. Asking the USD builders
for a Nano price throws, as it does for XRP. The operator writes the price in
raw and keeps it up to date: `10n ** 27n` raw is 0.001 XNO.

## Buyer

`NanoProvider` holds no key. It is given a `send(to, amountRaw)` function, from
whatever wallet or node signs and publishes the block, and pays with the hash
that function returns. The payload is `{ "blockHash": "<64 hex>" }` in an x402
v2 header with `network: "nano:mainnet"`.

```ts
import { NanoProvider } from 'uvd-x402-sdk/nano';

const nano = new NanoProvider({ address: 'nano_...', send: (to, raw) => wallet.send(to, raw) });
await nano.connect();
const payload = await nano.signPayment({ recipient: 'nano_...', amount: '0.001' }, chain); // XNO
const header = nano.encodePaymentHeader(payload);
```

## Merchant: how a payment is verified

`createNanoVerifier` reads the block with the node RPC `block_info`
(`json_block: "true"`) and accepts it only when:

1. the hash is 64 hex characters;
2. `subtype` is `send` (a receive, open or change block is refused);
3. `contents.link_as_account` is the merchant's `payTo` (same public key);
4. `amount` is at least the price, compared as integers of raw;
5. `confirmed` is `"true"`;
6. the hash has not been accepted before (replay store).

An unconfirmed block or an unreachable node is "no verdict" (`retryable`): the
middleware answers 503 and the same hash can be presented again. The default
replay store is in memory; give `replayStore` a shared, atomic one when several
servers take payments.

It is opt-in, through `localVerifiers` of the middleware options:

```ts
import { createNanoVerifier, createNanoRpc } from 'uvd-x402-sdk/nano';

const paywall = createFetchPaywall({
  accepts: [
    { network: 'base', asset: USDC, amount: '10000', payTo: '0x...' },
    { network: 'nano:mainnet', asset: 'XNO', amount: (10n ** 27n).toString(), payTo: 'nano_...' },
  ],
  localVerifiers: {
    nano: createNanoVerifier({ payTo: 'nano_...', amountRaw: 10n ** 27n, rpc: createNanoRpc('http://127.0.0.1:7076') }),
  },
});
```

Without `localVerifiers`, nothing changes. With it, only payments whose network
is `nano:mainnet` are taken out of the facilitator path; their `settle()`
returns the block hash, since the funds have already moved.
