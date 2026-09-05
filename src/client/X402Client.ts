/**
 * uvd-x402-sdk - Main Client
 *
 * The X402Client is the primary entry point for the SDK.
 * It manages wallet connections, chain switching, and payment creation.
 */

import { ethers } from 'ethers';
import type {
  ChainConfig,
  NetworkType,
  PaymentInfo,
  PaymentResult,
  WalletState,
  X402ClientConfig,
  X402Event,
  X402EventData,
  X402EventHandler,
  EVMPaymentPayload,
  TokenType,
  X402EVMPayload,
  X402Version,
  X402PaymentOffer,
  X402FetchOptions,
} from '../types';
import { X402Error, DEFAULT_CONFIG } from '../types';
import {
  SUPPORTED_CHAINS,
  getChainByName,
  getChainById,
  getEnabledChains,
  getTokenConfig,
} from '../chains';
import {
  validateRecipient,
  chainToCAIP2,
  caip2ToChain,
  encodeBase64Json,
  buildTokenMetadata,
} from '../utils';

/**
 * X402Client - Main SDK client for x402 payments
 *
 * @example
 * ```ts
 * import { X402Client } from 'uvd-x402-sdk';
 *
 * const client = new X402Client({ defaultChain: 'base' });
 *
 * // Connect wallet
 * await client.connect('base');
 *
 * // Create payment
 * const result = await client.createPayment({
 *   recipient: '0x...',
 *   amount: '10.00',
 * });
 *
 * // Use result.paymentHeader in your API request
 * ```
 */
export class X402Client {
  // Configuration
  private readonly config: Required<Pick<X402ClientConfig, 'facilitatorUrl' | 'defaultChain' | 'autoConnect' | 'debug'>> & X402ClientConfig;

  // Wallet state
  private provider: ethers.BrowserProvider | ethers.JsonRpcProvider | null = null;
  private signer: ethers.Signer | null = null;
  private connectedAddress: string | null = null;
  private currentChainId: number | null = null;
  private currentNetwork: NetworkType | null = null;
  private currentChainName: string | null = null;

  // Event emitter
  private eventHandlers: Map<X402Event, Set<X402EventHandler<X402Event>>> = new Map();

  constructor(config: X402ClientConfig = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    // Apply custom RPC overrides
    if (config.rpcOverrides) {
      for (const [chainName, rpcUrl] of Object.entries(config.rpcOverrides)) {
        if (SUPPORTED_CHAINS[chainName]) {
          SUPPORTED_CHAINS[chainName].rpcUrl = rpcUrl;
        }
      }
    }

    // Apply custom chain configurations
    if (config.customChains) {
      for (const [chainName, chainConfig] of Object.entries(config.customChains)) {
        if (SUPPORTED_CHAINS[chainName]) {
          Object.assign(SUPPORTED_CHAINS[chainName], chainConfig);
        }
      }
    }

    this.log('X402Client initialized', { config: this.config });
  }

  // ============================================================================
  // PUBLIC API - Wallet Connection
  // ============================================================================

  /**
   * Connect to a wallet on the specified chain
   */
  async connect(chainName?: string): Promise<string> {
    const targetChain = chainName || this.config.defaultChain;
    const chain = getChainByName(targetChain);

    if (!chain) {
      throw new X402Error(`Unsupported chain: ${targetChain}`, 'CHAIN_NOT_SUPPORTED');
    }

    if (!chain.x402.enabled) {
      throw new X402Error(`Chain ${targetChain} is not enabled for x402 payments`, 'CHAIN_NOT_SUPPORTED');
    }

    this.log(`Connecting wallet on ${chain.displayName}...`);

    // Route to appropriate connection method based on network type
    switch (chain.networkType) {
      case 'evm':
        return this.connectEVMWallet(chain);
      case 'solana':
        throw new X402Error(
          'Solana support requires importing from "uvd-x402-sdk/solana"',
          'CHAIN_NOT_SUPPORTED'
        );
      case 'stellar':
        throw new X402Error(
          'Stellar support requires importing from "uvd-x402-sdk/stellar"',
          'CHAIN_NOT_SUPPORTED'
        );
      case 'near':
        throw new X402Error(
          'NEAR support requires importing from "uvd-x402-sdk/near"',
          'CHAIN_NOT_SUPPORTED'
        );
      case 'xrpl':
        throw new X402Error(
          'XRPL support requires importing from "uvd-x402-sdk/xrpl"',
          'CHAIN_NOT_SUPPORTED'
        );
      default:
        throw new X402Error(`Unknown network type for chain ${targetChain}`, 'CHAIN_NOT_SUPPORTED');
    }
  }

