# uvd-x402-sdk

> Gasless crypto payments across 15 blockchain networks using the x402 protocol.

The x402 SDK enables any application to accept USDC payments without requiring users to pay gas fees. Users sign a message or transaction, and the Ultravioleta facilitator handles on-chain settlement.

## Features

- **15 Supported Networks**: EVM chains, Solana, Fogo, Stellar, and NEAR
- **x402 v1 & v2**: Full support for both protocol versions with automatic detection
- **Gasless Payments**: Users never pay gas - the facilitator covers all network fees
- **Multi-Network**: Accept payments on multiple networks simultaneously
- **Type-Safe**: Comprehensive TypeScript definitions
- **Framework Agnostic**: Works with any JavaScript framework
- **React Hooks**: First-class React integration
- **Modular**: Import only what you need

## Quick Start

```typescript
import { X402Client } from 'uvd-x402-sdk';

const client = new X402Client({ defaultChain: 'base' });

// Connect wallet
const address = await client.connect('base');

// Create payment
const result = await client.createPayment({
  recipient: '0x...',
  amount: '10.00',
});

// Use in your API request
await fetch('/api/purchase', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-PAYMENT': result.paymentHeader,
  },
  body: JSON.stringify({ item: 'premium-feature' }),
});
```

## Installation

```bash
npm install uvd-x402-sdk
```

### Peer Dependencies by Network

```bash
# EVM chains (Base, Ethereum, etc.) - included by default
npm install ethers@^6

# Solana & Fogo (SVM chains)
npm install @solana/web3.js @solana/spl-token

# Stellar
npm install @stellar/stellar-sdk @stellar/freighter-api

# NEAR
npm install @near-wallet-selector/core @near-wallet-selector/my-near-wallet

# React hooks (optional)
npm install react
```

---

## Network Examples

### EVM Chains (11 Networks)

All EVM chains use EIP-712 typed data signing with ERC-3009 TransferWithAuthorization.

#### Base (Recommended - Fastest & Cheapest)

```typescript
import { X402Client } from 'uvd-x402-sdk';

const client = new X402Client({ defaultChain: 'base' });

// Connect to Base
const address = await client.connect('base');
console.log('Connected:', address);

// Check balance
const balance = await client.getBalance();
console.log('USDC Balance:', balance);

// Create payment
const result = await client.createPayment({
  recipient: '0xD3868E1eD738CED6945A574a7c769433BeD5d474',
  amount: '10.00',
});

console.log('Payment header:', result.paymentHeader);
```

#### Ethereum

```typescript
import { X402Client } from 'uvd-x402-sdk';

const client = new X402Client({ defaultChain: 'ethereum' });
const address = await client.connect('ethereum');

const result = await client.createPayment({
  recipient: '0xD3868E1eD738CED6945A574a7c769433BeD5d474',
  amount: '100.00', // Higher amounts common on Ethereum
});
```

#### Polygon

```typescript
import { X402Client } from 'uvd-x402-sdk';

const client = new X402Client({ defaultChain: 'polygon' });
const address = await client.connect('polygon');

const result = await client.createPayment({
  recipient: '0xD3868E1eD738CED6945A574a7c769433BeD5d474',
  amount: '10.00',
});
```

#### Arbitrum

```typescript
import { X402Client } from 'uvd-x402-sdk';

const client = new X402Client({ defaultChain: 'arbitrum' });
const address = await client.connect('arbitrum');

const result = await client.createPayment({
  recipient: '0xD3868E1eD738CED6945A574a7c769433BeD5d474',
  amount: '10.00',
});
```

#### Optimism

```typescript
import { X402Client } from 'uvd-x402-sdk';

const client = new X402Client({ defaultChain: 'optimism' });
const address = await client.connect('optimism');

const result = await client.createPayment({
  recipient: '0xD3868E1eD738CED6945A574a7c769433BeD5d474',
  amount: '10.00',
});
```

#### Avalanche C-Chain

