import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'providers/evm/index': 'src/providers/evm/index.ts',
    'providers/solana/index': 'src/providers/solana/index.ts',
    'providers/stellar/index': 'src/providers/stellar/index.ts',
    'providers/near/index': 'src/providers/near/index.ts',
    'utils/index': 'src/utils/index.ts',
    'react/index': 'src/react/index.tsx',
    'adapters/index': 'src/adapters/index.ts',
    'backend/index': 'src/backend/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
  external: [
    'react',
    '@solana/web3.js',
    '@solana/spl-token',
    '@stellar/stellar-sdk',
    '@stellar/freighter-api',
    '@walletconnect/ethereum-provider',
    '@near-wallet-selector/core',
    '@near-wallet-selector/my-near-wallet',
  ],
});