  /**
   * Connect using a private key (Node.js / server-side, no browser wallet needed)
   */
  async connectWithPrivateKey(privateKey: string, chainName?: string): Promise<string> {
    const targetChain = chainName || this.config.defaultChain;
    const chain = getChainByName(targetChain);

    if (!chain) {
      throw new X402Error(`Unsupported chain: ${targetChain}`, 'CHAIN_NOT_SUPPORTED');
    }

    if (!chain.x402.enabled) {
      throw new X402Error(`Chain ${targetChain} is not enabled for x402 payments`, 'CHAIN_NOT_SUPPORTED');
    }

    if (chain.networkType !== 'evm') {
      throw new X402Error('connectWithPrivateKey is only supported for EVM chains', 'CHAIN_NOT_SUPPORTED');
    }

    this.log(`Connecting with private key on ${chain.displayName}...`);

    const rpcProvider = new ethers.JsonRpcProvider(chain.rpcUrl);
    const wallet = new ethers.Wallet(privateKey, rpcProvider);

    this.provider = rpcProvider;
    this.signer = wallet;
    this.connectedAddress = wallet.address;
    this.currentChainId = chain.chainId;
    this.currentNetwork = 'evm';
    this.currentChainName = chain.name;

    const state = this.getState();
    this.emit('connect', state);
    this.log('Private key wallet connected', { address: this.connectedAddress, chain: chain.name });

    return this.connectedAddress;
  }

  /**
   * Disconnect the current wallet
   */
  async disconnect(): Promise<void> {
    this.provider = null;
    this.signer = null;
    this.connectedAddress = null;
    this.currentChainId = null;
    this.currentNetwork = null;
    this.currentChainName = null;

    this.emit('disconnect', undefined);
    this.log('Wallet disconnected');
  }

  /**
   * Switch to a different chain (EVM only)
   */
  async switchChain(chainName: string): Promise<void> {
    const chain = getChainByName(chainName);

    if (!chain) {
      throw new X402Error(`Unsupported chain: ${chainName}`, 'CHAIN_NOT_SUPPORTED');
    }

    if (chain.networkType !== 'evm') {
      throw new X402Error(
        'switchChain is only supported for EVM networks. Reconnect with connect() for other networks.',
        'CHAIN_NOT_SUPPORTED'
      );
    }

    if (!this.provider) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    // Private key connections cannot use wallet_switchEthereumChain — re-create provider
    if (this.provider instanceof ethers.JsonRpcProvider && this.signer instanceof ethers.Wallet) {
      const rpcProvider = new ethers.JsonRpcProvider(chain.rpcUrl);
      const wallet = new ethers.Wallet(this.signer.privateKey, rpcProvider);
      this.provider = rpcProvider;
      this.signer = wallet;
      this.currentChainId = chain.chainId;
      this.currentChainName = chain.name;
      this.emit('chainChanged', { chainId: chain.chainId, chainName: chain.name });
      this.log('Switched chain (private key mode)', { chain: chain.name });
      return;
    }

    await this.switchEVMChain(chain);
  }

  // ============================================================================
  // PUBLIC API - Payment Creation
  // ============================================================================

  /**
   * Create a payment authorization
   *
   * @param paymentInfo - Payment information from 402 response
   * @returns Payment result with encoded X-PAYMENT header
   */
  async createPayment(paymentInfo: PaymentInfo): Promise<PaymentResult> {
    if (!this.connectedAddress) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    if (!this.currentChainName) {
      throw new X402Error('Chain not set', 'CHAIN_NOT_SUPPORTED');
    }

    const chain = getChainByName(this.currentChainName);
    if (!chain) {
      throw new X402Error(`Chain ${this.currentChainName} not found`, 'CHAIN_NOT_SUPPORTED');
    }

    this.emit('paymentStarted', { amount: paymentInfo.amount, network: chain.name });
    this.log('Creating payment...', { paymentInfo, chain: chain.name });

    try {
      // Route to appropriate payment method
      switch (chain.networkType) {
        case 'evm':
          return await this.createEVMPayment(paymentInfo, chain);
        default:
          throw new X402Error(
            `Payment creation for ${chain.networkType} requires the appropriate provider`,
            'CHAIN_NOT_SUPPORTED'
          );
      }
    } catch (error) {
      const x402Error = error instanceof X402Error
        ? error
        : new X402Error(
            error instanceof Error ? error.message : 'Unknown error',
            'PAYMENT_FAILED',
            error
          );

      this.emit('paymentFailed', { error: x402Error.message, code: x402Error.code });
      throw x402Error;
    }
  }


