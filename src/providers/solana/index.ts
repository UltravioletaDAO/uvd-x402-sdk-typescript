/**
 * uvd-x402-sdk - SVM Provider (Solana Virtual Machine)
 *
 * Provides wallet connection and payment creation for SVM-based chains via Phantom.
 * Supports: Solana, Fogo
 * Uses partially-signed transactions where the facilitator is the fee payer.
 *
 * @example Solana
 * ```ts
 * import { SVMProvider } from 'uvd-x402-sdk/solana';
 * import { getChainByName } from 'uvd-x402-sdk';
 *
 * const svm = new SVMProvider();
 *
 * // Connect
 * const address = await svm.connect();
 *
 * // Create Solana payment
 * const chainConfig = getChainByName('solana')!;
 * const paymentPayload = await svm.signPayment(paymentInfo, chainConfig);
 * const header = svm.encodePaymentHeader(paymentPayload, chainConfig);
 * ```
 *
 * @example Fogo
 * ```ts
 * import { SVMProvider } from 'uvd-x402-sdk/solana';
 * import { getChainByName } from 'uvd-x402-sdk';
 *
 * const svm = new SVMProvider();
 *
 * // Connect (same wallet works for all SVM chains)
 * const address = await svm.connect();
 *
 * // Create Fogo payment
 * const chainConfig = getChainByName('fogo')!;
 * const paymentPayload = await svm.signPayment(paymentInfo, chainConfig);
 * const header = svm.encodePaymentHeader(paymentPayload, chainConfig);
 * ```
 */

import type {
  ChainConfig,
  PaymentInfo,
  SolanaPaymentPayload,
  WalletAdapter,
} from '../../types';
import { X402Error } from '../../types';
import { getChainByName } from '../../chains';

// Lazy import Solana dependencies to avoid bundling when not used
let Connection: typeof import('@solana/web3.js').Connection;
let PublicKey: typeof import('@solana/web3.js').PublicKey;
let TransactionMessage: typeof import('@solana/web3.js').TransactionMessage;
let VersionedTransaction: typeof import('@solana/web3.js').VersionedTransaction;
let ComputeBudgetProgram: typeof import('@solana/web3.js').ComputeBudgetProgram;
let getAssociatedTokenAddress: typeof import('@solana/spl-token').getAssociatedTokenAddress;
let createTransferCheckedInstruction: typeof import('@solana/spl-token').createTransferCheckedInstruction;
let createAssociatedTokenAccountIdempotentInstruction: typeof import('@solana/spl-token').createAssociatedTokenAccountIdempotentInstruction;
let TOKEN_PROGRAM_ID: typeof import('@solana/spl-token').TOKEN_PROGRAM_ID;

async function loadSolanaDeps() {
  if (!Connection) {
    const web3 = await import('@solana/web3.js');
    const splToken = await import('@solana/spl-token');
    Connection = web3.Connection;
    PublicKey = web3.PublicKey;
    TransactionMessage = web3.TransactionMessage;
    VersionedTransaction = web3.VersionedTransaction;
    ComputeBudgetProgram = web3.ComputeBudgetProgram;
    getAssociatedTokenAddress = splToken.getAssociatedTokenAddress;
    createTransferCheckedInstruction = splToken.createTransferCheckedInstruction;
    createAssociatedTokenAccountIdempotentInstruction = splToken.createAssociatedTokenAccountIdempotentInstruction;
    TOKEN_PROGRAM_ID = splToken.TOKEN_PROGRAM_ID;
  }
}

/**
 * Phantom wallet provider interface
 */
interface PhantomProvider {
  isPhantom?: boolean;
  isConnected?: boolean;
  publicKey?: { toBase58(): string };
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  disconnect(): Promise<void>;
  signTransaction<T>(transaction: T): Promise<T>;
}

/**
 * SVMProvider - Wallet adapter for SVM chains (Solana, Fogo) via Phantom
 *
 * @alias SolanaProvider for backward compatibility
 */
export class SVMProvider implements WalletAdapter {
  readonly id = 'phantom';
  readonly name = 'Phantom';
  readonly networkType = 'svm' as const;

  private provider: PhantomProvider | null = null;
  private publicKey: InstanceType<typeof PublicKey> | null = null;
  private connections: Map<string, InstanceType<typeof Connection>> = new Map();
  private address: string | null = null;

  /**
   * Check if Phantom wallet is available
   */
  isAvailable(): boolean {
    if (typeof window === 'undefined') return false;
    return !!(
      (window as Window & { phantom?: { solana?: PhantomProvider } }).phantom?.solana?.isPhantom ||
      (window as Window & { solana?: PhantomProvider }).solana?.isPhantom
    );
  }