```typescript
import { X402Client } from 'uvd-x402-sdk';

const client = new X402Client({ defaultChain: 'avalanche' });
const address = await client.connect('avalanche');

const result = await client.createPayment({
  recipient: '0xD3868E1eD738CED6945A574a7c769433BeD5d474',
  amount: '10.00',
});
```

#### Celo

```typescript
import { X402Client } from 'uvd-x402-sdk';

const client = new X402Client({ defaultChain: 'celo' });
const address = await client.connect('celo');

const result = await client.createPayment({
  recipient: '0xD3868E1eD738CED6945A574a7c769433BeD5d474',
  amount: '10.00',
});
```

#### HyperEVM

```typescript
import { X402Client } from 'uvd-x402-sdk';

const client = new X402Client({ defaultChain: 'hyperevm' });
const address = await client.connect('hyperevm');

const result = await client.createPayment({
  recipient: '0xD3868E1eD738CED6945A574a7c769433BeD5d474',
  amount: '10.00',
});
```

#### Unichain

```typescript
import { X402Client } from 'uvd-x402-sdk';

const client = new X402Client({ defaultChain: 'unichain' });
const address = await client.connect('unichain');

const result = await client.createPayment({
  recipient: '0xD3868E1eD738CED6945A574a7c769433BeD5d474',
  amount: '10.00',
});
```

#### Monad

```typescript
import { X402Client } from 'uvd-x402-sdk';

const client = new X402Client({ defaultChain: 'monad' });
const address = await client.connect('monad');

const result = await client.createPayment({
  recipient: '0xD3868E1eD738CED6945A574a7c769433BeD5d474',
  amount: '10.00',
});
```

---

### SVM Chains (Solana Virtual Machine)

SVM chains use partially-signed transactions where the facilitator is the fee payer.

#### Solana

```typescript
import { SVMProvider } from 'uvd-x402-sdk/solana';
import { getChainByName } from 'uvd-x402-sdk';

const svm = new SVMProvider();

// Check if Phantom is installed
if (!svm.isAvailable()) {
  throw new Error('Please install Phantom wallet from phantom.app');
}

// Connect
const address = await svm.connect();
console.log('Connected Solana wallet:', address);

// Get chain config
const chainConfig = getChainByName('solana')!;

// Get balance
const balance = await svm.getBalance(chainConfig);
console.log('USDC Balance:', balance);

// Create payment
const paymentPayload = await svm.signPayment(
  {
    recipient: '5Y32Dk6weq1LrMRdujpJyDbTN3SjwXGoQS9QN39WQ9Cq',
    amount: '10.00',
    facilitator: 'F742C4VfFLQ9zRQyithoj5229ZgtX2WqKCSFKgH2EThq',
  },
  chainConfig
);

// Encode as X-PAYMENT header
const header = svm.encodePaymentHeader(paymentPayload, chainConfig);
console.log('Payment header:', header);
```

#### Fogo

Fogo is an SVM chain with ultra-fast ~400ms finality.

```typescript
import { SVMProvider } from 'uvd-x402-sdk/solana';
import { getChainByName } from 'uvd-x402-sdk';

const svm = new SVMProvider();

// Connect (same wallet works for all SVM chains)
const address = await svm.connect();

// Get Fogo chain config
const chainConfig = getChainByName('fogo')!;

// Get balance on Fogo
const balance = await svm.getBalance(chainConfig);
console.log('Fogo USDC Balance:', balance);

// Create Fogo payment
const paymentPayload = await svm.signPayment(
  {
    recipient: '5Y32Dk6weq1LrMRdujpJyDbTN3SjwXGoQS9QN39WQ9Cq',
    amount: '10.00',
    facilitator: 'F742C4VfFLQ9zRQyithoj5229ZgtX2WqKCSFKgH2EThq',
  },
  chainConfig
);

// Encode with correct network name ('fogo')
const header = svm.encodePaymentHeader(paymentPayload, chainConfig);
console.log('Fogo payment header:', header);
```

---

### Stellar

Stellar uses Soroban authorization entries for gasless transfers.

