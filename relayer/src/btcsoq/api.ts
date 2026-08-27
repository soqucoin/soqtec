/**
 * BTCSOQ gateway HTTP surface (DL §5 — intent + status API).
 *
 * Mounted onto the existing relayer Express app:
 *   POST /api/btc/intent          {ssqAddress} → fresh P2TR deposit address
 *   POST /api/btc/redeem-intent   {ssqAddress, btcAddress}
 *   GET  /api/btc/status/:id      intent status (+?proof=1 for full SPV hex)
 *   GET  /api/btc/gateway         gateway status (Terminal PoR panel feed)
 *   GET  /api/btc/deposits        recent deposit ledger entries
 *   POST /api/btc/block-notify    bitcoind blocknotify push (localhost only)
 */

import type express from 'express';
import { BtcsoqGateway, GatewayInputError } from './gateway';
import { mountTheaterRoutes } from './theater';
import { logger } from '../utils/logger';

// Light abuse guard for intent creation (conference audience, public URL)
const INTENT_WINDOW_MS = 60 * 60 * 1000;
const INTENT_MAX_PER_WINDOW = 20;
const intentHits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (intentHits.get(ip) || []).filter((t) => now - t < INTENT_WINDOW_MS);
  if (hits.length >= INTENT_MAX_PER_WINDOW) {
    intentHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  intentHits.set(ip, hits);
  return false;
}

// BTC/USD price cache: one upstream fetch per minute serves every visitor.
// Client-direct CoinGecko dies behind conference NAT (per-IP 429s) — the
// hero paragraph must not degrade in front of a room.
let priceCache: { usd: number; fetchedAt: number } | null = null;
const PRICE_TTL_MS = 60_000;

async function btcUsdPrice(): Promise<{ usd: number; ageSec: number } | null> {
  const now = Date.now();
  if (priceCache && now - priceCache.fetchedAt < PRICE_TTL_MS) {
    return { usd: priceCache.usd, ageSec: (now - priceCache.fetchedAt) / 1000 };
  }
  try {
    const r = await (await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      { signal: AbortSignal.timeout(8000) },
    )).json() as any;
    const usd = r?.bitcoin?.usd;
    if (typeof usd === 'number' && usd > 0) {
      priceCache = { usd, fetchedAt: now };
      return { usd, ageSec: 0 };
    }
  } catch { /* fall through to stale */ }
  // Stale beats blank: keep serving the last good price, aged honestly.
  return priceCache
    ? { usd: priceCache.usd, ageSec: (now - priceCache.fetchedAt) / 1000 }
    : null;
}