  /**
   * Connect to Phantom wallet
   */
  async connect(): Promise<string> {
    await loadSolanaDeps();

    // Get Phantom provider
    this.provider = await this.getPhantomProvider();
    if (!this.provider) {
      throw new X402Error(
        'Phantom wallet not installed. Please install from phantom.app',
        'WALLET_NOT_FOUND'
      );
    }

    try {
      // Check if already connected
      if (this.provider.publicKey && this.provider.isConnected) {
        const publicKeyString = this.provider.publicKey.toBase58();
        this.publicKey = new PublicKey(publicKeyString);
        this.address = publicKeyString;
        await this.initConnection();
        return publicKeyString;
      }

      // Connect
      const resp = await this.provider.connect();
      const publicKeyString = resp.publicKey.toBase58();

      this.publicKey = new PublicKey(publicKeyString);
      this.address = publicKeyString;

      await this.initConnection();

      return publicKeyString;
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (error.message.includes('User rejected') || (error as { code?: number }).code === 4001) {
          throw new X402Error('Connection rejected by user', 'WALLET_CONNECTION_REJECTED');
        }
      }
      throw new X402Error(
        `Failed to connect Phantom: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'UNKNOWN_ERROR',
        error
      );
    }
  }

  /**
   * Disconnect from Phantom
   */
  async disconnect(): Promise<void> {
    if (this.provider) {
      try {
        await this.provider.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
    this.provider = null;
    this.publicKey = null;
    this.connections.clear();
    this.address = null;
  }

  /**
   * Get current address
   */
  getAddress(): string | null {
    return this.address;
  }

  /**
   * Get USDC balance
   */
  async getBalance(chainConfig: ChainConfig): Promise<string> {
    await loadSolanaDeps();

    if (!this.address) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    await this.initConnection(chainConfig);
    if (!this.connection) {
      throw new X402Error('Failed to connect to Solana RPC', 'NETWORK_ERROR');
    }

    try {
      const response = await fetch(chainConfig.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [
            this.address,
            { mint: chainConfig.usdc.address },
            { encoding: 'jsonParsed' },
          ],
        }),
      });

      const data = await response.json();

      if (!data.result?.value?.length) {
        return '0.00';
      }

      const tokenAccountInfo = data.result.value[0].account.data.parsed.info;
      const balance = Number(tokenAccountInfo.tokenAmount.amount) / Math.pow(10, tokenAccountInfo.tokenAmount.decimals);

      return balance.toFixed(2);
    } catch {
      return '0.00';
    }
  }

  /**
   * Create SVM payment (partially-signed transaction)
   *
   * Works for both Solana and Fogo chains.
   *
   * Transaction structure required by facilitator:
   * 1. SetComputeUnitLimit
   * 2. SetComputeUnitPrice
   * 3. (Optional) CreateAssociatedTokenAccount if recipient ATA doesn't exist
   * 4. TransferChecked (USDC transfer)
   *
   * Fee payer: Facilitator (not user)
   * User pays: ZERO SOL/FOGO
   */
  async signPayment(paymentInfo: PaymentInfo, chainConfig: ChainConfig): Promise<string> {
    await loadSolanaDeps();

    if (!this.provider || !this.publicKey || !this.address) {
      throw new X402Error('Wallet not connected', 'WALLET_NOT_CONNECTED');
    }

    const connection = await this.getConnection(chainConfig);
    if (!connection) {
      throw new X402Error(`Failed to connect to ${chainConfig.displayName} RPC`, 'NETWORK_ERROR');
    }

    // Get recipient and facilitator addresses
    const recipient = paymentInfo.recipients?.solana || paymentInfo.recipient;
    const facilitatorAddress = paymentInfo.facilitator;

    if (!facilitatorAddress) {
      throw new X402Error('Facilitator address not provided', 'INVALID_CONFIG');
    }

    const recipientPubkey = new PublicKey(recipient);
    const facilitatorPubkey = new PublicKey(facilitatorAddress);
    const usdcMint = new PublicKey(chainConfig.usdc.address);

    // Parse amount (6 decimals for USDC)
    const amount = Math.floor(parseFloat(paymentInfo.amount) * 1_000_000);

    // Get token accounts
    const fromTokenAccount = await getAssociatedTokenAddress(
      usdcMint,
      this.publicKey,
      true,
      TOKEN_PROGRAM_ID
    );

    const toTokenAccount = await getAssociatedTokenAddress(
      usdcMint,
      recipientPubkey,
      true,
      TOKEN_PROGRAM_ID
    );

    // Check if recipient ATA exists
    const toTokenAccountInfo = await connection.getAccountInfo(toTokenAccount);
    const needsATACreation = toTokenAccountInfo === null;

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash('finalized');

    // Build instructions in exact order required by facilitator
    const instructions = [];

    // Instruction 0: SetComputeUnitLimit
    instructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: needsATACreation ? 50_000 : 20_000,
      })
    );

    // Instruction 1: SetComputeUnitPrice
    instructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 1,
      })
    );

    // Instruction 2 (optional): CreateAssociatedTokenAccountIdempotent
    // User pays for ATA creation (not facilitator - security check in x402-rs)
    if (needsATACreation) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          this.publicKey, // User pays for ATA creation
          toTokenAccount,
          recipientPubkey,
          usdcMint,
          TOKEN_PROGRAM_ID
        )
      );
    }

    // Instruction 2/3: TransferChecked
    instructions.push(
      createTransferCheckedInstruction(
        fromTokenAccount,
        usdcMint,
        toTokenAccount,
        this.publicKey,
        amount,
        6,
        [],
        TOKEN_PROGRAM_ID
      )
    );

    // Build VersionedTransaction with facilitator as fee payer
    const messageV0 = new TransactionMessage({
      payerKey: facilitatorPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);

    // User signs (partial signature - facilitator will co-sign)
    let signedTransaction: InstanceType<typeof VersionedTransaction>;
    try {
      signedTransaction = await this.provider.signTransaction(transaction);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('User rejected')) {
        throw new X402Error('Signature rejected by user', 'SIGNATURE_REJECTED');
      }
      throw new X402Error(
        `Failed to sign transaction: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PAYMENT_FAILED',
        error
      );
    }

