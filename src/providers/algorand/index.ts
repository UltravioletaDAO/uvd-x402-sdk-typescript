/**
 * uvd-x402-sdk - Algorand Provider
 *
 * Provides wallet connection and payment creation for Algorand via Pera Wallet.
 * Uses ASA (Algorand Standard Assets) transfers for USDC payments.
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
 * // Connect to Pera Wallet
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

async function loadAlgorandDeps() {
  if (!algosdk) {
    algosdk = await import('algosdk');
  }
  if (!PeraWalletConnect) {
    const peraModule = await import('@perawallet/connect');
    PeraWalletConnect = peraModule.PeraWalletConnect;
  }
}

/**
 * AlgorandProvider - Wallet adapter for Algorand via Pera Wallet
 *
 * Supports both mainnet and testnet through chain configuration.
 */
export class AlgorandProvider implements WalletAdapter {
  readonly id = 'pera';
  readonly name = 'Pera Wallet';
  readonly networkType = 'algorand' as const;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private peraWallet: any = null;
  private address: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private algodClients: Map<string, any> = new Map();

  /**
   * Check if Pera Wallet is available
   * Note: Pera works as a WalletConnect modal, so it's always "available"
   */
  isAvailable(): boolean {
    return typeof window !== 'undefined';
  }

  /**
   * Connect to Pera Wallet
   */
  async connect(_chainName?: string): Promise<string> {
    await loadAlgorandDeps();

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
        return accounts[0];
      }

      // If no previous session, connect fresh
      const newAccounts = await this.peraWallet.connect();

      if (newAccounts.length === 0) {
        throw new X402Error('No accounts returned from Pera Wallet', 'WALLET_CONNECTION_REJECTED');
      }

      this.address = newAccounts[0];

      // Set up disconnect handler
      this.peraWallet.connector?.on('disconnect', () => {
        this.address = null;
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
   * Disconnect from Pera Wallet
   */
  async disconnect(): Promise<void> {
    if (this.peraWallet) {
      try {
        await this.peraWallet.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
    this.peraWallet = null;
    this.address = null;
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

    if (!this.peraWallet || !this.address) {
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

      // Sign with Pera Wallet
      const signedTxns = await this.peraWallet.signTransaction([[{ txn }]]);

      if (!signedTxns || signedTxns.length === 0) {
        throw new X402Error('No signed transaction returned', 'SIGNATURE_REJECTED');
      }

      const signedTxn = signedTxns[0];

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
