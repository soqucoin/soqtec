/**
 * BTCSOQ Gateway — orchestrator for the quantum-shielded Bitcoin lane.
 *
 * Owns the BitcoinCEA lifecycle, the intent registry (deposit-address ↔
 * attendee ssq Dilithium address binding), and the deposit ledger.
 *
 * Day 1 scope (DL §6): intent API + deposit detection with confirmation
 * policy + SPV proof capture, proven E2E on regtest.
 * Day 2 wires the money: receipt mint via soq-signer (OP_RETURN tag),
 * redemption watching, BTC release — at which point release routing is
 * integrated with the DUAEventRouter. The router is NOT used on Day 1
 * because its release path is hardwired to SOQ sendtoaddress, which must
 * never fire off a raw BTC deposit event.
 *
 * DL-BTC-SOQTEC-GATEWAY-2026-07-16.md §5 — epic bead soqucoin-build-6hp.
 */

import { randomUUID } from 'crypto';
import { BitcoinCEA, BitcoinCEAConfig } from '../cea/bitcoin-cea';
import { NormalizedBurnEvent, BurnConfidence } from '../cea/types';
import { GatewayStore, BtcIntent, DepositRecord } from './store';
import { logger } from '../utils/logger';

export interface BtcsoqConfig extends BitcoinCEAConfig {
  enabled: boolean;
  releaseWallet: string;
  dataDir: string;
  intentTtlHours: number;
  /** Public explorer base for deep links (e.g. https://mempool.space/testnet4) */
  explorerBase: string;
}

/** Loose shape check for a stagenet Soqucoin bech32m address (ssq1...). Full
 *  validation happens against the node when the mint path lands (Day 2). */
const SSQ_ADDR_RE = /^ssq1[02-9ac-hj-np-z]{20,120}$/;

/** Loose shape check for a Bitcoin testnet4/regtest bech32 payout address. */
const BTC_ADDR_RE = /^(tb1|bcrt1)[02-9ac-hj-np-z]{20,100}$/;

const CONFIDENCE_ORDER: BurnConfidence[] = ['mempool', 'confirmed', 'finalized'];

export class BtcsoqGateway {
  private config: BtcsoqConfig;
  private cea: BitcoinCEA;
  private store: GatewayStore;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Last emitted confidence per deposit key — dedup + upgrade detection */
  private seen: Map<string, BurnConfidence> = new Map();
  private startedAt: number = 0;

  constructor(config: BtcsoqConfig) {
    this.config = config;
    this.cea = new BitcoinCEA(config);
    this.store = new GatewayStore(config.dataDir);
  }

  async start(): Promise<void> {
    await this.store.load();

    // Prime dedup state from persisted deposits so restarts don't re-log
    for (const dep of this.store.listDeposits()) {
      this.seen.set(dep.key, dep.confidence);
    }

    await this.cea.start(this.store.getPollCursor() ?? null);
    await this.cea.subscribeBurns((evt) => this.onDepositEvent(evt));

    this.pollTimer = setInterval(() => {
      this.checkNow().catch((err) =>
        logger.error(`[BTCSOQ] poll tick failed: ${err.message}`)
      );
    }, this.config.pollIntervalMs);

    this.startedAt = Date.now();
    logger.info(`[BTCSOQ] Gateway started (${this.config.network}, poll ${this.config.pollIntervalMs}ms, finality ${this.config.finalityConf} conf)`);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.cea.stop();
    logger.info('[BTCSOQ] Gateway stopped');
  }

  /** Poll immediately (timer tick or blocknotify push), then persist the cursor. */
  async checkNow(): Promise<number> {
    const n = await this.cea.checkNow();
    const cursor = this.cea.getCursor();
    if (cursor && cursor !== this.store.getPollCursor()) {
      await this.store.setPollCursor(cursor);
    }
    await this.expireStaleIntents();
    return n;
  }

  // ── Intents ────────────────────────────────────────────