```typescript
import { StellarProvider } from 'uvd-x402-sdk/stellar';
import { getChainByName } from 'uvd-x402-sdk';

const stellar = new StellarProvider();

// Check if Freighter is installed
if (!stellar.isAvailable()) {
  throw new Error('Please install Freighter wallet from freighter.app');
}

// Connect
const address = await stellar.connect();
console.log('Connected Stellar wallet:', address);

// Get chain config
const chainConfig = getChainByName('stellar')!;

// Get balance
const balance = await stellar.getBalance(chainConfig);
console.log('USDC Balance:', balance);

// Create payment
const paymentPayload = await stellar.signPayment(
  {
    recipient: 'GD3FWQ4QFSCO2F2KVXZPQWOC27CQHXHYCRCRRZBMWU3DNOZW2IIGOU54',
    amount: '10.00',
  },
  chainConfig
);

// Encode as X-PAYMENT header
const header = stellar.encodePaymentHeader(paymentPayload);
console.log('Payment header:', header);
```

---

### NEAR Protocol

NEAR uses NEP-366 meta-transactions where the facilitator pays all gas.

```typescript
import { NEARProvider } from 'uvd-x402-sdk/near';
import { getChainByName } from 'uvd-x402-sdk';

const near = new NEARProvider();

// Check if NEAR wallet is available
if (!near.isAvailable()) {
  throw new Error('Please install MyNearWallet or Meteor wallet');
}

// Connect
const accountId = await near.connect();
console.log('Connected NEAR account:', accountId);

// Get chain config
const chainConfig = getChainByName('near')!;

// Get balance
const balance = await near.getBalance(chainConfig);
console.log('USDC Balance:', balance);

// Create payment
const paymentPayload = await near.signPayment(
  {
    recipient: '0xultravioleta.near',
    amount: '10.00',
  },
  chainConfig
);

// Encode as X-PAYMENT header
const header = near.encodePaymentHeader(paymentPayload);
console.log('Payment header:', header);
```

---

## x402 Protocol Versions

The SDK supports both x402 v1 and v2 protocols.

### v1 (Default)

```typescript
// v1 uses simple network names
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "base",
  "payload": { ... }
}
```

### v2 (CAIP-2)

```typescript
// v2 uses CAIP-2 chain identifiers
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "eip155:8453",
  "payload": { ... },
  "accepts": [
    { "network": "eip155:8453", "asset": "0x833...", "amount": "10000000" },
    { "network": "solana:5eykt...", "asset": "EPjF...", "amount": "10000000" }
  ]
}
```

### Version Detection and Conversion

```typescript
import {
  detectX402Version,
  chainToCAIP2,
  caip2ToChain,
  convertX402Header,
} from 'uvd-x402-sdk';

// Detect version from response
const version = detectX402Version(response402);
// Returns: 1 or 2

// Convert between formats
const caip2 = chainToCAIP2('base');
// Returns: 'eip155:8453'

const chainName = caip2ToChain('eip155:8453');
// Returns: 'base'

// Convert headers between versions
const v2Header = convertX402Header(v1Header, 2);
```

### Configure Version

```typescript
const client = new X402Client({
  defaultChain: 'base',
  x402Version: 2, // Force v2 format
  // or
  x402Version: 'auto', // Auto-detect from 402 response (default)
});
```

---

## Multi-Payment Support

Accept payments on multiple networks simultaneously.

### Configuration

```typescript
const client = new X402Client({
  defaultChain: 'base',
  multiPayment: {
    networks: ['base', 'solana', 'stellar', 'near'],
    defaultNetwork: 'base',
    autoDetect: true, // Auto-select based on user's wallet
  },
});
```

### Generate Payment Options

```typescript
import { generatePaymentOptions, getEnabledChains } from 'uvd-x402-sdk';

// Get all enabled chain configs
const chains = getEnabledChains();

// Generate v2 payment options
const options = generatePaymentOptions(chains, '10.00');

// Result:
// [
//   { network: 'eip155:8453', asset: '0x833...', amount: '10000000' },
//   { network: 'solana:5eykt...', asset: 'EPjF...', amount: '10000000' },
//   { network: 'stellar:pubnet', asset: 'CCW67...', amount: '100000000' },
//   { network: 'near:mainnet', asset: '17208...', amount: '10000000' },
// ]
```

