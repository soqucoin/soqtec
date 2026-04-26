/**
 * DUA Event Router
 *
 * Central hub that receives normalized burn events from ANY chain's CEA,
 * deduplicates them (seen-set), applies confidence policies, and routes
 * releases through PAUL lanes or falls back to direct sendtoaddress.
 *
 * Architecture:
 *   CEA (Solana) ──┐
 *   CEA (Bitcoin) ──┼──► DUA Event Router ──► PAUL Lane Manager ──► L1 release
 *   CEA (Ethereum)──┘                    └──► Direct sendtoaddress (fallback)
 *
 * Patent reference: SOQ-P006 Claim 1(e), Section 3.2 Multi-Provider Resilience
 */

import {
  ChainEventAdapter,
  NormalizedBurnEvent,
  BurnConfidence,
  ChainId,
} from './types';
import { logger } from '../utils/logger';

/** Configuration for the DUA router */
export interface DUARouterConfig {
  /** Minimum confidence to trigger a release */
  releasePolicy: BurnConfidence;

  /** PAUL lane manager URL (e.g., http://localhost:3003) */
  paulEndpoint: string;

  /** Fallback Soqucoin RPC for direct sendtoaddress */
  soqucoinRpcUrl: string;
  soqucoinRpcUser: string;
  soqucoinRpcPass: string;

  /** Poll interval for fallback detection (ms) */
  pollIntervalMs: number;

  /** Maximum speculative releases before requiring finalization */
  maxSpeculativeQueue: number;
}

/** Release record for audit/reconciliation */
export interface ReleaseRecord {
  burnTxId: string;
  chain: ChainId;
  recipientSoq: string;
  netAmountSoq: bigint;
  confidence: BurnConfidence;
  releaseTxId: string | null;
  releaseMethod: 'paul' | 'direct' | 'pending';
  detectedAt: number;
  releasedAt: number | null;
  finalizedAt: number | null;
}

export class DUAEventRouter {
  private adapters: Map<ChainId, ChainEventAdapter> = new Map();
  private seenSet: Set<string> = new Set();      // burn_tx_id dedup
  private releases: ReleaseRecord[] = [];
  private config: DUARouterConfig;
  private pollTimers: Map<ChainId, ReturnType<typeof setInterval>> = new Map();
  private halted: boolean = false;               // circuit breaker state

  constructor(config: DUARouterConfig) {
    this.config = config;
  }

  /**
   * Register a CEA for a source chain.
   * Multiple adapters can coexist (Solana + Bitcoin + Ethereum).
   */
  registerAdapter(adapter: ChainEventAdapter): void {
    if (this.adapters.has(adapter.chainId)) {
      logger.warn(`[DUA] Replacing existing adapter for ${adapter.chainId}`);
    }
    this.adapters.set(adapter.chainId, adapter);
    logger.info(`[DUA] Registered CEA: ${adapter.chainId}`);
  }

  /**
   * Start all registered adapters.
   * Sets up both push (subscribe) and pull (poll) detection per chain.
   */
  async startAll(): Promise<void> {
    logger.info(`[DUA] Starting event router with ${this.adapters.size} adapter(s)`);
    logger.info(`[DUA] Release policy: ${this.config.releasePolicy}`);

    for (const [chainId, adapter] of this.adapters) {
      try {
        // Start the adapter
        await adapter.start();

        // Register push-based callback
        await adapter.subscribeBurns((event) => this.onBurnDetected(event));
        logger.info(`[DUA] ${chainId}: push subscription active`);

        // Start poll-based fallback
        let pollRef: string | null = null;
        const timer = setInterval(async () => {
          try {
            const result = await adapter.pollBurns(pollRef);
            pollRef = result.nextRef;
            for (const burn of result.burns) {
              await this.onBurnDetected(burn);
            }
          } catch (err) {
            logger.error(`[DUA] ${chainId} poll error:`, err);
          }
        }, this.config.pollIntervalMs);
        this.pollTimers.set(chainId, timer);
        logger.info(`[DUA] ${chainId}: poll fallback active (${this.config.pollIntervalMs}ms)`);

      } catch (err) {
        logger.error(`[DUA] Failed to start adapter ${chainId}:`, err);
      }
    }
  }

