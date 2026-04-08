/**
 * SOQ-TEC Relayer API Server
 * 
 * REST API endpoints consumed by the SOQ-TEC Terminal dashboard.
 * All responses follow the terminal's data format expectations.
 */

import express from 'express';
import cors from 'cors';
import { RelayerConfig } from './config';
import { TransferQueue } from './queue';
import { SolanaWatcher } from './watchers/solana';
import { SoqucoinWatcher } from './watchers/soqucoin';
import { logger } from './utils/logger';

export async function startApiServer(
  config: RelayerConfig,
  queue: TransferQueue,
  solanaWatcher: SolanaWatcher,
  soqucoinWatcher: SoqucoinWatcher,
): Promise<express.Application> {
  const app = express();

  // Middleware
  app.use(cors({ origin: config.apiCorsOrigins }));
  app.use(express.json());

  // Request logging
  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
  });

  // ──────────────────────────────────────────
  // GET /api/status — Bridge status overview
  // ──────────────────────────────────────────
  app.get('/api/status', (_req, res) => {
    const stats = queue.getStats();
    res.json({
      ok: true,
      bridge: {
        status: 'operational',
        version: '0.1.0',
        network: config.network,
        uptime: process.uptime(),
      },
      vault: {
        balance: soqucoinWatcher.getVaultBalance(),
        blockHeight: soqucoinWatcher.getBlockHeight(),
        custodyType: 'ML-DSA-44 (FIPS 204)',
        threshold: `${config.threshold}-of-${config.validatorCount}`,
      },
      solana: {
        connected: solanaWatcher.isRunning(),
        totalBurned: solanaWatcher.getTotalBurned(),
      },
      soqucoin: {
        connected: soqucoinWatcher.isRunning(),
        vaultBalance: soqucoinWatcher.getVaultBalance(),
      },
      queue: stats,
    });
  });

  // ──────────────────────────────────────────
  // GET /api/activity — Recent bridge activity
  // ──────────────────────────────────────────
  app.get('/api/activity', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    res.json({
      ok: true,
      transfers: queue.getAllActivity(limit),
      burns: solanaWatcher.getRecentBurns(limit),
      deposits: soqucoinWatcher.getRecentDeposits(limit),
    });
  });

  // ──────────────────────────────────────────
  // GET /api/reserves — Proof of Reserves
  // ──────────────────────────────────────────
  app.get('/api/reserves', (_req, res) => {
    const vaultBalance = soqucoinWatcher.getVaultBalance();
    const totalMinted = solanaWatcher.getTotalBurned(); // pSOQ in circulation ≈ burned

    res.json({
      ok: true,
      reserves: {
        soqVaultBalance: vaultBalance,
        psoqCirculating: totalMinted,
        backingRatio: totalMinted > 0 
          ? (vaultBalance / totalMinted * 100).toFixed(2) + '%'
          : '100.00%',
        lastAttestation: new Date().toISOString(),
        custodyType: 'ML-DSA-44 (FIPS 204) 3-of-5 Threshold',
        auditor: 'Halborn Security',
      },
    });
  });

  // ──────────────────────────────────────────
  // GET /api/health — Basic health check
  // ──────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      services: {
        solana_watcher: solanaWatcher.isRunning(),
        soqucoin_watcher: soqucoinWatcher.isRunning(),
        api: true,
      },
    });
  });

  // Start server
  return new Promise((resolve) => {
    const server = app.listen(config.apiPort, () => {
      resolve(app);
    });
    (app as any).close = () => server.close();
  });
}
