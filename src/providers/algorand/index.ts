/**
 * uvd-x402-sdk - Algorand Provider
 *
 * Provides wallet connection and payment creation for Algorand.
 * Supports both Lute Wallet (desktop browser extension) and Pera Wallet (mobile).
 * Uses ASA (Algorand Standard Assets) transfers for USDC payments.
 *
 * Wallet Priority:
 * 1. Lute Wallet - Desktop browser extension (preferred for desktop)
 * 2. Pera Wallet - Mobile via WalletConnect (fallback/mobile)
 *
 * USDC ASA IDs:
 * - Mainnet: 31566704
 * - Testnet: 10458941
 *
 * @example
 * ```ts
 * import { AlgorandProvider } from 'uvd-x402-sdk/algorand';
 * import { getChainByName } from 'uvd-x402-sdk';
 *
 * const algorand = new AlgorandProvider();
 *
 * // Connect to Lute (desktop) or Pera (mobile) automatically
 * const address = await algorand.connect();
 *
 * // Create Algorand payment
 * const chainConfig = getChainByName('algorand')!;
 * const paymentPayload = await algorand.signPayment(paymentInfo, chainConfig);
 * const header = algorand.encodePaymentHeader(paymentPayload, chainConfig);
 * ```
 */

import type {
  ChainConfig,
  PaymentInfo,
  AlgorandPaymentPayload,
  WalletAdapter,
  X402Version,
} from '../../types';
import { X402Error } from '../../types';
import { getChainByName } from '../../chains';
import { chainToCAIP2 } from '../../utils';

/**
 * Browser-compatible base64 encoding for Uint8Array
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Lazy import Algorand dependencies
let algosdk: typeof import('algosdk') | null = null;
let PeraWalletConnect: typeof import('@perawallet/connect').PeraWalletConnect | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let LuteConnect: any = null;

async function loadAlgorandDeps() {
  if (!algosdk) {
    algosdk = await import('algosdk');
  }
}

async function loadPeraWallet() {
  if (!PeraWalletConnect) {
    const peraModule = await import('@perawallet/connect');
    PeraWalletConnect = peraModule.PeraWalletConnect;
  }
}

async function loadLuteWallet() {
  if (!LuteConnect) {
    try {
      const luteModule = await import('lute-connect');
      LuteConnect = luteModule.default;
    } catch {
      // Lute not installed, will fall back to Pera
      LuteConnect = null;
    }
  }
}

/**
 * Check if Lute wallet extension is installed
 */
function isLuteAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  // Lute injects itself into window.algorand or window.lute
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;
  return !!(win.algorand || win.lute);
}

/**
 * AlgorandProvider - Wallet adapter for Algorand
 *
 * Supports Lute Wallet (desktop) and Pera Wallet (mobile).
 * Automatically detects and uses the best available wallet.
 */
export class AlgorandProvider implements WalletAdapter {
  readonly id = 'algorand';
  readonly name = 'Algorand Wallet';
  readonly networkType = 'algorand' as const;

  // Active wallet type
  private walletType: 'lute' | 'pera' | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private luteWallet: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private peraWallet: any = null;
  private address: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private algodClients: Map<string, any> = new Map();

  /**
   * Check if any Algorand wallet is available
   * Returns true if Lute extension is installed OR we can use Pera (always available via WalletConnect)
   */
  isAvailable(): boolean {
    return typeof window !== 'undefined';
  }

  /**
   * Get the name of the currently connected wallet
   */
  getWalletName(): string {
    if (this.walletType === 'lute') return 'Lute Wallet';
    if (this.walletType === 'pera') return 'Pera Wallet';
    return 'Algorand Wallet';
  }

  /**
   * Connect to Algorand wallet
   * Priority: Lute (desktop extension) > Pera (mobile via WalletConnect)
   */
  async connect(_chainName?: string): Promise<string> {
    await loadAlgorandDeps();

    // Try Lute first (better desktop UX)
    if (isLuteAvailable()) {
      try {
        return await this.connectLute();
      } catch (error) {
        // Lute failed, try Pera
        console.warn('Lute connection failed, falling back to Pera:', error);
      }
    }

    // Fall back to Pera (mobile/WalletConnect)
    return await this.connectPera();
  }

