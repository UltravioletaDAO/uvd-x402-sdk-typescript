import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { getChainByName, getTokenConfig, isUsdPegged } from './chains';
import { EVMProvider } from './providers/evm';
import { buildVerifyRequest, parsePaymentHeader, toPaymentRequirementsV2 } from './backend';

describe.each([
  ['arc', 5042, '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
    '25fe3beaae16ef5c1cb9757c6efc1bf33f81ecd4c7dae191320372013b7d2175'],
  ['arc-testnet', 5042002, '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    '649ec6b0634bd74f28684781d2c9ae49dff14ba3d5f9bb5d70c1e1f0e1ebf160'],
] as const)('EURC on %s (offline; live settlement pending)', (network, chainId, address, separator) => {
  it.each([1, 2] as const)('signs euro units and preserves the asset in v%s', async (version) => {
    const chain = getChainByName(network)!;
    const token = getTokenConfig(network, 'eurc')!;
    expect([token.address, token.decimals, isUsdPegged(token)]).toEqual([address, 6, false]);
    const wallet = ethers.Wallet.createRandom();
    const provider = new EVMProvider();
    Object.assign(provider, { signer: wallet, address: wallet.address });
    const signed = await provider.signPayment({ recipient: wallet.address, amount: '0.01', tokenType: 'eurc' }, chain);
    const header = provider.encodePaymentHeader(signed, chain, version, { includeTokenMetadata: true });
    const wire = JSON.parse(Buffer.from(header, 'base64').toString());
    const { authorization, signature, token: metadata } = wire.payload;
    expect(authorization.value).toBe('10000'); // 0.01 euros, no USD conversion
    expect(metadata.address).toBe(address);
    const types = { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] };
    const domain = { name: 'EURC', version: '2', chainId, verifyingContract: address };
    expect(ethers.TypedDataEncoder.hashDomain(domain)).toBe(`0x${separator}`);
    expect(ethers.verifyTypedData(domain, types, authorization, signature)).toBe(wallet.address);
    for (const wrong of [
      { ...domain, chainId: chainId === 5042 ? 5042002 : 5042 },
      { ...domain, name: 'USDC' }, { ...domain, verifyingContract: chain.usdc.address },
    ]) {
      expect(ethers.verifyTypedData(wrong, types, authorization, signature)).not.toBe(wallet.address);
    }
    const requirements = { scheme: 'exact', network: version === 2 ? `eip155:${chainId}` : network,
      asset: address, maxAmountRequired: '10000', payTo: wallet.address,
      resource: 'https://example.com/eurc', maxTimeoutSeconds: 300,
      extra: { name: 'EURC', version: '2' } };
    const request = buildVerifyRequest(parsePaymentHeader(header), requirements);
    expect(JSON.stringify(request)).toContain(address);
    expect(toPaymentRequirementsV2(requirements).amount).toBe('10000');
    await expect(provider.signPayment({ recipient: wallet.address, amount: '0.0000001', tokenType: 'eurc' }, chain)).rejects.toThrow();
  });
});
