/**
 * uvd-x402-sdk - Chain Registry
 *
 * Complete configuration for all 16 supported blockchain networks.
 * EVM chains (10): Use ERC-3009 TransferWithAuthorization
 * SVM chains (2): Solana and Fogo - Use SPL tokens with partially-signed transactions
 * Stellar (1): Uses Soroban authorization entries
 * NEAR (1): Uses NEP-366 meta-transactions
 * Algorand (2): Uses ASA transfers with atomic transaction groups
 */

import type { ChainConfig, NetworkType, TokenType, TokenConfig } from '../types';

/**
 * Default facilitator URL for x402 payments
 */
export const DEFAULT_FACILITATOR_URL = 'https://facilitator.ultravioletadao.xyz';

/**
 * All supported chains configuration
 *
 * To add a new chain:
 * 1. Add chain config below with all required fields
 * 2. Verify USDC contract supports ERC-3009 (transferWithAuthorization) for EVM chains
 * 3. Test on testnet first before enabling
 */
export const SUPPORTED_CHAINS: Record<string, ChainConfig> = {
  // ============================================================================
  // EVM CHAINS (10 networks)
  // ============================================================================

  base: {
    chainId: 8453,
    chainIdHex: '0x2105',
    name: 'base',
    displayName: 'Base',
    networkType: 'evm',
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    nativeCurrency: {
      name: 'Ethereum',
      symbol: 'ETH',
      decimals: 18,
    },
    usdc: {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: 6,
      name: 'USD Coin',
      version: '2',
    },
    tokens: {
      usdc: {
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        decimals: 6,
        name: 'USD Coin',
        version: '2',
      },
      eurc: {
        address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
        decimals: 6,
        name: 'EURC',
        version: '2',
      },
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },

  avalanche: {
    chainId: 43114,
    chainIdHex: '0xa86a',
    name: 'avalanche',
    displayName: 'Avalanche C-Chain',
    networkType: 'evm',
    rpcUrl: 'https://avalanche-c-chain-rpc.publicnode.com',
    explorerUrl: 'https://snowtrace.io',
    nativeCurrency: {
      name: 'Avalanche',
      symbol: 'AVAX',
      decimals: 18,
    },
    usdc: {
      address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      decimals: 6,
      name: 'USD Coin',
      version: '2',
    },
    tokens: {
      usdc: {
        address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
        decimals: 6,
        name: 'USD Coin',
        version: '2',
      },
      eurc: {
        address: '0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD',
        decimals: 6,
        name: 'EURC',
        version: '2',
      },
      ausd: {
        address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
        decimals: 6,
        name: 'Agora Dollar',
        version: '1',
      },
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },

  ethereum: {
    chainId: 1,
    chainIdHex: '0x1',
    name: 'ethereum',
    displayName: 'Ethereum',
    networkType: 'evm',
    rpcUrl: 'https://eth.llamarpc.com',
    explorerUrl: 'https://etherscan.io',
    nativeCurrency: {
      name: 'Ethereum',
      symbol: 'ETH',
      decimals: 18,
    },
    usdc: {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      decimals: 6,
      name: 'USD Coin',
      version: '2',
    },
    tokens: {
      usdc: {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        decimals: 6,
        name: 'USD Coin',
        version: '2',
      },
      eurc: {
        address: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
        decimals: 6,
        name: 'Euro Coin',
        version: '2',
      },
      ausd: {
        address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
        decimals: 6,
        name: 'Agora Dollar',
        version: '1',
      },
      pyusd: {
        address: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8',
        decimals: 6,
        name: 'PayPal USD',
        version: '1',
      },
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },

  polygon: {
    chainId: 137,
    chainIdHex: '0x89',
    name: 'polygon',
    displayName: 'Polygon',
    networkType: 'evm',
    rpcUrl: 'https://polygon-rpc.com',
    explorerUrl: 'https://polygonscan.com',
    nativeCurrency: {
      name: 'Polygon',
      symbol: 'POL',
      decimals: 18,
    },
    usdc: {
      address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      decimals: 6,
      name: 'USD Coin',
      version: '2',
    },
    tokens: {
      usdc: {
        address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        decimals: 6,
        name: 'USD Coin',
        version: '2',
      },
      ausd: {
        address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
        decimals: 6,
        name: 'Agora Dollar',
        version: '1',
      },
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },

  arbitrum: {
    chainId: 42161,
    chainIdHex: '0xa4b1',
    name: 'arbitrum',
    displayName: 'Arbitrum One',
    networkType: 'evm',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    nativeCurrency: {
      name: 'Ethereum',
      symbol: 'ETH',
      decimals: 18,
    },
    usdc: {
      address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      decimals: 6,
      name: 'USD Coin',
      version: '2',
    },
    tokens: {
      usdc: {
        address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        decimals: 6,
        name: 'USD Coin',
        version: '2',
      },
      ausd: {
        address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
        decimals: 6,
        name: 'Agora Dollar',
        version: '1',
      },
      usdt: {
        address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        decimals: 6,
        name: 'USD₮0',
        version: '1',
      },
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },

  optimism: {
    chainId: 10,
    chainIdHex: '0xa',
    name: 'optimism',
    displayName: 'Optimism',
    networkType: 'evm',
    rpcUrl: 'https://mainnet.optimism.io',
    explorerUrl: 'https://optimistic.etherscan.io',
    nativeCurrency: {
      name: 'Ethereum',
      symbol: 'ETH',
      decimals: 18,
    },
    usdc: {
      address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      decimals: 6,
      name: 'USD Coin',
      version: '2',
    },
    tokens: {
      usdc: {
        address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
        decimals: 6,
        name: 'USD Coin',
        version: '2',
      },
      usdt: {
        address: '0x01bff41798a0bcf287b996046ca68b395dbc1071',
        decimals: 6,
        name: 'USD₮0',
        version: '1',
      },
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },

  celo: {
    chainId: 42220,
    chainIdHex: '0xa4ec',
    name: 'celo',
    displayName: 'Celo',
    networkType: 'evm',
    rpcUrl: 'https://forno.celo.org',
    explorerUrl: 'https://celoscan.io',
    nativeCurrency: {
      name: 'Celo',
      symbol: 'CELO',
      decimals: 18,
    },
    usdc: {
      address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
      decimals: 6,
      name: 'USDC',  // Celo uses "USDC" not "USD Coin" for EIP-712
      version: '2',
    },
    tokens: {
      usdc: {
        address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
        decimals: 6,
        name: 'USDC',  // Celo uses "USDC" not "USD Coin" for EIP-712
        version: '2',
      },
      usdt: {
        address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
        decimals: 6,
        name: 'Tether USD',  // Celo USDT uses "Tether USD" for EIP-712
        version: '1',
      },
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },

  hyperevm: {
    chainId: 999,
    chainIdHex: '0x3e7',
    name: 'hyperevm',
    displayName: 'HyperEVM',
    networkType: 'evm',
    rpcUrl: 'https://rpc.hyperliquid.xyz/evm',
    explorerUrl: 'https://hyperevmscan.io',
    nativeCurrency: {
      name: 'Ethereum',
      symbol: 'ETH',
      decimals: 18,
    },
    usdc: {
      address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
      decimals: 6,
      name: 'USDC',  // HyperEVM uses "USDC" not "USD Coin"
      version: '2',
    },
    tokens: {
      usdc: {
        address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
        decimals: 6,
        name: 'USDC',  // HyperEVM uses "USDC" not "USD Coin"
        version: '2',
      },
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },

  unichain: {
    chainId: 130,
    chainIdHex: '0x82',
    name: 'unichain',
    displayName: 'Unichain',
    networkType: 'evm',
    rpcUrl: 'https://unichain-rpc.publicnode.com',
    explorerUrl: 'https://uniscan.xyz',
    nativeCurrency: {
      name: 'Ethereum',
      symbol: 'ETH',
      decimals: 18,
    },
    usdc: {
      address: '0x078d782b760474a361dda0af3839290b0ef57ad6',
      decimals: 6,
      name: 'USDC',  // Unichain uses "USDC" not "USD Coin"
      version: '2',
    },
    tokens: {
      usdc: {
        address: '0x078d782b760474a361dda0af3839290b0ef57ad6',
        decimals: 6,
        name: 'USDC',  // Unichain uses "USDC" not "USD Coin"
        version: '2',
      },
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },

  monad: {
    chainId: 143,
    chainIdHex: '0x8f',
    name: 'monad',
    displayName: 'Monad',
    networkType: 'evm',
    rpcUrl: 'https://rpc.monad.xyz',
    explorerUrl: 'https://monad.socialscan.io',
    nativeCurrency: {
      name: 'Monad',
      symbol: 'MON',
      decimals: 18,
    },
    usdc: {
      address: '0x754704bc059f8c67012fed69bc8a327a5aafb603',
      decimals: 6,
      name: 'USDC',  // Monad uses "USDC" not "USD Coin"
      version: '2',
    },
    tokens: {
      usdc: {
        address: '0x754704bc059f8c67012fed69bc8a327a5aafb603',
        decimals: 6,
        name: 'USDC',  // Monad uses "USDC" not "USD Coin"
        version: '2',
      },
      ausd: {
        address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
        decimals: 6,
        name: 'Agora Dollar',
        version: '1',
      },
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },

  // ============================================================================
  // SVM CHAINS (2 networks) - Solana Virtual Machine
  // ============================================================================

  solana: {
    chainId: 0, // Non-EVM
    chainIdHex: '0x0',
    name: 'solana',
    displayName: 'Solana',
    networkType: 'svm',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    explorerUrl: 'https://solscan.io',
    nativeCurrency: {
      name: 'Solana',
      symbol: 'SOL',
      decimals: 9,
    },
    usdc: {
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC SPL token mint
      decimals: 6,
      name: 'USD Coin',
      version: '1',
    },
    tokens: {
      usdc: {
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC SPL token mint
        decimals: 6,
        name: 'USD Coin',
        version: '1',
      },
      ausd: {
        address: 'AUSD1jCcCyPLybk1YnvPWsHQSrZ46dxwoMniN4N2UEB9', // AUSD Token2022 mint
        decimals: 6,
        name: 'Agora Dollar',
        version: '1',
      },
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },

  fogo: {
    chainId: 0, // Non-EVM (SVM)
    chainIdHex: '0x0',
    name: 'fogo',
    displayName: 'Fogo',
    networkType: 'svm',
    rpcUrl: 'https://rpc.fogo.nightly.app/',
    explorerUrl: 'https://explorer.fogo.nightly.app',
    nativeCurrency: {
      name: 'Fogo',
      symbol: 'FOGO',
      decimals: 9,
    },
    usdc: {
      address: 'uSd2czE61Evaf76RNbq4KPpXnkiL3irdzgLFUMe3NoG', // Fogo USDC mint
      decimals: 6,
      name: 'USDC',
      version: '1',
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },

  // ============================================================================
  // STELLAR (1 network)
  // ============================================================================

  stellar: {
    chainId: 0, // Non-EVM
    chainIdHex: '0x0',
    name: 'stellar',
    displayName: 'Stellar',
    networkType: 'stellar',
    rpcUrl: 'https://horizon.stellar.org',
    explorerUrl: 'https://stellar.expert/explorer/public',
    nativeCurrency: {
      name: 'Lumens',
      symbol: 'XLM',
      decimals: 7, // Stellar uses 7 decimals (stroops)
    },
    usdc: {
      address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', // Soroban Asset Contract
      decimals: 7, // Stellar USDC uses 7 decimals
      name: 'USDC',
      version: '1',
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },

  // ============================================================================
  // NEAR (1 network) - Uses NEP-366 meta-transactions
  // ============================================================================

  near: {
    chainId: 0, // Non-EVM
    chainIdHex: '0x0',
    name: 'near',
    displayName: 'NEAR Protocol',
    networkType: 'near',
    rpcUrl: 'https://rpc.mainnet.near.org',
    explorerUrl: 'https://nearblocks.io',
    nativeCurrency: {
      name: 'NEAR',
      symbol: 'NEAR',
      decimals: 24, // NEAR uses 24 decimals (yoctoNEAR)
    },
    usdc: {
      address: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', // Native Circle USDC
      decimals: 6,
      name: 'USDC',
      version: '1',
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true, // NEP-366 meta-transactions supported
    },
  },

  // ============================================================================
  // ALGORAND (2 networks) - Uses ASA transfers with atomic transaction groups
  // ============================================================================

  algorand: {
    chainId: 0, // Non-EVM (Algorand uses genesis hash for network identification)
    chainIdHex: '0x0',
    name: 'algorand',
    displayName: 'Algorand',
    networkType: 'algorand',
    rpcUrl: 'https://mainnet-api.algonode.cloud',
    explorerUrl: 'https://allo.info',
    nativeCurrency: {
      name: 'Algo',
      symbol: 'ALGO',
      decimals: 6, // Algorand uses 6 decimals (microAlgos)
    },
    usdc: {
      address: '31566704', // USDC ASA ID on Algorand mainnet
      decimals: 6,
      name: 'USDC',
      version: '1',
    },
    tokens: {
      usdc: {
        address: '31566704', // USDC ASA ID on Algorand mainnet
        decimals: 6,
        name: 'USDC',
        version: '1',
      },
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },

  'algorand-testnet': {
    chainId: 0, // Non-EVM
    chainIdHex: '0x0',
    name: 'algorand-testnet',
    displayName: 'Algorand Testnet',
    networkType: 'algorand',
    rpcUrl: 'https://testnet-api.algonode.cloud',
    explorerUrl: 'https://testnet.allo.info',
    nativeCurrency: {
      name: 'Algo',
      symbol: 'ALGO',
      decimals: 6,
    },
    usdc: {
      address: '10458941', // USDC ASA ID on Algorand testnet
      decimals: 6,
      name: 'USDC',
      version: '1',
    },
    tokens: {
      usdc: {
        address: '10458941', // USDC ASA ID on Algorand testnet
        decimals: 6,
        name: 'USDC',
        version: '1',
      },
    },
    x402: {
      facilitatorUrl: DEFAULT_FACILITATOR_URL,
      enabled: true,
    },
  },
};

/**
 * Default chain for new users
 */
export const DEFAULT_CHAIN = 'base';

/**
 * Get chain config by chain ID
 */
export function getChainById(chainId: number): ChainConfig | undefined {
  return Object.values(SUPPORTED_CHAINS).find(chain => chain.chainId === chainId);
}

/**
 * Get chain config by name (case-insensitive)
 */
export function getChainByName(name: string): ChainConfig | undefined {
  return SUPPORTED_CHAINS[name.toLowerCase()];
}

/**
 * Check if a chain is supported
 */
export function isChainSupported(chainIdOrName: number | string): boolean {
  if (typeof chainIdOrName === 'number') {
    return Object.values(SUPPORTED_CHAINS).some(chain => chain.chainId === chainIdOrName);
  }
  return chainIdOrName.toLowerCase() in SUPPORTED_CHAINS;
}

/**
 * Get list of enabled chains
 */
export function getEnabledChains(): ChainConfig[] {
  return Object.values(SUPPORTED_CHAINS).filter(chain => chain.x402.enabled);
}

/**
 * Get list of chains by network type
 */
export function getChainsByNetworkType(networkType: NetworkType): ChainConfig[] {
  return Object.values(SUPPORTED_CHAINS).filter(
    chain => chain.networkType === networkType && chain.x402.enabled
  );
}

/**
 * Get all EVM chain IDs (for wallet_switchEthereumChain)
 */
export function getEVMChainIds(): number[] {
  return getChainsByNetworkType('evm').map(chain => chain.chainId);
}

/**
 * Get list of SVM chains (Solana, Fogo)
 */
export function getSVMChains(): ChainConfig[] {
  return Object.values(SUPPORTED_CHAINS).filter(
    chain => chain.networkType === 'svm' && chain.x402.enabled
  );
}

/**
 * Check if a chain is SVM-based (Solana Virtual Machine)
 */
export function isSVMChain(chainName: string): boolean {
  const chain = getChainByName(chainName);
  return chain?.networkType === 'svm';
}

/**
 * Get network type from chain name
 */
export function getNetworkType(chainName: string): NetworkType | undefined {
  const chain = getChainByName(chainName);
  return chain?.networkType;
}

/**
 * Format transaction URL for block explorer
 */
export function getExplorerTxUrl(chainName: string, txHash: string): string | null {
  const chain = getChainByName(chainName);
  if (!chain) return null;

  switch (chain.networkType) {
    case 'evm':
      return `${chain.explorerUrl}/tx/${txHash}`;
    case 'svm':
    case 'solana': // @deprecated
      return `${chain.explorerUrl}/tx/${txHash}`;
    case 'stellar':
      return `${chain.explorerUrl}/tx/${txHash}`;
    case 'near':
      return `${chain.explorerUrl}/txns/${txHash}`;
    case 'algorand':
      return `${chain.explorerUrl}/tx/${txHash}`;
    default:
      return null;
  }
}

/**
 * Format address URL for block explorer
 */
export function getExplorerAddressUrl(chainName: string, address: string): string | null {
  const chain = getChainByName(chainName);
  if (!chain) return null;

  switch (chain.networkType) {
    case 'evm':
      return `${chain.explorerUrl}/address/${address}`;
    case 'svm':
    case 'solana': // @deprecated
      return `${chain.explorerUrl}/account/${address}`;
    case 'stellar':
      return `${chain.explorerUrl}/account/${address}`;
    case 'near':
      return `${chain.explorerUrl}/address/${address}`;
    case 'algorand':
      return `${chain.explorerUrl}/account/${address}`;
    default:
      return null;
  }
}

/**
 * Get list of Algorand chains
 */
export function getAlgorandChains(): ChainConfig[] {
  return Object.values(SUPPORTED_CHAINS).filter(
    chain => chain.networkType === 'algorand' && chain.x402.enabled
  );
}

/**
 * Check if a chain is Algorand-based
 */
export function isAlgorandChain(chainName: string): boolean {
  const chain = getChainByName(chainName);
  return chain?.networkType === 'algorand';
}

// ============================================================================
// MULTI-TOKEN SUPPORT FUNCTIONS
// ============================================================================

/**
 * Get token configuration for a specific chain and token type
 * Falls back to USDC config if token not found (for backward compatibility)
 *
 * @param chainName - Chain name (e.g., 'ethereum', 'base')
 * @param tokenType - Token type (e.g., 'usdc', 'eurc', 'pyusd')
 * @returns Token configuration or undefined if chain not found
 */
export function getTokenConfig(
  chainName: string,
  tokenType: TokenType = 'usdc'
): TokenConfig | undefined {
  const chain = getChainByName(chainName);
  if (!chain) return undefined;

  // Try to get from tokens map first (new multi-token support)
  if (chain.tokens && chain.tokens[tokenType]) {
    return chain.tokens[tokenType];
  }

  // Fall back to usdc config for backward compatibility
  if (tokenType === 'usdc') {
    return chain.usdc;
  }

  return undefined;
}

/**
 * Get list of supported tokens for a chain
 *
 * @param chainName - Chain name (e.g., 'ethereum', 'base')
 * @returns Array of supported token types, or empty array if chain not found
 */
export function getSupportedTokens(chainName: string): TokenType[] {
  const chain = getChainByName(chainName);
  if (!chain) return [];

  // If tokens map exists, return its keys
  if (chain.tokens) {
    return Object.keys(chain.tokens) as TokenType[];
  }

  // Default to just USDC for chains without explicit tokens map
  return ['usdc'];
}

/**
 * Check if a token is supported on a specific chain
 *
 * @param chainName - Chain name (e.g., 'ethereum', 'base')
 * @param tokenType - Token type (e.g., 'usdc', 'eurc', 'pyusd')
 * @returns true if token is supported on the chain
 */
export function isTokenSupported(chainName: string, tokenType: TokenType): boolean {
  const chain = getChainByName(chainName);
  if (!chain) return false;

  // Check tokens map
  if (chain.tokens && chain.tokens[tokenType]) {
    return true;
  }

  // USDC is always supported (backward compatibility)
  if (tokenType === 'usdc') {
    return true;
  }

  return false;
}

/**
 * Get all chains that support a specific token
 *
 * @param tokenType - Token type (e.g., 'usdc', 'eurc', 'pyusd')
 * @returns Array of chain configs that support the token
 */
export function getChainsByToken(tokenType: TokenType): ChainConfig[] {
  return Object.values(SUPPORTED_CHAINS).filter(chain => {
    if (!chain.x402.enabled) return false;
    if (chain.tokens && chain.tokens[tokenType]) return true;
    if (tokenType === 'usdc') return true; // USDC is universal
    return false;
  });
}
