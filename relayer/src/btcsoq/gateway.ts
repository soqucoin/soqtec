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

import { randomUUID, createHash } from 'crypto';
import { existsSync } from 'fs';
import { BitcoinCEA, BitcoinCEAConfig } from '../cea/bitcoin-cea';
import { NormalizedBurnEvent, BurnConfidence } from '../cea/types';
import { GatewayStore, BtcIntent, DepositRecord, MintRecord, ConvertRecord, Ln402Record } from './store';
import { MintSignerClient } from './signer-client';
import { ProdConvertClient } from './convert-client';
import { Ln402Client } from './ln402';
import { SoqScanner } from './soq-scan';
import { BitcoinRpc } from './rpc';
import { encodeTag } from './receipt';
import { AttestedEventKind, AttestationRecord, buildPayload, sha256Hex } from './attestation';
import { logger } from '../utils/logger';

export interface BtcsoqConfig extends BitcoinCEAConfig {
  enabled: boolean;
  releaseWallet: string;
  dataDir: string;
  intentTtlHours: number;
  /** Public explorer base for deep links (e.g. https://mempool.space/testnet4) */
  explorerBase: string;
  // ── Money loop (Day 2) ──
  /** Dedicated gateway signer instance (soq-privacy-signer pattern, NOT prod 8550) */
  mintSignerUrl: string;
  mintSignerToken: string;
  /** Gateway mint float address (a key in the gateway signer's keystore) */
  mintFromAddress: string;
  /** Receipts return here to redeem (a second key in the same keystore) */
  redemptionAddress: string;
  /** Carrier UTXO value in shors — must cover its own redemption spend fee */
  carrierShors: number;
  /** sat/vB for mint txs (stagenet floor = 1000) */
  mintFeeRate: number;
  /** Deposits below this are recorded but never minted (underpay guard) */
  minDepositSats: number;
  /** Stagenet cold-node RPC (read-only: recovery + redemption scanning) */
  soqRpcUrl: string;
  soqRpcUser: string;
  soqRpcPass: string;
  /** Attestation signing key (in the gateway signer keystore); empty = feed off */
  attestationAddress: string;
  // ── Circuit breaker (Day 4) ──
  /** Rolling 24h mint ceiling in sats (0 = unlimited) */
  maxDailyMintSats: number;
  /** Rolling 24h release ceiling in sats (0 = unlimited) */
  maxDailyReleaseSats: number;
  /** Pause switch: while this file exists, mints and releases are deferred */
  pauseFile: string;
  // ── USDSOQ conversion leg (WS2, Miami) ──
  /** PRODUCTION signer base URL (convert engine lives there); empty = leg off */
  convertSignerUrl: string;
  convertSignerToken: string;
  /** Convert treasury deposit address (must match the engine's TreasuryAddrs) */
  convertTreasuryAddress: string;
  /** Gateway-held USDSOQ destination (a key in the gateway signer keystore) */
  convertUsdsoqAddress: string;
  /** SOQ shors sent through the consensus swap per completed BTC loop */
  convertSoqShors: number;
  /** Rolling 24h ceiling on SOQ entering the treasury (0 = unlimited) */
  maxDailyConvertShors: number;
  // ── Lightning + SOQ-402 finale (WS3, Miami) ──
  /** L2SOQ LSP base URL; empty = leg off */
  ln402LspUrl: string;
  /** SOQ-402 seller base URL (same VPS: http://127.0.0.1:4020); empty = leg off */
  ln402SellerUrl: string;
  /** The on-stage question — fixed so the receipt's request hash is stable */
  ln402Question: string;
  /** Hosted payer channel capacity in shors (≤ LSP max_channel_sat) */
  ln402ChannelShors: number;
  /** Gateway signer address whose key identifies the payer channel */
  ln402ChannelAddress: string;
  // ── Theater (the payoff acts) ──
  /** Second SOQ-402 agent (Bit, :4021) — empty disables the duel + theater */
  ln402Seller2Url: string;
  /** Race payee channel identity (a gateway signer key, distinct from payer) */
  racePayeeAddress: string;
  // ── Bitcoin anchoring (WS4) ──
  /** Write the ledger's merkle root into a Bitcoin OP_RETURN on a schedule */
  anchorEnabled: boolean;
  /** Minutes between anchor checks (a tx is only sent when the ledger changed) */
  anchorIntervalMin: number;
}