  // ============================================================================
  // PUBLIC API - Buyer loop
  // ============================================================================

  /**
   * Fetch a resource, paying its `402 Payment Required` challenge if it has one.
   *
   * The BUYER side of x402, and the half this client was missing: it could sign
   * a payment ({@link createPayment}) but never ask for one, so every consumer
   * hand-rolled the same loop -- probe, read `accepts`, pick, sign, retry --
   * and each one picked its own answer to "how much is too much".
   *
   * Safe by default: `maxAmount` is a hard ceiling. A 402 that asks for more
   * throws `PAYMENT_EXCEEDS_MAX` instead of quietly signing it. A response that
   * is not a 402 -- a first-try 200 included -- comes back untouched; this pays
   * only when payment is what was asked for.
   *
   * @param url - Resource URL.
   * @param options - See {@link X402FetchOptions}.
   * @returns The paid response after a 402, or the original response.
   *
   * @example
   * ```ts
   * await client.connectWithPrivateKey(key, 'base');
   * const res = await client.fetch('https://api.example.com/data', {
   *   maxAmount: '0.05',
   * });
   * const data = await res.json();
   * ```
   */
  async fetch(url: string, options: X402FetchOptions = {}): Promise<Response> {
    if (!this.connectedAddress) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    const method = options.method || 'GET';
    const doFetch = options.fetchImpl || globalThis.fetch;
    if (typeof doFetch !== 'function') {
      throw new X402Error(
        'No fetch implementation available; pass options.fetchImpl',
        'NETWORK_ERROR'
      );
    }

    const probe = await doFetch(url, { ...options.init, method });
    if (probe.status !== 402) {
      return probe;
    }

    let body: unknown;
    try {
      body = await probe.json();
    } catch (error) {
      throw new X402Error(
        `402 response body is not JSON: ${error instanceof Error ? error.message : 'unknown'}`,
        'PAYMENT_FAILED',
        error
      );
    }

    const tokenType: TokenType = options.tokenType || 'usdc';
    const { version, offers } = this.parse402(body, tokenType);
    if (offers.length === 0) {
      throw new X402Error(
        '402 response offered no usable payment options',
        'NO_ACCEPTABLE_PAYMENT'
      );
    }

    // The ceiling is deliberately NOT applied while selecting: if even the
    // cheapest offer is over budget the caller wants to be told the price, not
    // handed a vague "nothing acceptable".
    const chosen = options.select
      ? options.select(offers)
      : X402Client.cheapestOffer(offers);
    if (!chosen) {
      throw new X402Error(
        'No payment option selected for the 402 challenge',
        'NO_ACCEPTABLE_PAYMENT'
      );
    }

    if (options.maxAmount !== undefined) {
      const ceiling = ethers.parseUnits(options.maxAmount, chosen.decimals);
      if (BigInt(chosen.amount) > ceiling) {
        throw new X402Error(
          `Payment of ${ethers.formatUnits(chosen.amount, chosen.decimals)} exceeds ` +
            `maxAmount ${options.maxAmount} for ${url}`,
          'PAYMENT_EXCEEDS_MAX',
          {
            amount: chosen.amount,
            decimals: chosen.decimals,
            maxAmount: options.maxAmount,
          }
        );
      }
    }

    if (!chosen.chainName) {
      throw new X402Error(
        `402 asked for payment on unknown network '${chosen.network}'`,
        'CHAIN_NOT_SUPPORTED'
      );
    }

    if (chosen.chainName !== this.currentChainName) {
      await this.switchChain(chosen.chainName);
    }

    const payment = await this.createPayment({
      recipient: chosen.payTo,
      amount: ethers.formatUnits(chosen.amount, chosen.decimals),
      tokenType,
      network: chosen.chainName,
      x402Version: version,
    });

    // v1 servers read `X-PAYMENT`; v2 ones read `PAYMENT-SIGNATURE`. Both carry
    // the identical base64 payload, so sending both on a v2 retry costs nothing
    // and spares the caller from guessing which name the resource implemented.
    const paidHeaders: Record<string, string> = {
      ...X402Client.headersToRecord(options.init?.headers),
      'X-PAYMENT': payment.paymentHeader,
    };
    if (version === 2) {
      paidHeaders['PAYMENT-SIGNATURE'] = payment.paymentHeader;
    }

    return doFetch(url, { ...options.init, method, headers: paidHeaders });
  }

