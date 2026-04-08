/**
 * Solana Chain Watcher
 * 
 * Monitors the SOQ-TEC bridge program on Solana for BurnForRedemption events.
 * When a burn is detected, it queues a SOQ release on the Soqucoin side.
 */

import { Connection, PublicKey, ConfirmedSignatureInfo } from '@solana/web3.js';
import { RelayerConfig } from '../config';
import { TransferQueue, TransferDirection } from '../queue';
import { logger } from '../utils/logger';

export interface BurnEvent {
  user: string;
  amount: number;
  netAmount: number;
  fee: number;
  soqAddress: string;
  nonce: number;
  timestamp: number;
  txSignature: string;
}

export class SolanaWatcher {
  private connection: Connection;
  private programId: PublicKey;
  private queue: TransferQueue;
  private config: RelayerConfig;
  private polling: NodeJS.Timer | null = null;
  private lastSignature: string | null = null;
  private burnEvents: BurnEvent[] = [];

  constructor(config: RelayerConfig, queue: TransferQueue) {
    this.config = config;
    this.queue = queue;
    this.connection = new Connection(config.solanaRpc, 'confirmed');
    this.programId = new PublicKey(config.solanaProgramId);
  }

  async start(): Promise<void> {
    logger.info('[Solana] Starting watcher...');
    logger.info(`[Solana] Program: ${this.programId.toString()}`);
    logger.info(`[Solana] Poll interval: ${this.config.solanaPollInterval}ms`);

    // Get latest signature as starting point
    const sigs = await this.connection.getSignaturesForAddress(
      this.programId,
      { limit: 1 }
    );
    if (sigs.length > 0) {
      this.lastSignature = sigs[0].signature;
      logger.info(`[Solana] Starting from signature: ${this.lastSignature.slice(0, 16)}...`);
    }

    // Start polling for new transactions
    this.polling = setInterval(() => this.poll(), this.config.solanaPollInterval);
  }

  async stop(): Promise<void> {
    if (this.polling) {
      clearInterval(this.polling);
      this.polling = null;
    }
    logger.info('[Solana] Watcher stopped');
  }

  private async poll(): Promise<void> {
    try {
      const options: any = { limit: 20 };
      if (this.lastSignature) {
        options.until = this.lastSignature;
      }

      const sigs = await this.connection.getSignaturesForAddress(
        this.programId,
        options
      );

      if (sigs.length === 0) return;

      // Process newest first
      for (const sigInfo of sigs.reverse()) {
        await this.processTransaction(sigInfo);
      }

      this.lastSignature = sigs[0].signature;
    } catch (err) {
      logger.error('[Solana] Poll error:', err);
    }
  }

  private async processTransaction(sigInfo: ConfirmedSignatureInfo): Promise<void> {
    try {
      const tx = await this.connection.getTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx || !tx.meta || tx.meta.err) return;

      // Parse program logs for BurnForRedemption events
      const logs = tx.meta.logMessages || [];
      const burnLog = logs.find(log => log.includes('BurnForRedemptionEvent'));

      if (burnLog) {
        // TODO: Decode actual event data from transaction
        // For now, log the detection
        const burnEvent: BurnEvent = {
          user: '', // Extract from tx accounts
          amount: 0, // Extract from event data
          netAmount: 0,
          fee: 0,
          soqAddress: '',
          nonce: 0,
          timestamp: tx.blockTime || Date.now() / 1000,
          txSignature: sigInfo.signature,
        };

        this.burnEvents.push(burnEvent);
        logger.info(`[Solana] 🔥 Burn detected: ${sigInfo.signature.slice(0, 16)}...`);

        // Queue SOQ release on Soqucoin
        this.queue.enqueue({
          direction: TransferDirection.SOLANA_TO_SOQUCOIN,
          sourceTx: sigInfo.signature,
          amount: burnEvent.netAmount,
          destinationAddress: burnEvent.soqAddress,
          timestamp: Date.now(),
          status: 'pending',
        });
      }
    } catch (err) {
      logger.error(`[Solana] Error processing tx ${sigInfo.signature}:`, err);
    }
  }

  // API helpers
  getRecentBurns(limit: number = 20): BurnEvent[] {
    return this.burnEvents.slice(-limit).reverse();
  }

  getTotalBurned(): number {
    return this.burnEvents.reduce((sum, e) => sum + e.amount, 0);
  }

  isRunning(): boolean {
    return this.polling !== null;
  }
}
