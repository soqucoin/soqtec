/**
 * Solana Chain Event Adapter (CEA)
 *
 * Provides two burn detection channels:
 *   1. Push: Helius Enhanced Webhook (account change on bridge token accounts)
 *   2. Pull: Solana RPC polling via getSignaturesForAddress
 *
 * Both channels produce NormalizedBurnEvents that the DUA router handles.
 * If Helius goes down, the poll channel picks up the slack within 5 seconds.
 *
 * Patent reference: SOQ-P006 §3.1 (Webhook Push) + §3.2 (Poll Fallback)
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, EventParser } from '@coral-xyz/anchor';
import {
  ChainEventAdapter,
  NormalizedBurnEvent,
  BurnCallback,
  VerifyResult,
  BurnConfidence,
} from './types';
import { logger } from '../utils/logger';

export interface SolanaCEAConfig {
  /** Solana RPC URL (Helius, Alchemy, or public) */
  rpcUrl: string;

  /** Helius API key for webhooks + enhanced RPC */
  heliusApiKey: string;

  /** Bridge program ID on Solana */
  programId: string;

  /** Bridge token mint address */
  tokenMint: string;

  /** Helius webhook URL to register (our relayer's callback endpoint) */
  webhookCallbackUrl: string;

  /** Bridge IDL for event parsing */
  idl: any;

  /** Poll interval in ms (fallback) */
  pollIntervalMs: number;
}

export class SolanaCEA implements ChainEventAdapter {
  readonly chainId = 'solana' as const;

  private config: SolanaCEAConfig;
  private connection: Connection;
  private programPubkey: PublicKey;
  private eventParser: EventParser;
  private callback: BurnCallback | null = null;
  private lastSignature: string | null = null;
  private healthy: boolean = false;
  private webhookId: string | null = null;

  constructor(config: SolanaCEAConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, 'finalized');
    this.programPubkey = new PublicKey(config.programId);

