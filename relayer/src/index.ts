/**
 * SOQ-TEC Bridge Relayer
 * 
 * Watches both Solana and Soqucoin chains for bridge events,
 * coordinates cross-chain transfers with 3-of-5 threshold signing.
 * 
 * Architecture:
 * - SolanaWatcher: Monitors BurnForRedemption events on Solana
 * - SoqucoinWatcher: Monitors vault lock transactions on Soqucoin L1
 * - TransferQueue: Manages pending transfers with retry logic
 * - API Server: Exposes /api/status, /api/activity for the terminal dashboard
 */

import { SolanaWatcher } from './watchers/solana';
import { SoqucoinWatcher } from './watchers/soqucoin';
import { TransferQueue } from './queue';
import { startApiServer } from './api';
import { logger } from './utils/logger';
import { loadConfig } from './config';

async function main(): Promise<void> {
  logger.info('╔════════════════════════════════════════╗');
  logger.info('║   SOQ-TEC BRIDGE RELAYER v0.1.0        ║');
  logger.info('║   Quantum-Tolerant Ecosystem Custody   ║');
  logger.info('╚════════════════════════════════════════╝');
  logger.info('');

  const config = loadConfig();
  logger.info(`Network: ${config.network}`);
  logger.info(`Solana RPC: ${config.solanaRpc}`);
  logger.info(`Soqucoin RPC: ${config.soqucoinRpc}`);
  logger.info(`Threshold: ${config.threshold}/${config.validatorCount}`);

  // Initialize transfer queue
  const queue = new TransferQueue(config);

  // Start chain watchers
  const solanaWatcher = new SolanaWatcher(config, queue);
  const soqucoinWatcher = new SoqucoinWatcher(config, queue);

  await solanaWatcher.start();
  logger.info('✓ Solana watcher started');

  await soqucoinWatcher.start();
  logger.info('✓ Soqucoin watcher started');

  // Start API server for terminal dashboard
  const api = await startApiServer(config, queue, solanaWatcher, soqucoinWatcher);
  logger.info(`✓ API server listening on port ${config.apiPort}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`\n${signal} received — shutting down gracefully...`);
    await solanaWatcher.stop();
    await soqucoinWatcher.stop();
    api.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('');
  logger.info('SOQ-TEC Relayer operational. Watching for bridge events...');
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
