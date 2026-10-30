import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { getChainByName, getChainsByNetworkType, getSupportedTokens, getTokenConfig } from './chains';
import { X402Client } from './client/X402Client';
import { EVMProvider } from './providers/evm';
import { decodeX402Header } from './utils/x402';

// USDT does not carry the same EIP-712 name on every chain: name() is "USD₮0"
// (U+20AE) on Arbitrum and Optimism, plain "USDT0" on Monad and "Tether USD"
// on Celo. An authorization signed under the wrong name is one the contract
// rejects. The last column is a name the signature must not verify under.
//
// Each row was read from the contract itself, by eth_call to name() and
// DOMAIN_SEPARATOR() on 2026-10-30, at the RPC and block named. The separator
// is the hash of exactly (name, version, chainId, address), so only the name
// the contract has hashes to it. Same method as src/eurc-domains.test.ts.
const MEASURED = [
  // https://arb1.arbitrum.io/rpc, block 519694682
  ['arbitrum', 42161, '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 'USD₮0', '1',
    '566af68fb471b22d6421762f84aa7bd761c670a2e4d5c8a47d4085d5957b127c', 'USDT0'],
  // https://mainnet.optimism.io, block 158884736
  ['optimism', 10, '0x01bff41798a0bcf287b996046ca68b395dbc1071', 'USD₮0', '1',
    'd5d99c075f21e38eddc66fa99b98beae156454110a618179d962c413a942762c', 'USDT0'],
  // https://rpc.monad.xyz, block 117914684
  ['monad', 143, '0xe7cd86e13AC4309349F30B3435a9d337750fC82D', 'USDT0', '1',
    '101a90213d0b0d9d607fe3b94dcb41e91f20ab1432d4cd23ae9f820c0968452a', 'USD\u20AE0'],
  // https://forno.celo.org, block 81467491
  ['celo', 42220, '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', 'Tether USD', '1',
    'bcb4d62e4834b598d0eacecd84c0b397a0254e077c41cf2143e394d5701d1088', 'USDT0'],
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
    { recipient: wallet.address, amount: '0.01', tokenType: 'usdt' }, getChainByName(network)!));
  return { signer: wallet.address, message, signature: ethers.Signature.from({ v, r, s }).serialized };
}

async function viaClient(network: string): Promise<Signed> {
  const wallet = ethers.Wallet.createRandom();
  const client = new X402Client({ defaultChain: network });
  await client.connectWithPrivateKey(wallet.privateKey, network);
  const { paymentHeader } = await client.createPayment(
    { recipient: wallet.address, amount: '0.01', tokenType: 'usdt' });
  const { payload } = decodeX402Header(paymentHeader) as {
    payload: { authorization: Record<string, unknown>; signature: string } };
  return { signer: wallet.address, message: payload.authorization, signature: payload.signature };
}

describe.each(MEASURED)('USDT on %s', (network, chainId, address, name, version, separator, other) => {
  it('the registry carries the measured domain, and it hashes to DOMAIN_SEPARATOR()', () => {
    const chain = getChainByName(network)!;
    const token = getTokenConfig(network, 'usdt')!;
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

it('every enabled EVM chain with USDT is pinned here', () => {
  const measured = new Set<string>(MEASURED.map(([network]) => network));
  const withUsdt = getChainsByNetworkType('evm').filter((chain) => getSupportedTokens(chain.name).includes('usdt'));
  for (const chain of withUsdt) {
    expect(measured.has(chain.name), `USDT on ${chain.name} is pinned nowhere`).toBe(true);
  }
});
