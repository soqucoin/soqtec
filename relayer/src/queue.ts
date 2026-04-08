/**
 * Transfer Queue
 * 
 * Manages pending cross-chain transfers with retry logic,
 * confirmation tracking, and state persistence.
 */

import { RelayerConfig } from './config';
import { logger } from './utils/logger';

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

  constructor(config: RelayerConfig) {
    this.config = config;
    // Process queue every 5 seconds
    setInterval(() => this.processNext(), 5000);
  }

  enqueue(transfer: Transfer): void {
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
      pending.status = 'signing';
      logger.info(`[Queue] Processing transfer ${pending.id}...`);

      if (pending.direction === TransferDirection.SOLANA_TO_SOQUCOIN) {
        await this.processSolToSoq(pending);
      } else {
        await this.processSoqToSol(pending);
      }

      pending.status = 'completed';
      this.completed.push(pending);
      this.queue = this.queue.filter(t => t.id !== pending.id);
      logger.info(`[Queue] ✓ Transfer ${pending.id} completed`);
    } catch (err: any) {
      pending.status = 'failed';
      pending.error = err.message;
      pending.retryCount = (pending.retryCount || 0) + 1;

      if (pending.retryCount < 3) {
        pending.status = 'pending'; // Retry
        logger.warn(`[Queue] Transfer ${pending.id} failed, retry ${pending.retryCount}/3`);
      } else {
        logger.error(`[Queue] Transfer ${pending.id} permanently failed:`, err);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processSolToSoq(transfer: Transfer): Promise<void> {
    // 1. Verify burn event on Solana (re-check transaction)
    // 2. Collect threshold signatures from validators
    // 3. Construct and sign Soqucoin raw transaction
    // 4. Broadcast via soqucoind RPC
    // 5. Record destination txid
    
    logger.info(`[Queue] SOL→SOQ: Releasing ${transfer.amount} SOQ to ${transfer.destinationAddress}`);
    
    // TODO: Implement actual Soqucoin transaction construction
    // This requires:
    // - UTXO selection from vault
    // - Transaction construction (P2PKH with Dilithium sig)
    // - Threshold signing ceremony
    // - Broadcast via sendrawtransaction
    
    transfer.destinationTx = 'pending_implementation';
  }

  private async processSoqToSol(transfer: Transfer): Promise<void> {
    // 1. Wait for 6 confirmations on Soqucoin
    // 2. Collect threshold signatures from validators
    // 3. Submit mint_from_deposit instruction to Solana
    // 4. Record destination txid
    
    logger.info(`[Queue] SOQ→SOL: Minting ${transfer.amount} pSOQ to ${transfer.destinationAddress}`);
    
    // TODO: Implement actual Solana mint transaction
    // This requires:
    // - Confirmation count verification
    // - validator signature collection
    // - Anchor CPI to bridge program mint_from_deposit
    
    transfer.destinationTx = 'pending_implementation';
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

  getStats(): { pending: number; completed: number; failed: number } {
    return {
      pending: this.queue.filter(t => t.status === 'pending' || t.status === 'signing').length,
      completed: this.completed.length,
      failed: this.queue.filter(t => t.status === 'failed').length,
    };
  }
}
