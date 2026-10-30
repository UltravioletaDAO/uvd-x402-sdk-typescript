import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { getChainByName, getChainById, getEnabledChains, getSupportedTokens, getTokenConfig, CAIP2_IDENTIFIERS, CAIP2_TO_CHAIN } from './index';
import { X402Client } from './client/X402Client';
import { EVMProvider } from './providers/evm';
import { decodeX402Header } from './utils/x402';

// Read-only eth_call on 2026-10-30; also pinned in x402-rs@38d67a47 hashkey_tests.
const MEASURED = [
  // https://mainnet.hsk.xyz, block 29510555
  ['hashkey', 177, '0x054ed45810DbBAb8B27668922D110669c9D88D0a', 'Bridged USDC', '2',
    '78101f50ab6b299bde76a9973e97b1c9ead7df26f6a40692f4440296a507259d', 'USD Coin'],
  // https://testnet.hsk.xyz, block 35090796
  ['hashkey-testnet', 133, '0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6', 'USD Coin', '2',
    '4b73b8fe157f795886e2aa243f2ccddcc00b80eaa9f9b4b368b716895be71d09', 'Bridged USDC'],
] as const;
const TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] };

interface Signed { signer: string; message: Record<string, unknown>; signature: string }

// The SDK has two EVM signers, and each builds its own domain from the registry.
async function viaProvider(network: string): Promise<Signed> {
  const wallet = ethers.Wallet.createRandom();
  const provider = new EVMProvider();
  Object.assign(provider, { signer: wallet, address: wallet.address });
  const { v, r, s, ...message } = JSON.parse(await provider.signPayment(
    { recipient: wallet.address, amount: '0.01', tokenType: 'usdc' }, getChainByName(network)!));
  return { signer: wallet.address, message, signature: ethers.Signature.from({ v, r, s }).serialized };
}

async function viaClient(network: string): Promise<Signed> {
  const wallet = ethers.Wallet.createRandom();
  const client = new X402Client({ defaultChain: network });
  await client.connectWithPrivateKey(wallet.privateKey, network);
  const { paymentHeader } = await client.createPayment(
    { recipient: wallet.address, amount: '0.01', tokenType: 'usdc' });
  const { payload } = decodeX402Header(paymentHeader) as {
    payload: { authorization: Record<string, unknown>; signature: string } };
  return { signer: wallet.address, message: payload.authorization, signature: payload.signature };
}

describe.each(MEASURED)('HashKey USDC on %s', (network, chainId, address, name, version, separator, other) => {
  it('the registry carries the measured domain, and it hashes to DOMAIN_SEPARATOR()', () => {
    const chain = getChainByName(network)!;
    const token = getTokenConfig(network, 'usdc')!;
    expect([chain.chainId, token.address, token.name, token.version]).toEqual([chainId, address, name, version]);
    const domain = { name: token.name, version: token.version, chainId, verifyingContract: token.address };
    expect(ethers.TypedDataEncoder.hashDomain(domain)).toBe(`0x${separator}`);
  });

  it.each([
    ['EVMProvider.signPayment', viaProvider],
    ['X402Client.createPayment', viaClient],
  ] as const)('%s signs under that domain and not under the other name', async (_path, sign) => {
    const { signer, message, signature } = await sign(network);
    const domain = { name, version, chainId, verifyingContract: address };
    expect(ethers.verifyTypedData(domain, TYPES, message, signature)).toBe(signer);
    expect(ethers.verifyTypedData({ ...domain, name: other }, TYPES, message, signature)).not.toBe(signer);
  });
});

describe.each(MEASURED)('%s registry and public exports', (network, chainId, address, name, version) => {
  it('registers the enabled EVM network and its CAIP-2 round trip', () => {
    const chain = getChainByName(network)!;
    expect(getChainByName(network.toUpperCase())).toBe(chain);
    expect(getChainById(chainId)).toBe(chain);
    expect(getEnabledChains()).toContain(chain);
    expect(chain.chainIdHex).toBe(`0x${chainId.toString(16)}`);
    expect(chain.networkType).toBe('evm');
    expect(chain.nativeCurrency).toEqual({ name: 'HashKey', symbol: 'HSK', decimals: 18 });
    expect(CAIP2_IDENTIFIERS[network]).toBe(`eip155:${chainId}`);
    expect(CAIP2_TO_CHAIN[`eip155:${chainId}`]).toBe(network);
    expect(getSupportedTokens(network)).toEqual(['usdc']);
    expect(getTokenConfig(network, 'usdt')).toBeUndefined();
    expect(chain.usdc).toEqual({ address, name, version, decimals: 6 });
    expect(getTokenConfig(network, 'usdc')).toEqual(chain.usdc);
  });
});
