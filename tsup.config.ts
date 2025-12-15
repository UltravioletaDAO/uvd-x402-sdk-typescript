import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'providers/evm/index': 'src/providers/evm/index.ts',
    'providers/solana/index': 'src/providers/solana/index.ts',
    'providers/stellar/index': 'src/providers/stellar/index.ts',
    'react/index': 'src/react/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [
    'react',
    '@solana/web3.js',
    '@solana/spl-token',
    '@stellar/stellar-sdk',
    '@stellar/freighter-api',
    '@walletconnect/ethereum-provider',
  ],
});