  async createDepositIntent(ssqAddress: string): Promise<BtcIntent> {
    if (!SSQ_ADDR_RE.test(ssqAddress)) {
      throw new GatewayInputError('Invalid Soqucoin address (expected stagenet bech32m, ssq1...)');
    }

    const id = randomUUID();
    // Fresh P2TR per intent from the watch-only descriptor wallet — the
    // label binds address → intent inside the wallet itself, so the
    // binding is recoverable even without this store (DL §4.3).
    const btcDepositAddress = await this.cea.deriveDepositAddress(`intent:${id}`);

    const now = Date.now();
    const intent: BtcIntent = {
      id,
      kind: 'deposit',
      network: this.config.network,
      ssqAddress,
      btcDepositAddress,
      status: 'awaiting-deposit',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.config.intentTtlHours * 3600_000,
    };
    await this.store.putIntent(intent);
    logger.info(`[BTCSOQ] Deposit intent ${id.slice(0, 8)}: ${btcDepositAddress} ↔ ${ssqAddress.slice(0, 20)}...`);
    return intent;
  }

  async createRedeemIntent(ssqAddress: string, btcPayoutAddress: string): Promise<BtcIntent> {
    if (!SSQ_ADDR_RE.test(ssqAddress)) {
      throw new GatewayInputError('Invalid Soqucoin address (expected stagenet bech32m, ssq1...)');
    }
    if (!BTC_ADDR_RE.test(btcPayoutAddress)) {
      throw new GatewayInputError(`Invalid Bitcoin payout address for ${this.config.network}`);
    }

    const now = Date.now();
    const intent: BtcIntent = {
      id: randomUUID(),
      kind: 'redeem',
      network: this.config.network,
      ssqAddress,
      btcPayoutAddress,
      status: 'awaiting-receipt',   // redemption watcher lands Day 2
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.config.intentTtlHours * 3600_000,
    };
    await this.store.putIntent(intent);
    logger.info(`[BTCSOQ] Redeem intent ${intent.id.slice(0, 8)}: receipt → ${btcPayoutAddress}`);
    return intent;
  }

  getIntent(id: string): BtcIntent | undefined {
    return this.store.getIntent(id);
  }

  // ── Deposit event handling ─────────────────────────────

  private async onDepositEvent(evt: NormalizedBurnEvent): Promise<void> {
    const key = evt.burnTxId;   // txid:vout
    const meta = (evt.rawMeta || {}) as any;

    // Dedup / confidence-upgrade gate (mirrors DUA router semantics)
    const prev = this.seen.get(key);
    if (prev && CONFIDENCE_ORDER.indexOf(evt.confidence) <= CONFIDENCE_ORDER.indexOf(prev)) {
      return;
    }
    this.seen.set(key, evt.confidence);

    const intent = this.store.findDepositIntentByAddress(meta.address);
    const sats = Number(evt.grossAmount);

    logger.info(`[BTCSOQ] DEPOSIT ${prev ? 'upgrade' : 'detected'}: ${sats} sats → ${meta.address} (${evt.confidence}, ${meta.confirmations} conf)${intent ? ` intent=${intent.id.slice(0, 8)}` : ' UNSOLICITED'}`);

    const existing = this.store.getDeposit(key);
    const dep: DepositRecord = existing ?? {
      key,
      txid: meta.txid,
      vout: meta.vout,
      address: meta.address,
      sats,
      confirmations: meta.confirmations ?? 0,
      confidence: evt.confidence,
      intentId: intent?.id ?? null,
      network: this.config.network,
      firstSeenAt: evt.detectedAt,
      confirmedAt: null,
    };
    dep.confirmations = meta.confirmations ?? dep.confirmations;
    dep.confidence = evt.confidence;
    dep.blockHash = meta.blockhash ?? dep.blockHash;
    dep.blockHeight = meta.blockheight ?? dep.blockHeight;

    // SPV proof once confirmed (self-checked inside getSpvProof)
    if (evt.confidence !== 'mempool' && !dep.spvProof) {
      const proof = await this.cea.getSpvProof(dep.txid, dep.blockHash);
      if (proof) {
        dep.spvProof = proof;
        logger.info(`[BTCSOQ] SPV proof captured for ${dep.txid.slice(0, 16)}... (${proof.length / 2} bytes)`);
      }
      if (!dep.confirmedAt) dep.confirmedAt = Date.now();
    }
    await this.store.putDeposit(dep);

    // Intent transition
    if (intent && intent.kind === 'deposit') {
      const expired = intent.status === 'expired';
      if (expired) {
        // Funds to an expired intent are still recorded (dep above) — flag, don't mint.
        logger.warn(`[BTCSOQ] Deposit to EXPIRED intent ${intent.id.slice(0, 8)} — recorded, held for manual handling`);
        return;
      }
      if (evt.confidence === 'mempool' && intent.status === 'awaiting-deposit') {
        await this.transition(intent, 'deposit-seen', dep);
      } else if (evt.confidence !== 'mempool' &&
                 (intent.status === 'awaiting-deposit' || intent.status === 'deposit-seen')) {
        // Confirmation policy met → eligible for receipt mint (Day 2 picks up here)
        await this.transition(intent, 'confirmed', dep);
      }
    }
  }