/** How often stuck 'minting'/'redeeming' records are re-driven. */
const MINT_RETRY_MS = 30_000;

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
  private signer: MintSignerClient;
  private scanner: SoqScanner;
  private releaseRpc: BitcoinRpc;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private moneyTimer: ReturnType<typeof setInterval> | null = null;
  private moneyLoopRunning: boolean = false;
  private convertClient: ProdConvertClient | null = null;
  private ln402Client: Ln402Client | null = null;
  /** Serializes mint attempts per deposit key (poll tick vs retry tick race) */
  private mintingInFlight: Set<string> = new Set();
  /** Serializes conversion attempts per deposit key */
  private convertingInFlight: Set<string> = new Set();
  /** Serializes 402 attempts per deposit key */
  private ln402InFlight: Set<string> = new Set();
  /** Last emitted confidence per deposit key — dedup + upgrade detection */
  private seen: Map<string, BurnConfidence> = new Map();
  /** Router sink — when wired, mint routing goes CEA → DUA router → strategy */
  private routerSink: ((evt: NormalizedBurnEvent) => Promise<void>) | null = null;
  private startedAt: number = 0;

  constructor(config: BtcsoqConfig) {
    this.config = config;
    this.cea = new BitcoinCEA(config);
    this.store = new GatewayStore(config.dataDir);
    this.signer = new MintSignerClient({
      url: config.mintSignerUrl,
      token: config.mintSignerToken,
      feeRate: config.mintFeeRate,
    });
    this.scanner = new SoqScanner({
      rpcUrl: config.soqRpcUrl,
      rpcUser: config.soqRpcUser,
      rpcPass: config.soqRpcPass,
    });
    this.releaseRpc = new BitcoinRpc({
      url: config.rpcUrl,
      user: config.rpcUser,
      pass: config.rpcPass,
      wallet: config.releaseWallet,
    });
    if (this.convertEnabled()) {
      this.convertClient = new ProdConvertClient({
        url: config.convertSignerUrl,
        token: config.convertSignerToken,
      });
    }
  }

  private convertEnabled(): boolean {
    return !!(this.config.convertSignerUrl && this.config.convertSignerToken &&
              this.config.convertTreasuryAddress && this.config.convertUsdsoqAddress &&
              this.config.convertSoqShors > 0);
  }

  private ln402Enabled(): boolean {
    return !!(this.config.ln402LspUrl && this.config.ln402SellerUrl &&
              this.config.ln402Question && this.config.ln402ChannelAddress);
  }

  /** Lazy: the channel identity pubkey comes from the gateway signer. */
  private async getLn402Client(): Promise<Ln402Client> {
    if (!this.ln402Client) {
      const pubkey = await this.signer.pubkey(this.config.ln402ChannelAddress);
      this.ln402Client = new Ln402Client({
        lspUrl: this.config.ln402LspUrl,
        sellerUrl: this.config.ln402SellerUrl,
        question: this.config.ln402Question,
        dataDir: this.config.dataDir,
        channelAddress: this.config.ln402ChannelAddress,
        channelPubkeyHex: pubkey,
        channelCapacityShors: this.config.ln402ChannelShors,
      });
    }
    return this.ln402Client;
  }

  /**
   * Wire the DUA router as the mint-routing hop (CEA → router → strategy →
   * mint). Without a sink the gateway routes mints directly — behavior is
   * identical either way because the mint pipeline is CAS-idempotent.
   */
  setRouterSink(sink: (evt: NormalizedBurnEvent) => Promise<void>): void {
    this.routerSink = sink;
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

    if (this.moneyLoopEnabled()) {
      // Crash recovery BEFORE anything can mint: resolve every in-flight
      // 'minting'/'redeeming' record against chain/wallet truth.
      await this.recoverInFlight();

      this.moneyTimer = setInterval(() => {
        this.moneyTick().catch((err) =>
          logger.error(`[BTCSOQ] money tick failed: ${err.message}`)
        );
      }, MINT_RETRY_MS);
      logger.info(`[BTCSOQ] Money loop armed: mint float=${this.config.mintFromAddress.slice(0, 20)}..., redemption=${this.config.redemptionAddress.slice(0, 20)}..., carrier=${this.config.carrierShors} shors, min deposit=${this.config.minDepositSats} sats`);
      logger.info(this.convertEnabled()
        ? `[BTCSOQ] USDSOQ leg armed: ${this.config.convertSoqShors} shors/loop via treasury ${this.config.convertTreasuryAddress.slice(0, 20)}... → ${this.config.convertUsdsoqAddress.slice(0, 20)}...`
        : '[BTCSOQ] USDSOQ leg off (convert signer/treasury/destination not configured)');
      logger.info(this.ln402Enabled()
        ? `[BTCSOQ] Lightning/402 leg armed: LSP ${this.config.ln402LspUrl}, seller ${this.config.ln402SellerUrl}`
        : '[BTCSOQ] Lightning/402 leg off (LSP/seller/question/channel address not configured)');
    } else {
      logger.warn('[BTCSOQ] Money loop DISABLED (mint signer/addresses not configured) — detection-only mode');
    }

    if (this.config.anchorEnabled) {
      this.anchorTimer = setInterval(() => {
        this.anchorNow().catch((err) => logger.warn(`[BTCSOQ] anchor tick failed: ${err.message}`));
      }, this.config.anchorIntervalMin * 60_000);
      logger.info(`[BTCSOQ] Bitcoin anchoring armed: every ${this.config.anchorIntervalMin} min when the ledger changes`);
    }

    this.startedAt = Date.now();
    logger.info(`[BTCSOQ] Gateway started (${this.config.network}, poll ${this.config.pollIntervalMs}ms, finality ${this.config.finalityConf} conf)`);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.moneyTimer) {
      clearInterval(this.moneyTimer);
      this.moneyTimer = null;
    }
    if (this.anchorTimer) {
      clearInterval(this.anchorTimer);
      this.anchorTimer = null;
    }
    await this.cea.stop();
    logger.info('[BTCSOQ] Gateway stopped');
  }

  private moneyLoopEnabled(): boolean {
    return !!(this.config.mintSignerUrl && this.config.mintSignerToken &&
              this.config.mintFromAddress && this.config.redemptionAddress);
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
    await this.requireValidSsq(ssqAddress);

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
    await this.requireValidSsq(ssqAddress);
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

  /**
   * Node-side validation (bech32m checksum, network HRP). The shape regex
   * alone admits addresses that can never decode — a mint claimed against
   * one would retry forever. Fails OPEN if the node is unreachable (the
   * mint-time check below still fails closed before any claim).
   */
  private async requireValidSsq(ssqAddress: string): Promise<void> {
    if (!this.moneyLoopEnabled()) return;   // detection-only mode: keep Day-1 behavior
    let valid = true;
    try {
      valid = await this.scanner.validateAddress(ssqAddress);
    } catch (err: any) {
      logger.warn(`[BTCSOQ] validateaddress unavailable (${err.message}) — accepting shape-valid address`);
      return;
    }
    if (!valid) {
      throw new GatewayInputError('Soqucoin address failed checksum validation (not a real stagenet address)');
    }
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
      if (intent.status === 'expired') {
        // A fortress address never goes dead: pool payouts arrive on their
        // own schedule (threshold-gated, sometimes days apart), so money
        // revives the intent and processing continues normally. The
        // address→ssq binding lives in the wallet label and never changed.
        intent.status = 'awaiting-deposit';
        intent.expiresAt = Date.now() + this.config.intentTtlHours * 3600_000;
        intent.updatedAt = Date.now();
        await this.store.putIntent(intent);
        logger.info(`[BTCSOQ] Deposit to expired intent ${intent.id.slice(0, 8)} — revived, processing normally`);
      }
      if (evt.confidence === 'mempool' && intent.status === 'awaiting-deposit') {
        await this.transition(intent, 'deposit-seen', dep);
      } else if (evt.confidence !== 'mempool' &&
                 (intent.status === 'awaiting-deposit' || intent.status === 'deposit-seen')) {
        // Confirmation policy met → eligible for receipt mint
        await this.transition(intent, 'confirmed', dep);
      }
    }

    // Mint routing: through the DUA router when wired (CEA → router →
    // release strategy → mint), else direct. CAS-idempotent either way.
    if (this.moneyLoopEnabled() && evt.confidence !== 'mempool') {
      if (this.routerSink) {
        await this.routerSink(evt);
      } else {
        await this.mintForDepositKey(key);
      }
    }
  }

  /**
   * DUA release-strategy entry point: mint the receipt for a confirmed
   * deposit event. Returns the mint txid, or null when there is nothing
   * actionable (unsolicited / already in flight / below minimum).
   */
  async mintForDepositEvent(evt: NormalizedBurnEvent): Promise<string | null> {
    return this.mintForDepositKey(evt.burnTxId);
  }

  private async mintForDepositKey(key: string): Promise<string | null> {
    const dep = this.store.getDeposit(key);
    if (!dep) return null;

    const existing = this.store.getMint(key);
    if (existing) {
      // Replay-safe: one deposit outpoint mints exactly once, ever.
      return existing.mintTxid ?? null;
    }

    const intent = dep.intentId ? this.store.getIntent(dep.intentId) : undefined;
    if (!intent || intent.kind !== 'deposit') {
      // Unsolicited deposits are held, never minted (no ssq binding exists).
      return null;
    }
    if (intent.status !== 'confirmed') return null;

    if (dep.sats < this.config.minDepositSats) {
      intent.status = 'failed';
      intent.failReason = `underpay: ${dep.sats} sats < ${this.config.minDepositSats} minimum`;
      intent.updatedAt = Date.now();
      await this.store.putIntent(intent);
      logger.warn(`[BTCSOQ] Intent ${intent.id.slice(0, 8)} → failed (${intent.failReason}) — deposit held, no mint`);
      return null;
    }

    // Mint-time address check, BEFORE any claim: an undecodable recipient
    // would leave a 'minting' record retrying forever (pre-validation
    // intents from Day 1 can carry shape-valid-but-fake addresses).
    try {
      if (!(await this.scanner.validateAddress(intent.ssqAddress))) {
        intent.status = 'failed';
        intent.failReason = 'recipient ssq address failed checksum validation';
        intent.updatedAt = Date.now();
        await this.store.putIntent(intent);
        logger.warn(`[BTCSOQ] Intent ${intent.id.slice(0, 8)} → failed (invalid recipient ${intent.ssqAddress.slice(0, 24)}...) — deposit held, no mint`);
        return null;
      }
    } catch (err: any) {
      // Node unreachable — don't claim, don't fail; the next tick retries.
      logger.warn(`[BTCSOQ] validateaddress unavailable at mint time (${err.message}) — deferring mint for ${key.slice(0, 20)}...`);
      return null;
    }

    const tag = encodeTag('mint', BigInt(dep.sats), dep.txid, dep.vout);
    const claimHeight = await this.scanner.tipHeight();
    const rec: MintRecord = {
      key,
      intentId: intent.id,
      ssqAddress: intent.ssqAddress,
      sats: dep.sats,
      carrierShors: this.config.carrierShors,
      opReturnHex: tag.toString('hex'),
      status: 'minting',
      claimHeight,
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // THE CAS: claim the outpoint BEFORE the signer sees anything. If this
    // returns false another path already claimed it — walk away.
    if (!(await this.store.claimMint(rec))) {
      return this.store.getMint(key)?.mintTxid ?? null;
    }

    intent.status = 'minting';
    intent.updatedAt = Date.now();
    await this.store.putIntent(intent);
    logger.info(`[BTCSOQ] MINT claimed for ${key.slice(0, 20)}... (${dep.sats} sats → ${intent.ssqAddress.slice(0, 20)}...)`);

    return this.attemptMint(rec);
  }

  /**
   * Drive one mint attempt for a claimed record. ALWAYS chain-checks first:
   * a previous attempt may have broadcast and then crashed/timed out before
   * we recorded the txid. Blind re-mint is the pool double-credit class.
   */
  private async attemptMint(rec: MintRecord): Promise<string | null> {
    if (this.mintingInFlight.has(rec.key)) return null;
    // Breaker: defer, never fail — the record stays 'minting' and the tick
    // retries once the pause lifts / the 24h window frees up. The chain
    // recovery check still runs first on the retry, so nothing double-mints.
    const deferral = this.mintBreakerReason(rec.sats);
    if (deferral) {
      logger.warn(`[BTCSOQ] MINT deferred for ${rec.key.slice(0, 20)}...: ${deferral}`);
      return null;
    }
    this.mintingInFlight.add(rec.key);
    try {
      const payload = Buffer.from(rec.opReturnHex, 'hex');
      const found = await this.scanner.findMintTx(payload, rec.claimHeight);
      if (found) {
        logger.info(`[BTCSOQ] MINT recovered from chain for ${rec.key.slice(0, 20)}...: ${found.txid.slice(0, 16)}... (${found.height === null ? 'mempool' : `block ${found.height}`})`);
        if (found.carrierAddress && found.carrierAddress !== rec.ssqAddress) {
          logger.error(`[BTCSOQ] MINT ${found.txid.slice(0, 16)}... carrier pays ${found.carrierAddress}, expected ${rec.ssqAddress} — flagging, NOT finalizing`);
          rec.lastError = `carrier address mismatch on recovered mint ${found.txid}`;
          await this.store.putMint(rec);
          return null;
        }
        return this.finalizeMint(rec, found.txid);
      }

      rec.attempts += 1;
      await this.store.putMint(rec);
      const res = await this.signer.sendBtcsoqMint({
        recipientAddress: rec.ssqAddress,
        amount: rec.carrierShors,
        opReturnHex: rec.opReturnHex,
        fromAddress: this.config.mintFromAddress,
      });
      return await this.finalizeMint(rec, res.txid);
    } catch (err: any) {
      rec.lastError = err.message;
      await this.store.putMint(rec);
      logger.error(`[BTCSOQ] MINT attempt ${rec.attempts} failed for ${rec.key.slice(0, 20)}...: ${err.message} — stays 'minting', retry in ${MINT_RETRY_MS / 1000}s`);
      return null;
    } finally {
      this.mintingInFlight.delete(rec.key);
    }
  }

  private async finalizeMint(rec: MintRecord, mintTxid: string): Promise<string> {
    rec.status = 'minted';
    rec.mintTxid = mintTxid;
    rec.mintedAt = rec.mintedAt ?? Date.now();
    rec.lastError = undefined;
    await this.store.putMint(rec);

    const intent = this.store.getIntent(rec.intentId);
    if (intent) {
      intent.status = 'minted';
      intent.mintTxid = mintTxid;
      intent.updatedAt = Date.now();
      await this.store.putIntent(intent);
    }
    logger.info(`[BTCSOQ] MINTED ${rec.sats} sats receipt → ${rec.ssqAddress.slice(0, 20)}... (tx ${mintTxid.slice(0, 16)}..., carrier ${rec.carrierShors} shors)`);
    await this.attest('receipt-minted', {
      key: rec.key, intentId: rec.intentId, ssqAddress: rec.ssqAddress,
      sats: rec.sats, txid: mintTxid,
    });
    // Extend the line: the USDSOQ leg rides behind the mint, never blocks it
    // (failures land in the convert record and the money tick re-drives them).
    this.startConvertLeg(rec).catch((err) =>
      logger.warn(`[BTCSOQ] convert leg start failed for ${rec.key.slice(0, 20)}...: ${err.message} — money tick will retry`)
    );
    return mintTxid;
  }

  // ── USDSOQ conversion leg (WS2 — the consensus hop) ────

  private dailyConvertedShors(): number {
    const cutoff = Date.now() - 24 * 3600_000;
    return this.store.listConverts()
      .filter((c) => c.createdAt > cutoff)
      .reduce((s, c) => s + c.soqInShors, 0);
  }

  /** null = clear to convert; string = deferral reason (retried by the tick). */
  private convertBreakerReason(shors: number): string | null {
    if (this.isPaused()) return 'gateway paused (pause file present)';
    if (this.config.maxDailyConvertShors > 0 &&
        this.dailyConvertedShors() + shors > this.config.maxDailyConvertShors) {
      return `daily convert cap: ${this.dailyConvertedShors()} + ${shors} > ${this.config.maxDailyConvertShors} shors/24h`;
    }
    return null;
  }

  /**
   * Claim the conversion for a minted loop (CAS, one per deposit outpoint
   * ever) and drive the first attempt. The conversion spends GATEWAY float
   * SOQ — the attendee's receipt coin is never touched.
   */
  private async startConvertLeg(mint: MintRecord): Promise<void> {
    if (!this.convertEnabled()) return;
    if (this.store.getConvert(mint.key)) return;

    // Cap-aware claim: don't claim what the breaker would immediately defer —
    // an over-cap day should leave no backlog of claimed-but-parked records.
    const deferral = this.convertBreakerReason(this.config.convertSoqShors);
    if (deferral) {
      logger.warn(`[BTCSOQ] CONVERT not claimed for ${mint.key.slice(0, 20)}...: ${deferral}`);
      return;
    }

    const [depTxid, depVoutStr] = mint.key.split(':');
    const tag = encodeTag('convert', BigInt(mint.sats), depTxid, Number(depVoutStr));
    const claimHeight = await this.scanner.tipHeight();
    const rec: ConvertRecord = {
      key: mint.key,
      intentId: mint.intentId,
      ssqAddress: mint.ssqAddress,
      sats: mint.sats,
      soqInShors: this.config.convertSoqShors,
      opReturnHex: tag.toString('hex'),
      status: 'converting',
      claimHeight,
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (!(await this.store.claimConvert(rec))) return;
    logger.info(`[BTCSOQ] CONVERT claimed for ${mint.key.slice(0, 20)}... (${rec.soqInShors} shors → USDSOQ via treasury)`);
    await this.attemptConvert(rec);
  }

  /**
   * Drive one conversion attempt. Phase A: the BSQ1-'C'-tagged SOQ deposit
   * into the treasury — ALWAYS chain-checked first (the tag makes the send
   * recoverable; blind re-send is the pool double-credit class). Phase B:
   * the prod signer's convert execute, idempotent per treasury outpoint on
   * the signer side, so every retry is safe.
   */
  private async attemptConvert(rec: ConvertRecord): Promise<void> {
    if (!this.convertClient) return;
    if (this.convertingInFlight.has(rec.key)) return;
    const deferral = this.convertBreakerReason(rec.treasuryTxid ? 0 : rec.soqInShors);
    if (deferral) {
      logger.warn(`[BTCSOQ] CONVERT deferred for ${rec.key.slice(0, 20)}...: ${deferral}`);
      return;
    }
    this.convertingInFlight.add(rec.key);
    try {
      if (!rec.treasuryTxid) {
        const payload = Buffer.from(rec.opReturnHex, 'hex');
        const found = await this.scanner.findMintTx(payload, rec.claimHeight);
        if (found) {
          if (found.carrierAddress && found.carrierAddress !== this.config.convertTreasuryAddress) {
            logger.error(`[BTCSOQ] CONVERT ${found.txid.slice(0, 16)}... pays ${found.carrierAddress}, expected treasury — flagging, NOT proceeding`);
            rec.lastError = `treasury address mismatch on recovered convert send ${found.txid}`;
            await this.store.putConvert(rec);
            return;
          }
          rec.treasuryTxid = found.txid;
          await this.store.putConvert(rec);
          logger.info(`[BTCSOQ] CONVERT treasury send recovered from chain: ${found.txid.slice(0, 16)}...`);
        } else {
          rec.attempts += 1;
          await this.store.putConvert(rec);
          const res = await this.signer.sendBtcsoqMint({
            recipientAddress: this.config.convertTreasuryAddress,
            amount: rec.soqInShors,
            opReturnHex: rec.opReturnHex,
            fromAddress: this.config.mintFromAddress,
          });
          rec.treasuryTxid = res.txid;
          await this.store.putConvert(rec);
          logger.info(`[BTCSOQ] CONVERT treasury deposit sent: ${rec.soqInShors} shors (tx ${res.txid.slice(0, 16)}...)`);
        }
      }

      const result = await this.convertClient.execute(
        'soq_to_usdsoq', rec.treasuryTxid, this.config.convertUsdsoqAddress,
      );
      rec.status = 'converted';
      rec.payoutTxid = result.payout_txid;
      rec.usdsoqOutShors = result.amount_out;
      rec.convertedAt = rec.convertedAt ?? Date.now();
      rec.lastError = undefined;
      await this.store.putConvert(rec);
      logger.info(`[BTCSOQ] CONVERTED ${rec.soqInShors} shors → ${result.amount_out} USDSOQ units (payout ${result.payout_txid.slice(0, 16)}...${result.idempotent ? ', idempotent replay' : ''}) — loop ${rec.key.slice(0, 20)}... reached the stablecoin`);
      await this.attest('converted-usdsoq', {
        key: rec.key, intentId: rec.intentId, ssqAddress: rec.ssqAddress,
        sats: rec.sats, txid: result.payout_txid,
        detail: {
          soqInShors: rec.soqInShors,
          usdsoqOutShors: result.amount_out,
          treasuryTxid: rec.treasuryTxid,
        },
      });
      // The finale rides behind the stablecoin hop: Bitcoin pays an AI.
      this.startLn402Leg(rec).catch((err) =>
        logger.warn(`[BTCSOQ] 402 leg start failed for ${rec.key.slice(0, 20)}...: ${err.message} — money tick will retry`)
      );
    } catch (err: any) {
      rec.lastError = err.message;
      await this.store.putConvert(rec);
      // Expected while the treasury deposit is under the engine's conf
      // policy — the money tick retries until it clears.
      logger.warn(`[BTCSOQ] CONVERT attempt for ${rec.key.slice(0, 20)}... not complete: ${err.message} — stays 'converting', retry in ${MINT_RETRY_MS / 1000}s`);
    } finally {
      this.convertingInFlight.delete(rec.key);
    }
  }

  /** Everything the theater acts need — they ride the leg's own client. */
  theaterDeps(): import('./theater').TheaterDeps {
    return {
      enabled: this.ln402Enabled() && !!this.config.ln402Seller2Url && !!this.config.racePayeeAddress,
      ln: () => this.getLn402Client(),
      grokUrl: this.config.ln402SellerUrl,
      claudeUrl: this.config.ln402Seller2Url,
      payee: async () => ({
        address: this.config.racePayeeAddress,
        pubkeyHex: await this.signer.pubkey(this.config.racePayeeAddress),
      }),
      // The Bitcoin context the terminal renders: vault truth + the real,
      // measured wait the gateway's own deposit endured for ONE confirmation.
      btcContext: async () => {
        const s = await this.gatewayStatus();
        const waited = this.store.listDeposits()
          .filter((d) => d.confirmedAt && d.firstSeenAt)
          .map((d) => Math.round((d.confirmedAt! - d.firstSeenAt) / 1000))
          .filter((sec) => sec > 0);
        return {
          network: s.network,
          crossedSats: s.deposits.totalSats,
          vaultSats: s.vault ? Number(s.vault.confirmedSats) : null,
          outstandingSats: s.receipts.outstandingSats,
          redeemedSats: s.receipts.redeemedSats,
          covered: s.vault ? Number(s.vault.confirmedSats) >= s.receipts.outstandingSats : null,
          confPolicy: s.confPolicy.required,
          depositWaitSec: waited.length ? Math.round(waited.reduce((a, b) => a + b, 0) / waited.length) : null,
          anchor: s.anchor?.last ?? null,
        };
      },
      recentAttestations: (limit: number) => this.store.listAttestations().slice(0, limit)
        .map((a) => ({ id: a.id, kind: a.kind, ts: a.ts, payload: a.payload })),
    };
  }

  // ── Lightning + SOQ-402 leg (WS3 — the finale) ─────────

  /**
   * Claim the 402 leg for a converted loop (CAS, one per deposit outpoint
   * ever): the gateway pays a post-quantum Lightning invoice and an AI
   * answers for the money. Costs ~333 shors per loop on the hosted rail.
   */
  private async startLn402Leg(convert: ConvertRecord): Promise<void> {
    if (!this.ln402Enabled()) return;
    if (this.store.getLn402(convert.key)) return;

    const rec: Ln402Record = {
      key: convert.key,
      intentId: convert.intentId,
      ssqAddress: convert.ssqAddress,
      sats: convert.sats,
      status: 'asking',
      question: this.config.ln402Question,
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (!(await this.store.claimLn402(rec))) return;
    logger.info(`[BTCSOQ] 402 claimed for ${convert.key.slice(0, 20)}... — asking the machine`);
    await this.attempt402(rec);
  }

  /**
   * Drive one 402 attempt: challenge (pins an invoice) → pay (idempotent
   * against LSP invoice status) → redeem (retry-safe until the seller marks
   * the invoice redeemed). Every step persists before money moves; an
   * expired invoice is dropped and re-challenged, never re-paid.
   */
  private async attempt402(rec: Ln402Record): Promise<void> {
    if (!this.ln402Enabled()) return;
    if (this.ln402InFlight.has(rec.key)) return;
    if (this.isPaused()) {
      logger.warn(`[BTCSOQ] 402 deferred for ${rec.key.slice(0, 20)}...: gateway paused`);
      return;
    }
    this.ln402InFlight.add(rec.key);
    try {
      const ln = await this.getLn402Client();

      if (!rec.invoiceId) {
        rec.attempts += 1;
        await this.store.putLn402(rec);
        const c = await ln.challenge();
        rec.invoiceId = c.invoiceId;
        rec.amountSat = c.amountSat;
        rec.sellerPub = c.sellerPub;
        await this.store.putLn402(rec);
        logger.info(`[BTCSOQ] 402 challenge for ${rec.key.slice(0, 20)}...: invoice ${c.invoiceId} (${c.amountSat} shors)`);
      }

      const status = await ln.invoiceStatus(rec.invoiceId);
      if (status === 'expired') {
        logger.warn(`[BTCSOQ] 402 invoice ${rec.invoiceId} expired unpaid — re-challenging next tick`);
        rec.invoiceId = undefined;
        rec.sellerPub = undefined;
        await this.store.putLn402(rec);
        return;
      }
      if (status === 'pending') {
        await ln.payInvoice(rec.invoiceId);
        logger.info(`[BTCSOQ] 402 invoice ${rec.invoiceId} PAID over the PQ Lightning rail`);
      }

      const ans = await ln.redeem(rec.invoiceId, rec.sellerPub!);
      rec.status = 'answered';
      rec.answer = ans.answer;
      rec.model = ans.model;
      rec.receipt = ans.receipt;
      rec.receiptVerified = ans.receiptVerified;
      rec.responseSha256 = ans.responseSha256;
      rec.answeredAt = rec.answeredAt ?? Date.now();
      rec.lastError = undefined;
      await this.store.putLn402(rec);
      logger.info(`[BTCSOQ] 402 ANSWERED for ${rec.key.slice(0, 20)}... (model ${rec.model}, seller receipt ${rec.receiptVerified ? 'VERIFIED' : 'UNVERIFIED'}) — Bitcoin paid a machine for an answer`);
      await this.attest('lightning-paid', {
        key: rec.key, intentId: rec.intentId, ssqAddress: rec.ssqAddress,
        sats: rec.sats, txid: rec.invoiceId,
        detail: {
          invoiceId: rec.invoiceId,
          amountShors: rec.amountSat ?? 0,
          responseSha256: rec.responseSha256 ?? '',
          sellerReceiptVerified: rec.receiptVerified ? 1 : 0,
        },
      });
    } catch (err: any) {
      rec.lastError = err.message;
      await this.store.putLn402(rec);
      logger.warn(`[BTCSOQ] 402 attempt for ${rec.key.slice(0, 20)}... not complete: ${err.message} — stays 'asking', retry in ${MINT_RETRY_MS / 1000}s`);
    } finally {
      this.ln402InFlight.delete(rec.key);
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

    if (status === 'confirmed') {
      await this.attest('deposit-confirmed', {
        key: dep.key, intentId: intent.id, ssqAddress: intent.ssqAddress,
        sats: dep.sats, txid: dep.txid,
      });
    }
  }

  // ── Attestations (Dilithium-signed event feed) ─────────

  /**
   * Record + sign an attestation for a money event. Idempotent per
   * (kind, deposit key). Signing failures never block the money path:
   * the record persists unsigned and the money tick retries it.
   */
  private async attest(kind: AttestedEventKind, f: {
    key: string; intentId: string; ssqAddress: string; sats: number; txid: string;
    detail?: Record<string, string | number>;
  }): Promise<void> {
    if (!this.config.attestationAddress) return;
    const id = `${kind}:${f.key}`;
    if (this.store.getAttestation(id)) return;

    const payload = buildPayload({
      kind,
      network: this.config.network,
      key: f.key,
      intentId: f.intentId,
      ssqAddress: f.ssqAddress,
      sats: f.sats,
      txid: f.txid,
      ts: Date.now(),
      detail: f.detail,
    });
    const rec: AttestationRecord = {
      id,
      kind,
      payload,
      digestHex: sha256Hex(payload),
      signatureHex: null,
      signerAddress: this.config.attestationAddress,
      ts: Date.now(),
    };
    await this.store.putAttestation(rec);
    await this.signAttestation(rec);
  }

  private async signAttestation(rec: AttestationRecord): Promise<void> {
    try {
      rec.signatureHex = await this.signer.signDigest(rec.digestHex, rec.signerAddress);
      await this.store.putAttestation(rec);
      logger.info(`[BTCSOQ] ATTESTED ${rec.kind} for ${rec.id.split(':').slice(1).join(':').slice(0, 20)}... (ML-DSA-44, ${rec.signatureHex.length / 2} bytes)`);
    } catch (err: any) {
      logger.warn(`[BTCSOQ] attestation signing failed for ${rec.id} (${err.message}) — will retry on money tick`);
    }
  }

  /** Feed for the Terminal + verifiers; pubkey fetched lazily and cached. */
  private attestationPubkey: string | null = null;

  async attestationFeed(limit: number = 100): Promise<any> {
    if (!this.config.attestationAddress) return { enabled: false, attestations: [] };
    if (!this.attestationPubkey) {
      try {
        this.attestationPubkey = await this.signer.pubkey(this.config.attestationAddress);
      } catch { /* feed still serves; pubkey retried next call */ }
    }
    return {
      enabled: true,
      algorithm: 'ML-DSA-44 (FIPS 204), empty context',
      signerAddress: this.config.attestationAddress,
      pubkeyHex: this.attestationPubkey,
      verify: 'digest = sha256(payload); @noble/post-quantum ml_dsa44.verify(signature, digest, pubkey) === true. The payload string is signed verbatim (empty ML-DSA context).',
      attestations: this.store.listAttestations().slice(0, limit),
    };
  }

  // ── Circuit breaker ────────────────────────────────────

  /** Set when PoR inverts (outstanding > vault) — mints halt, releases continue. */
  private porHalted: boolean = false;

  /** Manual pause: the file's existence is the switch (touch to halt, rm to resume). */
  private isPaused(): boolean {
    try {
      return !!this.config.pauseFile && existsSync(this.config.pauseFile);
    } catch {
      return false;
    }
  }

  private dailyMintedSats(): number {
    const cutoff = Date.now() - 24 * 3600_000;
    return this.store.listMints()
      .filter((m) => m.mintedAt && m.mintedAt > cutoff)
      .reduce((s, m) => s + m.sats, 0);
  }

  private dailyReleasedSats(): number {
    const cutoff = Date.now() - 24 * 3600_000;
    return this.store.listMints()
      .filter((m) => m.releasedAt && m.releasedAt > cutoff)
      .reduce((s, m) => s + m.sats, 0);
  }

  /** null = clear to mint `sats`; string = deferral reason (retried by the tick). */
  private mintBreakerReason(sats: number): string | null {
    if (this.isPaused()) return 'gateway paused (pause file present)';
    if (this.porHalted) return 'PoR halt: outstanding receipts exceed vault';
    if (this.config.maxDailyMintSats > 0 &&
        this.dailyMintedSats() + sats > this.config.maxDailyMintSats) {
      return `daily mint cap: ${this.dailyMintedSats()} + ${sats} > ${this.config.maxDailyMintSats} sats/24h`;
    }
    return null;
  }

  private releaseBreakerReason(sats: number): string | null {
    if (this.isPaused()) return 'gateway paused (pause file present)';
    if (this.config.maxDailyReleaseSats > 0 &&
        this.dailyReleasedSats() + sats > this.config.maxDailyReleaseSats) {
      return `daily release cap: ${this.dailyReleasedSats()} + ${sats} > ${this.config.maxDailyReleaseSats} sats/24h`;
    }
    return null;
  }

  /** PoR invariant check — runs every money tick. Vault must cover outstanding. */
  private async checkPorInvariant(): Promise<void> {
    try {
      const vault = await this.cea.getVaultBalance();
      const outstanding = this.store.listMints()
        .filter((m) => m.status === 'minted' || m.status === 'minting')
        .reduce((s, m) => s + m.sats, 0);
      const covered = Number(vault.confirmedSats) + Number(vault.pendingSats) >= outstanding;
      if (!covered && !this.porHalted) {
        this.porHalted = true;
        logger.error(`[BTCSOQ] CIRCUIT BREAKER: PoR VIOLATION — outstanding ${outstanding} sats > vault ${vault.confirmedSats}+${vault.pendingSats}. MINTS HALTED (releases continue; they reduce exposure). Manual investigation required.`);
      } else if (covered && this.porHalted) {
        this.porHalted = false;
        logger.warn('[BTCSOQ] PoR invariant restored — mint halt lifted');
      }
    } catch { /* vault unreadable — keep current state, next tick retries */ }
  }

  // ── Money loop (mint retry / recovery / redemption / release) ──

  /**
   * Periodic driver for everything money-shaped that isn't event-driven:
   * stuck 'confirmed' intents (crash between transition and claim), stuck
   * 'minting' records (signer down/timeout), redemption block scanning,
   * and stuck 'redeeming' records (crash between claim and release).
   */
  private async moneyTick(): Promise<void> {
    if (this.moneyLoopRunning) return;
    this.moneyLoopRunning = true;
    try {
      await this.checkPorInvariant();
      // Deposits that confirmed but never got a mint claim
      for (const intent of this.store.listIntents()) {
        if (intent.kind === 'deposit' && intent.status === 'confirmed' &&
            intent.depositTxid !== undefined && intent.depositVout !== undefined) {
          await this.mintForDepositKey(`${intent.depositTxid}:${intent.depositVout}`);
        }
      }
      // Claimed mints that haven't landed
      for (const rec of this.store.listMints()) {
        if (rec.status === 'minting') {
          await this.attemptMint(rec);
        }
      }
      await this.scanForRedemptions();
      for (const rec of this.store.listMints()) {
        if (rec.status === 'redeeming') {
          await this.attemptRelease(rec);
        }
      }
      // USDSOQ leg: claim any minted loop still missing its conversion
      // (crash between finalizeMint and claim, or leg enabled after the
      // fact — pre-WS2 loops convert retroactively), then drive in-flight.
      if (this.convertEnabled()) {
        for (const m of this.store.listMints()) {
          if (m.status !== 'minting' && !this.store.getConvert(m.key)) {
            await this.startConvertLeg(m);
          }
        }
        for (const rec of this.store.listConverts()) {
          if (rec.status === 'converting') {
            await this.attemptConvert(rec);
          }
        }
      }
      // 402 leg: claim any converted loop still missing its answer, then
      // drive in-flight asks (crash anywhere resumes from persisted state).
      if (this.ln402Enabled()) {
        for (const c of this.store.listConverts()) {
          if (c.status === 'converted' && !this.store.getLn402(c.key)) {
            await this.startLn402Leg(c);
          }
        }
        for (const rec of this.store.listLn402()) {
          if (rec.status === 'asking') {
            await this.attempt402(rec);
          }
        }
      }
      // Attestations that failed to sign (signer down) get retried here
      for (const att of this.store.listAttestations()) {
        if (att.signatureHex === null) {
          await this.signAttestation(att);
        }
      }
    } finally {
      this.moneyLoopRunning = false;
    }
  }

  /** Boot-time recovery: resolve in-flight records against chain/wallet truth. */
  private async recoverInFlight(): Promise<void> {
    const minting = this.store.listMints().filter((m) => m.status === 'minting');
    const redeeming = this.store.listMints().filter((m) => m.status === 'redeeming');
    if (minting.length || redeeming.length) {
      logger.warn(`[BTCSOQ] Recovery: ${minting.length} 'minting' + ${redeeming.length} 'redeeming' record(s) in flight at boot`);
    }
    for (const rec of minting) {
      await this.attemptMint(rec);       // chain-check first, then re-mint
    }
    for (const rec of redeeming) {
      await this.attemptRelease(rec);    // wallet-history check first, then re-release
    }
    for (const rec of this.store.listConverts()) {
      if (rec.status === 'converting') {
        await this.attemptConvert(rec);  // tag-scan first, then re-send
      }
    }
    for (const rec of this.store.listLn402()) {
      if (rec.status === 'asking') {
        await this.attempt402(rec);      // invoice-status check first, never re-pay
      }
    }
  }

  /** Scan new stagenet blocks for receipts returning to the redemption address. */
  private async scanForRedemptions(): Promise<void> {
    const tip = await this.scanner.tipHeight();
    let cursor = this.store.getSoqScanHeight();
    if (cursor === undefined) {
      // First run: start at the tip — receipts can't predate the gateway.
      await this.store.setSoqScanHeight(tip);
      return;
    }
    if (tip <= cursor) return;

    const spends = await this.scanner.scanRedemptions(
      this.config.redemptionAddress,
      cursor,
      tip,
      (outpoint) => !!this.store.findMintByCarrier(outpoint),
    );

    for (const spend of spends) {
      if (spend.spentCarriers.length === 0) {
        // Coins at the redemption address with no receipt lineage — the
        // redeem-without-receipt case. Held, never released.
        logger.warn(`[BTCSOQ] Unbacked payment to redemption address (tx ${spend.txid.slice(0, 16)}..., ${spend.paidShors} shors) — NO lineage to any minted carrier, held`);
        continue;
      }
      for (const carrier of spend.spentCarriers) {
        const rec = this.store.findMintByCarrier(carrier);
        if (rec) await this.onReceiptReturned(rec, spend.txid);
      }
    }

    await this.store.setSoqScanHeight(tip);
  }

  /** A minted receipt carrier was spent into the redemption address. */
  private async onReceiptReturned(rec: MintRecord, receiptSpendTxid: string): Promise<void> {
    if (rec.status === 'redeeming' || rec.status === 'redeemed') {
      return;   // rescan/reorg replay — release already claimed or done
    }
    if (rec.status !== 'minted') {
      logger.error(`[BTCSOQ] Receipt for ${rec.key.slice(0, 20)}... returned while record is '${rec.status}' — ignoring`);
      return;
    }

    // Bind to the oldest open redeem intent for this attendee address.
    let redeemIntent = this.store.listIntents()
      .filter((i) => i.kind === 'redeem' && i.status === 'awaiting-receipt' && i.ssqAddress === rec.ssqAddress)
      .sort((a, b) => a.createdAt - b.createdAt)[0];

    if (!redeemIntent) {
      // The registration may have aged out while the receipt sat in a
      // wallet. The payout address was this owner's explicit instruction:
      // revive their most recent expired registration instead of stranding
      // the redemption. (Newest, not oldest — the latest instruction wins.)
      const dormant = this.store.listIntents()
        .filter((i) => i.kind === 'redeem' && i.status === 'expired' && i.ssqAddress === rec.ssqAddress)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (dormant) {
        dormant.status = 'awaiting-receipt';
        dormant.expiresAt = Date.now() + this.config.intentTtlHours * 3600_000;
        dormant.updatedAt = Date.now();
        await this.store.putIntent(dormant);
        logger.info(`[BTCSOQ] Redeem intent ${dormant.id.slice(0, 8)} for ${rec.ssqAddress.slice(0, 20)}... — revived by returned receipt`);
        redeemIntent = dormant;
      }
    }

    if (!redeemIntent) {
      logger.warn(`[BTCSOQ] Receipt ${rec.mintTxid?.slice(0, 16)}... returned (tx ${receiptSpendTxid.slice(0, 16)}...) but NO open redeem intent for ${rec.ssqAddress.slice(0, 20)}... — held for manual handling (no payout address)`);
      return;
    }

    // Release CAS: claim the record BEFORE the BTC wallet call.
    rec.status = 'redeeming';
    rec.redeemIntentId = redeemIntent.id;
    rec.receiptSpendTxid = receiptSpendTxid;
    await this.store.putMint(rec);

    redeemIntent.status = 'receipt-received';
    redeemIntent.receiptSpendTxid = receiptSpendTxid;
    redeemIntent.mintTxid = rec.mintTxid;
    redeemIntent.sats = rec.sats;
    redeemIntent.updatedAt = Date.now();
    await this.store.putIntent(redeemIntent);
    logger.info(`[BTCSOQ] REDEEM: receipt ${rec.mintTxid?.slice(0, 16)}... returned → releasing ${rec.sats} sats to ${redeemIntent.btcPayoutAddress}`);
    await this.attest('receipt-returned', {
      key: rec.key, intentId: redeemIntent.id, ssqAddress: rec.ssqAddress,
      sats: rec.sats, txid: receiptSpendTxid,
    });

    await this.attemptRelease(rec);
  }

  /**
   * Release BTC for a 'redeeming' record. Idempotency lives in the release
   * wallet itself: every send carries comment `redeem:<intentId>`, so after
   * a crash we find the payment in listtransactions instead of paying twice.
   */
  private async attemptRelease(rec: MintRecord): Promise<void> {
    const intent = rec.redeemIntentId ? this.store.getIntent(rec.redeemIntentId) : undefined;
    if (!intent || !intent.btcPayoutAddress) {
      logger.error(`[BTCSOQ] Release for ${rec.key.slice(0, 20)}... has no redeem intent/payout address — manual handling required`);
      return;
    }

    // Breaker: defer, never fail — the record stays 'redeeming' and the tick
    // retries. The wallet-history check still runs first on every retry.
    const deferral = this.releaseBreakerReason(rec.sats);
    if (deferral) {
      logger.warn(`[BTCSOQ] RELEASE deferred for ${rec.key.slice(0, 20)}...: ${deferral}`);
      return;
    }

    try {
      const comment = `redeem:${intent.id}`;

      // Wallet-truth check BEFORE any send (crash between claim and send,
      // or between send and record — either way the wallet knows).
      const history: any[] = await this.releaseRpc.call('listtransactions', ['*', 1000, 0]);
      const already = history.find((t) => t.category === 'send' && t.comment === comment);
      if (already) {
        logger.info(`[BTCSOQ] Release recovered from wallet history: ${already.txid.slice(0, 16)}... (${comment})`);
        return this.finalizeRelease(rec, intent, already.txid);
      }

      // subtractfeefromamount=true: the BTC network fee comes out of the
      // released sats, so the release float can never over-drain.
      const releaseTxid: string = await this.releaseRpc.call('sendtoaddress', [
        intent.btcPayoutAddress,
        rec.sats / 1e8,
        comment,
        '',
        true,
      ]);
      await this.finalizeRelease(rec, intent, releaseTxid);
    } catch (err: any) {
      rec.lastError = err.message;
      await this.store.putMint(rec);
      logger.error(`[BTCSOQ] RELEASE failed for ${rec.key.slice(0, 20)}...: ${err.message} — stays 'redeeming', retry in ${MINT_RETRY_MS / 1000}s`);
    }
  }

  private async finalizeRelease(rec: MintRecord, intent: BtcIntent, releaseTxid: string): Promise<void> {
    rec.status = 'redeemed';
    rec.releaseTxid = releaseTxid;
    rec.releasedAt = rec.releasedAt ?? Date.now();
    rec.lastError = undefined;
    await this.store.putMint(rec);

    intent.status = 'released';
    intent.releaseTxid = releaseTxid;
    intent.updatedAt = Date.now();
    await this.store.putIntent(intent);
    logger.info(`[BTCSOQ] RELEASED ${rec.sats} sats → ${intent.btcPayoutAddress} (tx ${releaseTxid.slice(0, 16)}...) — loop closed for deposit ${rec.key.slice(0, 20)}...`);
    await this.attest('btc-released', {
      key: rec.key, intentId: intent.id, ssqAddress: rec.ssqAddress,
      sats: rec.sats, txid: releaseTxid,
    });
  }

  private async expireStaleIntents(): Promise<void> {
    const now = Date.now();
    for (const intent of this.store.listIntents()) {
      if ((intent.status === 'awaiting-deposit' || intent.status === 'awaiting-receipt') &&
          now > intent.expiresAt) {
        intent.status = 'expired';
        intent.updatedAt = now;
        await this.store.putIntent(intent);
        logger.info(`[BTCSOQ] Intent ${intent.id.slice(0, 8)} expired (${intent.kind === 'deposit' ? 'no deposit' : 'no receipt'} within TTL)`);
      }
    }
  }

  // ── Bitcoin anchoring (WS4): the books, notarized by the parent chain ──

  private anchorTimer: ReturnType<typeof setInterval> | null = null;
  private anchoring = false;

  /**
   * Merkle root over the attestation ledger. Recipe (also published in the
   * API): leaves are the 32-byte sha256 digests of every attestation
   * payload, sorted by attestation id; parents are sha256(left || right);
   * an odd node is paired with itself. Anyone holding the public feed can
   * recompute this root and compare it with the bytes Bitcoin notarized.
   */
  computeLedgerRoot(): { root: string; leafCount: number } {
    const leaves = this.store.listAttestations()
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((a) => Buffer.from(a.digestHex, 'hex'));
    if (leaves.length === 0) return { root: '', leafCount: 0 };
    let level: Buffer[] = leaves;
    while (level.length > 1) {
      const next: Buffer[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] ?? level[i];
        next.push(createHash('sha256').update(Buffer.concat([left, right])).digest());
      }
      level = next;
    }
    return { root: level[0].toString('hex'), leafCount: leaves.length };
  }

  /**
   * Anchor the current ledger root into a testnet4 OP_RETURN from the
   * release wallet. Skips when nothing changed since the last anchor
   * (no empty notarizations). Payload: "BSQA" + 0x01 + root(32) +
   * leafCount(u32 LE) = 41 bytes.
   */
  async anchorNow(force = false): Promise<{ anchored: boolean; reason?: string; txid?: string; root?: string }> {
    if (this.anchoring) return { anchored: false, reason: 'anchor already in flight' };
    const { root, leafCount } = this.computeLedgerRoot();
    if (!root) return { anchored: false, reason: 'ledger is empty' };
    const last = this.store.lastAnchor();
    if (!force && last && last.root === root) {
      return { anchored: false, reason: 'ledger unchanged since last anchor', root };
    }
    this.anchoring = true;
    try {
      const payload = Buffer.alloc(41);
      payload.write('BSQA', 0, 'ascii');
      payload.writeUInt8(0x01, 4);
      Buffer.from(root, 'hex').copy(payload, 5);
      payload.writeUInt32LE(leafCount, 37);

      const raw: string = await this.releaseRpc.call('createrawtransaction', [
        [], [{ data: payload.toString('hex') }],
      ]);
      const funded: any = await this.releaseRpc.call('fundrawtransaction', [raw]);
      const signed: any = await this.releaseRpc.call('signrawtransactionwithwallet', [funded.hex]);
      if (!signed.complete) throw new Error('anchor tx signing incomplete');
      const txid: string = await this.releaseRpc.call('sendrawtransaction', [signed.hex]);

      await this.store.putAnchor({ ts: Date.now(), root, leafCount, txid });
      logger.info(`[BTCSOQ] ANCHORED the ledger into Bitcoin: root ${root.slice(0, 16)}... (${leafCount} events) tx ${txid.slice(0, 16)}...`);
      return { anchored: true, txid, root };
    } catch (err: any) {
      logger.warn(`[BTCSOQ] anchor failed: ${err.message} — next interval retries`);
      return { anchored: false, reason: err.message };
    } finally {
      this.anchoring = false;
    }
  }

  /** Public anchor view for the APIs and the pages. */
  anchorStatus(): any {
    const last = this.store.lastAnchor();
    const { root, leafCount } = this.computeLedgerRoot();
    return {
      enabled: this.config.anchorEnabled,
      last: last ? {
        txid: last.txid,
        root: last.root,
        leafCount: last.leafCount,
        ts: last.ts,
        explorer: this.config.network === 'testnet4'
          ? `${this.config.explorerBase}/tx/${last.txid}` : undefined,
        current: last.root === root,
      } : null,
      currentRoot: root || null,
      currentLeafCount: leafCount,
      recipe: 'leaves = sha256 digests of every attestation payload (the digestHex field), sorted by attestation id; parent = sha256(left || right); an odd node pairs with itself. The Bitcoin tx OP_RETURN carries "BSQA" + 0x01 + root (32 bytes) + leaf count (uint32 LE).',
    };
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
    const mints = this.store.listMints();
    // Outstanding = receipts issued and not yet redeemed. The honest PoR
    // claim: vault BTC >= outstanding receipt backing at all times.
    const outstanding = mints.filter((m) => m.status === 'minted' || m.status === 'minting');
    const redeemed = mints.filter((m) => m.status === 'redeemed' || m.status === 'redeeming');
    return {
      asset: 'BTCSOQ',
      model: 'overlay-receipt',   // relayer-tracked for the demo; consensus asset = roadmap (DL §3)
      network: this.config.network,
      healthy: this.cea.isHealthy(),
      moneyLoop: this.moneyLoopEnabled(),
      breaker: {
        paused: this.isPaused(),
        porHalted: this.porHalted,
        dailyMintCapSats: this.config.maxDailyMintSats || null,
        dailyMintUsedSats: this.dailyMintedSats(),
        dailyReleaseCapSats: this.config.maxDailyReleaseSats || null,
        dailyReleaseUsedSats: this.dailyReleasedSats(),
      },
      blockHeight: height,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      confPolicy: { required: this.config.finalityConf },
      vault: vault ? {
        confirmedSats: vault.confirmedSats.toString(),
        pendingSats: vault.pendingSats.toString(),
      } : null,
      receipts: {
        minted: mints.filter((m) => m.status !== 'minting').length,
        outstandingSats: outstanding.reduce((s, m) => s + m.sats, 0),
        redeemedSats: redeemed.reduce((s, m) => s + m.sats, 0),
        inFlight: mints.filter((m) => m.status === 'minting' || m.status === 'redeeming').length,
        redemptionAddress: this.config.redemptionAddress || null,
      },
      conversions: (() => {
        const converts = this.store.listConverts();
        const done = converts.filter((c) => c.status === 'converted');
        return {
          enabled: this.convertEnabled(),
          count: done.length,
          inFlight: converts.length - done.length,
          soqInShors: done.reduce((s, c) => s + c.soqInShors, 0),
          usdsoqOutShors: done.reduce((s, c) => s + (c.usdsoqOutShors ?? 0), 0),
          usdsoqAddress: this.config.convertUsdsoqAddress || null,
        };
      })(),
      ln402: (() => {
        const asks = this.store.listLn402();
        const answered = asks.filter((a) => a.status === 'answered');
        return {
          enabled: this.ln402Enabled(),
          answered: answered.length,
          inFlight: asks.length - answered.length,
          paidShors: answered.reduce((s, a) => s + (a.amountSat ?? 0), 0),
          receiptsVerified: answered.filter((a) => a.receiptVerified).length,
        };
      })(),
      intents: {
        total: intents.length,
        awaiting: intents.filter((i) => i.status === 'awaiting-deposit').length,
        confirmed: intents.filter((i) => i.status === 'confirmed').length,
        minted: intents.filter((i) => i.status === 'minted').length,
        released: intents.filter((i) => i.status === 'released').length,
      },
      deposits: {
        total: deposits.length,
        totalSats: deposits.reduce((s, d) => s + d.sats, 0),
        unsolicited: deposits.filter((d) => d.intentId === null).length,
      },
      anchor: this.anchorStatus(),
    };
  }

  /** The Bitcoin CEA — exposed so the DUA router can register it (unmanaged). */
  getCea(): BitcoinCEA {
    return this.cea;
  }

  listRecentMints(limit: number = 50) {
    return this.store.listMints().slice(0, limit);
  }

  listRecentDeposits(limit: number = 50): DepositRecord[] {
    return this.store.listDeposits().slice(0, limit);
  }

  /** Paid AI answers + seller receipts (the page re-verifies both sigs). */
  listAnswers(limit: number = 20): Ln402Record[] {
    return this.store.listLn402().slice(0, limit);
  }
}

/** 4xx-class input error, distinguished from operational failures. */
export class GatewayInputError extends Error {}
