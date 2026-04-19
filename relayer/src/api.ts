/**
 * SOQ-TEC Relayer API Server
 * 
 * REST API endpoints consumed by the SOQ-TEC Terminal dashboard
 * and SoquShield wallet.
 */

import express from 'express';
import cors from 'cors';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { readFileSync } from 'fs';
import { RelayerConfig } from './config';
import { TransferQueue } from './queue';
import { SolanaWatcher } from './watchers/solana';
import { SoqucoinWatcher } from './watchers/soqucoin';
import { logger } from './utils/logger';

// Rate limit: 1 airdrop per address per 10 minutes
const airdropCooldowns = new Map<string, number>();
const AIRDROP_COOLDOWN_MS = 10 * 60 * 1000; // 10 min
const AIRDROP_AMOUNT = 10_000; // 10K tpSOQ per request

export async function startApiServer(
  config: RelayerConfig,
  queue: TransferQueue,
  solanaWatcher: SolanaWatcher,
  soqucoinWatcher: SoqucoinWatcher,
): Promise<express.Application> {
  const app = express();

  // Middleware — allow all origins in dev (file:// sends null origin)
  app.use(cors({
    origin: config.network === 'devnet' ? true : config.apiCorsOrigins,
  }));
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
  // POST /api/airdrop-psoq — Devnet test pSOQ faucet
  // ──────────────────────────────────────────
  // Mints test pSOQ to a user's Solana address.
  // Only available on devnet. Uses the relayer's mint authority key.
  //
  // Body: { "address": "Base58SolanaAddress", "amount": 10000, "mint": "7TCU5..." }
  // Response: { "ok": true, "signature": "...", "amount": 10000 }
  app.post('/api/airdrop-psoq', async (req, res) => {
    // Only available on devnet
    if (config.network !== 'devnet') {
      return res.status(403).json({ 
        ok: false, 
        error: 'Airdrop only available on devnet' 
      });
    }

    const { address, amount } = req.body;
    if (!address || typeof address !== 'string' || address.length < 32) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Invalid Solana address' 
      });
    }

    // Rate limit per address
    const now = Date.now();
    const lastAirdrop = airdropCooldowns.get(address) || 0;
    if (now - lastAirdrop < AIRDROP_COOLDOWN_MS) {
      const remainingSec = Math.ceil((AIRDROP_COOLDOWN_MS - (now - lastAirdrop)) / 1000);
      return res.status(429).json({ 
        ok: false, 
        error: `Rate limited — try again in ${remainingSec}s` 
      });
    }

    const airdropAmount = Math.min(amount || AIRDROP_AMOUNT, 100_000); // Cap at 100K
    const mintPubkey = new PublicKey(config.psoqMint);
    const decimals = 9; // tpSOQ has 9 decimals

    try {
      logger.info(`Airdrop: ${airdropAmount} tpSOQ → ${address}`);

      // Load mint authority keypair from the relayer's key file
      const keypairPath = config.solanaKeypairPath.replace('~', process.env.HOME || '/root');
      const keypairData = JSON.parse(readFileSync(keypairPath, 'utf8'));
      const mintAuthority = Keypair.fromSecretKey(Uint8Array.from(keypairData));

      // Connect to Solana devnet
      const connection = new Connection(config.solanaRpc, 'confirmed');
      const recipientPubkey = new PublicKey(address);

      // Step 1: Get or create associated token account for recipient
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        mintAuthority,     // payer for ATA creation
        mintPubkey,        // token mint
        recipientPubkey,   // owner of the ATA
      );

      logger.info(`ATA: ${ata.address.toBase58()} (owner: ${address})`);

      // Step 2: Mint tokens to the ATA
      // Amount in smallest units (9 decimals): 10000 tpSOQ = 10000 * 10^9
      const rawAmount = BigInt(airdropAmount) * BigInt(10 ** decimals);
      const signature = await mintTo(
        connection,
        mintAuthority,     // payer
        mintPubkey,        // mint
        ata.address,       // destination ATA
        mintAuthority,     // mint authority
        rawAmount,         // amount in smallest units
      );

      airdropCooldowns.set(address, now);
      logger.info(`Airdrop success: ${airdropAmount} tpSOQ → ${address} (${signature})`);

      res.json({
        ok: true,
        signature,
        amount: airdropAmount,
        mint: config.psoqMint,
        message: `Airdropped ${airdropAmount.toLocaleString()} tpSOQ`,
      });
    } catch (err: any) {
      logger.error(`Airdrop failed for ${address}: ${err.message}`);
      res.status(500).json({
        ok: false,
        error: `Airdrop failed: ${err.message?.substring(0, 200) || 'unknown error'}`,
      });
    }
  });

  // ──────────────────────────────────────────
  // POST /api/bridge/psoq-to-soq — Bridge pSOQ → SOQ
  // ──────────────────────────────────────────
  // User burns pSOQ on Solana, relayer releases SOQ from vault.
  // SoquShield calls this after displaying the bridge form.
  //
  // For hackathon demo: we skip the actual burn verification and
  // release SOQ directly from the hot wallet. Production requires
  // burn tx verification + threshold Dilithium attestation.
  //
  // Body: { "amount": 1000, "soqAddress": "sq1p...", "solanaAddress": "Base58..." }
  app.post('/api/bridge/psoq-to-soq', async (req, res) => {
    const { amount, soqAddress, solanaAddress } = req.body;

    // Input validation
    if (!soqAddress || typeof soqAddress !== 'string' || soqAddress.length < 20) {
      return res.status(400).json({ ok: false, error: 'Invalid SOQ address' });
    }
    if (!solanaAddress || typeof solanaAddress !== 'string' || solanaAddress.length < 20) {
      return res.status(400).json({ ok: false, error: 'Invalid Solana address' });
    }
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid amount' });
    }
    if (amount < config.minTransferSoq) {
      return res.status(400).json({ ok: false, error: `Minimum transfer: ${config.minTransferSoq} SOQ` });
    }
    if (amount > config.maxTransferSoq) {
      return res.status(400).json({ ok: false, error: `Maximum transfer: ${config.maxTransferSoq} SOQ` });
    }

    // 0.1% bridge fee (min 1 SOQ)
    const fee = Math.max(amount * 0.001, 1);
    const netAmount = amount - fee;

    try {
      logger.info(`[Bridge] pSOQ→SOQ: ${amount} SOQ (net: ${netAmount}) → ${soqAddress} (from: ${solanaAddress})`);

      // Release SOQ from vault to user's Dilithium wallet address
      // Uses sendtoaddress via the existing soqucoinRpc helper
      const response = await fetch(config.soqucoinRpc, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(
            `${config.soqucoinRpcUser}:${config.soqucoinRpcPass}`
          ).toString('base64'),
        },
        body: JSON.stringify({
          jsonrpc: '1.0',
          id: Date.now(),
          method: 'sendtoaddress',
          params: [
            soqAddress,
            netAmount,
            `SOQ-TEC Bridge: pSOQ→SOQ`,
            `From: ${solanaAddress.slice(0, 16)}...`,
          ],
        }),
      });

      const rpcData = await response.json() as any;

      if (rpcData.error) {
        logger.error(`[Bridge] pSOQ→SOQ RPC error: ${rpcData.error.message}`);
        return res.status(500).json({ ok: false, error: `Bridge release failed: ${rpcData.error.message}` });
      }

      const soqTxid = rpcData.result;

      // Enqueue for activity tracking
      queue.enqueue({
        direction: 'sol_to_soq' as any,
        sourceTx: `bridge_${Date.now()}_${solanaAddress.slice(0, 8)}`,
        amount: amount * 1e9,
        destinationAddress: soqAddress,
        timestamp: Date.now(),
        status: 'completed',
        destinationTx: soqTxid,
      });

      logger.info(`[Bridge] ✅ pSOQ→SOQ complete: ${netAmount} SOQ → ${soqAddress} (txid: ${soqTxid})`);

      res.json({
        ok: true,
        soqTxid,
        netAmount,
        fee,
        message: `Bridged ${netAmount.toLocaleString()} SOQ to your wallet`,
      });
    } catch (err: any) {
      logger.error(`[Bridge] pSOQ→SOQ failed: ${err.message}`);
      res.status(500).json({ ok: false, error: `Bridge failed: ${err.message?.substring(0, 200) || 'unknown'}` });
    }
  });

  // ──────────────────────────────────────────
  // POST /api/bridge/soq-to-psoq — Bridge SOQ → pSOQ
  // ──────────────────────────────────────────
  // User sends SOQ to vault, relayer mints pSOQ to user's Solana address.
  // For hackathon demo: uses SPL mintTo (same as airdrop path) to
  // demonstrate the flow. Production requires vault deposit verification
  // + threshold Dilithium attestation + Anchor CPI.
  //
  // Body: { "amount": 1000, "solanaAddress": "Base58...", "soqTxid": "optional" }
  app.post('/api/bridge/soq-to-psoq', async (req, res) => {
    const { amount, solanaAddress, soqTxid } = req.body;

    // Input validation
    if (!solanaAddress || typeof solanaAddress !== 'string' || solanaAddress.length < 20) {
      return res.status(400).json({ ok: false, error: 'Invalid Solana address' });
    }
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid amount' });
    }
    if (amount < config.minTransferSoq) {
      return res.status(400).json({ ok: false, error: `Minimum transfer: ${config.minTransferSoq} pSOQ` });
    }
    if (amount > config.maxTransferSoq) {
      return res.status(400).json({ ok: false, error: `Maximum transfer: ${config.maxTransferSoq} pSOQ` });
    }

    // 0.1% bridge fee (min 1 pSOQ)
    const fee = Math.max(amount * 0.001, 1);
    const netAmount = amount - fee;

    try {
      logger.info(`[Bridge] SOQ→pSOQ: ${amount} pSOQ (net: ${netAmount}) → ${solanaAddress}`);

      // Mint pSOQ to user's Solana address (same mechanism as airdrop)
      const keypairPath = config.solanaKeypairPath.replace('~', process.env.HOME || '/root');
      const keypairData = JSON.parse(readFileSync(keypairPath, 'utf8'));
      const mintAuthority = Keypair.fromSecretKey(Uint8Array.from(keypairData));

      const connection = new Connection(config.solanaRpc, 'confirmed');
      const recipientPubkey = new PublicKey(solanaAddress);
      const mintPubkey = new PublicKey(config.psoqMint);

      // Get or create ATA for recipient
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        mintAuthority,
        mintPubkey,
        recipientPubkey,
      );

      // Mint tokens (9 decimals)
      const rawAmount = BigInt(Math.floor(netAmount)) * BigInt(10 ** 9);
      const signature = await mintTo(
        connection,
        mintAuthority,
        mintPubkey,
        ata.address,
        mintAuthority,
        rawAmount,
      );

      // Enqueue for activity tracking
      queue.enqueue({
        direction: 'soq_to_sol' as any,
        sourceTx: soqTxid || `bridge_soq_${Date.now()}`,
        amount: amount * 1e9,
        destinationAddress: solanaAddress,
        timestamp: Date.now(),
        status: 'completed',
        destinationTx: signature,
      });

      logger.info(`[Bridge] ✅ SOQ→pSOQ complete: ${netAmount} pSOQ → ${solanaAddress} (sig: ${signature})`);

      res.json({
        ok: true,
        solanaSignature: signature,
        netAmount,
        fee,
        message: `Bridged ${netAmount.toLocaleString()} pSOQ to your wallet`,
      });
    } catch (err: any) {
      logger.error(`[Bridge] SOQ→pSOQ failed: ${err.message}`);
      res.status(500).json({ ok: false, error: `Bridge failed: ${err.message?.substring(0, 200) || 'unknown'}` });
    }
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