---

## React Integration

```tsx
import { X402Provider, useX402, usePayment, useBalance } from 'uvd-x402-sdk/react';

function App() {
  return (
    <X402Provider config={{ defaultChain: 'base' }}>
      <PaymentPage />
    </X402Provider>
  );
}

function PaymentPage() {
  const { connect, disconnect, isConnected, address, network } = useX402();
  const { balance, isLoading: balanceLoading } = useBalance();
  const { pay, isPaying, error } = usePayment();

  const handlePurchase = async () => {
    const result = await pay({
      recipient: '0xD3868E1eD738CED6945A574a7c769433BeD5d474',
      amount: '10.00',
    });

    await fetch('/api/purchase', {
      headers: { 'X-PAYMENT': result.paymentHeader },
      method: 'POST',
      body: JSON.stringify({ item: 'premium' }),
    });
  };

  if (!isConnected) {
    return <button onClick={() => connect('base')}>Connect Wallet</button>;
  }

  return (
    <div>
      <p>Connected: {address}</p>
      <p>Network: {network}</p>
      <p>Balance: {balanceLoading ? 'Loading...' : `${balance} USDC`}</p>
      <button onClick={handlePurchase} disabled={isPaying}>
        {isPaying ? 'Processing...' : 'Pay $10 USDC'}
      </button>
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  );
}
```

---

## Supported Networks

### EVM Networks (11)

| Network | Chain ID | USDC Decimals | Status |
|---------|----------|---------------|--------|
| Base | 8453 | 6 | Enabled |
| Ethereum | 1 | 6 | Enabled |
| Polygon | 137 | 6 | Enabled |
| Arbitrum | 42161 | 6 | Enabled |
| Optimism | 10 | 6 | Enabled |
| Avalanche | 43114 | 6 | Enabled |
| Celo | 42220 | 6 | Enabled |
| HyperEVM | 999 | 6 | Enabled |
| Unichain | 130 | 6 | Enabled |
| Monad | 143 | 6 | Enabled |
| BSC | 56 | 18 | Disabled* |

*BSC USDC doesn't support ERC-3009 transferWithAuthorization

### SVM Networks (2)

| Network | USDC Mint | Decimals | Wallet | Status |
|---------|-----------|----------|--------|--------|
| Solana | EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v | 6 | Phantom | Enabled |
| Fogo | uSd2czE61Evaf76RNbq4KPpXnkiL3irdzgLFUMe3NoG | 6 | Phantom | Enabled |

### Other Networks (2)

| Network | USDC Address | Decimals | Wallet | Status |
|---------|--------------|----------|--------|--------|
| Stellar | CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75 | 7 | Freighter | Enabled |
| NEAR | 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 | 6 | MyNearWallet | Enabled |

---

## API Reference

### X402Client

```typescript
const client = new X402Client(config?: X402ClientConfig);

interface X402ClientConfig {
  facilitatorUrl?: string;      // Default: 'https://facilitator.ultravioletadao.xyz'
  defaultChain?: string;        // Default: 'base'
  autoConnect?: boolean;        // Default: false
  debug?: boolean;              // Default: false
  x402Version?: 1 | 2 | 'auto'; // Default: 'auto'
  customChains?: Record<string, Partial<ChainConfig>>;
  rpcOverrides?: Record<string, string>;
  multiPayment?: MultiPaymentConfig;
}
```

#### Methods

| Method | Description |
|--------|-------------|
| `connect(chainName?)` | Connect wallet to specified chain |
| `disconnect()` | Disconnect current wallet |
| `switchChain(chainName)` | Switch to different EVM chain |
| `createPayment(paymentInfo)` | Create payment authorization |
| `getBalance()` | Get USDC balance on current chain |
| `getState()` | Get current wallet state |
| `isConnected()` | Check if wallet is connected |
| `on(event, handler)` | Subscribe to events |

### Chain Utilities

