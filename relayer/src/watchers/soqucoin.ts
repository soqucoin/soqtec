/**
 * Soqucoin Chain Watcher
 * 
 * Monitors the Soqucoin L1 vault address for incoming lock transactions.
 * When a deposit is detected, it queues a pSOQ mint on the Solana side.
 * 
 * Architecture (Layer 3 — DL-HOT-WALLET-RPC-QUEUE):
 *   READ path:  Cold Node (disablewallet=1) for chain info + block scanning
 *               SoquShield ElectrumX API for vault balance/UTXO queries
 *   WRITE path: Hot Wallet is NEVER touched by the watcher.
 *               Only the TransferQueue.processSolToSoq() calls sendtoaddress.
 * 
 * This separation eliminates cs_wallet mutex contention from the polling loop,
 * which was the root cause of "Work queue depth exceeded" on the Hot Wallet VPS.
 * See: design-log/DL-HOT-WALLET-RPC-QUEUE.md
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
  private polling: ReturnType<typeof setInterval> | null = null;
  private lastBlockHeight: number = 0;
  private deposits: VaultDeposit[] = [];
  private vaultBalance: number = 0;

  constructor(config: RelayerConfig, queue: TransferQueue) {
    this.config = config;
    this.queue = queue;
  }

  async start(): Promise<void> {
    logger.info('[Soqucoin] Starting watcher...');
    logger.info(`[Soqucoin] Cold Node RPC: ${this.config.coldNodeRpc}`);
    logger.info(`[Soqucoin] SoquShield API: ${this.config.soqushieldApi}`);
    logger.info(`[Soqucoin] Hot Wallet RPC: ${this.config.soqucoinRpc} (WRITE-ONLY — used by TransferQueue)`);
    logger.info(`[Soqucoin] Vault: ${this.config.vaultAddress || 'not configured'}`);
    logger.info(`[Soqucoin] Poll interval: ${this.config.soqucoinPollInterval}ms`);

    // Get current block height — uses COLD NODE (no wallet mutex)
    try {
      const info = await this.coldNodeRpc('getblockchaininfo');
      this.lastBlockHeight = info.blocks;
      logger.info(`[Soqucoin] Current block height: ${this.lastBlockHeight}`);
    } catch (err) {
      logger.warn('[Soqucoin] Could not connect to cold node RPC — will retry...');
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
      // Check for new blocks — COLD NODE (no wallet mutex)
      const info = await this.coldNodeRpc('getblockchaininfo');
      const currentHeight = info.blocks;

      if (currentHeight <= this.lastBlockHeight) return;

      // Scan new blocks for vault transactions — COLD NODE (no wallet mutex)
      for (let h = this.lastBlockHeight + 1; h <= currentHeight; h++) {
        await this.scanBlock(h);
      }

      this.lastBlockHeight = currentHeight;

      // Update vault balance — ELECTRUMX (zero mutex, zero RPC)
      await this.updateVaultBalance();
    } catch (err) {
      logger.error('[Soqucoin] Poll error:', err);
    }
  }

  private async scanBlock(height: number): Promise<void> {
    try {
      // COLD NODE — getblockhash and getblock only need cs_main (no wallet)
      const blockHash = await this.coldNodeRpc('getblockhash', [height]);
      const block = await this.coldNodeRpc('getblock', [blockHash, 2]); // verbosity=2 includes tx details

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

  /**
   * Update vault balance via SoquShield ElectrumX API.
   * 
   * BEFORE (cs_wallet contention):
   *   rpcCall('listunspent', [1, 9999999, [vaultAddress]]) → Hot Wallet → cs_wallet lock
   * 
   * AFTER (zero mutex):
   *   fetch(soqushieldApi/api/v2/balance/{address}) → ElectrumX → Cold Node (no wallet)
   */
  private async updateVaultBalance(): Promise<void> {
    if (!this.config.vaultAddress) return;
    try {
      const response = await fetch(
        `${this.config.soqushieldApi}/api/v2/balance/${this.config.vaultAddress}`,
        { signal: AbortSignal.timeout(10000) }
      );

      if (!response.ok) {
        throw new Error(`ElectrumX API returned ${response.status}`);
      }

      const data = await response.json() as any;
      
      // SoquShield API returns { confirmed: number, unconfirmed: number }
      // Values are in satoshis, convert to SOQ
      if (data.confirmed !== undefined) {
        this.vaultBalance = data.confirmed / 1e8;
        logger.debug?.(`[Soqucoin] Vault balance updated via ElectrumX: ${this.vaultBalance} SOQ`);
      }
    } catch (err: any) {
      // Fallback: try cold node's gettxout if ElectrumX is down
      // (gettxout only needs cs_main, not cs_wallet)
      logger.warn(`[Soqucoin] ElectrumX balance update failed: ${err.message} — keeping cached balance`);
    }
  }

  /**
   * JSON-RPC call to the COLD NODE (disablewallet=1).
   * 
   * This is the read-path RPC. It NEVER touches the hot wallet.
   * Only cs_main is acquired — no wallet mutex contention.
   */
  private async coldNodeRpc(method: string, params: any[] = []): Promise<any> {
    const response = await fetch(this.config.coldNodeRpc, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(
          `${this.config.coldNodeRpcUser}:${this.config.coldNodeRpcPass}`
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
      throw new Error(`Cold node RPC error: ${data.error.message}`);
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
