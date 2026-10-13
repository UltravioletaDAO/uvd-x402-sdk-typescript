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

## Why a payment is bound to an order

A Nano block has no memo and its hash is public. If the merchant accepted "any
confirmed send to `payTo` that nobody has claimed", whoever watches the ledger
could present somebody else's hash and take the resource. So every Nano payment
is bound to **one issued requirement**:

1. The 402 carries an order in the Nano accept's `extra.nano`:
   `{ orderId, representative, issuedAt, expiresAt }`. `orderId` is random and
   carries a MAC (HMAC-SHA256 under the server's secret) over its window,
   `payTo`, price and resource, so it only verifies for the request it was
   issued for.
2. The buyer's **send block sets its `representative` to the order
   commitment**: `nano_` account of
   `SHA256("xno-binding/v1/rep|" + orderId + "|" + payTo + "|" + amountRaw)`
   (option C of the [XNO binding standard](https://github.com/dhyabi2/xno-call-binding/blob/main/docs/BINDING-STANDARD.md);
   test vector: `("order-0001", all-zero account, 5e28 raw)` gives
   `nano_33q9dassq66es6mcay83n5kypqgpzjikr9bkc9ope9xch1borfphgehj4ozj`).
   The paying key signs it, so nobody else can produce a block with that value.
3. The payment header carries `{ blockHash, orderId }`.

## Buyer

`NanoProvider` holds no key. It is given a `send(to, amountRaw, { representative })`
function, from whatever wallet or node signs and publishes the block (the
wallet must let the caller set the representative of the send block), and pays
with the hash that function returns. It **recomputes the commitment itself** and
refuses to pay when the 402 has no order or its `representative` does not match
`payTo`, price and order id. The payload is `{ "blockHash": "<64 hex>", "orderId": "..." }`
in an x402 v2 header with `network: "nano:mainnet"`.

```ts
import { NanoProvider } from 'uvd-x402-sdk/nano';

const nano = new NanoProvider({
  address: 'nano_...',
  send: (to, raw, { representative }) => wallet.send(to, raw, { representative }),
});
await nano.connect();
// paymentInfo.accepted is the Nano accept of the 402, extra.nano included.
const payload = await nano.signPayment({ recipient: 'nano_...', amount: '0.001', accepted }, chain); // XNO
const header = nano.encodePaymentHeader(payload);
```

## Merchant: how a payment is verified

`createNanoVerifier` rebuilds the requirement from the request's own `payTo`,
price and resource, checks the presented `orderId` against its `issuer`, and
reads the block with the node RPC `block_info` (`json_block: "true"`). It
accepts it only when:

1. the hash is 64 hex characters;
2. `subtype` is `send` (a receive, open or change block is refused);
3. `contents.link_as_account` is the merchant's `payTo` (same public key);
4. `amount` is at least the price, compared as integers of raw;
5. `contents.representative` is the order commitment (the block is bound to this order);
6. `confirmed` is `"true"`;
7. the node's `local_timestamp` for the block lies inside the order's window
   (`issuedAt`..`expiresAt`; a block whose time the node does not know is refused);
8. neither the block hash nor the order id has been accepted before (replay store).

An unconfirmed block or an unreachable node is "no verdict" (`retryable`): the
middleware answers 503 and the same hash can be presented again.

### The replay store is mandatory and persistent

There is no default store. `createNanoVerifier` throws without a `replayStore`
and refuses one whose `persistent` is not `true`, because a restart that forgets
claims lets every old block be presented again. `SqliteNanoReplayStore` takes a
`better-sqlite3` database the program opens (the SDK never loads it itself; the
connection must run with `PRAGMA synchronous = FULL`): the block hash is the
PRIMARY KEY and the order id is UNIQUE, so one block credits one order once,
across processes sharing the file. For several machines implement
`NanoReplayStore` over a shared database or `SET NX`; `claim` must be atomic.
`createVolatileNanoReplayStore` exists for tests and needs
`allowVolatileReplayStore: true`.

It is opt-in, through `localVerifiers` of the middleware options. The fetch
and Hono paywalls put a fresh order in `extra.nano` of every Nano accept they
advertise (from the verifier's `issuer`):

```ts
import Database from 'better-sqlite3';
import { createNanoVerifier, createNanoOrderIssuer, createNanoRpc, SqliteNanoReplayStore } from 'uvd-x402-sdk/nano';

const db = new Database('nano-claims.db');
db.pragma('synchronous = FULL');

const paywall = createFetchPaywall({
  accepts: [
    { network: 'base', asset: USDC, amount: '10000', payTo: '0x...' },
    { network: 'nano:mainnet', asset: 'XNO', amount: (10n ** 27n).toString(), payTo: 'nano_...' },
  ],
  localVerifiers: {
    nano: createNanoVerifier({
      issuer: createNanoOrderIssuer({ secret: process.env.NANO_ORDER_SECRET!, ttlSeconds: 600 }),
      rpc: createNanoRpc('http://127.0.0.1:7076'),
      replayStore: new SqliteNanoReplayStore(db),
    }),
  },
});
```

The Express middleware verifies Nano payments the same way, but its own 402
builder does not advertise Nano accepts; serve the 402 for Nano from the fetch
or Hono paywall, or call `issuer.issue(...)` yourself and put the result in the
accept's `extra.nano`.

Without `localVerifiers`, nothing changes. With it, only payments whose network
is `nano:mainnet` are taken out of the facilitator path; their `settle()`
returns the block hash, since the funds have already moved.