  /**
   * Normalise a 402 body into its envelope version and its payment offers.
   *
   * Reads both spec shapes -- `{x402Version, accepts: [...]}` and the non-spec
   * one where a lone requirement sits at the top level -- and both dialects of
   * the price field (`maxAmountRequired` in v1, `amount` in v2).
   */
  private parse402(
    body: unknown,
    tokenType: TokenType
  ): { version: X402Version; offers: X402PaymentOffer[] } {
    const doc = (body ?? {}) as Record<string, unknown>;
    const version: X402Version = Number(doc.x402Version) === 2 ? 2 : 1;

    const rawAccepts = Array.isArray(doc.accepts)
      ? doc.accepts
      : doc.payTo
        ? [doc]
        : [];

    const offers: X402PaymentOffer[] = [];
    for (const entry of rawAccepts) {
      if (!entry || typeof entry !== 'object') continue;
      const accept = entry as Record<string, unknown>;

      const amount = accept.amount ?? accept.maxAmountRequired;
      const payTo = accept.payTo;
      const network = accept.network;
      if (amount === undefined || amount === null) continue;
      if (typeof payTo !== 'string' || !payTo) continue;
      if (typeof network !== 'string' || !network) continue;

      const chainName = getChainByName(network) ? network : caip2ToChain(network);

      offers.push({
        network,
        chainName,
        asset: typeof accept.asset === 'string' ? accept.asset : undefined,
        amount: String(amount),
        decimals: X402Client.offerDecimals(chainName, tokenType),
        payTo,
        raw: accept,
      });
    }

    return { version, offers };
  }

  /**
   * Decimals to read an offer's atomic `amount` with.
   *
   * Not cosmetic: BSC USDC has 18 and everyone else's has 6, so reading every
   * price at 6 makes one chain look 10^12 times cheaper than it is and the
   * cheapest offer gets chosen wrong. Falls back to 6 only when the chain is
   * unknown -- and an unknown chain cannot be paid anyway.
   */
  private static offerDecimals(chainName: string | null, tokenType: TokenType): number {
    if (!chainName) return 6;
    const token = getTokenConfig(chainName, tokenType);
    if (token) return token.decimals;
    return getChainByName(chainName)?.usdc.decimals ?? 6;
  }

  /** Cheapest offer, compared across chains at a common scale. */
  private static cheapestOffer(offers: X402PaymentOffer[]): X402PaymentOffer {
    return offers.reduce((best, offer) =>
      X402Client.scaled(offer) < X402Client.scaled(best) ? offer : best
    );
  }

  /** An offer's price scaled to 18 decimals, so BigInt comparison is exact. */
  private static scaled(offer: X402PaymentOffer): bigint {
    const exponent = 18 - offer.decimals;
    const value = BigInt(offer.amount);
    return exponent >= 0
      ? value * 10n ** BigInt(exponent)
      : value / 10n ** BigInt(-exponent);
  }

  /** Flatten whatever `HeadersInit` shape the caller passed into a record. */
  private static headersToRecord(init?: HeadersInit): Record<string, string> {
    if (!init) return {};
    if (Array.isArray(init)) return Object.fromEntries(init);
    const maybeHeaders = init as Headers;
    if (typeof maybeHeaders.forEach === 'function') {
      const out: Record<string, string> = {};
      maybeHeaders.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }
    return { ...(init as Record<string, string>) };
  }

  /**
   * Check USDC balance on current chain
   */
  async getBalance(): Promise<string> {
    if (!this.connectedAddress || !this.currentChainName) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    const chain = getChainByName(this.currentChainName);
    if (!chain) {
      throw new X402Error(`Chain ${this.currentChainName} not found`, 'CHAIN_NOT_SUPPORTED');
    }

    switch (chain.networkType) {
      case 'evm':
        return this.getEVMBalance(chain);
      default:
        throw new X402Error(
          `Balance check for ${chain.networkType} requires the appropriate provider`,
          'CHAIN_NOT_SUPPORTED'
        );
    }
  }