function isLocalhost(req: express.Request): boolean {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function mountBtcsoqRoutes(app: express.Application, gateway: BtcsoqGateway): void {

  // ── POST /api/btc/intent ─────────────────────────────
  app.post('/api/btc/intent', async (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) {
      return res.status(429).json({ ok: false, error: 'Rate limited — try again later' });
    }

    const { ssqAddress } = req.body || {};
    if (!ssqAddress || typeof ssqAddress !== 'string') {
      return res.status(400).json({ ok: false, error: 'ssqAddress required' });
    }

    try {
      const intent = await gateway.createDepositIntent(ssqAddress.trim().toLowerCase());
      res.json({
        ok: true,
        intentId: intent.id,
        btcDepositAddress: intent.btcDepositAddress,
        ssqAddress: intent.ssqAddress,
        network: intent.network,
        expiresAt: intent.expiresAt,
        status: intent.status,
      });
    } catch (err: any) {
      if (err instanceof GatewayInputError) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      logger.error(`[BTCSOQ:API] intent creation failed: ${err.message}`);
      res.status(500).json({ ok: false, error: 'Intent creation failed' });
    }
  });

  // ── POST /api/btc/redeem-intent ──────────────────────
  app.post('/api/btc/redeem-intent', async (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) {
      return res.status(429).json({ ok: false, error: 'Rate limited — try again later' });
    }

    const { ssqAddress, btcAddress } = req.body || {};
    if (!ssqAddress || typeof ssqAddress !== 'string' ||
        !btcAddress || typeof btcAddress !== 'string') {
      return res.status(400).json({ ok: false, error: 'ssqAddress and btcAddress required' });
    }

    try {
      const intent = await gateway.createRedeemIntent(
        ssqAddress.trim().toLowerCase(),
        btcAddress.trim().toLowerCase(),
      );
      res.json({
        ok: true,
        intentId: intent.id,
        btcPayoutAddress: intent.btcPayoutAddress,
        network: intent.network,
        status: intent.status,
        expiresAt: intent.expiresAt,
      });
    } catch (err: any) {
      if (err instanceof GatewayInputError) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      logger.error(`[BTCSOQ:API] redeem intent failed: ${err.message}`);
      res.status(500).json({ ok: false, error: 'Redeem intent creation failed' });
    }
  });

  // ── GET /api/btc/status/:id ──────────────────────────
  app.get('/api/btc/status/:id', async (req, res) => {
    try {
      const status = await gateway.intentStatus(req.params.id);
      if (!status) {
        return res.status(404).json({ ok: false, error: 'Unknown intent' });
      }
      // Full SPV proof hex only on explicit request (it's big)
      if (req.query.proof === '1') {
        status.spvProof = gateway.getIntentRaw(req.params.id)?.spvProof;
      }
      res.json({ ok: true, intent: status });
    } catch (err: any) {
      logger.error(`[BTCSOQ:API] status failed: ${err.message}`);
      res.status(500).json({ ok: false, error: 'Status lookup failed' });
    }
  });

  // ── GET /api/btc/gateway ─────────────────────────────
  app.get('/api/btc/gateway', async (_req, res) => {
    try {
      res.json({ ok: true, gateway: await gateway.gatewayStatus() });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/btc/deposits ────────────────────────────
  app.get('/api/btc/deposits', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const deposits = gateway.listRecentDeposits(limit).map((d) => ({
      ...d,
      spvProof: undefined,
      spvProofAvailable: !!d.spvProof,
    }));
    res.json({ ok: true, deposits });
  });

  // ── GET /api/btc/mints ───────────────────────────────
  // Receipt ledger view (mint/redeem stream for the Terminal + E2E asserts)
  app.get('/api/btc/mints', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    res.json({ ok: true, mints: gateway.listRecentMints(limit) });
  });

  // ── GET /api/btc/price ───────────────────────────────
  // Server-cached BTC/USD for the threat counter (60s TTL, stale-if-error).
  app.get('/api/btc/price', async (_req, res) => {
    const p = await btcUsdPrice();
    if (!p) return res.status(503).json({ ok: false, error: 'price unavailable' });
    res.json({ ok: true, usd: p.usd, ageSec: Math.round(p.ageSec), source: 'CoinGecko (server-cached)' });
  });

  // ── GET /api/btc/answers ─────────────────────────────
  // Paid AI answers with the seller's ML-DSA-signed 402 receipts (WS3).
  // Everything here is public proof material — the page verifies both the
  // gateway attestation AND the seller receipt in the visitor's browser.
  app.get('/api/btc/answers', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    res.json({ ok: true, answers: gateway.listAnswers(limit) });
  });

  // ── GET /api/btc/attestations ────────────────────────
  // Dilithium-signed event feed — independently verifiable (ML-DSA-44)
  app.get('/api/btc/attestations', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      res.json({ ok: true, ...(await gateway.attestationFeed(limit)) });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/btc/anchor — on-demand notarization ────
  // Localhost only (T-60 pre-flight): anchor the current ledger root into
  // Bitcoin right now, even if unchanged (force=1).
  app.post('/api/btc/anchor', async (req, res) => {
    if (!isLocalhost(req)) {
      return res.status(403).json({ ok: false });
    }
    try {
      const result = await gateway.anchorNow(req.query.force === '1');
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/btc/block-notify (bitcoind push channel) ─
  app.post('/api/btc/block-notify', async (req, res) => {
    if (!isLocalhost(req)) {
      return res.status(403).json({ ok: false });
    }
    const hash = req.body?.hash || 'unknown';
    logger.info(`[BTCSOQ:API] blocknotify ${String(hash).slice(0, 16)}... → immediate poll`);
    try {
      const n = await gateway.checkNow();
      res.json({ ok: true, dispatched: n });
    } catch (err: any) {
      logger.error(`[BTCSOQ:API] block-notify poll failed: ${err.message}`);
      res.status(500).json({ ok: false });
    }
  });

  mountTheaterRoutes(app, gateway.theaterDeps());

  logger.info('[BTCSOQ:API] Routes mounted: /api/btc/{intent,redeem-intent,status/:id,gateway,deposits,block-notify}');
}
