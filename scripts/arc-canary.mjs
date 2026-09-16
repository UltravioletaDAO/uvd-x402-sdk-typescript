/** Operator acceptance helper. Reads {network, protocol, private_key, recipient}
 * from stdin, verifies and settles ONE micro-USDC. --execute is mandatory.
 * Keys stay in memory. Reconcile any uncertain result before running again.
 * The injected EIP-1193 wallet exercises the public EVMProvider connection API.
 */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { Wallet } from 'ethers';
import { getChainByName } from '../dist/index.mjs';
import { EVMProvider } from '../dist/providers/evm/index.mjs';
import { FacilitatorClient, buildPaymentRequirements, parsePaymentHeader } from '../dist/backend/index.mjs';

try {
  if (!process.argv.includes('--execute')) throw new Error('Explicit --execute required');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (!['arc', 'arc-testnet'].includes(input.network) || ![1, 2].includes(input.protocol)) {
    throw new Error('Unsupported canary network or protocol');
  }
  const chain = getChainByName(input.network);
  const wallet = new Wallet(input.private_key);
  delete input.private_key;
  globalThis.window = {
    crypto: webcrypto,
    ethereum: { async request({ method, params }) {
      if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [wallet.address];
      if (method === 'eth_chainId') return chain.chainIdHex;
      if (method === 'wallet_switchEthereumChain' && params[0].chainId === chain.chainIdHex) return null;
      if (method === 'eth_signTypedData_v4') {
        const { domain, types, message } = JSON.parse(params[1]);
        delete types.EIP712Domain;
        return wallet.signTypedData(domain, types, message);
      }
      throw new Error('Unexpected wallet method');
    } },
  };
  const provider = new EVMProvider();
  await provider.connect(input.network);
  const signed = await provider.signPayment({ recipient: input.recipient, amount: '0.000001' }, chain);
  if (JSON.parse(signed).value !== '1') throw new Error('Wrong atomic amount');
  const payment = parsePaymentHeader(provider.encodePaymentHeader(signed, chain, input.protocol));
  const requirements = buildPaymentRequirements({
    chainName: input.network, x402Version: input.protocol,
    recipient: input.recipient, amount: '0.000001', resource: 'https://example.com/arc-sdk-canary',
  });
  const client = new FacilitatorClient({ x402Version: input.protocol, timeout: 55000, retries: 0 });
  const verified = await client.verify(payment, requirements);
  if (!verified.isValid) {
    console.log(JSON.stringify({ stage: 'verify', network: input.network, result: verified }));
    throw new Error('Verify refused; no settle requested');
  }
  console.log(JSON.stringify({ stage: 'settle_requested', network: input.network,
    nonce: JSON.parse(signed).nonce, protocol: input.protocol }));
  const result = await client.settle(payment, requirements);
  console.log(JSON.stringify({ stage: 'settled', network: input.network, protocol: input.protocol, result }));
  if (!result.success || !result.transactionHash) throw new Error('Reconcile uncertain settle');
  const replay = await client.settle(payment, requirements);
  console.log(JSON.stringify({ stage: 'replay', network: input.network, result: replay }));
  if (replay.success && replay.transactionHash !== result.transactionHash) throw new Error('Different replay transaction');
  await provider.disconnect();
} catch {
  // SDK exceptions may contain input context; never print them with a live key.
  console.error('Arc canary stopped. Inspect the public stage/nonce/hash above; do not automatically retry.');
  process.exitCode = 1;
}