  private async transition(intent: BtcIntent, status: BtcIntent['status'], dep: DepositRecord): Promise<void> {
    intent.status = status;
    intent.updatedAt = Date.now();
    intent.depositTxid = dep.txid;
    intent.depositVout = dep.vout;
    intent.sats = dep.sats;
    intent.confirmations = dep.confirmations;
    if (dep.spvProof) intent.spvProof = dep.spvProof;
    await this.store.putIntent(intent);
    logger.info(`[BTCSOQ] Intent ${intent.id.slice(0, 8)} → ${status}`);
  }

  private async expireStaleIntents(): Promise<void> {
    const now = Date.now();
    for (const intent of this.store.listIntents()) {
      if (intent.status === 'awaiting-deposit' && now > intent.expiresAt) {
        intent.status = 'expired';
        intent.updatedAt = now;
        await this.store.putIntent(intent);
        logger.info(`[BTCSOQ] Intent ${intent.id.slice(0, 8)} expired (no deposit within TTL)`);
      }
    }
  }

  // ── Status surfaces ────────────────────────────────────

  /** Live view of one intent, refreshing confirmations from the node. */
  async intentStatus(id: string): Promise<any | null> {
    const intent = this.store.getIntent(id);
    if (!intent) return null;

    let live: any = {};
    if (intent.depositTxid !== undefined && intent.depositVout !== undefined) {
      const v = await this.cea.verifyBurn(`${intent.depositTxid}:${intent.depositVout}`);
      live = {
        liveConfirmations: v.confirmations ?? 0,
        liveConfidence: v.confidence,
        blockHeight: v.blockHeight,
      };
    }

    return {
      ...intent,
      ...live,
      spvProofAvailable: !!intent.spvProof,
      spvProof: undefined,   // full hex via explicit query param on the status route
      explorer: intent.depositTxid && this.config.network === 'testnet4'
        ? `${this.config.explorerBase}/tx/${intent.depositTxid}`
        : undefined,
      confPolicy: { required: this.config.finalityConf, disclosed: true },
    };
  }

  getIntentRaw(id: string): BtcIntent | undefined {
    return this.store.getIntent(id);
  }

  async gatewayStatus(): Promise<any> {
    let vault: { confirmedSats: bigint; pendingSats: bigint } | null = null;
    let height: number | null = null;
    try {
      vault = await this.cea.getVaultBalance();
      height = await this.cea.getBlockHeight();
    } catch { /* degraded — reported via healthy flag */ }

    const intents = this.store.listIntents();
    const deposits = this.store.listDeposits();
    return {
      asset: 'BTCSOQ',
      model: 'overlay-receipt',   // relayer-tracked for the demo; consensus asset = roadmap (DL §3)
      network: this.config.network,
      healthy: this.cea.isHealthy(),
      blockHeight: height,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      confPolicy: { required: this.config.finalityConf },
      vault: vault ? {
        confirmedSats: vault.confirmedSats.toString(),
        pendingSats: vault.pendingSats.toString(),
      } : null,
      intents: {
        total: intents.length,
        awaiting: intents.filter((i) => i.status === 'awaiting-deposit').length,
        confirmed: intents.filter((i) => i.status === 'confirmed').length,
        minted: intents.filter((i) => i.status === 'minted').length,
      },
      deposits: {
        total: deposits.length,
        totalSats: deposits.reduce((s, d) => s + d.sats, 0),
        unsolicited: deposits.filter((d) => d.intentId === null).length,
      },
    };
  }

  listRecentDeposits(limit: number = 50): DepositRecord[] {
    return this.store.listDeposits().slice(0, limit);
  }
}

/** 4xx-class input error, distinguished from operational failures. */
export class GatewayInputError extends Error {}
