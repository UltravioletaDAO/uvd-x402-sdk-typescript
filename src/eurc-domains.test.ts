import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { getChainByName, getChainsByNetworkType, getSupportedTokens, getTokenConfig } from './chains';
import { X402Client } from './client/X402Client';
import { EVMProvider } from './providers/evm';
import { decodeX402Header } from './utils/x402';

// Circle did not give EURC the same EIP-712 name on every chain: name() is
// "Euro Coin" on Ethereum and Avalanche and "EURC" on Base. An authorization
// signed under the wrong name is one the contract rejects. Avalanche was signed
// as "EURC" here and as "Euro Coin" in the Python SDK until this test.
//
// Each row was read from the contract itself, by eth_call to name(), version()
// and DOMAIN_SEPARATOR() on 2026-10-10, at the RPC and block named. The
// separator is what settles it: it is the hash of exactly (name, version,
// chainId, address), so only the name the contract has hashes to it. These are
// FiatToken v2.2 proxies, which compute the separator from the stored name on
// every call: a later implementation that renamed the token would not turn this
// offline test red. The Python SDK pins the same rows
// (tests/test_eurc_domains.py). Arc's EURC is pinned by src/arc-eurc.test.ts.
const MEASURED = [
  // https://api.avax.network/ext/bc/C/rpc, block 97214492
  ['avalanche', 43114, '0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD', 'Euro Coin', '2',
    '094e957ad84a5711a2d13ea2ddcfe3947fe1704472f07bf8a49718f55a65f4b1'],
  // https://mainnet.base.org, block 52429544
  ['base', 8453, '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', 'EURC', '2',
    'ec4dcbded0afd42599589b79220899bbe000bb5ea66d6f1bc176e78d094203bb'],
  // https://ethereum-rpc.publicnode.com, block 26163122
  ['ethereum', 1, '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', 'Euro Coin', '2',
    '99f188f447f0c6eaf68589359cd2ead8c2faaaaee984ab926fdb734d0040073b'],
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
    { recipient: wallet.address, amount: '0.01', tokenType: 'eurc' }, getChainByName(network)!));
  return { signer: wallet.address, message, signature: ethers.Signature.from({ v, r, s }).serialized };
}

async function viaClient(network: string): Promise<Signed> {
  const wallet = ethers.Wallet.createRandom();
  const client = new X402Client({ defaultChain: network });
  await client.connectWithPrivateKey(wallet.privateKey, network);
  const { paymentHeader } = await client.createPayment(
    { recipient: wallet.address, amount: '0.01', tokenType: 'eurc' });
  const { payload } = decodeX402Header(paymentHeader) as {
    payload: { authorization: Record<string, unknown>; signature: string } };
  return { signer: wallet.address, message: payload.authorization, signature: payload.signature };
}

describe.each(MEASURED)('EURC on %s', (network, chainId, address, name, version, separator) => {
  it('the registry carries the measured domain, and it hashes to DOMAIN_SEPARATOR()', () => {
    const chain = getChainByName(network)!;
    const token = getTokenConfig(network, 'eurc')!;
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
    const other = name === 'EURC' ? 'Euro Coin' : 'EURC';
    expect(ethers.verifyTypedData({ ...domain, name: other }, TYPES, message, signature)).not.toBe(signer);
  });
});

it('every enabled EVM chain with EURC is pinned here or by a row of arc-eurc.test.ts', () => {
  const arcRows = readFileSync(resolve(__dirname, 'arc-eurc.test.ts'), 'utf8');
  const measured = new Set<string>(MEASURED.map(([network]) => network));
  const withEurc = getChainsByNetworkType('evm').filter((chain) => getSupportedTokens(chain.name).includes('eurc'));
  expect(withEurc.length).toBeGreaterThan(measured.size);
  for (const chain of withEurc) {
    if (measured.has(chain.name)) continue;
    const row = `['${chain.name}', ${chain.chainId}, '${getTokenConfig(chain.name, 'eurc')!.address}',`;
    expect(arcRows, `EURC on ${chain.name} is pinned nowhere`).toContain(row);
  }
});
