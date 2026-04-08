/**
 * Soqucoin Chain Watcher
 * 
 * Monitors the Soqucoin L1 vault address for incoming lock transactions.
 * When a deposit is detected, it queues a pSOQ mint on the Solana side.
 * 
 * Uses the Soqucoin JSON-RPC API (Bitcoin Core compatible).
 * Vault custody uses NIST FIPS 204 ML-DSA-44 (Dilithium) keys.
 */

import { RelayerConfig } from '../config';
import { TransferQueue, TransferDirection } from '../queue';
import { logger } from '../utils/logger';

export interface VaultDeposit {
  txid: string;
  amount: number;
  fromAddress: string;
  confirmations: number;
  blockHeight: number;
  timestamp: number;
}

export class SoqucoinWatcher {
  private config: RelayerConfig;
  private queue: TransferQueue;
  private polling: NodeJS.Timer | null = null;
  private lastBlockHeight: number = 0;
  private deposits: VaultDeposit[] = [];
  private vaultBalance: number = 0;

  constructor(config: RelayerConfig, queue: TransferQueue) {
    this.config = config;
    this.queue = queue;
  }

  async start(): Promise<void> {
    logger.info('[Soqucoin] Starting watcher...');
    logger.info(`[Soqucoin] RPC: ${this.config.soqucoinRpc}`);
    logger.info(`[Soqucoin] Vault: ${this.config.vaultAddress || 'not configured'}`);
    logger.info(`[Soqucoin] Poll interval: ${this.config.soqucoinPollInterval}ms`);

    // Get current block height
    try {
      const info = await this.rpcCall('getblockchaininfo');
      this.lastBlockHeight = info.blocks;
      logger.info(`[Soqucoin] Current block height: ${this.lastBlockHeight}`);
    } catch (err) {
      logger.warn('[Soqucoin] Could not connect to RPC — will retry...');
    }

    // Start polling
    this.polling = setInterval(() => this.poll(), this.config.soqucoinPollInterval);
  }

  async stop(): Promise<void> {
    if (this.polling) {
      clearInterval(this.polling);
      this.polling = null;
    }
    logger.info('[Soqucoin] Watcher stopped');
  }

  private async poll(): Promise<void> {
    try {
      // Check for new blocks
      const info = await this.rpcCall('getblockchaininfo');
      const currentHeight = info.blocks;

      if (currentHeight <= this.lastBlockHeight) return;

      // Scan new blocks for vault transactions
      for (let h = this.lastBlockHeight + 1; h <= currentHeight; h++) {
        await this.scanBlock(h);
      }

      this.lastBlockHeight = currentHeight;

      // Update vault balance
      await this.updateVaultBalance();
    } catch (err) {
      logger.error('[Soqucoin] Poll error:', err);
    }
  }

  private async scanBlock(height: number): Promise<void> {
    try {
      const blockHash = await this.rpcCall('getblockhash', [height]);
      const block = await this.rpcCall('getblock', [blockHash, 2]); // verbosity=2 includes tx details

      for (const tx of block.tx || []) {
        // Check if any output pays to our vault address
        for (const vout of tx.vout || []) {
          const addresses = vout.scriptPubKey?.addresses || [];
          if (addresses.includes(this.config.vaultAddress)) {
            const deposit: VaultDeposit = {
              txid: tx.txid,
              amount: vout.value,
              fromAddress: tx.vin?.[0]?.prevout?.scriptPubKey?.addresses?.[0] || 'unknown',
              confirmations: 1,
              blockHeight: height,
              timestamp: block.time,
            };

            this.deposits.push(deposit);
            logger.info(`[Soqucoin] 🔒 Vault deposit: ${deposit.amount} SOQ in tx ${deposit.txid.slice(0, 16)}...`);

            // Queue pSOQ mint on Solana (only after 6 confirmations)
            // For now, queue immediately — confirmation check happens in queue processor
            this.queue.enqueue({
              direction: TransferDirection.SOQUCOIN_TO_SOLANA,
              sourceTx: deposit.txid,
              amount: deposit.amount,
              destinationAddress: '', // Need to extract from OP_RETURN or metadata
              timestamp: Date.now(),
              status: 'pending_confirmations',
              requiredConfirmations: 6,
            });
          }
        }
      }
    } catch (err) {
      logger.error(`[Soqucoin] Error scanning block ${height}:`, err);
    }
  }

  private async updateVaultBalance(): Promise<void> {
    if (!this.config.vaultAddress) return;
    try {
      // Use listunspent filtered to vault address
      const utxos = await this.rpcCall('listunspent', [1, 9999999, [this.config.vaultAddress]]);
      this.vaultBalance = utxos.reduce((sum: number, utxo: any) => sum + utxo.amount, 0);
    } catch {
      // Fallback: keep existing balance
    }
  }

  /**
   * JSON-RPC call to Soqucoin node
   */
  private async rpcCall(method: string, params: any[] = []): Promise<any> {
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

    const data = await response.json();
    if (data.error) {
      throw new Error(`RPC error: ${data.error.message}`);
    }
    return data.result;
  }

  // API helpers
  getVaultBalance(): number {
    return this.vaultBalance;
  }

  getBlockHeight(): number {
    return this.lastBlockHeight;
  }

  getRecentDeposits(limit: number = 20): VaultDeposit[] {
    return this.deposits.slice(-limit).reverse();
  }

  isRunning(): boolean {
    return this.polling !== null;
  }
}
