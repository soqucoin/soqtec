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
import { SolanaBridgeExecutor } from './bridge/solana-executor';
import { BtcsoqGateway } from './btcsoq/gateway';
import { mountBtcsoqRoutes } from './btcsoq/api';
import idl from './idl/soqtec_bridge.json';

async function main(): Promise<void> {
  logger.info('╔════════════════════════════════════════════╗');
  logger.info('║   SOQ-TEC BRIDGE RELAYER v0.3.0            ║');
  logger.info('║   Quantum-Tolerant Ecosystem Custody       ║');
  logger.info('║   PAUL + DUA/CEA + PoR + Bridge-Back       ║');
  logger.info('╚════════════════════════════════════════════╝');
  logger.info('');

  const config = loadConfig();
  logger.info(`Network: ${config.network}`);
  logger.info(`Solana RPC: ${config.solanaRpc}`);
  logger.info(`Soqucoin RPC: ${config.soqucoinRpc}`);
  logger.info(`Threshold: ${config.threshold}/${config.validatorCount}`);

  // BTCSOQ_ONLY: run just the BTCSOQ gateway + API — used for the Day-1/2
  // dev instance on the Services VPS so the LIVE Solana-lane relayer service
  // is never restarted with in-progress branch code.
  const btcsoqOnly = process.env.BTCSOQ_ONLY === 'true';
  if (btcsoqOnly) {
    logger.info('BTCSOQ_ONLY=true — Solana/Soqucoin watchers, bridge executor and DUA are DISABLED');
  }

  // Initialize transfer queue (legacy — used by watchers)
  const queue = new TransferQueue(config);

  // Start chain watchers (legacy — retained for compatibility)
  const solanaWatcher = new SolanaWatcher(config, queue);
  const soqucoinWatcher = new SoqucoinWatcher(config, queue);

  if (!btcsoqOnly) {
    await solanaWatcher.start();
    logger.info('Solana watcher started (legacy poll)');

    await soqucoinWatcher.start();
    logger.info('Soqucoin watcher started');
  }

  // ─── Bridge Executor (SOQ→SOL + PoR) ──────────────────
  let bridgeExecutor: SolanaBridgeExecutor | null = null;

  if (btcsoqOnly) {
    // skipped in BTCSOQ_ONLY mode
  } else try {
    bridgeExecutor = new SolanaBridgeExecutor(config);
    await bridgeExecutor.initialize();

    if (bridgeExecutor.isInitialized()) {
      // Attach to queue for bridge-back mints
      queue.setBridgeExecutor(bridgeExecutor);

      // Start periodic PoR attestation (every 5 min)
      bridgeExecutor.startPeriodicPoR(
        () => soqucoinWatcher.getVaultBalance(),
        () => soqucoinWatcher.getBlockHeight()
      );
      logger.info('Bridge executor initialized — SOQ→SOL + PoR active');
    } else {
      logger.warn('Bridge executor: IDL not loaded — running in detection-only mode');
    }
  } catch (err: any) {
    logger.warn(`Bridge executor skipped: ${err.message}`);
  }

  // ─── DUA/CEA Pipeline ─────────────────────────────────
  let duaRouter: DUAEventRouter | null = null;

  if (config.duaEnabled && !btcsoqOnly) {
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
      network: config.network === 'devnet' ? 'devnet' : 'mainnet-beta',
    });

    duaRouter.registerAdapter(solanaCEA);
    logger.info(`│ Release policy: ${config.releasePolicy}`);
    logger.info(`│ PAUL endpoint:  ${config.paulEndpoint}`);
    logger.info(`│ Helius key:     ${config.heliusApiKey ? config.heliusApiKey.slice(0, 8) + '...' : '(not set — poll-only)'}`);
    logger.info(`│ Webhook URL:    ${config.webhookCallbackUrl || '(not set — no push)'}`);

    // Start the DUA pipeline
    await duaRouter.startAll();
    logger.info('│ DUA/CEA pipeline active');
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

  // ─── BTCSOQ Gateway (quantum-shielded Bitcoin lane) ───
  // Detection-only on Day 1: BitcoinCEA events flow to the BtcsoqGateway
  // orchestrator, NOT the DUA router — the router's release path is
  // SOQ-sendtoaddress-specific and must never fire on a raw BTC deposit.
  // Router integration lands with the receipt-mint path (Day 2, DL §6).
  let btcsoqGateway: BtcsoqGateway | null = null;

  if (config.btcsoq.enabled) {
    logger.info('');
    logger.info('┌─ BTCSOQ Gateway ────────────────────────┐');
    logger.info(`│ Network:      ${config.btcsoq.network}`);
    logger.info(`│ Bitcoin RPC:  ${config.btcsoq.rpcUrl}`);
    logger.info(`│ Vault wallet: ${config.btcsoq.depositWallet} (watch-only)`);
    logger.info(`│ Finality:     ${config.btcsoq.finalityConf} conf (disclosed)`);
    btcsoqGateway = new BtcsoqGateway({ ...config.btcsoq });
    await btcsoqGateway.start();
    logger.info('│ BTCSOQ lane active (overlay receipt)');
    logger.info('└──────────────────────────────────────────┘');
  } else {
    logger.info('BTCSOQ gateway: disabled (set BTCSOQ_ENABLED=true to activate)');
  }

  // Start API server for terminal dashboard
  const api = await startApiServer(config, queue, solanaWatcher, soqucoinWatcher);
  if (btcsoqGateway) {
    mountBtcsoqRoutes(api, btcsoqGateway);
  }
  logger.info(`API server listening on port ${config.apiPort}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`\n${signal} received — shutting down gracefully...`);
    if (!btcsoqOnly) {
      await solanaWatcher.stop();
      await soqucoinWatcher.stop();
    }
    if (btcsoqGateway) await btcsoqGateway.stop();
    if (duaRouter) await duaRouter.stopAll();
    if (bridgeExecutor) bridgeExecutor.stopPeriodicPoR();
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