    const coder = new BorshCoder(config.idl);
    this.eventParser = new EventParser(this.programPubkey, coder);
  }

  async start(): Promise<void> {
    logger.info('[CEA:Solana] Starting...');

    // Test RPC connectivity
    try {
      const slot = await this.connection.getSlot();
      logger.info(`[CEA:Solana] Connected to RPC — slot ${slot}`);
      this.healthy = true;
    } catch (err) {
      logger.error('[CEA:Solana] RPC connection failed:', err);
      throw err;
    }

    // Get latest signature as poll starting point
    try {
      const sigs = await this.connection.getSignaturesForAddress(
        this.programPubkey,
        { limit: 1 }
      );
      if (sigs.length > 0) {
        this.lastSignature = sigs[0].signature;
        logger.info(`[CEA:Solana] Poll starting from: ${this.lastSignature.slice(0, 16)}...`);
      }
    } catch (err) {
      logger.warn('[CEA:Solana] Could not fetch initial signature — will start from latest');
    }
  }

  async stop(): Promise<void> {
    this.healthy = false;
    // Remove webhook if we registered one
    if (this.webhookId) {
      try {
        await this.deleteHeliusWebhook(this.webhookId);
      } catch (err) {
        logger.warn('[CEA:Solana] Failed to delete webhook:', err);
      }
    }
    logger.info('[CEA:Solana] Stopped');
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  /**
   * Push-based: register callback and set up Helius webhook
   */
  async subscribeBurns(callback: BurnCallback): Promise<void> {
    this.callback = callback;

    // Register Helius Enhanced Webhook for token account changes
    try {
      this.webhookId = await this.registerHeliusWebhook();
      logger.info(`[CEA:Solana] Helius webhook registered: ${this.webhookId}`);
    } catch (err) {
      logger.warn('[CEA:Solana] Helius webhook registration failed — poll-only mode:', err);
      // Not fatal — poll fallback handles this
    }
  }

  /**
   * Pull-based: poll for new transactions on the bridge program
   */
  async pollBurns(sinceRef: string | null): Promise<{
    burns: NormalizedBurnEvent[];
    nextRef: string;
  }> {
    const ref = sinceRef || this.lastSignature;
    const options: any = { limit: 20 };
    if (ref) {
      options.until = ref;
    }

    try {
      const sigs = await this.connection.getSignaturesForAddress(
        this.programPubkey,
        options
      );

      if (sigs.length === 0) {
        return { burns: [], nextRef: ref || '' };
      }

      const burns: NormalizedBurnEvent[] = [];

      // Process oldest first
      for (const sig of sigs.reverse()) {
        const event = await this.parseTransaction(sig.signature);
        if (event) {
          burns.push(event);
        }
      }

      const newRef = sigs[0].signature;
      this.lastSignature = newRef;

      return { burns, nextRef: newRef };
    } catch (err) {
      logger.error('[CEA:Solana] Poll error:', err);
      this.healthy = false;
      return { burns: [], nextRef: ref || '' };
    }
  }

  /**
   * On-chain verification: confirm a burn TX is finalized
   *
   * Patent: "independently verifying the burn transaction on the first
   * blockchain by confirming the transaction signature corresponds to
   * a finalized, irreversible state change" — Claim 1(d)
   */
  async verifyBurn(burnTxId: string): Promise<VerifyResult> {
    try {
      // MUST use 'finalized' commitment — not 'confirmed' or 'processed'
      const tx = await this.connection.getTransaction(burnTxId, {
        maxSupportedTransactionVersion: 0,
        commitment: 'finalized',
      });

      if (!tx) {
        // Try confirmed — maybe it's not finalized yet
        const txConfirmed = await this.connection.getTransaction(burnTxId, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });

        if (!txConfirmed) {
          return { valid: false, confidence: 'mempool', error: 'TX not found' };
        }

        return {
          valid: true,
          confidence: 'confirmed',
          blockHeight: txConfirmed.slot,
        };
      }

      if (tx.meta?.err) {
        return { valid: false, confidence: 'finalized', error: `TX failed: ${JSON.stringify(tx.meta.err)}` };
      }

      return {
        valid: true,
        confidence: 'finalized',
        blockHeight: tx.slot,
      };
    } catch (err: any) {
      return { valid: false, confidence: 'mempool', error: err.message };
    }
  }

  // ─── Private Helpers ─────────────────────────────────

  /**
   * Parse a Solana transaction for BurnForRedemption events
   */
  private async parseTransaction(signature: string): Promise<NormalizedBurnEvent | null> {
    try {
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx || !tx.meta || tx.meta.err) return null;

      const logs = tx.meta.logMessages || [];
      const events = this.eventParser.parseLogs(logs);

      for (const event of events) {
        if (event.name === 'burnForRedemptionEvent') {
          const data = event.data as any;

          // Decode SOQ address from bytes
          const soqAddrBytes = data.soqAddress as number[];
          const soqAddress = Buffer.from(soqAddrBytes)
            .toString('utf8')
            .replace(/\0/g, '');

          // Determine confidence based on what connection returned
          // (our connection uses 'finalized' commitment)
          const confidence: BurnConfidence = 'finalized';

          return {
            chain: 'solana',
            burnTxId: signature,
            grossAmount: BigInt(data.amount.toString()),
            netAmountSoq: BigInt(data.netAmount.toString()),
            feeAmount: BigInt(data.fee.toString()),
            recipientSoq: soqAddress,
            nonce: Number(data.nonce),
            confidence,
            detectedAt: Date.now(),
            finalizedAt: confidence === 'finalized' ? Date.now() : null,
            rawMeta: {
              user: data.user?.toString(),
              slot: tx.slot,
            },
          };
        }
      }

      return null;
    } catch (err) {
      logger.error(`[CEA:Solana] Error parsing tx ${signature.slice(0, 16)}...:`, err);
      return null;
    }
  }

  /**
   * Register a Helius Enhanced Webhook to monitor the bridge program
   *
   * Helius API: POST https://api.helius.xyz/v0/webhooks
   * Triggers on: token account balance decrease (burn)
   */
  private async registerHeliusWebhook(): Promise<string> {
    const resp = await fetch(
      `https://api.helius.xyz/v0/webhooks?api-key=${this.config.heliusApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookURL: this.config.webhookCallbackUrl,
          transactionTypes: ['BURN'],
          accountAddresses: [this.config.programId],
          webhookType: 'enhanced',
          // Enhanced webhook gives us parsed instruction data
        }),
      }
    );

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Helius webhook registration failed (${resp.status}): ${body}`);
    }

    const data = await resp.json() as any;
    return data.webhookID;
  }

  /** Delete a Helius webhook */
  private async deleteHeliusWebhook(webhookId: string): Promise<void> {
    await fetch(
      `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${this.config.heliusApiKey}`,
      { method: 'DELETE' }
    );
  }

  /**
   * Process an incoming Helius webhook payload.
   * This is called by the relayer's HTTP server when Helius fires.
   *
   * Call this from your Express/Fastify route handler:
   *   app.post('/api/helius/burn-events', (req, res) => {
   *     solanaCea.processWebhookPayload(req.body);
   *     res.sendStatus(200);
   *   });
   */
  async processWebhookPayload(payload: any[]): Promise<void> {
    if (!this.callback) return;

    for (const event of payload) {
      // Helius Enhanced Webhook format
      if (event.type !== 'BURN') continue;

      const sig = event.signature;
      if (!sig) continue;

      // The webhook fires on 'confirmed' — we need to verify finalization
      // Parse the full transaction to get our event data
      const burnEvent = await this.parseTransaction(sig);
      if (burnEvent) {
        await this.callback(burnEvent);
      }
    }
  }
}
