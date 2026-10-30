# HashKey Chain

The SDK registers `hashkey` (`eip155:177`) and `hashkey-testnet` (`eip155:133`). Both use HSK for gas and USDC with 6 decimals for EIP-3009 payments. HashKey USDT has no EIP-3009 and is not enabled.

| Network | RPC | Explorer | USDC | EIP-712 name | Version |
| --- | --- | --- | --- | --- | --- |
| hashkey | https://mainnet.hsk.xyz | https://hsk.blockscout.com | `0x054ed45810DbBAb8B27668922D110669c9D88D0a` | Bridged USDC | 2 |
| hashkey-testnet | https://testnet.hsk.xyz | https://testnet-explorer.hskchain.net | `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6` | USD Coin | 2 |

Read-only `eth_chainId`, `name()` and `DOMAIN_SEPARATOR()` checks on 2026-10-30 matched [x402-rs@38d67a47](https://github.com/UltravioletaDAO/x402-rs/blob/38d67a47/src/chain/evm.rs):

| Network | Block | DOMAIN_SEPARATOR |
| --- | --- | --- |
| hashkey | 29510555 | `0x78101f50ab6b299bde76a9973e97b1c9ead7df26f6a40692f4440296a507259d` |
| hashkey-testnet | 35090796 | `0x4b73b8fe157f795886e2aa243f2ccddcc00b80eaa9f9b4b368b716895be71d09` |

`src/hashkey.test.ts` pins these values offline and checks both SDK signing paths. These are recorded observations, not live CI checks; an on-chain upgrade requires a separate recheck.

```ts
import { getChainByName, CAIP2_IDENTIFIERS, X402Client } from 'uvd-x402-sdk';

const chain = getChainByName('hashkey')!;
const network = CAIP2_IDENTIFIERS[chain.name]; // eip155:177
const client = new X402Client({ defaultChain: chain.name });
```

When constructing requirements manually, supply `extra: { name: 'Bridged USDC', version: '2' }` on mainnet and `extra: { name: 'USD Coin', version: '2' }` on testnet. `buildPaymentRequirements` supplies these from the registry.
