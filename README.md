# uvd-x402-sdk

Gasless crypto payments across 21 blockchain networks using the x402 protocol.

Users sign a message or transaction, and the Ultravioleta facilitator handles on-chain settlement. No gas fees for users.

## Features

- **21 Networks**: EVM (13 including Scroll, SKALE Base), Solana, Fogo, Stellar, NEAR, Algorand, Sui
- **Multi-Stablecoin**: USDC, EURC, AUSD, PYUSD, USDT
- **x402 v1 & v2**: Both protocol versions with auto-detection
- **Gasless**: Facilitator pays all network fees
- **Type-Safe**: Full TypeScript support
- **React & Wagmi**: First-class integrations
- **Signing Wallet Adapters**: EnvKeyAdapter (server/CLI), OWSWalletAdapter (Open Wallet Standard), or bring your own
- **ERC-8004 Trustless Agents**: On-chain reputation and identity across 20 networks (18 EVM + 2 Solana)
- **Escrow & Refunds**: Hold payments with dispute resolution
- **Advanced Escrow**: Full escrow lifecycle (authorize, release, refund, charge) with SigningWalletAdapter support
- **Commerce Scheme**: `'commerce'` scheme alias for marketplace integrations (identical to `'escrow'` on-chain)
- **`/accepts` Negotiation**: Discover facilitator capabilities before constructing payments
- **Bazaar Discovery**: Register and discover paid resources across the x402 network
- **Facilitator Info**: Query version, supported networks, blacklist, and health

## Installation

```bash
npm install uvd-x402-sdk
```

### Peer Dependencies

```bash
# EVM (included by default)
npm install ethers@^6

# Solana/Fogo
npm install @solana/web3.js @solana/spl-token

# Stellar
npm install @stellar/stellar-sdk @stellar/freighter-api

# NEAR
npm install @near-wallet-selector/core @near-wallet-selector/my-near-wallet

# Algorand
npm install algosdk lute-connect

# Sui
npm install @mysten/sui
```

## Quick Start

### Server + Client (Private Key)

The fastest way to get up and running. No browser wallet needed — works in Node.js, scripts, and agents.

**.env**

```bash
RECEIVING_ADDRESS=0xYourWalletAddress
PRIVATE_KEY=0xYourPrivateKey
```

**Server (Hono)**

```bash
npm install hono @hono/node-server uvd-x402-sdk dotenv
```

```typescript
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createHonoMiddleware } from 'uvd-x402-sdk';
import 'dotenv/config';

const app = new Hono();
const receiver = process.env.RECEIVING_ADDRESS as string;

// x402 payment middleware — handles 402, verify, and settle automatically
const paywall = createHonoMiddleware({
  accepts: [{
    network: 'skale-base',
    asset: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
    amount: '1000000', // $1.00 USDC.e (6 decimals)
    payTo: receiver,
    extra: {
      name: 'Bridged USDC (SKALE Bridge)',
      version: '2',
    },
  }],
});

app.get('/api/free', (c) => c.json({ message: 'This endpoint is free!' }));

app.get('/api/premium', paywall, (c) => {
  return c.json({ message: 'Payment verified and settled!', timestamp: new Date().toISOString() });
});

serve({ fetch: app.fetch, port: 3000 });
console.log('Server running on http://localhost:3000');
```

**Client (Private Key)**

```bash
npm install uvd-x402-sdk ethers dotenv
```

```typescript
import { X402Client } from 'uvd-x402-sdk';
import 'dotenv/config';

const client = new X402Client({ defaultChain: 'skale-base' });
await client.connectWithPrivateKey(process.env.PRIVATE_KEY as string);

const result = await client.createPayment({
  recipient: process.env.RECEIVING_ADDRESS as string,
  amount: '1.00',
});

const response = await fetch('http://localhost:3000/api/premium', {
  headers: { 'X-PAYMENT': result.paymentHeader },
});

const data = await response.json();
console.log('Response:', data);
```

