/**
 * SOQ-TEC Bridge Relayer
 * 
 * Watches both Solana and Soqucoin chains for bridge events,
 * coordinates cross-chain transfers with 3-of-5 threshold signing.
 * 
 * Architecture (v0.2.0 — DUA/CEA):
 * - DUAEventRouter: Central hub receiving burns from ANY chain CEA
 * - SolanaCEA: Push (Helius webhook) + Pull (RPC poll) burn detection
 * - PAUL Lane Manager: Sub-second release via pre-allocated UTXOs
 * - SolanaWatcher: Legacy Anchor event parser (fallback)
 * - SoqucoinWatcher: Monitors vault lock transactions on Soqucoin L1
 * - TransferQueue: Manages pending transfers with retry logic
 * - API Server: /api/status, /api/activity, /api/dua/* for terminal dashboard
 */

import { SolanaWatcher } from './watchers/solana';
import { SoqucoinWatcher } from './watchers/soqucoin';
import { TransferQueue } from './queue';
import { startApiServer } from './api';
import { logger } from './utils/logger';
import { loadConfig } from './config';
import { DUAEventRouter, SolanaCEA } from './cea';
import idl from './idl/soqtec_bridge.json';

async function main(): Promise<void> {
  logger.info('╔════════════════════════════════════════════╗');
  logger.info('║   SOQ-TEC BRIDGE RELAYER v0.2.0            ║');
  logger.info('║   Quantum-Tolerant Ecosystem Custody       ║');
  logger.info('║   PAUL + DUA/CEA — Chain-Agnostic Release  ║');
  logger.info('╚════════════════════════════════════════════╝');
  logger.info('');

  const config = loadConfig();
  logger.info(`Network: ${config.network}`);
  logger.info(`Solana RPC: ${config.solanaRpc}`);
  logger.info(`Soqucoin RPC: ${config.soqucoinRpc}`);
  logger.info(`Threshold: ${config.threshold}/${config.validatorCount}`);

  // Initialize transfer queue (legacy — used by watchers)
  const queue = new TransferQueue(config);

  // Start chain watchers (legacy — retained for compatibility)
  const solanaWatcher = new SolanaWatcher(config, queue);
  const soqucoinWatcher = new SoqucoinWatcher(config, queue);

  await solanaWatcher.start();
  logger.info('✓ Solana watcher started (legacy poll)');

  await soqucoinWatcher.start();
  logger.info('✓ Soqucoin watcher started');

  // ─── DUA/CEA Pipeline ─────────────────────────────────
  let duaRouter: DUAEventRouter | null = null;

  if (config.duaEnabled) {
    logger.info('');
    logger.info('┌─ DUA/CEA Pipeline ──────────────────────┐');

    // Initialize DUA Event Router
    duaRouter = new DUAEventRouter({
      releasePolicy: config.releasePolicy,
      paulEndpoint: config.paulEndpoint,
      soqucoinRpcUrl: config.soqucoinRpc,
      soqucoinRpcUser: config.soqucoinRpcUser,
      soqucoinRpcPass: config.soqucoinRpcPass,
      pollIntervalMs: config.solanaPollInterval,
      maxSpeculativeQueue: 100,
    });

    // Register Solana CEA (Helius webhook + RPC poll)
    const solanaCEA = new SolanaCEA({
      rpcUrl: config.solanaRpc,
      heliusApiKey: config.heliusApiKey,
      programId: config.solanaProgramId,
      tokenMint: config.psoqMint,
      webhookCallbackUrl: config.webhookCallbackUrl,
      idl: idl,
      pollIntervalMs: config.solanaPollInterval,
    });

    duaRouter.registerAdapter(solanaCEA);
    logger.info(`│ Release policy: ${config.releasePolicy}`);
    logger.info(`│ PAUL endpoint:  ${config.paulEndpoint}`);
    logger.info(`│ Helius key:     ${config.heliusApiKey ? config.heliusApiKey.slice(0, 8) + '...' : '(not set — poll-only)'}`);
    logger.info(`│ Webhook URL:    ${config.webhookCallbackUrl || '(not set — no push)'}`);

    // Start the DUA pipeline
    await duaRouter.startAll();
    logger.info('│ ✅ DUA/CEA pipeline active');
    logger.info('│ Flow: Burn → CEA → DUA Router → PAUL → L1 Release');
    logger.info('└──────────────────────────────────────────┘');

    // Store CEA reference for webhook endpoint
    (global as any).__solanaCEA = solanaCEA;
    (global as any).__duaRouter = duaRouter;
  } else {
    logger.info('');
    logger.info('DUA/CEA: disabled (set DUA_ENABLED=true to activate)');
    logger.info('Using legacy watcher + queue pipeline');
  }

  // Start API server for terminal dashboard
  const api = await startApiServer(config, queue, solanaWatcher, soqucoinWatcher);
  logger.info(`✓ API server listening on port ${config.apiPort}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`\n${signal} received — shutting down gracefully...`);
    await solanaWatcher.stop();
    await soqucoinWatcher.stop();
    if (duaRouter) await duaRouter.stopAll();
    (api as any).close();
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