```typescript
import {
  SUPPORTED_CHAINS,
  getChainByName,
  getChainById,
  getEnabledChains,
  getChainsByNetworkType,
  getSVMChains,
  isSVMChain,
  getExplorerTxUrl,
  getExplorerAddressUrl,
} from 'uvd-x402-sdk';
```

### x402 Utilities

```typescript
import {
  detectX402Version,
  chainToCAIP2,
  caip2ToChain,
  createX402V1Header,
  createX402V2Header,
  encodeX402Header,
  decodeX402Header,
  convertX402Header,
  generatePaymentOptions,
} from 'uvd-x402-sdk';
```

---

## Error Handling

```typescript
import { X402Error } from 'uvd-x402-sdk';

try {
  await client.createPayment(paymentInfo);
} catch (error) {
  if (error instanceof X402Error) {
    switch (error.code) {
      case 'WALLET_NOT_FOUND':
        alert('Please install a wallet');
        break;
      case 'WALLET_CONNECTION_REJECTED':
        alert('Connection cancelled');
        break;
      case 'INSUFFICIENT_BALANCE':
        alert('Not enough USDC');
        break;
      case 'SIGNATURE_REJECTED':
        alert('Payment cancelled');
        break;
      case 'CHAIN_NOT_SUPPORTED':
        alert('Network not supported');
        break;
      default:
        alert(error.message);
    }
  }
}
```

### Error Codes

| Code | Description |
|------|-------------|
| `WALLET_NOT_FOUND` | No compatible wallet detected |
| `WALLET_NOT_CONNECTED` | Wallet not connected |
| `WALLET_CONNECTION_REJECTED` | User rejected connection |
| `CHAIN_NOT_SUPPORTED` | Chain not supported |
| `CHAIN_SWITCH_REJECTED` | User rejected chain switch |
| `INSUFFICIENT_BALANCE` | Not enough USDC |
| `SIGNATURE_REJECTED` | User rejected signature |
| `PAYMENT_FAILED` | Payment processing failed |
| `NETWORK_ERROR` | Network request failed |
| `INVALID_CONFIG` | Invalid configuration |

---

## Troubleshooting

### Common Issues

#### "No Ethereum wallet found"

Install MetaMask or another EVM wallet. For mobile, use WalletConnect.

#### "Phantom wallet not installed"

Install Phantom from [phantom.app](https://phantom.app) for Solana/Fogo support.

#### "Freighter wallet not installed"

Install Freighter from [freighter.app](https://www.freighter.app) for Stellar support.

#### "No NEAR wallet found"

Install MyNearWallet or Meteor wallet for NEAR support.

#### "Chain not supported"

Check if the chain is enabled in `SUPPORTED_CHAINS`. BSC is disabled because its USDC doesn't support ERC-3009.

#### "Signature rejected by user"

User clicked "Reject" in their wallet. This is not an error - just user cancellation.

#### Wrong network in X-PAYMENT header

For SVM chains, always pass `chainConfig` to `encodePaymentHeader()`:

```typescript
// WRONG - will use 'solana' for Fogo
const header = svm.encodePaymentHeader(payload);

// CORRECT - uses 'fogo' for Fogo
const fogoConfig = getChainByName('fogo')!;
const header = svm.encodePaymentHeader(payload, fogoConfig);
```

### Debug Mode

Enable debug logging:

```typescript
const client = new X402Client({
  debug: true,
  defaultChain: 'base',
});
```

---

## Security

- Users NEVER pay gas or submit transactions directly
- EVM: Users sign EIP-712 structured messages only
- Solana/Fogo: Users sign partial transactions (USDC transfer instruction only)
- Stellar: Users sign Soroban authorization entries only
- NEAR: Users sign NEP-366 meta-transactions only
- The facilitator submits and pays for all transactions

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Links

- [x402 Protocol](https://x402.org)
- [Ultravioleta DAO](https://ultravioletadao.xyz)
- [402milly](https://402milly.xyz)
- [GitHub](https://github.com/UltravioletaDAO/uvd-x402-sdk-typescript)
- [npm](https://www.npmjs.com/package/uvd-x402-sdk)