  /**
   * Core handler: called when ANY CEA detects a burn.
   * Deduplicates, verifies confidence, and routes to PAUL or direct release.
   */
  private async onBurnDetected(event: NormalizedBurnEvent): Promise<void> {
    // Dedup: seen-set keyed by burn TX ID
    const dedup = `${event.chain}:${event.burnTxId}`;
    if (this.seenSet.has(dedup)) {
      // Already processed — but check if this is a confidence upgrade
      const existing = this.releases.find(r => r.burnTxId === event.burnTxId);
      if (existing && this.isUpgrade(existing.confidence, event.confidence)) {
        existing.confidence = event.confidence;
        if (event.confidence === 'finalized') {
          existing.finalizedAt = Date.now();
        }
        logger.info(`[DUA] ${event.chain}: confidence upgrade for ${event.burnTxId.slice(0, 16)}... → ${event.confidence}`);
      }
      return;
    }
    this.seenSet.add(dedup);

    // Circuit breaker check
    if (this.halted) {
      logger.warn(`[DUA] HALTED — burn ${event.burnTxId.slice(0, 16)}... queued but not released`);
      this.releases.push({
        burnTxId: event.burnTxId,
        chain: event.chain,
        recipientSoq: event.recipientSoq,
        netAmountSoq: event.netAmountSoq,
        confidence: event.confidence,
        releaseTxId: null,
        releaseMethod: 'pending',
        detectedAt: event.detectedAt,
        releasedAt: null,
        finalizedAt: null,
      });
      return;
    }

    // Confidence check against release policy
    if (!this.meetsPolicy(event.confidence)) {
      logger.info(`[DUA] ${event.chain}: burn ${event.burnTxId.slice(0, 16)}... at ${event.confidence} — below ${this.config.releasePolicy} policy, waiting...`);
      this.releases.push({
        burnTxId: event.burnTxId,
        chain: event.chain,
        recipientSoq: event.recipientSoq,
        netAmountSoq: event.netAmountSoq,
        confidence: event.confidence,
        releaseTxId: null,
        releaseMethod: 'pending',
        detectedAt: event.detectedAt,
        releasedAt: null,
        finalizedAt: null,
      });
      return;
    }

    // 🚀 RELEASE: burn meets confidence policy
    logger.info(`[DUA] 🔥 ${event.chain}: BURN → RELEASE`);
    logger.info(`  burn_tx:   ${event.burnTxId.slice(0, 24)}...`);
    logger.info(`  recipient: ${event.recipientSoq}`);
    logger.info(`  amount:    ${Number(event.netAmountSoq) / 1e8} SOQ`);
    logger.info(`  confidence: ${event.confidence}`);

    const record: ReleaseRecord = {
      burnTxId: event.burnTxId,
      chain: event.chain,
      recipientSoq: event.recipientSoq,
      netAmountSoq: event.netAmountSoq,
      confidence: event.confidence,
      releaseTxId: null,
      releaseMethod: 'pending',
      detectedAt: event.detectedAt,
      releasedAt: null,
      finalizedAt: event.confidence === 'finalized' ? Date.now() : null,
    };

    try {
      // Try PAUL first (sub-second release via pre-allocated lanes)
      const paulResult = await this.releasePAUL(event);
      record.releaseTxId = paulResult.release_txid;
      record.releaseMethod = 'paul';
      record.releasedAt = Date.now();
      logger.info(`[DUA] ✅ PAUL release: ${paulResult.release_txid} (${paulResult.elapsed_ms}ms)`);
    } catch (paulErr: any) {
      // PAUL failed (no matching lane UTXO?) — fall back to direct send
      logger.warn(`[DUA] PAUL unavailable: ${paulErr.message} — falling back to direct send`);
      try {
        const txid = await this.releaseDirect(event);
        record.releaseTxId = txid;
        record.releaseMethod = 'direct';
        record.releasedAt = Date.now();
        logger.info(`[DUA] ✅ Direct release: ${txid}`);
      } catch (directErr: any) {
        logger.error(`[DUA] ❌ BOTH release methods failed for ${event.burnTxId.slice(0, 16)}...`);
        logger.error(`  PAUL: ${paulErr.message}`);
        logger.error(`  Direct: ${directErr.message}`);
      }
    }

    this.releases.push(record);
  }