  // ============================================================================
  // PUBLIC API - Getters
  // ============================================================================

  /**
   * Get current wallet state
   */
  getState(): WalletState {
    return {
      connected: this.connectedAddress !== null,
      address: this.connectedAddress,
      chainId: this.currentChainId,
      network: this.currentChainName,
      networkType: this.currentNetwork,
      balance: null, // Call getBalance() separately
    };
  }

  /**
   * Get connected wallet address
   */
  getAddress(): string | null {
    return this.connectedAddress;
  }

  /**
   * Get current chain ID
   */
  getChainId(): number | null {
    return this.currentChainId;
  }

  /**
   * Get current chain name
   */
  getChainName(): string | null {
    return this.currentChainName;
  }

  /**
   * Get current chain display name
   */
  getChainDisplayName(): string | null {
    if (!this.currentChainName) return null;
    const chain = getChainByName(this.currentChainName);
    return chain?.displayName ?? null;
  }

  /**
   * Check if wallet is connected
   */
  isConnected(): boolean {
    return this.connectedAddress !== null;
  }

  /**
   * Get list of enabled chains
   */
  getEnabledChains(): ChainConfig[] {
    return getEnabledChains();
  }

  /**
   * Get chain config by name
   */
  getChain(name: string): ChainConfig | undefined {
    return getChainByName(name);
  }

  // ============================================================================
  // PUBLIC API - Events
  // ============================================================================

