# uvd-x402-sdk

Gasless crypto payments across 16 blockchain networks using the x402 protocol.

Users sign a message or transaction, and the Ultravioleta facilitator handles on-chain settlement. No gas fees for users.

## Features

- **16 Networks**: EVM (10), Solana, Fogo, Stellar, NEAR, Algorand (2)
- **Multi-Stablecoin**: USDC, EURC, AUSD, PYUSD, USDT
- **x402 v1 & v2**: Both protocol versions with auto-detection
- **Gasless**: Facilitator pays all network fees
- **Type-Safe**: Full TypeScript support
- **React & Wagmi**: First-class integrations

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
```

## Quick Start

### EVM Chains

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

### EVM (10)

| Network | Chain ID | Tokens |
|---------|----------|--------|
| Base | 8453 | USDC, EURC |
| Ethereum | 1 | USDC, EURC, AUSD, PYUSD, USDT |
| Polygon | 137 | USDC, AUSD |
| Arbitrum | 42161 | USDC, AUSD, USDT |
| Optimism | 10 | USDC |
| Avalanche | 43114 | USDC, EURC, AUSD |
| Celo | 42220 | USDC |
| HyperEVM | 999 | USDC |
| Unichain | 130 | USDC |
| Monad | 143 | USDC, AUSD |

### SVM (2)

| Network | Tokens | Wallet |
|---------|--------|--------|
| Solana | USDC, AUSD | Phantom |
| Fogo | USDC | Phantom |

### Algorand (2)

| Network | USDC ASA | Wallet |
|---------|----------|--------|
| Algorand | 31566704 | Lute, Pera |
| Algorand Testnet | 10458941 | Lute, Pera |

### Other (2)

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

// Or get by chain name
getFacilitatorAddress('algorand'); // KIMS5H6...
getFacilitatorAddress('base', 'evm'); // 0x1030...
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

  // Verify and settle
  const client = new FacilitatorClient();
  const requirements = buildPaymentRequirements({
    amount: '1.00',
    recipient: process.env.RECIPIENT,
  });

  const result = await client.verifyAndSettle(payment, requirements);

  if (!result.verified) {
    return res.status(402).json({ error: result.error });
  }

  res.json({ data: 'premium content', txHash: result.transactionHash });
});
```

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

## Links

- [x402 Protocol](https://x402.org)
- [Ultravioleta DAO](https://ultravioletadao.xyz)
- [npm](https://www.npmjs.com/package/uvd-x402-sdk)
- [GitHub](https://github.com/UltravioletaDAO/uvd-x402-sdk-typescript)

## License

MIT