  /** Release via PAUL lane manager (sub-second) */
  private async releasePAUL(event: NormalizedBurnEvent): Promise<any> {
    const soqAmount = Number(event.netAmountSoq) / 1e8;
    const resp = await fetch(`${this.config.paulEndpoint}/bridge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        burn_id: `${event.chain}:${event.burnTxId}`,
        recipient: event.recipientSoq,
        gross_amount: soqAmount,
        net_amount: soqAmount,
      }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'PAUL release failed');
    return data;
  }

  /** Direct sendtoaddress fallback (slower, uses general wallet) */
  private async releaseDirect(event: NormalizedBurnEvent): Promise<string> {
    const soqAmount = Number(event.netAmountSoq) / 1e8;
    const resp = await fetch(this.config.soqucoinRpcUrl, {
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
        method: 'sendtoaddress',
        params: [event.recipientSoq, soqAmount, `Bridge: ${event.chain}`, '', false],
      }),
    });
    const data = await resp.json() as any;
    if (data.error) throw new Error(data.error.message);
    return data.result;
  }

  /** Confidence level ordering */
  private meetsPolicy(confidence: BurnConfidence): boolean {
    const levels: BurnConfidence[] = ['mempool', 'confirmed', 'finalized'];
    const required = levels.indexOf(this.config.releasePolicy);
    const actual = levels.indexOf(confidence);
    return actual >= required;
  }

  /** Check if event confidence is an upgrade */
  private isUpgrade(from: BurnConfidence, to: BurnConfidence): boolean {
    const levels: BurnConfidence[] = ['mempool', 'confirmed', 'finalized'];
    return levels.indexOf(to) > levels.indexOf(from);
  }

  // ─── Circuit Breaker ─────────────────────────────────

  /** Halt all releases (Trigger Class B/C/D) */
  halt(reason: string): void {
    this.halted = true;
    logger.error(`[DUA] 🛑 CIRCUIT BREAKER ACTIVATED: ${reason}`);
  }

  /** Resume releases after manual investigation */
  resume(): void {
    this.halted = false;
    logger.info(`[DUA] ✅ Circuit breaker reset — releases resumed`);
    // Process any pending releases
    const pending = this.releases.filter(r => r.releaseMethod === 'pending');
    logger.info(`[DUA] ${pending.length} pending releases queued for processing`);
  }

  // ─── API Helpers ─────────────────────────────────────

  getStatus(): {
    adapters: { chainId: string; healthy: boolean }[];
    halted: boolean;
    releasePolicy: string;
    seenSetSize: number;
    releases: { total: number; paul: number; direct: number; pending: number };
  } {
    return {
      adapters: Array.from(this.adapters.entries()).map(([id, a]) => ({
        chainId: id,
        healthy: a.isHealthy(),
      })),
      halted: this.halted,
      releasePolicy: this.config.releasePolicy,
      seenSetSize: this.seenSet.size,
      releases: {
        total: this.releases.length,
        paul: this.releases.filter(r => r.releaseMethod === 'paul').length,
        direct: this.releases.filter(r => r.releaseMethod === 'direct').length,
        pending: this.releases.filter(r => r.releaseMethod === 'pending').length,
      },
    };
  }

  getRecentReleases(limit: number = 50): ReleaseRecord[] {
    return this.releases.slice(-limit).reverse();
  }

  async stopAll(): Promise<void> {
    for (const [chainId, timer] of this.pollTimers) {
      clearInterval(timer);
    }
    for (const [chainId, adapter] of this.adapters) {
      await adapter.stop();
    }
    logger.info('[DUA] All adapters stopped');
  }
}
