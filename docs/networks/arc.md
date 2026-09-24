# Arc mainnet and testnet

Direct USDC and EURC `exact` payments are supported by the Ultravioleta facilitator in both x402 v1 and v2. Both have funded payment receipts on Arc mainnet (EURC since 2026-09-22, x402 v1 and v2); EURC funded acceptance on Arc testnet is pending.

| Setting | Mainnet | Testnet |
|---|---|---|
| SDK / v1 name | `arc` | `arc-testnet` |
| Chain ID | `5042` | `5042002` |
| v2 network | `eip155:5042` | `eip155:5042002` |
| RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.io` |
| Explorer | `https://explorer.arc.io` | `https://explorer.testnet.arc.io` |

Both networks use USDC `0x3600000000000000000000000000000000000000` with EIP-712 domain `name: "USDC", version: "2"`. Payment amounts have **6 decimals**: `0.01 USDC` is `10000` atomic units. Native gas has 18 decimals on the same balance; the two readings must not be added. The facilitator pays gas. A payer needs USDC on the selected network.

The chain ID is part of the signature domain. An authorization signed on mainnet cannot be reused on testnet. The SDK preserves their distinct registry entries and CAIP-2 identifiers.

The facilitator URL is `https://facilitator.ultravioletadao.xyz`. Check `/supported` at runtime when using another facilitator. USYC, Gateway, contract-wallet signatures/EIP-6492 and `upto` are outside this Arc release. ERC-8004 identity and reputation are covered since 2.98.0: see [ERC-8004 on Arc](#erc-8004-on-arc-2980). Escrow is covered since 2.99.0: see [Escrow on Arc](#escrow-on-arc-2990).

## EURC: prices in euros

EURC is registered for direct EOA `exact` payments in x402 v1/v2. Circle publishes
different contracts for each network:

| Network | EURC contract | Payment decimals | EIP-712 name / version |
|---|---|---|---|
| Arc mainnet | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` | 6 | `EURC` / `2` |
| Arc testnet | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` | 6 | `EURC` / `2` |

**0.01 EURC is 10000 atomic units and is a euro price.** No USD/EUR exchange rate
is applied. EURC has its own balance; the facilitator still pays gas in **USDC**.
Select the EURC address explicitly and keep USDC as the default dollar asset.
Do not pass a dollar quote into the EURC signing path.

Contract metadata and EIP-712 domain separators were checked through both live
RPCs on 2026-09-17. Offline signatures and network/token isolation are tested.
**Funded EURC payments settled on Arc mainnet on 2026-09-22** through the public
facilitator (2.36.1), 10000 atomic units (0.01 EURC) each — see
[Confirmed EURC payments](#confirmed-eurc-payments-2026-09-22). Against the same funded
wallet this SDK as published (2.96.0) got `isValid: true` in v1 and v2.
**Arc testnet funded EURC settlement is still pending** (Circle's faucet needs a
human); unfunded testnet signatures reach the facilitator's balance check
(`insufficient_funds`). The USDC receipts further below keep their original scope.
[Assessment](../reports/2026-09-17-arc-eurc-assessment.json).
[Official Circle contract list](https://developers.circle.com/stablecoins/eurc-contract-addresses).

### EURC payer and merchant (TypeScript)

Install `npm install uvd-x402-sdk@^2.94.0`. Use explicit atomic requirements for
EURC; `buildPaymentRequirements` is a dollar-price convenience helper.

```typescript
import { getChainByName, getTokenConfig } from 'uvd-x402-sdk';
import { EVMProvider } from 'uvd-x402-sdk/evm';
import { FacilitatorClient, parsePaymentHeader } from 'uvd-x402-sdk/backend';

const chain = getChainByName('arc-testnet')!; // 'arc' for mainnet
const eurc = getTokenConfig(chain.name, 'eurc')!;
const requirements = {
  scheme: 'exact', network: `eip155:${chain.chainId}`, asset: eurc.address,
  maxAmountRequired: '10000', // 0.01 EURC, no USD conversion
  payTo: merchantAddress, resource: 'https://your-service.example/paid',
  maxTimeoutSeconds: 300, extra: { name: eurc.name, version: eurc.version },
};
const wallet = new EVMProvider();
await wallet.connect(chain.name);
const signed = await wallet.signPayment({
  recipient: requirements.payTo, amount: '0.01', tokenType: 'eurc',
}, chain);
const header = wallet.encodePaymentHeader(signed, chain, 2, { includeTokenMetadata: true });
const facilitator = new FacilitatorClient({ x402Version: 2 });
// Merchant: use YOUR stored requirements, not a price copied from the buyer.
const payment = parsePaymentHeader(header);
const verified = await facilitator.verify(payment, requirements);
if (!verified.isValid) throw new Error('Payment verification failed');
const settled = await facilitator.settle(payment, requirements);
if (!settled.success) throw new Error('Payment settlement failed');
// Deliver only after confirmed settlement; preserve an uncertain transaction ID.
```

For v1 use `chain.name` for `network` and version 1 in the encoder/client. Both
versions use the same six-decimal EURC amount and token-specific signing domain.


## Usage

Install `npm install uvd-x402-sdk@^2.92.0`.

Build the merchant's requirements with the ordinary backend helper:

```typescript
import { FacilitatorClient, buildPaymentRequirements, parsePaymentHeader } from 'uvd-x402-sdk/backend';

const requirements = buildPaymentRequirements({
  chainName: 'arc-testnet', // 'arc' selects mainnet
  x402Version: 2,
  amount: '0.01',
  recipient: '0xYourMerchantAddress',
  resource: 'https://your-service.example/paid',
});
const facilitator = new FacilitatorClient({ x402Version: 2 });
// const payment = parsePaymentHeader(paymentSignatureHeader);
// const verified = await facilitator.verify(payment, requirements);
// if (!verified.isValid) handleVerificationFailure(verified);
// const settled = await facilitator.settle(payment, requirements);
// Deliver the resource only after checking settled.success and its transactionHash.
```

The browser payer can use the public EVM wallet adapter:

```typescript
import { getChainByName } from 'uvd-x402-sdk';
import { EVMProvider } from 'uvd-x402-sdk/evm';

const chain = getChainByName('arc-testnet')!;
const wallet = new EVMProvider();
await wallet.connect(chain.name);
const signed = await wallet.signPayment({ recipient: '0xYourMerchantAddress', amount: '0.01' }, chain);
const paymentHeader = wallet.encodePaymentHeader(signed, chain, 2);
```

Use `arc` to select mainnet. Use version `1` in the requirements, header encoder and facilitator client for the v1 flow. The acceptance helper `scripts/arc-canary.mjs` uses a local EIP-1193 signer with the same public connect/sign/encode APIs; a real browser wallet was not part of that automated acceptance.

## Validation and operations

Automated tests cover both registries, amount scaling, v1/v2 forms, real EIP-712 signatures and rejection of signatures under the other network's domain. The complete SDK suite passed **735 tests**, and the existing Python/TypeScript conformance suite passed **430 checks**. Four real payments from this SDK were confirmed through the public facilitator. Each transferred one atomic USDC unit; replay did not credit the recipient again. [Full receipt evidence](../reports/2026-09-16-arc-sdk-acceptance.json).

A timeout or an error carrying a transaction hash is an uncertain payment. Reconcile that hash and the original authorization nonce before asking the payer for a new signature. Never create a fresh authorization automatically to resolve uncertainty.

Primary references: [Arc connection parameters](https://docs.arc.io/arc/references/connect-to-arc), [contract addresses](https://docs.arc.io/arc/references/contract-addresses), [facilitator Arc operations and receipts](https://github.com/UltravioletaDAO/x402-rs/blob/main/docs/networks/arc.md).

## Confirmed SDK payments (2026-09-16)

| Network | Protocol | Receipt |
|---|---|---|
| arc-testnet | v1 | [0x2f7cf28a85ff33411f62410a21d99e5c14fd8dc5f5a8915fc373e9d7f47fe10b](https://explorer.testnet.arc.io/tx/0x2f7cf28a85ff33411f62410a21d99e5c14fd8dc5f5a8915fc373e9d7f47fe10b) |
| arc-testnet | v2 | [0x17751f104e3a876eb9eba133b680bea478d0f78b87d60ab633334cd70eb8daea](https://explorer.testnet.arc.io/tx/0x17751f104e3a876eb9eba133b680bea478d0f78b87d60ab633334cd70eb8daea) |
| arc | v1 | [0x504d8753fbc7ee91cd523cc646fdd8e93e194084b4388c3c0c51a258729bcf2e](https://explorer.arc.io/tx/0x504d8753fbc7ee91cd523cc646fdd8e93e194084b4388c3c0c51a258729bcf2e) |
| arc | v2 | [0x02f2a82166369ca63d752a988df93e6210be113e63c6e47bca220aa4e1ae4d08](https://explorer.arc.io/tx/0x02f2a82166369ca63d752a988df93e6210be113e63c6e47bca220aa4e1ae4d08) |

These are controlled operator canaries through the SDK and public facilitator. They do not constitute customer sales or a browser/merchant UI acceptance test.

## EURC release acceptance (2026-09-17)

Version **2.94.0** is published and was installed into a clean environment.
The full suite passed **762 tests** and the existing cross-language suite
passed **430 checks**. Four offline signatures from the installed package cover
both Arc networks and both protocol versions; recovered signers and domains
match the independently measured contracts. Package integrity was checked against
the registry. [Release evidence](../reports/2026-09-17-arc-eurc-release-acceptance.json).

At that release funded EURC payments were deferred by operator instruction; these
signature and installation checks are not settlement receipts. The funded receipts
came on 2026-09-22 and are listed below.

## Confirmed EURC payments (2026-09-22)

| Network | Protocol | Receipt | Block |
|---|---|---|---|
| arc | v2 | [0xd9de3864e11698cf730664147ac383acb763279056ac091bab57cfd3bf536128](https://explorer.arc.io/tx/0xd9de3864e11698cf730664147ac383acb763279056ac091bab57cfd3bf536128) | 22114558 |
| arc | v1 | [0x3f966c6e634380b8c741019d66c2395b670ce5755105721d7cbe1e74e3f76d1d](https://explorer.arc.io/tx/0x3f966c6e634380b8c741019d66c2395b670ce5755105721d7cbe1e74e3f76d1d) | 22114670 |

Payer `0x649E4BAf56230ae09EE62Fe47bd98C3e50772869` (a fresh EOA holding only EURC, no
USDC), payee `0x103040545AC5031A11E8C03dd11324C7333a13C7`. Each receipt holds one EURC
`Transfer` of exactly 10000 units, gas was paid by the facilitator in USDC, and the
settle response carried a signed facilitator receipt with status `confirmed`. Both
were signed with the published Python SDK (0.88.0). This SDK (2.96.0) signed the
same 0.01 EURC with `signPayment({ amount: '0.01', tokenType: 'eurc' })` →
`value: '10000'`, and the facilitator answered `isValid: true` for v1 and v2 against
the funded wallet (verify only, no third settlement). Replaying each settle body
did not debit the payer again (measured by payer balance); in v1 the replay
returned the original transaction hash. Arc testnet remains pending.

## ERC-8004 on Arc (2.98.0)

`arc` and `arc-testnet` are `Erc8004Network`s with the canonical registries, and
`arc` is in `RELAYED_FEEDBACK_NETWORKS`, where the rating is recorded under the
rater's own address. `arc-testnet` has reads only: the facilitator serves
identity and reputation there, but no `FeedbackDelegate` is deployed, so
`supportsRelayedFeedback('arc-testnet')` is `false`.

| | `arc` (5042) | `arc-testnet` (5042002) |
|---|---|---|
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Reputation Registry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Validation Registry | `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |
| Relayed feedback | yes: v4 delegate `0x955Cc9fB9aB95FC0821ae74197D273dde5dA84f1` | no (`prepare` answers 400) |

These are the addresses the facilitator names in `ARC_MAINNET_CONTRACTS` and
`ARC_TESTNET_CONTRACTS` (x402-rs 2.39.0). Measured on 2026-09-23:

- Every registry has code: a 130-byte EIP-1967 proxy whose implementation slot
  holds the same address as on Base (mainnet) and Base Sepolia (testnet), with
  `getVersion()` = `2.0.0`. Mainnet was read on `rpc.mainnet.arc.io`, testnet on
  both `rpc.testnet.arc.io` and `rpc.testnet.arc.network`.
- The delegate has code on mainnet (5857 bytes), `VERSION()` = 4 and
  `REPUTATION_REGISTRY()` = the mainnet registry. The address has no code on
  testnet.
- The facilitator (2.39.0) lists both networks in `GET /feedback` →
  `supportedNetworks`, and `GET /identity/{arc,arc-testnet}/1` answers 200.
  `POST /feedback/evm/prepare` answers 200 on `arc` and offers that delegate
  and chain 5042. On `arc-testnet` it answers 400 `relayed feedback is not
  available on arc-testnet: no FeedbackDelegate is deployed there yet`.
- The first relayed rating on Arc is
  [0x0f8c7f7548382885d7674b5773823d560dd242596725acea4c8b4af92674bb2d](https://explorer.arc.io/tx/0x0f8c7f7548382885d7674b5773823d560dd242596725acea4c8b4af92674bb2d)
  (type 4, block 22313930). Its `NewFeedback` names the rater, not the
  facilitator, as the client.

```typescript
import { Erc8004Client, supportsRelayedFeedback } from 'uvd-x402-sdk/backend';

const erc8004 = new Erc8004Client();
const identity = await erc8004.getIdentity('arc', 1);
const reputation = await erc8004.getReputation('arc', 1);

supportsRelayedFeedback('arc');         // true  -> prepareRelayedFeedback / submitRelayedFeedback
supportsRelayedFeedback('arc-testnet'); // false -> no delegate on testnet
```

Gas on Arc is USDC. The facilitator pays it for the relayed rating, as it does
for payments.

## Escrow on Arc (2.99.0)

`AdvancedEscrowClient` (chain ID `5042` or `5042002`) and `buildEscrowPreAuth` run
on the x402r canonical escrow. The addresses are the same on both networks:

| Contract | Address |
|---|---|
| AuthCaptureEscrow | `0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff` |
| ERC3009PaymentCollector (`tokenCollector`) | `0x0E3dF9510de65469C4518D7843919c0b8C7A7757` |
| ProtocolFeeConfig | `0xBe2d24614F339a1eB103A399F93AA2a39Ca815Bc` |
| RefundRequestFactory | `0xe971C674fD5c3462023f3F891dF6289DFbC9CEFC` |
| PaymentOperatorFactory v1.0.2 | `0xc24153B7ED8DC03e551F29DDEeA5CadFe57e2716` |
| PaymentOperator (`operator`) | `0x0258472A1410Ac3Ad720f1BC83f22B3c0af1Fd9D` |

The operator is generation `'v3'` (`OPERATOR_ABI_V3`). It has no `release` and no
`refundInEscrow`, so the client maps them:

- `release(paymentInfo, amount)` sends `capture(paymentInfo, amount, 0x)`.
- `refundInEscrow(paymentInfo, amount)` sends `void(paymentInfo, 0x)`. `void` takes
  no amount: it returns the whole `capturableAmount` to the payer. The client reads
  that amount on-chain first and sends only when `amount` equals it. Otherwise it
  sends nothing and returns `errorCode` `ESCROW_VOID_AMOUNT_MISMATCH`, or
  `ESCROW_NOTHING_TO_VOID` when the capturable amount is 0. To return part of an
  escrow, `release` the part the receiver keeps, then `refundInEscrow` the rest.
- `refundPostEscrow(paymentInfo, amount, tokenCollector, collectorData)` sends
  `refund` with the same arguments.
- `charge` returns `ESCROW_UNSUPPORTED_ON_GENERATION` without signing or sending.
- While the operator address has no code, `release`, `refundInEscrow` and
  `refundPostEscrow` return `ESCROW_OPERATOR_NOT_DEPLOYED` and send nothing.

```typescript
import { AdvancedEscrowClient, ESCROW_VOID_AMOUNT_MISMATCH } from 'uvd-x402-sdk/backend';

const client = new AdvancedEscrowClient(signer, { chainId: 5042 });
// 5 USDC in escrow: pay the receiver 3, return the other 2 to the payer.
await client.release(paymentInfo, '3000000');                        // capture(paymentInfo, 3000000, 0x)
const refund = await client.refundInEscrow(paymentInfo, '2000000');  // void(paymentInfo, 0x)
if (!refund.success && refund.errorCode === ESCROW_VOID_AMOUNT_MISMATCH) {
  // 2000000 is not what is left in escrow. Nothing was sent.
}
```

Measured from the public RPCs on 2026-09-24 (Arc block 22439550, Arc Testnet block
63685410) and recorded in `src/fixtures/arc-escrow-d.rpc.json` by
`scripts/record-arc-escrow-d.mjs`:

- The factory's `computeAddress` returns the operator above on both networks, and
  its `ESCROW()` / `PROTOCOL_FEE_CONFIG()` are the escrow and fee config above. The
  factory bytecode is identical on both networks and contains every
  `OPERATOR_ABI_V3` selector (`capture` `0xf12b86f6`, `void` `0xc3c5090e`,
  `FEE_RECEIVER` `0xd3e78e4d`) and none of the v1/v2 `release` / `refundInEscrow`.
- The token collector's `authCaptureEscrow()` is the escrow above. Every contract in
  the table but the operator has code.
- USDC `name()` / `version()` are `USDC` / `2`, and the EIP-712 domain the client
  signs hashes to the token's `DOMAIN_SEPARATOR()` on both networks.
- The pre-auth vector `src/escrow-preauth.arc-vector.json` (the Python SDK's Arc
  pre-auth case) uses the nonce read from `AuthCaptureEscrow.getHash` on Arc.

`buildEscrowPreAuth` checks the escrow config's USDC domain against
`VERIFIED_USDC_DOMAINS`: on Arc and Arc Testnet a config that does not say
`USDC` / `2` is refused with `INVALID_CONFIG` before anything is signed.

The gasless `releaseViaFacilitator` / `refundViaFacilitator` send the same request
as on any other network; whether a facilitator serves escrow on Arc is for its
`/supported` to answer.