  /**
   * Subscribe to an event
   */
  on<E extends X402Event>(event: E, handler: X402EventHandler<E>): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler as X402EventHandler<X402Event>);

    // Return unsubscribe function
    return () => this.off(event, handler);
  }

  /**
   * Unsubscribe from an event
   */
  off<E extends X402Event>(event: E, handler: X402EventHandler<E>): void {
    this.eventHandlers.get(event)?.delete(handler as X402EventHandler<X402Event>);
  }

  // ============================================================================
  // PRIVATE - EVM Wallet Connection
  // ============================================================================

  private async connectEVMWallet(chain: ChainConfig): Promise<string> {
    // Check for injected provider
    if (typeof window === 'undefined' || !window.ethereum) {
      throw new X402Error(
        'No Ethereum wallet found. Please install MetaMask or another EVM wallet.',
        'WALLET_NOT_FOUND'
      );
    }

    try {
      this.provider = new ethers.BrowserProvider(window.ethereum);

      // Request account access
      await this.provider.send('eth_requestAccounts', []);

      // Switch to target chain
      await this.switchEVMChain(chain);

      // Get signer and address
      this.signer = await this.provider.getSigner();
      this.connectedAddress = await this.signer.getAddress();
      this.currentChainId = chain.chainId;
      this.currentNetwork = 'evm';
      this.currentChainName = chain.name;

      // Setup event listeners
      this.setupEVMEventListeners();

      const state = this.getState();
      this.emit('connect', state);
      this.log('EVM wallet connected', { address: this.connectedAddress, chain: chain.name });

      return this.connectedAddress;
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (error.message.includes('User rejected') || (error as { code?: number }).code === 4001) {
          throw new X402Error('Connection rejected by user', 'WALLET_CONNECTION_REJECTED');
        }
      }
      throw new X402Error(
        `Failed to connect wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'UNKNOWN_ERROR',
        error
      );
    }
  }

  private async switchEVMChain(chain: ChainConfig): Promise<void> {
    if (!this.provider) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    try {
      await this.provider.send('wallet_switchEthereumChain', [{ chainId: chain.chainIdHex }]);
    } catch (switchError: unknown) {
      // Chain not added - try to add it
      if ((switchError as { code?: number }).code === 4902) {
        try {
          await this.provider.send('wallet_addEthereumChain', [
            {
              chainId: chain.chainIdHex,
              chainName: chain.displayName,
              nativeCurrency: chain.nativeCurrency,
              rpcUrls: [chain.rpcUrl],
              blockExplorerUrls: [chain.explorerUrl],
            },
          ]);
        } catch (addError) {
          throw new X402Error(
            `Failed to add ${chain.displayName} network`,
            'CHAIN_SWITCH_REJECTED',
            addError
          );
        }
      } else if ((switchError as { code?: number }).code === 4001) {
        throw new X402Error('Network switch rejected by user', 'CHAIN_SWITCH_REJECTED');
      } else {
        throw new X402Error(
          `Failed to switch to ${chain.displayName}`,
          'CHAIN_SWITCH_REJECTED',
          switchError
        );
      }
    }

    this.currentChainId = chain.chainId;
    this.currentChainName = chain.name;
    this.emit('chainChanged', { chainId: chain.chainId, chainName: chain.name });
  }

  private setupEVMEventListeners(): void {
    if (typeof window === 'undefined' || !window.ethereum) return;

    window.ethereum.on?.('accountsChanged', ((...args: unknown[]) => {
      const accounts = args[0] as string[];
      if (accounts.length === 0) {
        this.disconnect();
      } else if (accounts[0] !== this.connectedAddress) {
        this.connectedAddress = accounts[0];
        this.emit('accountChanged', { address: accounts[0] });
      }
    }) as (...args: unknown[]) => void);

    window.ethereum.on?.('chainChanged', ((...args: unknown[]) => {
      const chainIdHex = args[0] as string;
      const chainId = parseInt(chainIdHex, 16);
      const chain = getChainById(chainId);
      if (chain) {
        this.currentChainId = chainId;
        this.currentChainName = chain.name;
        this.emit('chainChanged', { chainId, chainName: chain.name });
      }
    }) as (...args: unknown[]) => void);
  }

  // ============================================================================
  // PRIVATE - EVM Payment Creation
  // ============================================================================

  private async createEVMPayment(paymentInfo: PaymentInfo, chain: ChainConfig): Promise<PaymentResult> {
    if (!this.signer) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    // Get recipient address for EVM
    const recipient = this.getRecipientForNetwork(paymentInfo, 'evm');

    // Validate recipient address - prevents empty/invalid addresses
    validateRecipient(recipient, 'evm');

    // Which stablecoin to charge. Defaults to USDC so existing callers are
    // unaffected; anything else is resolved from the chain's token registry.
    const tokenType: TokenType = paymentInfo.tokenType || 'usdc';
    const token = getTokenConfig(chain.name, tokenType);
    if (!token) {
      throw new X402Error(
        `Token ${tokenType} not supported on ${chain.name}`,
        'CHAIN_NOT_SUPPORTED'
      );
    }

    // Generate random nonce
    const nonceBytes = new Uint8Array(32);
    if (typeof window !== 'undefined' && window.crypto) {
      window.crypto.getRandomValues(nonceBytes);
    } else {
      for (let i = 0; i < 32; i++) {
        nonceBytes[i] = Math.floor(Math.random() * 256);
      }
    }
    const nonce = ethers.hexlify(nonceBytes);

    // Set validity window (5 minutes for congested networks, 1 minute otherwise)
    const validAfter = 0;
    const validityWindowSeconds = chain.name === 'base' ? 300 : 60;
    const validBefore = Math.floor(Date.now() / 1000) + validityWindowSeconds;

    // EIP-712 domain of the token being charged
    const domain = {
      name: token.name,
      version: token.version,
      chainId: chain.chainId,
      verifyingContract: token.address,
    };

    // EIP-712 types for TransferWithAuthorization (ERC-3009)
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };

    // Parse amount in the token's own decimals
    const value = ethers.parseUnits(paymentInfo.amount, token.decimals);
    const from = await this.signer.getAddress();
    const to = ethers.getAddress(recipient);

    // Message to sign
    const message = {
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce,
    };

    this.log('Signing EIP-712 message...', { domain, message });

    // Sign the EIP-712 message
    let signature: string;
    try {
      signature = await this.signer.signTypedData(domain, types, message);
    } catch (error: unknown) {
      if (error instanceof Error && (error.message.includes('User rejected') || (error as { code?: number }).code === 4001)) {
        throw new X402Error('Signature rejected by user', 'SIGNATURE_REJECTED');
      }
      throw new X402Error(
        `Failed to sign payment: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PAYMENT_FAILED',
        error
      );
    }

    const sig = ethers.Signature.from(signature);

    // Construct payload
    const payload: EVMPaymentPayload = {
      from,
      to,
      value: value.toString(),
      validAfter,
      validBefore,
      nonce,
      v: sig.v,
      r: sig.r,
      s: sig.s,
      chainId: chain.chainId,
      token: token.address,
    };

    // Encode as X-PAYMENT header. The 402 wins over the config when it spoke:
    // `x402Version: 'auto'` means "whatever the resource asked for".
    const paymentHeader = this.encodeEVMPaymentHeader(
      payload,
      chain,
      paymentInfo.x402Version
    );

    this.emit('paymentSigned', { paymentHeader });

    const result: PaymentResult = {
      success: true,
      paymentHeader,
      headers: {
        'X-PAYMENT': paymentHeader,
        'PAYMENT-SIGNATURE': paymentHeader,
      },
      network: chain.name,
      payer: from,
    };

    this.emit('paymentCompleted', result);
    this.log('Payment created successfully', { network: chain.name, from });

    return result;
  }

  private encodeEVMPaymentHeader(
    payload: EVMPaymentPayload,
    chain: ChainConfig,
    versionHint?: X402Version
  ): string {
    // Reconstruct full signature from v, r, s
    const fullSignature = payload.r + payload.s.slice(2) + payload.v.toString(16).padStart(2, '0');

    // Determine version to use. A hint read off the resource's own 402 wins;
    // with no hint we fall back to the config (default v1 for compatibility).
    const version = versionHint ?? (this.config.x402Version === 2 ? 2 : 1);

    // Build the payload data
    const payloadData: X402EVMPayload = {
      signature: fullSignature,
      authorization: {
        from: payload.from,
        to: payload.to,
        value: payload.value,
        validAfter: payload.validAfter.toString(),
        validBefore: payload.validBefore.toString(),
        nonce: payload.nonce,
      },
    };

    if (this.config.includeTokenMetadata) {
      const token = buildTokenMetadata(chain.name, payload.token);
      if (!token) {
        throw new X402Error(
          `Token ${payload.token} is not in the registry for ${chain.name}; cannot build token metadata`,
          'CHAIN_NOT_SUPPORTED'
        );
      }
      payloadData.token = token;
    }

    // Format in x402 standard format (v1 or v2)
    const x402Payload = version === 2
      ? {
          x402Version: 2 as const,
          scheme: 'exact' as const,
          network: chainToCAIP2(chain.name), // CAIP-2 format for v2
          payload: payloadData,
        }
      : {
          x402Version: 1 as const,
          scheme: 'exact' as const,
          network: chain.name, // Plain chain name for v1
          payload: payloadData,
        };

    // Base64 encode (UTF-8 safe: token domain names like `USD₮0` are not ASCII)
    return encodeBase64Json(x402Payload);
  }

  // ============================================================================
  // PRIVATE - EVM Balance Check
  // ============================================================================

  private async getEVMBalance(chain: ChainConfig): Promise<string> {
    // Use public RPC for balance check (more reliable than wallet provider)
    const publicProvider = new ethers.JsonRpcProvider(chain.rpcUrl);

    const usdcAbi = ['function balanceOf(address owner) view returns (uint256)'];
    const usdcContract = new ethers.Contract(chain.usdc.address, usdcAbi, publicProvider);

    try {
      const balance = await usdcContract.balanceOf(this.connectedAddress);
      const formatted = ethers.formatUnits(balance, chain.usdc.decimals);
      return parseFloat(formatted).toFixed(2);
    } catch {
      return '0.00';
    }
  }

  // ============================================================================
  // PRIVATE - Utilities
  // ============================================================================

  private getRecipientForNetwork(paymentInfo: PaymentInfo, network: NetworkType): string {
    // Map SVM to solana for recipient lookup
    const lookupNetwork = network === 'svm' ? 'solana' : network;
    const recipients = paymentInfo.recipients as Record<string, string> | undefined;
    if (recipients?.[lookupNetwork]) {
      return recipients[lookupNetwork];
    }
    return paymentInfo.recipient;
  }

  private emit<E extends X402Event>(event: E, data: X402EventData[E]): void {
    this.eventHandlers.get(event)?.forEach(handler => {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in ${event} handler:`, error);
      }
    });
  }

  private log(message: string, data?: unknown): void {
    if (this.config.debug) {
      console.log(`[X402Client] ${message}`, data ?? '');
    }
  }
}

// Type augmentation for window.ethereum
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on?: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}
