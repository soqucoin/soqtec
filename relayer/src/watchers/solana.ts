/**
 * Solana Chain Watcher
 * 
 * Monitors the SOQ-TEC bridge program on Solana for BurnForRedemption events.
 * When a burn is detected, it decodes the event data and queues a SOQ release
 * on the Soqucoin side.
 * 
 * Uses Anchor's event parsing to decode BurnForRedemptionEvent from tx logs.
 */

import { Connection, PublicKey, ConfirmedSignatureInfo } from '@solana/web3.js';
import { Program, AnchorProvider, BorshCoder, EventParser } from '@coral-xyz/anchor';
import { RelayerConfig } from '../config';
import { TransferQueue, TransferDirection } from '../queue';
import { logger } from '../utils/logger';
import idl from '../idl/soqtec_bridge.json';

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
  private polling: ReturnType<typeof setInterval> | null = null;
  private lastSignature: string | null = null;
  private burnEvents: BurnEvent[] = [];
  private eventParser: EventParser;

  constructor(config: RelayerConfig, queue: TransferQueue) {
    this.config = config;
    this.queue = queue;
    this.connection = new Connection(config.solanaRpc, 'confirmed');
    this.programId = new PublicKey(config.solanaProgramId);
    
    // Set up Anchor event parser using the IDL
    const coder = new BorshCoder(idl as any);
    this.eventParser = new EventParser(this.programId, coder);
  }

  async start(): Promise<void> {
    logger.info('[Solana] Starting watcher...');
    logger.info(`[Solana] Program: ${this.programId.toString()}`);
    logger.info(`[Solana] Poll interval: ${this.config.solanaPollInterval}ms`);

    // Get latest signature as starting point
    try {
      const sigs = await this.connection.getSignaturesForAddress(
        this.programId,
        { limit: 1 }
      );
      if (sigs.length > 0) {
        this.lastSignature = sigs[0].signature;
        logger.info(`[Solana] Starting from signature: ${this.lastSignature.slice(0, 16)}...`);
      }
    } catch (err) {
      logger.warn('[Solana] Could not fetch initial signatures — will start from latest');
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

      // Process oldest first
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

      // Parse program logs for events using Anchor's EventParser
      const logs = tx.meta.logMessages || [];
      const events = this.eventParser.parseLogs(logs);

      for (const event of events) {
        if (event.name === 'burnForRedemptionEvent') {
          const data = event.data as any;
          
          // Decode the soq_address from bytes to base58
          const soqAddrBytes = data.soqAddress as number[];
          const soqAddress = Buffer.from(soqAddrBytes)
            .toString('utf8')
            .replace(/\0/g, ''); // strip null padding

          const burnEvent: BurnEvent = {
            user: data.user.toString(),
            amount: Number(data.amount),
            netAmount: Number(data.netAmount),
            fee: Number(data.fee),
            soqAddress,
            nonce: Number(data.nonce),
            timestamp: Number(data.timestamp),
            txSignature: sigInfo.signature,
          };

          this.burnEvents.push(burnEvent);
          
          logger.info(`[Solana] 🔥 BURN DETECTED`);
          logger.info(`  User:      ${burnEvent.user.slice(0, 16)}...`);
          logger.info(`  Amount:    ${burnEvent.amount / 1e9} pSOQ`);
          logger.info(`  Net:       ${burnEvent.netAmount / 1e9} SOQ (0.1% fee)`);
          logger.info(`  SOQ Addr:  ${burnEvent.soqAddress || 'raw bytes'}`);
          logger.info(`  Nonce:     ${burnEvent.nonce}`);
          logger.info(`  Tx:        ${sigInfo.signature.slice(0, 32)}...`);

          // Queue SOQ release on Soqucoin L1
          this.queue.enqueue({
            direction: TransferDirection.SOLANA_TO_SOQUCOIN,
            sourceTx: sigInfo.signature,
            amount: burnEvent.netAmount,
            destinationAddress: burnEvent.soqAddress,
            timestamp: Date.now(),
            status: 'pending',
          });
        }
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

  getBurnCount(): number {
    return this.burnEvents.length;
  }

  isRunning(): boolean {
    return this.polling !== null;
  }
}