  /**
   * Connect to Lute Wallet (desktop browser extension)
   */
  private async connectLute(): Promise<string> {
    await loadLuteWallet();

    if (!LuteConnect) {
      throw new X402Error('Lute Wallet SDK not available', 'WALLET_NOT_FOUND');
    }

    try {
      this.luteWallet = new LuteConnect('402milly');

      // Get Algorand genesis ID for mainnet
      const genesisId = 'mainnet-v1.0';

      // Connect and get accounts
      const accounts = await this.luteWallet.connect(genesisId);

      if (!accounts || accounts.length === 0) {
        throw new X402Error('No accounts returned from Lute Wallet', 'WALLET_CONNECTION_REJECTED');
      }

      this.address = accounts[0];
      this.walletType = 'lute';

      return accounts[0];
    } catch (error: unknown) {
      if (error instanceof X402Error) throw error;
      if (error instanceof Error) {
        if (error.message.includes('rejected') || error.message.includes('cancelled')) {
          throw new X402Error('Connection rejected by user', 'WALLET_CONNECTION_REJECTED');
        }
      }
      throw new X402Error(
        `Failed to connect Lute Wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'UNKNOWN_ERROR',
        error
      );
    }
  }

  /**
   * Connect to Pera Wallet (mobile via WalletConnect)
   */
  private async connectPera(): Promise<string> {
    await loadPeraWallet();

    if (!PeraWalletConnect) {
      throw new X402Error('Failed to load Pera Wallet SDK', 'WALLET_NOT_FOUND');
    }

    try {
      // Create Pera Wallet instance
      this.peraWallet = new PeraWalletConnect!();

      // Try to reconnect from previous session
      const accounts = await this.peraWallet.reconnectSession();

      if (accounts.length > 0) {
        this.address = accounts[0];
        this.walletType = 'pera';
        return accounts[0];
      }

      // If no previous session, connect fresh
      const newAccounts = await this.peraWallet.connect();

      if (newAccounts.length === 0) {
        throw new X402Error('No accounts returned from Pera Wallet', 'WALLET_CONNECTION_REJECTED');
      }

      this.address = newAccounts[0];
      this.walletType = 'pera';

      // Set up disconnect handler
      this.peraWallet.connector?.on('disconnect', () => {
        this.address = null;
        this.walletType = null;
      });

      return newAccounts[0];
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (error.message.includes('rejected') || error.message.includes('cancelled')) {
          throw new X402Error('Connection rejected by user', 'WALLET_CONNECTION_REJECTED');
        }
      }
      throw new X402Error(
        `Failed to connect Pera Wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'UNKNOWN_ERROR',
        error
      );
    }
  }