    // Serialize partially-signed transaction
    const serialized = signedTransaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    const payload: SolanaPaymentPayload = {
      transaction: Buffer.from(serialized).toString('base64'),
    };

    return JSON.stringify(payload);
  }

  /**
   * Encode SVM payment as X-PAYMENT header
   *
   * @param paymentPayload - The payment payload JSON string
   * @param chainConfig - Optional chain config (defaults to 'solana' if not provided)
   */
  encodePaymentHeader(paymentPayload: string, chainConfig?: ChainConfig): string {
    const payload = JSON.parse(paymentPayload) as SolanaPaymentPayload;

    // Use chain name from config, or default to 'solana' for backward compatibility
    const networkName = chainConfig?.name || 'solana';

    const x402Payload = {
      x402Version: 1,
      scheme: 'exact',
      network: networkName,
      payload: {
        transaction: payload.transaction,
      },
    };

    return btoa(JSON.stringify(x402Payload));
  }

  // Private helpers

  private async getPhantomProvider(): Promise<PhantomProvider | null> {
    if (typeof window === 'undefined') return null;

    // Try window.phantom.solana first
    const win = window as Window & {
      phantom?: { solana?: PhantomProvider };
      solana?: PhantomProvider;
    };

    if (win.phantom?.solana?.isPhantom) {
      return win.phantom.solana;
    }

    // Fallback to window.solana
    if (win.solana?.isPhantom) {
      return win.solana;
    }

    // Wait a bit for Phantom to inject itself
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (win.phantom?.solana?.isPhantom) {
        return win.phantom.solana;
      }
      if (win.solana?.isPhantom) {
        return win.solana;
      }
    }

    return null;
  }

  /**
   * Get or create a connection for a specific chain
   */
  private async getConnection(chainConfig?: ChainConfig): Promise<InstanceType<typeof Connection>> {
    await loadSolanaDeps();

    const config = chainConfig || getChainByName('solana');
    if (!config) {
      throw new X402Error('Chain config not found', 'CHAIN_NOT_SUPPORTED');
    }

    // Check if we already have a connection for this chain
    if (this.connections.has(config.name)) {
      return this.connections.get(config.name)!;
    }

    // Create new connection for this chain
    const connection = new Connection(config.rpcUrl, 'confirmed');
    this.connections.set(config.name, connection);

    return connection;
  }

  /**
   * @deprecated Use getConnection instead
   */
  private async initConnection(chainConfig?: ChainConfig): Promise<void> {
    await this.getConnection(chainConfig);
  }
}

/**
 * @deprecated Use SVMProvider instead
 */
export class SolanaProvider extends SVMProvider {
  constructor() {
    super();
    console.warn('SolanaProvider is deprecated. Use SVMProvider instead.');
  }
}

// Export both for backward compatibility
export { SVMProvider, SolanaProvider };
export default SVMProvider;
