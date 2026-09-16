# Arc mainnet and testnet

Direct USDC `exact` payments are supported by the Ultravioleta facilitator in both x402 v1 and v2. This release adds the network definitions to the SDK's normal signing and payment paths.

| Setting | Mainnet | Testnet |
|---|---|---|
| SDK / v1 name | `arc` | `arc-testnet` |
| Chain ID | `5042` | `5042002` |
| v2 network | `eip155:5042` | `eip155:5042002` |
| RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.io` |
| Explorer | `https://explorer.arc.io` | `https://explorer.testnet.arc.io` |

Both networks use USDC `0x3600000000000000000000000000000000000000` with EIP-712 domain `name: "USDC", version: "2"`. Payment amounts have **6 decimals**: `0.01 USDC` is `10000` atomic units. Native gas has 18 decimals on the same balance; the two readings must not be added. The facilitator pays gas. A payer needs USDC on the selected network.

The chain ID is part of the signature domain. An authorization signed on mainnet cannot be reused on testnet. The SDK preserves their distinct registry entries and CAIP-2 identifiers.

The facilitator URL is `https://facilitator.ultravioletadao.xyz`. Check `/supported` at runtime when using another facilitator. EURC/USYC, Gateway, contract-wallet signatures/EIP-6492, `upto`, escrow and ERC-8004 writes are outside this Arc release.

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
