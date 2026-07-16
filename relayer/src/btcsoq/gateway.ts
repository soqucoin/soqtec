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
import { existsSync } from 'fs';
import { BitcoinCEA, BitcoinCEAConfig } from '../cea/bitcoin-cea';
import { NormalizedBurnEvent, BurnConfidence } from '../cea/types';
import { GatewayStore, BtcIntent, DepositRecord, MintRecord } from './store';
import { MintSignerClient } from './signer-client';
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
  /** Serializes mint attempts per deposit key (poll tick vs retry tick race) */
  private mintingInFlight: Set<string> = new Set();
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
    } else {
      logger.warn('[BTCSOQ] Money loop DISABLED (mint signer/addresses not configured) — detection-only mode');
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
    return mintTxid;
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
    const redeemIntent = this.store.listIntents()
      .filter((i) => i.kind === 'redeem' && i.status === 'awaiting-receipt' && i.ssqAddress === rec.ssqAddress)
      .sort((a, b) => a.createdAt - b.createdAt)[0];

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
}

/** 4xx-class input error, distinguished from operational failures. */
export class GatewayInputError extends Error {}
