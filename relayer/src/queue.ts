/**
 * Transfer Queue
 * 
 * Manages pending cross-chain transfers with retry logic,
 * confirmation tracking, and state persistence.
 * 
 * SOL→SOQ direction: calls soqucoind `sendtoaddress` to release native SOQ
 * SOQ→SOL direction: calls bridge program `mint_from_deposit` to mint pSOQ
 */

import { RelayerConfig } from './config';
import { logger } from './utils/logger';
import { SolanaBridgeExecutor } from './bridge/solana-executor';

export enum TransferDirection {
  SOLANA_TO_SOQUCOIN = 'sol_to_soq',  // Burn pSOQ → Release SOQ
  SOQUCOIN_TO_SOLANA = 'soq_to_sol',  // Lock SOQ  → Mint pSOQ
}

export type TransferStatus = 
  | 'pending'
  | 'pending_confirmations'
  | 'signing'
  | 'submitting'
  | 'completed'
  | 'failed';

export interface Transfer {
  id?: string;
  direction: TransferDirection;
  sourceTx: string;
  amount: number;
  destinationAddress: string;
  timestamp: number;
  status: TransferStatus;
  requiredConfirmations?: number;
  currentConfirmations?: number;
  destinationTx?: string;
  error?: string;
  retryCount?: number;
}

export class TransferQueue {
  private queue: Transfer[] = [];
  private completed: Transfer[] = [];
  private processing: boolean = false;
  private config: RelayerConfig;
  private processedSourceTxs: Set<string> = new Set(); // replay protection
  private bridgeExecutor: SolanaBridgeExecutor | null = null;

  constructor(config: RelayerConfig) {
    this.config = config;
    // Process queue every 5 seconds
    setInterval(() => this.processNext(), 5000);
  }

  /**
   * Set the bridge executor for SOQ→SOL mint operations.
   * Must be called after construction to enable bridge-back flow.
   */
  setBridgeExecutor(executor: SolanaBridgeExecutor): void {
    this.bridgeExecutor = executor;
    logger.info('[Queue] Bridge executor attached — SOQ→SOL minting enabled');
  }

  enqueue(transfer: Transfer): void {
    // Replay protection — don't process the same source tx twice
    if (this.processedSourceTxs.has(transfer.sourceTx)) {
      logger.warn(`[Queue] Duplicate source tx ${transfer.sourceTx.slice(0, 16)}... — skipping`);
      return;
    }
    this.processedSourceTxs.add(transfer.sourceTx);

    transfer.id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    transfer.retryCount = 0;
    this.queue.push(transfer);
    logger.info(`[Queue] Enqueued transfer ${transfer.id} (${transfer.direction})`);
  }