This example uses SKALE Base (zero gas costs). Replace `network`, `asset`, and `extra` to use any supported chain — see [Supported Networks](#supported-networks).

### EVM Chains (Browser Wallet)

```typescript
import { X402Client } from 'uvd-x402-sdk';

const client = new X402Client({ defaultChain: 'base' });
const address = await client.connect('base');

const result = await client.createPayment({
  recipient: '0x...',
  amount: '10.00',
});

await fetch('/api/purchase', {
  headers: { 'X-PAYMENT': result.paymentHeader },
});
```

### Solana

```typescript
import { SVMProvider } from 'uvd-x402-sdk/solana';
import { getChainByName } from 'uvd-x402-sdk';

const svm = new SVMProvider();
const address = await svm.connect();
const chainConfig = getChainByName('solana')!;

const payload = await svm.signPayment({
  recipient: '5Y32Dk6weq1LrMRdujpJyDbTN3SjwXGoQS9QN39WQ9Cq',
  amount: '10.00',
}, chainConfig);

const header = svm.encodePaymentHeader(payload, chainConfig);
```

### Algorand

```typescript
import { AlgorandProvider } from 'uvd-x402-sdk/algorand';
import { getChainByName } from 'uvd-x402-sdk';

const algorand = new AlgorandProvider();
const address = await algorand.connect(); // Lute or Pera wallet
const chainConfig = getChainByName('algorand')!;

const payload = await algorand.signPayment({
  recipient: 'NCDSNUQ2QLXDMJXRALAW4CRUSSKG4IS37MVOFDQQPC45SE4EBZO42U6ZX4',
  amount: '10.00',
}, chainConfig);

const header = algorand.encodePaymentHeader(payload, chainConfig);
```

Algorand uses atomic transaction groups:
- Transaction 0: Fee payment (unsigned, facilitator signs)
- Transaction 1: USDC ASA transfer (signed by user)

### Sui

```typescript
import { SuiProvider } from 'uvd-x402-sdk/sui';
import { getChainByName } from 'uvd-x402-sdk';

const sui = new SuiProvider();
const address = await sui.connect(); // Sui Wallet
const chainConfig = getChainByName('sui')!;

const payload = await sui.signPayment({
  recipient: '0x1234...', // 66-char Sui address
  amount: '10.00',
}, chainConfig);

const header = sui.encodePaymentHeader(payload, chainConfig);
```

Sui uses sponsored transactions:
- User creates and signs a programmable transaction block
- Facilitator sponsors gas (pays in SUI)
- User pays zero gas fees

### Stellar

```typescript
import { StellarProvider } from 'uvd-x402-sdk/stellar';
import { getChainByName } from 'uvd-x402-sdk';

const stellar = new StellarProvider();
const address = await stellar.connect(); // Freighter wallet
const chainConfig = getChainByName('stellar')!;

const payload = await stellar.signPayment({
  recipient: 'GD3FWQ4QFSCO2F2KVXZPQWOC27CQHXHYCRCRRZBMWU3DNOZW2IIGOU54',
  amount: '10.00',
}, chainConfig);

const header = stellar.encodePaymentHeader(payload);
```

### NEAR

> **Important:** The SDK's `NEARProvider.signPayment()` only works with **injected wallets** (browser extensions).
> For **browser-redirect wallets** like MyNearWallet via `@near-wallet-selector`, you must use the popup flow below.

#### Option 1: Injected Wallet (Browser Extension)

```typescript
import { NEARProvider } from 'uvd-x402-sdk/near';
import { getChainByName } from 'uvd-x402-sdk';

const near = new NEARProvider();
const accountId = await near.connect(); // MyNearWallet browser extension
const chainConfig = getChainByName('near')!;

const payload = await near.signPayment({
  recipient: 'merchant.near',
  amount: '10.00',
}, chainConfig);

const header = near.encodePaymentHeader(payload);
```

#### Option 2: Browser-Redirect Wallet (Popup Flow) - Recommended

MyNearWallet via `@near-wallet-selector` is a browser-redirect wallet that requires a popup flow.
This is the recommended approach and works with the custom MyNearWallet deployment that supports NEP-366.

```typescript
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import '@near-wallet-selector/modal-ui/styles.css';

// Configuration
const NEAR_CONFIG = {
  usdcContract: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  recipientAccount: 'merchant.near',
  // Custom MyNearWallet with NEP-366 signDelegateAction support
  walletUrl: 'https://mynearwallet.ultravioletadao.xyz',
};

// Step 1: Initialize wallet selector
const selector = await setupWalletSelector({
  network: 'mainnet',
  modules: [
    setupMyNearWallet({ walletUrl: NEAR_CONFIG.walletUrl }),
  ],
});

const modal = setupModal(selector, {
  contractId: NEAR_CONFIG.usdcContract,
});

// Step 2: Connect wallet
modal.show(); // User selects wallet
// Wait for connection via selector.store.observable.subscribe()
const state = selector.store.getState();
const accountId = state.accounts[0].accountId;

// Step 3: Create payment with popup flow
async function createNearPayment(amount: string): Promise<string> {
  const amountRaw = Math.floor(parseFloat(amount) * 1_000_000); // 6 decimals

  // Get access key info and block height from RPC
  const [accessKeyInfo, blockInfo] = await Promise.all([
    getNearAccessKeyInfo(accountId),
    getNearBlockHeight(),
  ]);

  const nonce = accessKeyInfo.nonce + 1;
  const maxBlockHeight = blockInfo.blockHeight + 1000; // ~17 minutes

  // Build wallet URL for signDelegateAction
  const popupUrl = new URL(NEAR_CONFIG.walletUrl);
  popupUrl.pathname = '/sign-delegate-action';
  popupUrl.searchParams.set('receiverId', NEAR_CONFIG.usdcContract);
  popupUrl.searchParams.set('actions', JSON.stringify([{
    methodName: 'ft_transfer',
    args: {
      receiver_id: NEAR_CONFIG.recipientAccount,
      amount: amountRaw.toString(),
      memo: 'x402 payment',
    },
    gas: '30000000000000', // 30 TGas
    deposit: '1', // 1 yoctoNEAR
  }]));
  popupUrl.searchParams.set('callbackUrl', window.location.origin + '/near-callback');
  popupUrl.searchParams.set('meta', JSON.stringify({
    sender: accountId,
    nonce,
    maxBlockHeight,
    publicKey: accessKeyInfo.publicKey,
  }));

  // Open popup
  const popup = window.open(popupUrl.toString(), 'nearWallet', 'width=500,height=700');
  if (!popup) throw new Error('Popup blocked. Please allow popups.');

  // Wait for redirect with signedDelegateAction
  const signedDelegateAction = await new Promise<string>((resolve, reject) => {
    const checkInterval = setInterval(() => {
      if (popup.closed) {
        clearInterval(checkInterval);
        reject(new Error('Wallet popup closed'));
        return;
      }
      try {
        const url = popup.location.href;
        if (url.includes('signedDelegateAction=')) {
          clearInterval(checkInterval);
          popup.close();
          const params = new URLSearchParams(new URL(url).search);
          const errorCode = params.get('errorCode');
          if (errorCode) {
            reject(new Error(params.get('errorMessage') || errorCode));
            return;
          }
          resolve(params.get('signedDelegateAction')!);
        }
      } catch { /* cross-origin, keep waiting */ }
    }, 500);

    setTimeout(() => {
      clearInterval(checkInterval);
      if (!popup.closed) popup.close();
      reject(new Error('Popup timeout'));
    }, 300000); // 5 min timeout
  });

  // Return x402 payload
  return JSON.stringify({
    signedDelegateAction,
    network: 'near',
  });
}

// Helper: Get access key info from NEAR RPC
async function getNearAccessKeyInfo(accountId: string) {
  const rpcUrls = [
    'https://near.drpc.org',
    'https://rpc.mainnet.near.org',
  ];

  for (const rpcUrl of rpcUrls) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'dontcare',
          method: 'query',
          params: {
            request_type: 'view_access_key_list',
            finality: 'final',
            account_id: accountId,
          },
        }),
      });
      const data = await response.json();
      if (data.error) continue;

      const fullAccessKey = data.result.keys.find(
        (k: any) => k.access_key.permission === 'FullAccess'
      );
      return {
        nonce: fullAccessKey.access_key.nonce,
        publicKey: fullAccessKey.public_key,
      };
    } catch { continue; }
  }
  throw new Error('Failed to get NEAR access key info');
}

// Helper: Get block height from NEAR RPC
async function getNearBlockHeight() {
  const rpcUrls = [
    'https://near.drpc.org',
    'https://rpc.mainnet.near.org',
  ];

  for (const rpcUrl of rpcUrls) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'dontcare',
          method: 'block',
          params: { finality: 'final' },
        }),
      });
      const data = await response.json();
      if (data.error) continue;
      return { blockHeight: data.result.header.height };
    } catch { continue; }
  }
  throw new Error('Failed to get NEAR block height');
}

// Step 4: Encode payment header
function encodeNearPaymentHeader(payload: string): string {
  const parsed = JSON.parse(payload);
  const x402Payload = {
    x402Version: 1,
    scheme: 'exact',
    network: 'near',
    payload: {
      signedDelegateAction: parsed.signedDelegateAction,
    },
  };
  return btoa(JSON.stringify(x402Payload));
}

// Usage
const payload = await createNearPayment('10.00');
const header = encodeNearPaymentHeader(payload);
await fetch('/api/purchase', {
  headers: { 'X-PAYMENT': header },
});
```

See [402milly's full implementation](https://github.com/UltravioletaDAO/402milly/blob/main/frontend/src/services/x402-sdk.ts) for a production-ready example.

## Wagmi/RainbowKit

```typescript
import { useWalletClient } from 'wagmi';
import { createPaymentFromWalletClient } from 'uvd-x402-sdk/wagmi';

function PayButton() {
  const { data: walletClient } = useWalletClient();

  const handlePay = async () => {
    const paymentHeader = await createPaymentFromWalletClient(walletClient, {
      recipient: '0x...',
      amount: '10.00',
      chainName: 'base',
    });

    await fetch('/api/purchase', {
      headers: { 'X-PAYMENT': paymentHeader },
    });
  };

  return <button onClick={handlePay}>Pay $10</button>;
}
```

## Signing Wallet Adapters

Low-level signing primitives for server-side agents, CLI tools, and Open Wallet Standard wallets. These adapters implement EIP-191, EIP-712, and EIP-3009 (gasless USDC transfers).

### EnvKeyAdapter (Server / CLI / Agents)

Signs with a raw private key from the environment or constructor. **Never use in browser contexts.**

```typescript
import { EnvKeyAdapter } from 'uvd-x402-sdk';

// Option 1: Reads process.env.WALLET_PRIVATE_KEY
const wallet = new EnvKeyAdapter();

// Option 2: Explicit key
const wallet = new EnvKeyAdapter(process.env.MY_AGENT_KEY!);

console.log(wallet.getAddress()); // 0x...

// Sign EIP-3009 gasless USDC transfer
const auth = await wallet.signEIP3009({
  to: '0xRecipient...',
  amountUsdc: 1.00,
  network: 'base',
});
// auth contains: from, to, value, nonce, v, r, s, signature

// Sign arbitrary message (EIP-191)
const sig = await wallet.signMessage('Hello x402');

// Sign EIP-712 typed data
const result = await wallet.signTypedData(JSON.stringify({
  domain: { name: 'MyApp', version: '1', chainId: 8453 },
  types: { Order: [{ name: 'id', type: 'uint256' }] },
  primaryType: 'Order',
  message: { id: 42 },
}));
```

### OWSWalletAdapter (Open Wallet Standard)

Delegates signing to any wallet that implements the [Open Wallet Standard](https://github.com/open-wallet-standard/open-wallet-standard). Works with browser wallets, agent vaults, and hardware-backed signers.

```bash
npm install @open-wallet-standard/core  # optional peer dependency
```

```typescript
import { OWSWalletAdapter } from 'uvd-x402-sdk';

const wallet = new OWSWalletAdapter(owsWalletInstance);

const auth = await wallet.signEIP3009({
  to: '0xRecipient...',
  amountUsdc: 0.50,
  network: 'base',
});
```

### Custom Adapter

Implement the `SigningWalletAdapter` interface for your own signer:

```typescript
import type { SigningWalletAdapter, EIP3009Params, EIP3009Authorization } from 'uvd-x402-sdk';

class MyAdapter implements SigningWalletAdapter {
  getAddress(): string { /* ... */ }
  async signMessage(message: string): Promise<string> { /* ... */ }
  async signTypedData(typedData: string): Promise<{ signature: string; v: number; r: string; s: string }> { /* ... */ }
  async signEIP3009(params: EIP3009Params): Promise<EIP3009Authorization> { /* ... */ }
}
```

## Multi-Stablecoin (EVM)

```typescript
// Pay with EURC instead of USDC
const result = await client.createPayment({
  recipient: '0x...',
  amount: '10.00',
  tokenType: 'eurc', // 'usdc' | 'eurc' | 'ausd' | 'pyusd' | 'usdt'
});

// Check token availability
import { getSupportedTokens, isTokenSupported } from 'uvd-x402-sdk';

getSupportedTokens('ethereum'); // ['usdc', 'eurc', 'ausd', 'pyusd']
getSupportedTokens('base');     // ['usdc', 'eurc']
isTokenSupported('base', 'eurc'); // true
```

## AUSD on Solana (Token2022)

```typescript
import { SVMProvider } from 'uvd-x402-sdk/solana';
import { getChainByName } from 'uvd-x402-sdk';

const svm = new SVMProvider();
const chainConfig = getChainByName('solana')!;

// AUSD uses Token2022 program
const payload = await svm.signPayment({
  recipient: '5Y32Dk...',
  amount: '10.00',
  token: 'ausd', // Token2022 AUSD
}, chainConfig);

const header = svm.encodePaymentHeader(payload, chainConfig);
```

## Supported Networks

### EVM (13)

| Network | Chain ID | Tokens |
|---------|----------|--------|
| Base | 8453 | USDC, EURC |
| Ethereum | 1 | USDC, EURC, AUSD, PYUSD, USDT |
| Polygon | 137 | USDC, AUSD |
| Arbitrum | 42161 | USDC, AUSD, USDT |
| Optimism | 10 | USDC, USDT |
| Avalanche | 43114 | USDC, EURC, AUSD |
| Celo | 42220 | USDC, USDT |
| HyperEVM | 999 | USDC |
| Unichain | 130 | USDC |
| Monad | 143 | USDC, AUSD |
| Scroll | 534352 | USDC |
| SKALE Base | 1187947933 | USDC.e |
| SKALE Base Sepolia | 324705682 | USDC.e |

### SVM (2)

| Network | Tokens | Wallet |
|---------|--------|--------|
| Solana | USDC, AUSD | Phantom |
| Fogo | USDC | Phantom |

### Algorand

| Network | USDC ASA | Wallet |
|---------|----------|--------|
| Algorand | 31566704 | Lute, Pera |

### Sui

| Network | Tokens | Wallet |
|---------|--------|--------|
| Sui | USDC, AUSD | Sui Wallet |

### Other

| Network | Wallet |
|---------|--------|
| Stellar | Freighter |
| NEAR | MyNearWallet |

## Facilitator Addresses

The SDK includes built-in facilitator addresses. You don't need to configure them.

```typescript
import { FACILITATOR_ADDRESSES, getFacilitatorAddress } from 'uvd-x402-sdk';

// Built-in addresses
FACILITATOR_ADDRESSES.evm;      // 0x103040545AC5031A11E8C03dd11324C7333a13C7
FACILITATOR_ADDRESSES.solana;   // F742C4VfFLQ9zRQyithoj5229ZgtX2WqKCSFKgH2EThq
FACILITATOR_ADDRESSES.algorand; // KIMS5H6QLCUDL65L5UBTOXDPWLMTS7N3AAC3I6B2NCONEI5QIVK7LH2C2I
FACILITATOR_ADDRESSES.stellar;  // GCHPGXJT2WFFRFCA5TV4G4E3PMMXLNIDUH27PKDYA4QJ2XGYZWGFZNHB
FACILITATOR_ADDRESSES.near;     // uvd-facilitator.near
FACILITATOR_ADDRESSES.sui;      // 0xe7bbf2b13f7d72714760aa16e024fa1b35a978793f9893d0568a4fbf356a764a

// Or get by chain name
getFacilitatorAddress('algorand'); // KIMS5H6...
getFacilitatorAddress('base', 'evm'); // 0x1030...
getFacilitatorAddress('sui'); // 0xe7bbf...
```

## Backend

```typescript
import {
  FacilitatorClient,
  create402Response,
  extractPaymentFromHeaders,
  buildPaymentRequirements,
} from 'uvd-x402-sdk/backend';

// Return 402 if no payment
app.post('/api/premium', async (req, res) => {
  const payment = extractPaymentFromHeaders(req.headers);

  if (!payment) {
    const { status, headers, body } = create402Response({
      amount: '1.00',
      recipient: process.env.RECIPIENT,
      resource: 'https://api.example.com/premium',
      chainName: 'base',
    });
    return res.status(status).set(headers).json(body);
  }

  // Verify first, then settle when you're ready to fulfill the request
  const client = new FacilitatorClient();
  const requirements = buildPaymentRequirements({
    amount: '1.00',
    recipient: process.env.RECIPIENT,
    resource: 'https://api.example.com/premium',
    chainName: 'base',
    x402Version: payment.x402Version,
  });

  const verifyResult = await client.verify(payment, requirements);
  if (!verifyResult.isValid) {
    return res.status(402).json({ error: verifyResult.invalidReason });
  }

  const settleResult = await client.settle(payment, requirements);
  if (!settleResult.success) {
    return res.status(500).json({ error: settleResult.error });
  }

  res.json({ data: 'premium content', txHash: settleResult.transactionHash });
});
```

`createPaymentMiddleware()` and `createHonoMiddleware()` verify and settle automatically by default (`before-handler`). Use `settlementStrategy: 'manual'` if you need to control when settlement happens (e.g., settle only after confirming you can fulfill the request).

## React

```tsx
import { X402Provider, useX402, usePayment } from 'uvd-x402-sdk/react';

function App() {
  return (
    <X402Provider config={{ defaultChain: 'base' }}>
      <PaymentPage />
    </X402Provider>
  );
}

function PaymentPage() {
  const { connect, isConnected, address } = useX402();
  const { pay, isPaying } = usePayment();

  if (!isConnected) {
    return <button onClick={() => connect('base')}>Connect</button>;
  }

  return (
    <button onClick={() => pay({ recipient: '0x...', amount: '10.00' })} disabled={isPaying}>
      {isPaying ? 'Processing...' : 'Pay $10'}
    </button>
  );
}
```

## Error Handling

```typescript
import { X402Error } from 'uvd-x402-sdk';

try {
  await client.createPayment(paymentInfo);
} catch (error) {
  if (error instanceof X402Error) {
    switch (error.code) {
      case 'WALLET_NOT_FOUND': // Install wallet
      case 'WALLET_CONNECTION_REJECTED': // User rejected
      case 'INSUFFICIENT_BALANCE': // Not enough USDC
      case 'SIGNATURE_REJECTED': // User cancelled
      case 'CHAIN_NOT_SUPPORTED': // Unsupported network
    }
  }
}
```

## ERC-8004 Trustless Agents

Build verifiable on-chain reputation for AI agents and services. Supports **20 networks** (18 EVM + 2 Solana).

On EVM networks, agent IDs are sequential numbers. On Solana, agent IDs are base58 pubkey strings. The `AgentId` type (`number | string`) handles both.

### EVM Networks (18)

ethereum, base-mainnet, polygon, arbitrum, optimism, celo, bsc, monad, avalanche, skale-base, ethereum-sepolia, base-sepolia, polygon-amoy, arbitrum-sepolia, optimism-sepolia, celo-sepolia, avalanche-fuji, skale-base-sepolia

### Solana Networks (2)

solana, solana-devnet

### Usage

```typescript
import { Erc8004Client, AgentId } from 'uvd-x402-sdk/backend';

const erc8004 = new Erc8004Client();

// EVM: agent ID is a number
const identity = await erc8004.getIdentity('ethereum', 42);
console.log(identity.agentUri);

// Solana: agent ID is a base58 pubkey string
const solIdentity = await erc8004.getIdentity('solana', '8oo4dC4JvBLwy5...');
console.log(solIdentity.agentUri);

// Look up agent by wallet owner address
const byOwner = await erc8004.getIdentityByOwner('base-mainnet', '0xOwnerAddress...');
console.log(byOwner.agentId, byOwner.identity.agentUri);

// Get agent reputation
const reputation = await erc8004.getReputation('ethereum', 42);
console.log(`Score: ${reputation.summary.summaryValue}`);

// Submit feedback after payment
const result = await erc8004.submitFeedback({
  x402Version: 1,
  network: 'ethereum',
  feedback: {
    agentId: 42,
    value: 95,
    valueDecimals: 0,
    tag1: 'quality',
    proof: settleResponse.proofOfPayment,
  },
});

// Respond to feedback (agents only)
// sealHash is required for Solana, optional for EVM
await erc8004.appendResponse('ethereum', 42, 1, 'Thank you for your feedback!');
```

## `/accepts` Negotiation

Discover what the facilitator can settle before constructing payment authorizations. Used by Faremeter middleware and clients.

```typescript
import { FacilitatorClient } from 'uvd-x402-sdk/backend';

const client = new FacilitatorClient();

// Ask facilitator what it can settle
const enriched = await client.accepts([
  {
    scheme: 'exact',
    network: 'base-mainnet',
    maxAmountRequired: '1000000',
    resource: 'https://api.example.com/data',
    payTo: '0xMerchant...',
  },
]);
// enriched[0].extra now has feePayer, tokens, escrow config
```

## Escrow & Refunds

Hold payments in escrow with dispute resolution.

```typescript
import { EscrowClient } from 'uvd-x402-sdk/backend';

const escrow = new EscrowClient();

// Create escrow payment
const escrowPayment = await escrow.createEscrow({
  paymentHeader: req.headers['x-payment'],
  requirements: paymentRequirements,
  escrowDuration: 86400, // 24 hours
});

// Release after service delivery
await escrow.release(escrowPayment.id);

// Or request refund if service failed
await escrow.requestRefund({
  escrowId: escrowPayment.id,
  reason: 'Service not delivered',
});

// Query on-chain escrow state
const state = await escrow.getEscrowState({
  network: 'base-mainnet',
  payer: '0xPayer...',
  recipient: '0xRecipient...',
  nonce: '0x1234...',
});
```

## Advanced Escrow (AdvancedEscrowClient)

Full escrow lifecycle management for EVM chains. Supports both `ethers.Signer` and `SigningWalletAdapter` (EnvKey, OWS) for signing.

Supported on 10 EVM networks: Base, Base Sepolia, Ethereum, Ethereum Sepolia, Polygon, Arbitrum, Optimism, Celo, Monad, Avalanche.

### With Private Key (ethers.Signer)

```typescript
import { AdvancedEscrowClient } from 'uvd-x402-sdk/backend';

const client = new AdvancedEscrowClient(process.env.PRIVATE_KEY!, {
  chainId: 8453, // Base
});
await client.init();

// Build payment info
const paymentInfo = client.buildPaymentInfo(
  '0xWorkerAddress...', // receiver
  '5000000',           // amount in atomic units ($5.00 USDC)
  'standard',          // tier: 'standard' | 'express' | 'premium'
);

// Authorize: lock funds in escrow
const auth = await client.authorize(paymentInfo);

// Release: capture escrowed funds to receiver
await client.release(paymentInfo);

// Or refund: return escrowed funds to payer
await client.refundInEscrow(paymentInfo);

// Query escrow state on-chain
const state = await client.queryEscrowState(paymentInfo);
```

### With SigningWalletAdapter (OWS)

```typescript
import { AdvancedEscrowClient } from 'uvd-x402-sdk/backend';
import { OWSWalletAdapter } from 'uvd-x402-sdk';

const wallet = new OWSWalletAdapter(owsWalletInstance);
const client = new AdvancedEscrowClient(null, {
  wallet,
  rpcUrl: 'https://mainnet.base.org',
  chainId: 8453,
});
await client.init();

const paymentInfo = client.buildPaymentInfo('0xWorker...', '5000000', 'standard');
const auth = await client.authorize(paymentInfo);
```

### Gasless Operations via Facilitator

Release and refund can be executed through the facilitator (no gas required):

```typescript
// Gasless release
await client.releaseViaFacilitator(paymentInfo);

// Gasless refund
await client.refundViaFacilitator(paymentInfo);
```

### Direct Charge (No Escrow)

```typescript
// Instant payment without escrow hold
await client.charge(paymentInfo);
```

## Commerce Scheme

The `'commerce'` scheme is a semantic alias for `'escrow'`, introduced for marketplace integrations (Execution Market, arbiter workflows). It uses the same contracts, ABI, and ERC-3009 flow as `'escrow'`.

```typescript
import type { X402Scheme } from 'uvd-x402-sdk';

// All three schemes are valid
const scheme: X402Scheme = 'commerce'; // or 'exact' or 'escrow'

// PaymentRequirements and X402 headers accept all schemes
const header = {
  x402Version: 2,
  scheme: 'commerce',
  network: 'eip155:8453',
  payload: { /* ... */ },
};

// Default behavior unchanged: buildPaymentRequirements() defaults to 'exact'
```

The facilitator's `/supported` endpoint advertises both `'escrow'` and `'commerce'` entries for all 11 escrow-capable networks (14 entries each).

## Bazaar Discovery

Register and discover paid x402 resources across the network.

```typescript
import { BazaarClient } from 'uvd-x402-sdk/backend';

const bazaar = new BazaarClient({ apiKey: 'your-api-key' });

// Discover resources
const results = await bazaar.discover({
  category: 'ai',
  network: 'base',
  maxPrice: '0.10',
});

for (const resource of results.resources) {
  console.log(`${resource.name}: ${resource.url}`);
}

// Register a resource
const resource = await bazaar.register({
  url: 'https://api.example.com/v1/generate',
  name: 'Image Generator API',
  description: 'Generate images with AI',
  category: 'ai',
  networks: ['base', 'ethereum'],
  price: '0.05',
  payTo: '0x1234...',
});
```

## Facilitator Info

Query the facilitator for version, supported networks, and compliance data.

```typescript
import { FacilitatorClient } from 'uvd-x402-sdk/backend';

const client = new FacilitatorClient();

// Check version
const { version } = await client.getVersion();
console.log(`Facilitator: v${version}`);

// List supported networks
const supported = await client.getSupported();
for (const kind of supported.kinds) {
  console.log(`  ${kind.network} - ${kind.scheme}`);
}

// Check blacklist
const bl = await client.getBlacklist();
console.log(`Blocked addresses: ${bl.totalBlocked}`);

// Health check
const isHealthy = await client.healthCheck();
```

## Links

- [x402 Protocol](https://x402.org)
- [Ultravioleta DAO](https://ultravioletadao.xyz)
- [npm](https://www.npmjs.com/package/uvd-x402-sdk)
- [GitHub](https://github.com/UltravioletaDAO/uvd-x402-sdk-typescript)

## License

MIT