  /**
   * Disconnect from wallet
   */
  async disconnect(): Promise<void> {
    if (this.walletType === 'lute' && this.luteWallet) {
      try {
        // Lute doesn't have a disconnect method, just clear state
      } catch {
        // Ignore disconnect errors
      }
      this.luteWallet = null;
    }
    if (this.walletType === 'pera' && this.peraWallet) {
      try {
        await this.peraWallet.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.peraWallet = null;
    }
    this.address = null;
    this.walletType = null;
    this.algodClients.clear();
  }

  /**
   * Get current address
   */
  getAddress(): string | null {
    return this.address;
  }

  /**
   * Get USDC (ASA) balance
   */
  async getBalance(chainConfig: ChainConfig): Promise<string> {
    await loadAlgorandDeps();

    if (!this.address) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    const algodClient = await this.getAlgodClient(chainConfig);
    const assetId = parseInt(chainConfig.usdc.address, 10);

    try {
      const accountInfo = await algodClient.accountInformation(this.address).do();

      // Find the USDC asset in the account's assets
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const assets: any[] = accountInfo.assets || accountInfo['assets'] || [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const usdcAsset = assets.find((asset: any) =>
        (asset.assetId || asset['asset-id']) === assetId
      );

      if (!usdcAsset) {
        return '0.00'; // Account not opted into USDC
      }

      const amount = Number(usdcAsset.amount || usdcAsset['amount']);
      const balance = amount / Math.pow(10, chainConfig.usdc.decimals);
      return balance.toFixed(2);
    } catch {
      return '0.00';
    }
  }

  /**
   * Create Algorand ASA transfer payment
   *
   * Transaction structure:
   * 1. ASA Transfer from user to recipient
   * 2. Facilitator pays transaction fees
   */
  async signPayment(paymentInfo: PaymentInfo, chainConfig: ChainConfig): Promise<string> {
    await loadAlgorandDeps();

    if (!this.address || !this.walletType) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    if (!algosdk) {
      throw new X402Error('Algorand SDK not loaded', 'UNKNOWN_ERROR');
    }

    const algodClient = await this.getAlgodClient(chainConfig);

    // Get recipient address (use algorand-specific or fallback to default)
    const recipient = paymentInfo.recipients?.algorand || paymentInfo.recipient;
    const assetId = parseInt(chainConfig.usdc.address, 10);

    // Parse amount (6 decimals for USDC)
    const amount = Math.floor(parseFloat(paymentInfo.amount) * 1_000_000);

    try {
      // Get suggested transaction parameters
      const suggestedParams = await algodClient.getTransactionParams().do();

      // Create ASA transfer transaction
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: this.address,
        receiver: recipient,
        amount: BigInt(amount),
        assetIndex: assetId,
        suggestedParams: suggestedParams,
        note: new TextEncoder().encode('x402 payment via uvd-x402-sdk'),
      } as any);

      // Sign with the active wallet (Lute or Pera)
      let signedTxn: Uint8Array;

      if (this.walletType === 'lute' && this.luteWallet) {
        // Lute uses signTxns with base64 encoded transactions
        const txnBase64 = uint8ArrayToBase64(txn.toByte());
        const signedTxns = await this.luteWallet.signTxns([{ txn: txnBase64 }]);
        if (!signedTxns || signedTxns.length === 0 || !signedTxns[0]) {
          throw new X402Error('No signed transaction returned', 'SIGNATURE_REJECTED');
        }
        // Lute returns base64 encoded signed transaction
        signedTxn = Uint8Array.from(atob(signedTxns[0]), c => c.charCodeAt(0));
      } else if (this.walletType === 'pera' && this.peraWallet) {
        // Pera uses signTransaction with transaction objects
        const signedTxns = await this.peraWallet.signTransaction([[{ txn }]]);
        if (!signedTxns || signedTxns.length === 0) {
          throw new X402Error('No signed transaction returned', 'SIGNATURE_REJECTED');
        }
        signedTxn = signedTxns[0];
      } else {
        throw new X402Error('No wallet available for signing', 'WALLET_NOT_CONNECTED');
      }

      const payload: AlgorandPaymentPayload = {
        from: this.address,
        to: recipient,
        amount: amount.toString(),
        assetId: assetId,
        signedTxn: uint8ArrayToBase64(signedTxn),
      };

      return JSON.stringify(payload);
    } catch (error: unknown) {
      if (error instanceof X402Error) {
        throw error;
      }
      if (error instanceof Error) {
        if (error.message.includes('rejected') || error.message.includes('cancelled')) {
          throw new X402Error('Signature rejected by user', 'SIGNATURE_REJECTED');
        }
      }
      throw new X402Error(
        `Failed to sign transaction: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PAYMENT_FAILED',
        error
      );
    }
  }

  /**
   * Encode Algorand payment as X-PAYMENT header
   *
   * @param paymentPayload - JSON-encoded payment payload from signPayment()
   * @param chainConfig - Chain configuration
   * @param version - x402 protocol version (1 or 2, defaults to 1)
   * @returns Base64-encoded X-PAYMENT header value
   */
  encodePaymentHeader(
    paymentPayload: string,
    chainConfig?: ChainConfig,
    version: X402Version = 1
  ): string {
    const payload = JSON.parse(paymentPayload) as AlgorandPaymentPayload;

    // Use chain name from config, or default to 'algorand'
    const networkName = chainConfig?.name || 'algorand';

    // Build the payload data
    const payloadData = {
      from: payload.from,
      to: payload.to,
      amount: payload.amount,
      assetId: payload.assetId,
      signedTxn: payload.signedTxn,
      ...(payload.note && { note: payload.note }),
    };

    // Format in x402 standard format (v1 or v2)
    const x402Payload = version === 2
      ? {
          x402Version: 2 as const,
          scheme: 'exact' as const,
          network: chainToCAIP2(networkName), // CAIP-2 format for v2
          payload: payloadData,
        }
      : {
          x402Version: 1 as const,
          scheme: 'exact' as const,
          network: networkName, // Plain chain name for v1
          payload: payloadData,
        };

    return btoa(JSON.stringify(x402Payload));
  }

  // Private helpers

  /**
   * Get or create an Algod client for a specific chain
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getAlgodClient(chainConfig?: ChainConfig): Promise<any> {
    await loadAlgorandDeps();

    if (!algosdk) {
      throw new X402Error('Algorand SDK not loaded', 'UNKNOWN_ERROR');
    }

    const config = chainConfig || getChainByName('algorand');
    if (!config) {
      throw new X402Error('Chain config not found', 'CHAIN_NOT_SUPPORTED');
    }

    // Cache by RPC URL
    const cacheKey = config.rpcUrl;

    if (this.algodClients.has(cacheKey)) {
      return this.algodClients.get(cacheKey)!;
    }

    // Create new Algod client
    // Algonode.cloud doesn't require auth token
    const client = new algosdk.Algodv2('', config.rpcUrl, '');
    this.algodClients.set(cacheKey, client);

    return client;
  }
}

// Default export
export default AlgorandProvider;