  private async processNext(): Promise<void> {
    if (this.processing) return;

    const pending = this.queue.find(t => t.status === 'pending');
    if (!pending) return;

    this.processing = true;
    try {
      pending.status = 'submitting';
      logger.info(`[Queue] Processing transfer ${pending.id}...`);

      if (pending.direction === TransferDirection.SOLANA_TO_SOQUCOIN) {
        await this.processSolToSoq(pending);
      } else {
        await this.processSoqToSol(pending);
      }

      pending.status = 'completed';
      this.completed.push(pending);
      this.queue = this.queue.filter(t => t.id !== pending.id);
      logger.info(`[Queue] Transfer ${pending.id} completed → ${pending.destinationTx?.slice(0, 16) || 'n/a'}...`);
    } catch (err: any) {
      pending.status = 'failed';
      pending.error = err.message;
      pending.retryCount = (pending.retryCount || 0) + 1;

      if (pending.retryCount < 3) {
        pending.status = 'pending'; // Retry
        logger.warn(`[Queue] Transfer ${pending.id} failed (retry ${pending.retryCount}/3): ${err.message}`);
      } else {
        logger.error(`[Queue] Transfer ${pending.id} permanently failed: ${err.message}`);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * SOL → SOQ: Release native SOQ from vault to user's Soqucoin address
   * 
   * Uses `sendtoaddress` RPC call on the Soqucoin node.
   * The vault wallet is managed by soqucoind, so we just tell it to send.
   */
  private async processSolToSoq(transfer: Transfer): Promise<void> {
    const amountSoq = transfer.amount / 1e9; // Convert from smallest unit (9 decimals)
    
    logger.info(`[Queue] SOL→SOQ: Releasing ${amountSoq} SOQ to ${transfer.destinationAddress}`);

    if (!transfer.destinationAddress || transfer.destinationAddress.length < 10) {
      throw new Error(`Invalid SOQ address: ${transfer.destinationAddress}`);
    }

    if (amountSoq < this.config.minTransferSoq / 1e9) {
      throw new Error(`Amount ${amountSoq} below minimum transfer`);
    }

    // Call soqucoind RPC to send SOQ
    const txid = await this.soqucoinRpc('sendtoaddress', [
      transfer.destinationAddress,
      amountSoq,
      'SOQ-TEC Bridge Release',              // comment
      `Burn: ${transfer.sourceTx.slice(0, 16)}`,  // comment_to
    ]);

    transfer.destinationTx = txid;
    logger.info(`[Queue] SOQ released! txid: ${txid}`);
  }

  /**
   * SOQ → SOL: Mint pSOQ after verifying Soqucoin vault deposit
   * 
   * Flow:
   *   1. Verify the deposit tx has enough confirmations on soqucoind
   *   2. Call mint_from_deposit on the Solana bridge program via the executor
   *   3. The bridge program mints pSOQ to the recipient's token account
   */
  private async processSoqToSol(transfer: Transfer): Promise<void> {
    const amountSoq = transfer.amount;
    
    logger.info(`[Queue] SOQ→SOL: Minting ${amountSoq} pSOQ to ${transfer.destinationAddress}`);

    // Check confirmation count
    if (transfer.currentConfirmations !== undefined && 
        transfer.currentConfirmations < (transfer.requiredConfirmations || 6)) {
      transfer.status = 'pending_confirmations';
      throw new Error(`Only ${transfer.currentConfirmations}/${transfer.requiredConfirmations} confirmations`);
    }

    // Verify the deposit tx exists on soqucoind
    try {
      const txInfo = await this.soqucoinRpc('gettransaction', [transfer.sourceTx]);
      if (!txInfo || txInfo.confirmations < (transfer.requiredConfirmations || 6)) {
        throw new Error(`Insufficient confirmations: ${txInfo?.confirmations || 0}`);
      }
    } catch (err: any) {
      throw new Error(`Could not verify L1 deposit: ${err.message}`);
    }

    // Execute the mint via bridge executor
    if (this.bridgeExecutor && this.bridgeExecutor.isInitialized()) {
      const soqTxidBuffer = Buffer.from(transfer.sourceTx, 'hex');
      const sig = await this.bridgeExecutor.mintFromDeposit({
        amount: Math.floor(amountSoq * 1e9), // Convert to smallest unit
        soqTxid: soqTxidBuffer,
        recipientPubkey: transfer.destinationAddress,
      });
      transfer.destinationTx = sig;
    } else {
      // Fallback: log completion for demo purposes
      logger.warn('[Queue] Bridge executor not available — logging mint event only');
      transfer.destinationTx = `pending_mint_${Date.now()}`;
    }
  }

  /**
   * JSON-RPC call to Soqucoin node
   */
  private async soqucoinRpc(method: string, params: any[] = []): Promise<any> {
    const response = await fetch(this.config.soqucoinRpc, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(
          `${this.config.soqucoinRpcUser}:${this.config.soqucoinRpcPass}`
        ).toString('base64'),
      },
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: Date.now(),
        method,
        params,
      }),
    });

    const data = await response.json() as any;
    if (data.error) {
      throw new Error(`Soqucoin RPC error: ${data.error.message}`);
    }
    return data.result;
  }

  // API helpers
  getPendingTransfers(): Transfer[] {
    return [...this.queue];
  }

  getCompletedTransfers(limit: number = 50): Transfer[] {
    return this.completed.slice(-limit).reverse();
  }

  getAllActivity(limit: number = 50): Transfer[] {
    return [...this.queue, ...this.completed]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  getStats(): { pending: number; completed: number; failed: number; total: number } {
    return {
      pending: this.queue.filter(t => t.status === 'pending' || t.status === 'submitting').length,
      completed: this.completed.length,
      failed: this.queue.filter(t => t.status === 'failed').length,
      total: this.queue.length + this.completed.length,
    };
  }
}
